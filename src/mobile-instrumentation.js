// Page-side instrumentation script for mobile Safari targets.
// Injected via Runtime.evaluate through the Web Inspector protocol.
// Mirrors the desktop bridge's instrumentation patterns for:
//   - Console capture (log/warn/error/info/debug + uncaught errors + unhandled rejections)
//   - Network capture (fetch + XHR interception)
//   - Debugger support (async callback wrapping, breakpoints, pause/resume)
//   - Profiler support (time-delta sampling of wrapped callbacks)
//   - Animation inspection (document.getAnimations scanning)

export const INSTRUMENTATION_SCRIPT = `(() => {
  if (window.__mobileCdtBridge) return true;

  const bridge = {
    nextRequestId: 1,
    networkEvents: [],
    consoleEvents: [],
    debuggerEvents: [],
    animationEvents: [],
    profileEvents: [],
    networkInstalled: false,
  };
  window.__mobileCdtBridge = bridge;

  const debuggerState = {
    breakpoints: [],
    breakpointsActive: true,
    pauseRequested: false,
    pauseOnExceptions: "none",
    profilerEnabled: false,
    pendingInvocations: [],
    nextPauseId: 1,
  };
  bridge.debuggerState = debuggerState;

  const animationState = {
    enabled: false,
    playbackRate: 1,
    nextAnimationId: 1,
    animationIds: new WeakMap(),
    liveAnimations: {},
    snapshots: {},
    releasedIds: {},
  };
  bridge.animationState = animationState;

  // ── Serialization helpers ──

  function serializeValue(v) {
    if (v === null) return { type: "object", subtype: "null", value: null };
    if (v === undefined) return { type: "undefined" };
    var t = typeof v;
    if (t === "string" || t === "number" || t === "boolean")
      return { type: t, value: v, description: String(v) };
    if (t === "function")
      return { type: "function", description: v.toString().slice(0, 200) };
    try {
      return { type: "object", value: JSON.parse(JSON.stringify(v)), description: String(v) };
    } catch (e) {
      return { type: "object", description: String(v) };
    }
  }

  function normalizeHeaders(hdrs) {
    var out = {};
    if (hdrs && typeof hdrs.forEach === "function") {
      hdrs.forEach(function(v, k) { out[k] = v; });
    } else if (hdrs && typeof hdrs === "object") {
      for (var k in hdrs) out[k] = hdrs[k];
    }
    return out;
  }

  // ── Console instrumentation ──

  var origConsole = {};
  ["log", "warn", "error", "info", "debug"].forEach(function(level) {
    origConsole[level] = console[level] ? console[level].bind(console) : function() {};
    console[level] = function() {
      var args = Array.prototype.slice.call(arguments);
      bridge.consoleEvents.push({
        kind: "console-api",
        level: level,
        text: args.map(function(a) {
          try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
          catch (e) { return String(a); }
        }).join(" "),
        args: args.map(serializeValue),
        stackTrace: [],
        timestamp: Date.now(),
        monotonicTime: performance.now() / 1000,
      });
      return origConsole[level].apply(console, args);
    };
  });

  window.addEventListener("error", function(event) {
    bridge.consoleEvents.push({
      kind: "exception",
      text: event.message || String(event),
      url: event.filename || "",
      lineNumber: event.lineno || 0,
      columnNumber: event.colno || 0,
      timestamp: Date.now(),
      monotonicTime: performance.now() / 1000,
    });
  });

  window.addEventListener("unhandledrejection", function(event) {
    var reason = event.reason;
    bridge.consoleEvents.push({
      kind: "exception",
      text: "Unhandled promise rejection: " + (reason && reason.message ? reason.message : String(reason)),
      url: "",
      lineNumber: 0,
      columnNumber: 0,
      timestamp: Date.now(),
      monotonicTime: performance.now() / 1000,
    });
  });

  // ── Network: fetch wrapper ──

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function() {
      var fetchArgs = arguments;
      var request;
      try { request = new Request(fetchArgs[0], fetchArgs[1]); }
      catch (e) { return origFetch.apply(window, fetchArgs); }
      var requestId = String(bridge.nextRequestId++);
      // Capture request body for POST/PUT/PATCH
      var postData = null;
      var initArg = fetchArgs[1];
      if (initArg && typeof initArg.body === "string") {
        postData = initArg.body;
      } else if (initArg && initArg.body && typeof initArg.body.toString === "function" && !(initArg.body instanceof ReadableStream)) {
        try { postData = String(initArg.body); } catch (e) {}
      }
      bridge.networkEvents.push({
        kind: "request",
        requestId: requestId,
        url: request.url,
        method: request.method,
        headers: normalizeHeaders(request.headers),
        postData: postData,
        hasPostData: postData !== null,
        resourceType: "Fetch",
        timestamp: Date.now(),
        monotonicTime: performance.now() / 1000,
      });
      return origFetch.apply(window, fetchArgs).then(function(response) {
        var clone = response.clone();
        return clone.text().catch(function() { return ""; }).then(function(body) {
          bridge.networkEvents.push({
            kind: "response",
            requestId: requestId,
            url: response.url || request.url,
            status: response.status,
            statusText: response.statusText,
            headers: normalizeHeaders(response.headers),
            mimeType: response.headers.get("content-type") || "",
            body: body,
            encodedDataLength: body.length,
            timestamp: Date.now(),
            monotonicTime: performance.now() / 1000,
          });
          bridge.networkEvents.push({
            kind: "finished",
            requestId: requestId,
            encodedDataLength: body.length,
            timestamp: Date.now(),
            monotonicTime: performance.now() / 1000,
          });
          return response;
        });
      }).catch(function(error) {
        bridge.networkEvents.push({
          kind: "failed",
          requestId: requestId,
          errorText: String(error),
          canceled: false,
          timestamp: Date.now(),
          monotonicTime: performance.now() / 1000,
        });
        throw error;
      });
    };
  }

  // ── Network: XHR wrapper ──

  var XHR = XMLHttpRequest.prototype;
  var origOpen = XHR.open;
  var origSend = XHR.send;
  var origSetHeader = XHR.setRequestHeader;

  XHR.open = function(method, url) {
    this.__cdtReq = {
      requestId: String(bridge.nextRequestId++),
      method: method,
      url: new URL(url, location.href).href,
      headers: {},
    };
    return origOpen.apply(this, arguments);
  };

  XHR.setRequestHeader = function(k, v) {
    if (this.__cdtReq) this.__cdtReq.headers[k] = v;
    return origSetHeader.apply(this, arguments);
  };

  XHR.send = function(body) {
    var meta = this.__cdtReq || {
      requestId: String(bridge.nextRequestId++),
      method: "GET",
      url: "",
      headers: {},
    };
    bridge.networkEvents.push({
      kind: "request",
      requestId: meta.requestId,
      url: meta.url,
      method: meta.method,
      headers: meta.headers,
      postData: typeof body === "string" ? body : null,
      resourceType: "XHR",
      timestamp: Date.now(),
      monotonicTime: performance.now() / 1000,
    });
    var xhr = this;
    xhr.addEventListener("loadend", function() {
      if (xhr.status > 0) {
        var respHeaders = {};
        (xhr.getAllResponseHeaders() || "").split("\\r\\n").forEach(function(line) {
          var parts = line.split(": ");
          var k = parts.shift();
          if (k) respHeaders[k.toLowerCase()] = parts.join(": ");
        });
        var respBody = "";
        try { respBody = xhr.responseText || ""; } catch (e) {}
        bridge.networkEvents.push({
          kind: "response",
          requestId: meta.requestId,
          url: xhr.responseURL || meta.url,
          status: xhr.status,
          statusText: xhr.statusText,
          headers: respHeaders,
          mimeType: xhr.getResponseHeader("content-type") || "",
          body: respBody,
          encodedDataLength: respBody.length,
          timestamp: Date.now(),
          monotonicTime: performance.now() / 1000,
        });
        bridge.networkEvents.push({
          kind: "finished",
          requestId: meta.requestId,
          encodedDataLength: respBody.length,
          timestamp: Date.now(),
          monotonicTime: performance.now() / 1000,
        });
      } else {
        bridge.networkEvents.push({
          kind: "failed",
          requestId: meta.requestId,
          errorText: "XMLHttpRequest failed",
          canceled: false,
          timestamp: Date.now(),
          monotonicTime: performance.now() / 1000,
        });
      }
    }, { once: true });
    return origSend.apply(this, arguments);
  };

  bridge.networkInstalled = true;

  // ── Debugger: callback wrapping ──

  function matchesBreakpoint(meta) {
    if (!debuggerState.breakpointsActive || !meta) return [];
    return debuggerState.breakpoints.filter(function(bp) {
      if (bp.url !== meta.url || bp.lineNumber !== meta.lineNumber) return false;
      // Evaluate conditional breakpoint
      if (bp.condition) {
        try { return !!eval(bp.condition); }
        catch (e) { return false; }
      }
      return true;
    });
  }

  function recordProfile(meta, startTime, endTime) {
    if (!debuggerState.profilerEnabled) return;
    bridge.profileEvents.push({
      kind: "sample",
      meta: meta,
      startTime: startTime,
      endTime: endTime,
      duration: endTime - startTime,
    });
  }

  var origSetTimeout = window.setTimeout;
  var origSetInterval = window.setInterval;
  var origRAF = window.requestAnimationFrame;
  var origAddEventListener = EventTarget.prototype.addEventListener;

  function wrapCallback(callback, metaFactory) {
    if (typeof callback !== "function") return callback;
    var staticMeta = typeof metaFactory === "function" ? metaFactory() : (metaFactory || {});
    var wrapped = function() {
      var args = arguments;
      var hits = matchesBreakpoint(staticMeta);
      if (debuggerState.pauseRequested || hits.length) {
        debuggerState.pauseRequested = false;
        var pauseId = String(debuggerState.nextPauseId++);

        // Capture scope information for DevTools
        var scopeVars = {};
        // Capture function arguments
        var argNames = [];
        try {
          var fnStr = callback.toString();
          var argMatch = fnStr.match(/^(?:function\s*\w*\s*\(|(?:\(([^)]*)\)|(\w+))\s*=>)/);
          if (argMatch) {
            var argStr = argMatch[1] || argMatch[2] || "";
            argNames = argStr.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
          }
        } catch (e) {}
        var argsArr = Array.prototype.slice.call(args);
        for (var ai = 0; ai < argNames.length && ai < argsArr.length; ai++) {
          scopeVars[argNames[ai]] = serializeValue(argsArr[ai]);
        }
        // Capture 'this' if it's meaningful
        if (this && this !== window) {
          scopeVars["this"] = serializeValue(this);
        }
        // Capture arguments object
        if (argsArr.length) {
          scopeVars["arguments"] = { type: "object", description: "Arguments(" + argsArr.length + ")", value: argsArr.map(serializeValue) };
        }

        debuggerState.pendingInvocations.push({
          pauseId: pauseId,
          callback: callback,
          thisArg: this,
          args: argsArr,
          meta: staticMeta,
          scopeVars: scopeVars,
        });
        bridge.debuggerEvents.push({
          kind: "paused",
          reason: hits.length ? "breakpoint" : "other",
          pauseId: pauseId,
          meta: staticMeta,
          hitBreakpoints: hits.map(function(b) { return b.breakpointId; }),
          scopeVars: scopeVars,
          timestamp: Date.now(),
          monotonicTime: performance.now() / 1000,
        });
        return undefined;
      }
      var t0 = performance.now();
      try { return callback.apply(this, args); }
      finally { recordProfile(staticMeta, t0, performance.now()); }
    };
    callback.__cdtWrapped = wrapped;
    return wrapped;
  }

  // Wrap timers
  window.setTimeout = function(cb, delay) {
    var rest = Array.prototype.slice.call(arguments, 2);
    return origSetTimeout.apply(window, [
      wrapCallback(cb, { functionName: "setTimeout", url: "", lineNumber: 0, columnNumber: 0 }),
      delay,
    ].concat(rest));
  };

  window.setInterval = function(cb, delay) {
    var rest = Array.prototype.slice.call(arguments, 2);
    return origSetInterval.apply(window, [
      wrapCallback(cb, { functionName: "setInterval", url: "", lineNumber: 0, columnNumber: 0 }),
      delay,
    ].concat(rest));
  };

  if (origRAF) {
    window.requestAnimationFrame = function(cb) {
      return origRAF.call(window,
        wrapCallback(cb, { functionName: "requestAnimationFrame", url: "", lineNumber: 0, columnNumber: 0 })
      );
    };
  }

  // Wrap addEventListener
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (typeof listener === "function") {
      var wrapped = wrapCallback(listener, { functionName: "on" + type, url: "", lineNumber: 0, columnNumber: 0 });
      listener.__cdtWrapped = wrapped;
      return origAddEventListener.call(this, type, wrapped, options);
    }
    return origAddEventListener.call(this, type, listener, options);
  };

  // Wrap Promise handlers
  var origThen = Promise.prototype.then;
  var origCatch = Promise.prototype.catch;
  var origFinally = Promise.prototype.finally;

  Promise.prototype.then = function(onFulfilled, onRejected) {
    return origThen.call(this,
      typeof onFulfilled === "function"
        ? wrapCallback(onFulfilled, { functionName: "Promise.then", url: "", lineNumber: 0, columnNumber: 0 })
        : onFulfilled,
      typeof onRejected === "function"
        ? wrapCallback(onRejected, { functionName: "Promise.catch", url: "", lineNumber: 0, columnNumber: 0 })
        : onRejected
    );
  };

  Promise.prototype.catch = function(onRejected) {
    return origCatch.call(this,
      typeof onRejected === "function"
        ? wrapCallback(onRejected, { functionName: "Promise.catch", url: "", lineNumber: 0, columnNumber: 0 })
        : onRejected
    );
  };

  if (origFinally) {
    Promise.prototype.finally = function(onFinally) {
      return origFinally.call(this,
        typeof onFinally === "function"
          ? wrapCallback(onFinally, { functionName: "Promise.finally", url: "", lineNumber: 0, columnNumber: 0 })
          : onFinally
      );
    };
  }

  // ── Debugger control API ──

  bridge.resumeDebugger = function(mode, pauseId) {
    var idx = -1;
    for (var i = 0; i < debuggerState.pendingInvocations.length; i++) {
      if (debuggerState.pendingInvocations[i].pauseId === pauseId) { idx = i; break; }
    }
    if (idx < 0) return false;
    var entry = debuggerState.pendingInvocations.splice(idx, 1)[0];
    if (mode === "stepOver" || mode === "stepInto") {
      debuggerState.pauseRequested = true;
    }
    origSetTimeout(function() {
      try { entry.callback.apply(entry.thisArg, entry.args); } catch (e) {}
    }, 0);
    return true;
  };

  bridge.setDebuggerConfig = function(config) {
    if (config.breakpoints) debuggerState.breakpoints = config.breakpoints;
    if (typeof config.breakpointsActive === "boolean") debuggerState.breakpointsActive = config.breakpointsActive;
    if (typeof config.pauseRequested === "boolean") debuggerState.pauseRequested = config.pauseRequested;
    if (config.pauseOnExceptions) debuggerState.pauseOnExceptions = config.pauseOnExceptions;
    if (typeof config.profilerEnabled === "boolean") debuggerState.profilerEnabled = config.profilerEnabled;
    return true;
  };

  // ── Animation inspection ──

  function quantizeTime(v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return Math.round(v * 100) / 100;
  }

  function getAnimationType(a) {
    var n = (a && a.constructor && a.constructor.name) || "";
    if (n === "CSSTransition") return "CSSTransition";
    if (n === "CSSAnimation") return "CSSAnimation";
    return "WebAnimation";
  }

  function getAnimationName(a, type) {
    if (type === "CSSAnimation" && a.animationName) return a.animationName;
    if (type === "CSSTransition" && a.transitionProperty) return a.transitionProperty;
    return a.id || "animation";
  }

  function serializeTiming(t) {
    t = t || {};
    return {
      delay: Number(t.delay || 0),
      endDelay: Number(t.endDelay || 0),
      iterationStart: Number(t.iterationStart || 0),
      iterations: Number.isFinite(Number(t.iterations)) ? Number(t.iterations) : null,
      duration: typeof t.duration === "number" && Number.isFinite(t.duration) ? t.duration : 0,
      direction: t.direction || "normal",
      fill: t.fill || "none",
      easing: t.easing || "linear",
    };
  }

  function serializeKeyframes(effect) {
    if (!effect || !effect.getKeyframes) return [];
    try {
      return effect.getKeyframes().map(function(kf) {
        var props = {};
        for (var k in kf) {
          if (["offset", "computedOffset", "easing", "composite"].indexOf(k) === -1 && typeof kf[k] === "string") {
            props[k] = kf[k];
          }
        }
        return {
          offset: typeof kf.offset === "number" ? String(Math.round(kf.offset * 100)) + "%" : "0%",
          easing: kf.easing || "linear",
          properties: props,
        };
      });
    } catch (e) { return []; }
  }

  function serializeAnimation(a) {
    var effect = a.effect;
    var type = getAnimationType(a);
    var name = getAnimationName(a, type);
    var id = animationState.animationIds.get(a);
    if (!id) {
      id = "animation:" + animationState.nextAnimationId++;
      animationState.animationIds.set(a, id);
    }
    var timing = serializeTiming(effect && effect.getTiming ? effect.getTiming() : {});
    var keyframes = serializeKeyframes(effect);
    return {
      id: id,
      name: name,
      type: type,
      pausedState: a.playState === "paused",
      playState: a.playState || "idle",
      playbackRate: typeof a.playbackRate === "number" ? a.playbackRate : 1,
      startTime: quantizeTime(a.startTime),
      currentTime: quantizeTime(a.currentTime),
      source: Object.assign({}, timing, {
        keyframesRule: { name: name, keyframes: keyframes },
      }),
    };
  }

  function scanAnimations() {
    var animations = [];
    if (document.getAnimations) {
      try { animations = document.getAnimations({ subtree: true }); }
      catch (e) {
        try { animations = document.getAnimations(); } catch (e2) {}
      }
    }
    var next = {};
    var seen = {};
    for (var i = 0; i < animations.length; i++) {
      var a = animations[i];
      if (typeof a.playbackRate === "number" && a.playbackRate !== animationState.playbackRate) {
        try { a.playbackRate = animationState.playbackRate; } catch (e) {}
      }
      var snapshot = serializeAnimation(a);
      seen[snapshot.id] = true;
      var prev = animationState.snapshots[snapshot.id];
      next[snapshot.id] = snapshot;
      animationState.liveAnimations[snapshot.id] = a;
      if (!prev) {
        bridge.animationEvents.push({ kind: "created", id: snapshot.id, timestamp: Date.now() });
        bridge.animationEvents.push({ kind: "started", animation: snapshot, timestamp: Date.now() });
      }
    }
    for (var id in animationState.snapshots) {
      if (!seen[id]) {
        animationState.releasedIds[id] = animationState.snapshots[id];
        bridge.animationEvents.push({ kind: "canceled", id: id, timestamp: Date.now() });
      }
    }
    animationState.snapshots = next;
  }

  bridge.collectAnimationEvents = function() {
    if (!animationState.enabled) { bridge.animationEvents.length = 0; return []; }
    scanAnimations();
    var events = bridge.animationEvents.slice();
    bridge.animationEvents.length = 0;
    return events;
  };

  bridge.setAnimationConfig = function(config) {
    if (typeof config.enabled === "boolean") animationState.enabled = config.enabled;
    if (typeof config.playbackRate === "number" && Number.isFinite(config.playbackRate)) {
      animationState.playbackRate = config.playbackRate;
    }
    scanAnimations();
    return true;
  };

  bridge.setAnimationsPaused = function(ids, paused) {
    ids = ids || [];
    for (var i = 0; i < ids.length; i++) {
      var a = animationState.liveAnimations[ids[i]];
      if (a) { try { paused ? a.pause() : a.play(); } catch (e) {} }
    }
    scanAnimations();
    return true;
  };

  bridge.seekAnimations = function(ids, time) {
    ids = ids || [];
    for (var i = 0; i < ids.length; i++) {
      var a = animationState.liveAnimations[ids[i]];
      if (a) { try { a.currentTime = time; } catch (e) {} }
    }
    scanAnimations();
    return true;
  };

  bridge.releaseAnimations = function(ids) {
    ids = ids || [];
    for (var i = 0; i < ids.length; i++) {
      delete animationState.liveAnimations[ids[i]];
      delete animationState.snapshots[ids[i]];
    }
    return true;
  };

  bridge.getAnimationSnapshot = function(animationId) {
    scanAnimations();
    return animationState.snapshots[animationId] || null;
  };

  bridge.getDocumentAnimationPlaybackRate = function() {
    return animationState.playbackRate;
  };

  bridge.setDocumentAnimationPlaybackRate = function(rate) {
    if (typeof rate !== "number" || !Number.isFinite(rate)) return false;
    animationState.playbackRate = rate;
    scanAnimations();
    for (var id in animationState.liveAnimations) {
      try { animationState.liveAnimations[id].playbackRate = rate; } catch (e) {}
    }
    return true;
  };

  bridge.resolveAnimationObject = function(animationId) {
    scanAnimations();
    var snapshot = animationState.snapshots[animationId];
    if (!snapshot) return null;
    return {
      objectId: "animation:" + animationId,
      type: "object",
      className: "Animation",
      description: snapshot.name || "Animation",
    };
  };

  // ── DOM mutation observation ──

  bridge.domMutationEvents = [];
  bridge.domObserverEnabled = false;
  var domObserver = null;
  var nextMutNodeId = 100000;

  function getNodePath(node) {
    var path = [];
    var current = node;
    while (current && current.parentNode) {
      var parent = current.parentNode;
      var index = Array.prototype.indexOf.call(parent.childNodes, current);
      if (index < 0) break;
      path.unshift(index);
      current = parent;
    }
    return path;
  }

  function serializeMutNode(node) {
    if (!node) return null;
    var type = node.nodeType;
    var result = {
      nodeId: nextMutNodeId++,
      backendNodeId: nextMutNodeId,
      nodeType: type,
      nodeName: node.nodeName || "",
      localName: (node.localName || "").toLowerCase(),
      nodeValue: type === 3 ? (node.nodeValue || "") : "",
      childNodeCount: node.childNodes ? node.childNodes.length : 0,
      attributes: [],
    };
    if (type === 1 && node.attributes) {
      for (var i = 0; i < node.attributes.length; i++) {
        result.attributes.push(node.attributes[i].name);
        result.attributes.push(node.attributes[i].value);
      }
    }
    return result;
  }

  bridge.startDomObserver = function() {
    if (domObserver) return;
    bridge.domObserverEnabled = true;
    domObserver = new MutationObserver(function(mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mutation = mutations[i];
        var parentPath = getNodePath(mutation.target);

        if (mutation.type === "childList") {
          for (var j = 0; j < mutation.addedNodes.length; j++) {
            bridge.domMutationEvents.push({
              kind: "childNodeInserted",
              parentPath: parentPath,
              previousSiblingPath: mutation.previousSibling ? getNodePath(mutation.previousSibling) : null,
              node: serializeMutNode(mutation.addedNodes[j]),
              timestamp: Date.now(),
            });
          }
          for (var k = 0; k < mutation.removedNodes.length; k++) {
            bridge.domMutationEvents.push({
              kind: "childNodeRemoved",
              parentPath: parentPath,
              node: serializeMutNode(mutation.removedNodes[k]),
              timestamp: Date.now(),
            });
          }
        } else if (mutation.type === "attributes") {
          bridge.domMutationEvents.push({
            kind: "attributeModified",
            targetPath: parentPath,
            name: mutation.attributeName || "",
            value: mutation.target.getAttribute ? (mutation.target.getAttribute(mutation.attributeName) || "") : "",
            timestamp: Date.now(),
          });
        } else if (mutation.type === "characterData") {
          bridge.domMutationEvents.push({
            kind: "characterDataModified",
            targetPath: parentPath,
            newValue: mutation.target.nodeValue || "",
            timestamp: Date.now(),
          });
        }
      }
    });
    domObserver.observe(document.documentElement || document.body || document, {
      childList: true,
      attributes: true,
      characterData: true,
      subtree: true,
    });
  };

  bridge.stopDomObserver = function() {
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    bridge.domObserverEnabled = false;
    bridge.domMutationEvents.length = 0;
  };

  // ── View Transition API instrumentation ──

  if (document.startViewTransition) {
    var origStartViewTransition = document.startViewTransition.bind(document);
    document.startViewTransition = function(callbackOrOptions) {
      var transition = origStartViewTransition(callbackOrOptions);

      // When the transition is ready, scan for view-transition pseudo-element animations
      if (transition && transition.ready) {
        transition.ready.then(function() {
          // View transition pseudo-element animations should appear in getAnimations()
          // Emit a synthetic animation event for the view transition lifecycle
          if (animationState.enabled) {
            var vtId = "view-transition:" + animationState.nextAnimationId++;
            bridge.animationEvents.push({
              kind: "created",
              id: vtId,
              timestamp: Date.now(),
            });
            bridge.animationEvents.push({
              kind: "started",
              animation: {
                id: vtId,
                name: "view-transition",
                type: "ViewTransition",
                pausedState: false,
                playState: "running",
                playbackRate: 1,
                startTime: performance.now(),
                currentTime: 0,
                source: {
                  delay: 0,
                  endDelay: 0,
                  iterationStart: 0,
                  iterations: 1,
                  duration: 250,
                  direction: "normal",
                  fill: "none",
                  easing: "ease",
                  keyframesRule: { name: "view-transition", keyframes: [] },
                },
              },
              timestamp: Date.now(),
            });

            // Also try to capture the actual pseudo-element animations
            try {
              var docAnims = document.getAnimations({ subtree: true });
              for (var vi = 0; vi < docAnims.length; vi++) {
                var anim = docAnims[vi];
                var effect = anim.effect;
                if (effect && effect.pseudoElement &&
                    (effect.pseudoElement.indexOf("view-transition") >= 0 ||
                     effect.pseudoElement.indexOf("::view-transition") >= 0)) {
                  // This is a view-transition pseudo-element animation
                  var snapshot = serializeAnimation(anim);
                  snapshot.type = "ViewTransition";
                  snapshot.name = effect.pseudoElement || "view-transition";
                  bridge.animationEvents.push({
                    kind: "started",
                    animation: snapshot,
                    timestamp: Date.now(),
                  });
                }
              }
            } catch (e) {}
          }

          // Scan animations to pick up any new view-transition-related animations
          if (animationState.enabled) scanAnimations();
        }).catch(function() {});
      }

      if (transition && transition.finished) {
        transition.finished.then(function() {
          // Scan again to capture completion
          if (animationState.enabled) scanAnimations();
        }).catch(function() {});
      }

      return transition;
    };
  }

  return true;
})()`;
