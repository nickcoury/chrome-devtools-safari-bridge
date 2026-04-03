/**
 * DevTools Safari Bridge — Content Script
 *
 * Injected into every page. Handles all DOM/console/network/animation
 * instrumentation. Communicates with background.js via browser.runtime messaging.
 *
 * Push model: events are buffered and sent to background periodically.
 * Commands from background are handled via onMessage listener.
 */

(() => {
  if (window.__cdtBridge) return;

  const bridge = window.__cdtBridge = {
    consoleEvents: [],
    networkEvents: [],
    domDirty: false,
    animEnabled: false,
    animRate: 1,
    animNextId: 1,
    animIds: new WeakMap(),
    animPrev: {},
    animLive: {},
    animEvents: [],
    nextReqId: 1,
  };

  // ── Push events to background script ──────────────────────────────

  function pushEvents() {
    try {
      if (bridge.consoleEvents.length) {
        browser.runtime.sendMessage({
          type: "events", kind: "console", events: bridge.consoleEvents.splice(0)
        });
      }
      if (bridge.networkEvents.length) {
        browser.runtime.sendMessage({
          type: "events", kind: "network", events: bridge.networkEvents.splice(0)
        });
      }
      if (bridge.domDirty) {
        bridge.domDirty = false;
        browser.runtime.sendMessage({ type: "events", kind: "domDirty" });
      }
      if (bridge.animEnabled && bridge.animEvents.length) {
        animScan();
        browser.runtime.sendMessage({
          type: "events", kind: "animation", events: bridge.animEvents.splice(0)
        });
      }
    } catch (e) {
      // Extension context may be invalidated — ignore
    }
  }

  // Flush events every 100ms
  setInterval(pushEvents, 100);

  // ── Command handler (from background script) ──────────────────────

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const { type } = msg;

    switch (type) {
      case "ping":
        sendResponse({ ok: true, url: location.href, title: document.title });
        return;

      case "getSnapshot":
        sendResponse(getSnapshot());
        return;

      case "getOuterHTML": {
        const node = getNodeByPath(msg.path);
        sendResponse({ html: node?.outerHTML ?? node?.nodeValue ?? "" });
        return;
      }

      case "getBoxModel": {
        const node = getNodeByPath(msg.path);
        if (!node?.getBoundingClientRect) { sendResponse(null); return; }
        const r = node.getBoundingClientRect();
        sendResponse({ x: r.x, y: r.y, width: r.width, height: r.height });
        return;
      }

      case "getComputedStyle": {
        const node = getNodeByPath(msg.path);
        if (!node || node.nodeType !== 1) { sendResponse([]); return; }
        const s = getComputedStyle(node);
        sendResponse(Array.from(s).map(n => ({ name: n, value: s.getPropertyValue(n) })));
        return;
      }

      case "highlight":
        doHighlight(msg.path);
        sendResponse({ ok: true });
        return;

      case "hideHighlight":
        hideHighlight();
        sendResponse({ ok: true });
        return;

      case "evaluate":
        try {
          const result = eval(msg.expression);
          sendResponse({ value: result });
        } catch (e) {
          sendResponse({ error: e.message, stack: e.stack });
        }
        return;

      case "getScripts":
        sendResponse(Array.from(document.scripts).map((s, i) => ({
          index: i, src: s.src || "", inline: !s.src,
          type: s.type || "", source: s.src ? "" : (s.textContent || ""),
        })));
        return;

      case "getLayoutMetrics":
        sendResponse({
          w: window.innerWidth, h: window.innerHeight,
          sw: document.documentElement.scrollWidth,
          sh: document.documentElement.scrollHeight
        });
        return;

      case "animEnable":
        bridge.animEnabled = true;
        animScan();
        sendResponse({ ok: true });
        return;

      case "animDisable":
        bridge.animEnabled = false;
        sendResponse({ ok: true });
        return;

      case "animGetCurrent":
        animScan();
        sendResponse(bridge.animPrev[msg.animId] ? JSON.parse(bridge.animPrev[msg.animId]) : null);
        return;

      case "animGetRate":
        sendResponse({ rate: bridge.animRate });
        return;

      case "animSetRate":
        bridge.animRate = msg.rate;
        animScan();
        sendResponse({ ok: true });
        return;

      case "animSeek":
        for (const aid of (msg.ids || [])) {
          const a = bridge.animLive[aid];
          if (a) try { a.currentTime = msg.currentTime; } catch {}
        }
        animScan();
        sendResponse({ ok: true });
        return;

      case "animSetPaused":
        for (const aid of (msg.ids || [])) {
          const a = bridge.animLive[aid];
          if (a) try { msg.paused ? a.pause() : (a.play(), a.playbackRate = bridge.animRate); } catch {}
        }
        animScan();
        sendResponse({ ok: true });
        return;

      case "getPerformanceMetrics":
        sendResponse([
          { name: "Timestamp", value: Date.now() / 1000 },
          { name: "Documents", value: 1 },
          { name: "Nodes", value: document.getElementsByTagName("*").length },
        ]);
        return;
    }
  });

  // ── Console interception ──────────────────────────────────────────

  const origConsole = {};
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level]?.bind(console);
    if (!orig) continue;
    origConsole[level] = orig;
    console[level] = (...args) => {
      bridge.consoleEvents.push({
        level,
        text: args.map(a => {
          try { return typeof a === "string" ? a : JSON.stringify(a); }
          catch { return String(a); }
        }).join(" "),
        args: args.map(a => {
          if (a === null) return { type: "object", subtype: "null", value: null };
          if (a === undefined) return { type: "undefined" };
          const t = typeof a;
          if (t === "object") return {
            type: "object",
            description: Array.isArray(a) ? `Array(${a.length})` : a?.constructor?.name || "Object"
          };
          return { type: t, value: a, description: String(a) };
        }),
        timestamp: Date.now(),
      });
      return orig(...args);
    };
  }

  window.addEventListener("error", e => {
    bridge.consoleEvents.push({
      level: "error", text: e.message || String(e),
      args: [{ type: "string", value: e.message || "" }],
      timestamp: Date.now(), exception: true,
      url: e.filename, line: e.lineno, col: e.colno,
      stack: e.error?.stack || "",
    });
  });

  window.addEventListener("unhandledrejection", e => {
    bridge.consoleEvents.push({
      level: "error", text: e.reason?.message || String(e.reason),
      args: [{ type: "string", value: e.reason?.message || "" }],
      timestamp: Date.now(), exception: true,
      stack: e.reason?.stack || "",
    });
  });

  // ── Network interception ──────────────────────────────────────────

  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const req = new Request(...args);
    const rid = String(bridge.nextReqId++);
    const hdrs = {};
    for (const [k, v] of req.headers.entries()) hdrs[k] = v;
    bridge.networkEvents.push({
      kind: "request", requestId: rid, url: req.url,
      method: req.method, headers: hdrs, resourceType: "Fetch"
    });
    try {
      const resp = await origFetch(...args);
      const clone = resp.clone();
      let body = "";
      try { body = await clone.text(); } catch {}
      const rh = {};
      for (const [k, v] of resp.headers.entries()) rh[k] = v;
      bridge.networkEvents.push({
        kind: "response", requestId: rid, url: resp.url || req.url,
        status: resp.status, statusText: resp.statusText, headers: rh,
        mimeType: rh["content-type"] || "", body, encodedDataLength: body.length,
        resourceType: "Fetch"
      });
      bridge.networkEvents.push({
        kind: "finished", requestId: rid, encodedDataLength: body.length
      });
      return resp;
    } catch (e) {
      bridge.networkEvents.push({
        kind: "failed", requestId: rid, errorText: String(e)
      });
      throw e;
    }
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHdr = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__cdt = {
      requestId: String(bridge.nextReqId++), method,
      url: new URL(url, location.href).href, headers: {}
    };
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
    if (this.__cdt) this.__cdt.headers[k] = v;
    return origSetHdr.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    const m = this.__cdt || {
      requestId: String(bridge.nextReqId++), method: "GET",
      url: location.href, headers: {}
    };
    bridge.networkEvents.push({
      kind: "request", ...m,
      postData: typeof body === "string" ? body : null,
      resourceType: "XHR"
    });
    this.addEventListener("loadend", () => {
      const rh = {};
      for (const line of (this.getAllResponseHeaders() || "").trim().split(/[\r\n]+/).filter(Boolean)) {
        const p = line.split(": ");
        rh[p.shift()] = p.join(": ");
      }
      const rb = typeof this.responseText === "string" ? this.responseText : "";
      bridge.networkEvents.push({
        kind: "response", requestId: m.requestId, url: this.responseURL || m.url,
        status: this.status, statusText: this.statusText, headers: rh,
        mimeType: this.getResponseHeader("content-type") || "", body: rb,
        encodedDataLength: rb.length, resourceType: "XHR"
      });
      bridge.networkEvents.push(
        this.status > 0
          ? { kind: "finished", requestId: m.requestId, encodedDataLength: rb.length }
          : { kind: "failed", requestId: m.requestId, errorText: "XHR failed" }
      );
    }, { once: true });
    return origSend.apply(this, arguments);
  };

  // ── DOM mutation tracking ─────────────────────────────────────────

  const mo = new MutationObserver(() => { bridge.domDirty = true; });
  mo.observe(document, {
    childList: true, subtree: true, attributes: true, characterData: true
  });

  // ── Highlight overlay ─────────────────────────────────────────────

  let hlEl = null;

  function doHighlight(path) {
    let node = document;
    for (const i of (path || [])) node = node?.childNodes?.[i];
    if (!node?.getBoundingClientRect) { hideHighlight(); return; }
    if (!hlEl) {
      hlEl = document.createElement("div");
      hlEl.id = "__cdt_highlight";
      hlEl.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #4285f4;background:rgba(66,133,244,0.15);transition:all 0.1s;";
      document.documentElement.appendChild(hlEl);
    }
    const r = node.getBoundingClientRect();
    hlEl.style.left = r.left + "px";
    hlEl.style.top = r.top + "px";
    hlEl.style.width = r.width + "px";
    hlEl.style.height = r.height + "px";
    hlEl.style.display = "block";
  }

  function hideHighlight() {
    if (hlEl) hlEl.style.display = "none";
  }

  // ─��� Animation scanning ────────────────────────────────────────────

  const animType = a => {
    const n = a?.constructor?.name || "";
    return n.includes("Transition") ? "CSSTransition"
      : n.includes("CSSAnimation") ? "CSSAnimation" : "WebAnimation";
  };

  const animId = a => {
    let i = bridge.animIds.get(a);
    if (!i) { i = "anim:" + bridge.animNextId++; bridge.animIds.set(a, i); }
    return i;
  };

  const animSnap = a => {
    const e = a?.effect;
    const t = e?.getTiming?.() || {};
    const kf = e?.getKeyframes?.() || [];
    return {
      id: animId(a),
      name: a.animationName || a.transitionProperty || a.id || "animation",
      pausedState: a.playState === "paused",
      playState: a.playState || "idle",
      playbackRate: typeof a.playbackRate === "number" ? a.playbackRate : bridge.animRate,
      startTime: a.startTime, currentTime: a.currentTime, type: animType(a), cssId: "",
      source: {
        delay: Number(t.delay || 0), endDelay: Number(t.endDelay || 0),
        duration: typeof t.duration === "number" ? t.duration : 0,
        iterations: Number.isFinite(Number(t.iterations)) ? Number(t.iterations) : null,
        iterationStart: Number(t.iterationStart || 0),
        direction: t.direction || "normal",
        fill: t.fill || "none", easing: t.easing || "linear",
        backendNodeId: 0,
        keyframesRule: {
          name: a.animationName || a.transitionProperty || "animation",
          keyframes: kf.map(k => ({
            offset: typeof k.offset === "number" ? Math.round(k.offset * 100) + "%" : "0%",
            easing: k.easing || "linear"
          })),
        },
      },
    };
  };

  function animScan() {
    let anims = [];
    try { anims = document.getAnimations({ subtree: true }); }
    catch { try { anims = document.getAnimations(); } catch {} }
    const cur = {};
    const seen = new Set();
    for (const a of anims) {
      if (a.playbackRate !== bridge.animRate) {
        try { a.playbackRate = bridge.animRate; } catch {}
      }
      const sn = animSnap(a);
      seen.add(sn.id);
      cur[sn.id] = JSON.stringify(sn);
      bridge.animLive[sn.id] = a;
      if (!bridge.animPrev[sn.id]) {
        bridge.animEvents.push({ kind: "created", id: sn.id });
        bridge.animEvents.push({ kind: "started", animation: sn });
      } else if (bridge.animPrev[sn.id] !== cur[sn.id]) {
        bridge.animEvents.push({ kind: "updated", animation: sn });
      }
    }
    for (const id of Object.keys(bridge.animPrev)) {
      if (!seen.has(id)) {
        bridge.animEvents.push({ kind: "canceled", id });
        delete bridge.animLive[id];
      }
    }
    bridge.animPrev = cur;
  }

  // ── DOM snapshot ──────────────────────────────────────────────────

  function getSnapshot() {
    let nextId = 1;
    function attrPairs(el) {
      const out = [];
      if (!el?.attributes) return out;
      for (const a of el.attributes) out.push(a.name, a.value);
      return out;
    }
    function visit(node, depth) {
      const id = nextId++;
      const base = {
        nodeId: id, backendNodeId: id, nodeType: node.nodeType,
        nodeName: node.nodeName, localName: node.localName || "",
        nodeValue: node.nodeValue || "",
        childNodeCount: node.childNodes ? node.childNodes.length : 0,
        children: [], attributes: node.nodeType === 1 ? attrPairs(node) : [],
      };
      if (node.nodeType === 9) {
        base.documentURL = document.URL;
        base.baseURL = document.baseURI;
        base.xmlVersion = "";
        base.compatibilityMode = document.compatMode;
      }
      if (node.nodeType === 1) base.frameId = "main";
      if (depth !== 0 && node.childNodes?.length) {
        base.children = Array.from(node.childNodes, c => visit(c, depth > 0 ? depth - 1 : depth));
      }
      return base;
    }
    return { root: visit(document, -1), url: document.URL, title: document.title };
  }

  function getNodeByPath(path) {
    let c = document;
    for (const i of (path || [])) c = c?.childNodes?.[i];
    return c;
  }

  // ── Notify background that content script is ready ────────────────

  try {
    browser.runtime.sendMessage({ type: "contentReady", url: location.href, title: document.title });
  } catch {}
})();
