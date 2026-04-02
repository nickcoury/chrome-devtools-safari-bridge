/**
 * Desktop Safari CDP bridge — safaridriver + WebDriver BiDi.
 *
 * Events (console, network, page lifecycle) come via BiDi WebSocket.
 * DOM/CSS queries use WebDriver HTTP execute/sync on demand.
 * Page-side instrumentation is minimal: MutationObserver for live DOM
 * updates, console interceptor, and animation scanning when that panel
 * is open.  No monkey-patching of Promise, EventTarget, setTimeout, etc.
 */

import { spawn } from "child_process";
import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";
import {
  TraceMap,
  generatedPositionFor,
  originalPositionFor,
} from "@jridgewell/trace-mapping";
import { assessDesktopCompatibility } from "./compatibility.js";
import { Logger } from "./logger.js";
import { formatDesktopStartError, runDesktopPreflight } from "./preflight.js";

const host = "localhost";
const port = Number(process.env.DESKTOP_PORT || 9333);
const safariDriverPort = 9515;
const frontendUrl =
  process.env.FRONTEND_URL || "devtools://devtools/bundled/inspector.html";
const targetId = "desktop-safari";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const fixturesDir = path.join(repoRoot, "fixtures");
const fixtureMountPath = "/__fixtures";
const desktopStartUrl = process.env.DESKTOP_START_URL || "";
// SAFARI_DEV_WINDOW=1 keeps the automation window visible (useful for dev/testing).
// By default the window is moved off-screen since the user interacts via DevTools.
const showDevWindow = !!process.env.SAFARI_DEV_WINDOW;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── CDP stubs ───────────────────────────────────────────────────────

const STUB_METHODS = new Set([
  "Schema.getDomains",
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.setRemoteLocations",
  "Performance.enable",
  "Performance.disable",
  "Network.setAttachDebugStack",
  "Network.setBlockedURLs",
  "Network.emulateNetworkConditionsByRule",
  "Network.overrideNetworkState",
  "Network.clearAcceptedEncodingsOverride",
  "Runtime.runIfWaitingForDebugger",
  "Runtime.addBinding",
  "DOM.setInspectedNode",
  "CSS.trackComputedStyleUpdates",
  "CSS.takeComputedStyleUpdates",
  "CSS.trackComputedStyleUpdatesForNode",
  "Log.enable",
  "Log.startViolationsReport",
  "Accessibility.enable",
  "Autofill.enable",
  "Autofill.setAddresses",
  "Emulation.setEmulatedMedia",
  "Emulation.setEmulatedVisionDeficiency",
  "Emulation.setFocusEmulationEnabled",
  "Audits.enable",
  "ServiceWorker.enable",
  "Inspector.enable",
  "DOMDebugger.setBreakOnCSPViolation",
  "Page.setAdBlockingEnabled",
  "Page.startScreencast",
  "Page.addScriptToEvaluateOnNewDocument",
  "Debugger.setAsyncCallStackDepth",
  "Debugger.setBlackboxPatterns",
  "Debugger.setPauseOnExceptions",
  "Profiler.enable",
  "Runtime.releaseObject",
  "Runtime.releaseObjectGroup",
]);

// ── Page-side instrumentation (lightweight) ─────────────────────────

/**
 * Installed once after each navigation.  Provides:
 *   - Console interception → __cdt.consoleEvents
 *   - MutationObserver     → __cdt.domDirty flag
 *   - Highlight overlay    → __cdt.highlight(path) / __cdt.hideHighlight()
 *   - Animation scanning   → __cdt.animScan() etc (only when enabled)
 */
const PAGE_BRIDGE_JS = `
(() => {
  if (window.__cdt) return;
  const cdt = window.__cdt = {
    consoleEvents: [],
    domDirty: false,
    animEnabled: false,
    animRate: 1, animNextId: 1, animIds: new WeakMap(),
    animPrev: {}, animLive: {}, animEvents: [],
  };

  /* ── Console interception ─────────────────────────────── */
  const origConsole = {};
  for (const level of ["log","info","warn","error","debug"]) {
    const orig = console[level]?.bind(console);
    if (!orig) continue;
    origConsole[level] = orig;
    console[level] = (...args) => {
      cdt.consoleEvents.push({
        level,
        text: args.map(a => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } }).join(" "),
        args: args.map(a => {
          if (a === null) return { type: "object", subtype: "null", value: null };
          if (a === undefined) return { type: "undefined" };
          const t = typeof a;
          if (t === "object") return { type: "object", description: Array.isArray(a) ? "Array("+a.length+")" : a?.constructor?.name || "Object" };
          return { type: t, value: a, description: String(a) };
        }),
        timestamp: Date.now(),
      });
      return orig(...args);
    };
  }
  window.addEventListener("error", e => {
    cdt.consoleEvents.push({ level: "error", text: e.message || String(e), args: [{ type: "string", value: e.message || "" }], timestamp: Date.now(), exception: true, url: e.filename, line: e.lineno, col: e.colno, stack: e.error?.stack || "" });
  });
  window.addEventListener("unhandledrejection", e => {
    cdt.consoleEvents.push({ level: "error", text: e.reason?.message || String(e.reason), args: [{ type: "string", value: e.reason?.message || "" }], timestamp: Date.now(), exception: true, stack: e.reason?.stack || "" });
  });

  /* ── Network interception ───────────────────────────────── */
  cdt.networkEvents = [];
  cdt.nextReqId = 1;
  const origFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const req = new Request(...args);
    const rid = String(cdt.nextReqId++);
    const hdrs = {}; for (const [k,v] of req.headers.entries()) hdrs[k] = v;
    cdt.networkEvents.push({ kind:"request", requestId:rid, url:req.url, method:req.method, headers:hdrs, resourceType:"Fetch" });
    try {
      const resp = await origFetch(...args);
      const clone = resp.clone(); let body = ""; try { body = await clone.text(); } catch {}
      const rh = {}; for (const [k,v] of resp.headers.entries()) rh[k] = v;
      cdt.networkEvents.push({ kind:"response", requestId:rid, url:resp.url||req.url, status:resp.status, statusText:resp.statusText, headers:rh, mimeType:rh["content-type"]||"", body, encodedDataLength:body.length, resourceType:"Fetch" });
      cdt.networkEvents.push({ kind:"finished", requestId:rid, encodedDataLength:body.length });
      return resp;
    } catch (e) {
      cdt.networkEvents.push({ kind:"failed", requestId:rid, errorText:String(e) });
      throw e;
    }
  };
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHdr = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(method, url) {
    this.__cdt = { requestId: String(cdt.nextReqId++), method, url: new URL(url, location.href).href, headers: {} };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
    if (this.__cdt) this.__cdt.headers[k] = v;
    return origSetHdr.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const m = this.__cdt || { requestId: String(cdt.nextReqId++), method:"GET", url:location.href, headers:{} };
    cdt.networkEvents.push({ kind:"request", ...m, postData: typeof body === "string" ? body : null, resourceType:"XHR" });
    this.addEventListener("loadend", () => {
      const rh = {}; for (const line of (this.getAllResponseHeaders()||"").trim().split(/[\\r\\n]+/).filter(Boolean)) { const p = line.split(": "); rh[p.shift()] = p.join(": "); }
      const rb = typeof this.responseText === "string" ? this.responseText : "";
      cdt.networkEvents.push({ kind:"response", requestId:m.requestId, url:this.responseURL||m.url, status:this.status, statusText:this.statusText, headers:rh, mimeType:this.getResponseHeader("content-type")||"", body:rb, encodedDataLength:rb.length, resourceType:"XHR" });
      cdt.networkEvents.push(this.status > 0 ? { kind:"finished", requestId:m.requestId, encodedDataLength:rb.length } : { kind:"failed", requestId:m.requestId, errorText:"XHR failed" });
    }, { once: true });
    return origSend.apply(this, arguments);
  };

  /* ── DOM mutation tracking ────────────────────────────── */
  const mo = new MutationObserver(() => { cdt.domDirty = true; });
  mo.observe(document, { childList: true, subtree: true, attributes: true, characterData: true });

  /* ── Highlight overlay ────────────────────────────────── */
  let hlEl = null;
  cdt.highlight = (path) => {
    let node = document;
    for (const i of (path || [])) node = node?.childNodes?.[i];
    if (!node?.getBoundingClientRect) { cdt.hideHighlight(); return; }
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
  };
  cdt.hideHighlight = () => { if (hlEl) hlEl.style.display = "none"; };

  /* ── Animation scanning ───────────────────────────────── */
  const animType = a => {
    const n = a?.constructor?.name || "";
    return n.includes("Transition") ? "CSSTransition" : n.includes("CSSAnimation") ? "CSSAnimation" : "WebAnimation";
  };
  const animId = a => { let i = cdt.animIds.get(a); if (!i) { i = "anim:" + cdt.animNextId++; cdt.animIds.set(a, i); } return i; };
  const animSnap = a => {
    const e = a?.effect, t = e?.getTiming?.() || {}, kf = e?.getKeyframes?.() || [];
    return {
      id: animId(a), name: a.animationName || a.transitionProperty || a.id || "animation",
      pausedState: a.playState === "paused", playState: a.playState || "idle",
      playbackRate: typeof a.playbackRate === "number" ? a.playbackRate : cdt.animRate,
      startTime: a.startTime, currentTime: a.currentTime, type: animType(a), cssId: "",
      source: {
        delay: Number(t.delay||0), endDelay: Number(t.endDelay||0),
        duration: typeof t.duration === "number" ? t.duration : 0,
        iterations: Number.isFinite(Number(t.iterations)) ? Number(t.iterations) : null,
        iterationStart: Number(t.iterationStart||0), direction: t.direction||"normal",
        fill: t.fill||"none", easing: t.easing||"linear", backendNodeId: 0,
        keyframesRule: {
          name: a.animationName || a.transitionProperty || "animation",
          keyframes: kf.map(k => ({ offset: typeof k.offset === "number" ? Math.round(k.offset*100)+"%" : "0%", easing: k.easing||"linear" })),
        },
      },
    };
  };
  cdt.animScan = () => {
    let anims = [];
    try { anims = document.getAnimations({ subtree: true }); } catch { try { anims = document.getAnimations(); } catch {} }
    const cur = {}, seen = new Set();
    for (const a of anims) {
      if (a.playbackRate !== cdt.animRate) try { a.playbackRate = cdt.animRate; } catch {}
      const sn = animSnap(a); seen.add(sn.id); cur[sn.id] = JSON.stringify(sn); cdt.animLive[sn.id] = a;
      if (!cdt.animPrev[sn.id]) {
        cdt.animEvents.push({ kind: "created", id: sn.id });
        cdt.animEvents.push({ kind: "started", animation: sn });
      } else if (cdt.animPrev[sn.id] !== cur[sn.id]) {
        cdt.animEvents.push({ kind: "updated", animation: sn });
      }
    }
    for (const id of Object.keys(cdt.animPrev)) {
      if (!seen.has(id)) { cdt.animEvents.push({ kind: "canceled", id }); delete cdt.animLive[id]; }
    }
    cdt.animPrev = cur;
  };
  cdt.animDrain = () => { cdt.animScan(); const ev = cdt.animEvents.slice(); cdt.animEvents.length = 0; return ev; };
  cdt.animGet = id => { cdt.animScan(); return cdt.animPrev[id] ? JSON.parse(cdt.animPrev[id]) : null; };
})();
`;

// ── SafariDriver + BiDi Driver ──────────────────────────────────────

class SafariBidiDriver {
  constructor(logger) {
    this.logger = logger;
    this.sdProcess = null;
    this.sessionId = null;
    this.contextId = null;
    this.bidiWs = null;
    this.pendingCommands = new Map();
    this.nextId = 1;
    this.onEvent = null;
    this.currentUrl = "";
    this.currentTitle = "";
  }

  async #killPort(p) {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFileCb);
    try {
      const { stdout } = await execFileAsync("lsof", ["-iTCP:" + p, "-P", "-t"], { timeout: 3000 });
      for (const pid of [...new Set(stdout.trim().split("\n").filter(Boolean))]) {
        try { process.kill(Number(pid), "SIGKILL"); } catch {}
      }
    } catch {}
    // Also kill safaridriver by name
    try { await execFileAsync("pkill", ["-9", "-f", "safaridriver"], { timeout: 3000 }); } catch {}
  }

  async start() {
    await this.#killPort(safariDriverPort);
    await delay(1000);

    this.logger.info("Starting safaridriver...");
    this.sdProcess = spawn("safaridriver", ["--port", String(safariDriverPort)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.sdProcess.stderr?.on("data", (d) =>
      this.logger.debug("safaridriver:", d.toString().trim()),
    );

    // Wait for safaridriver to be ready (it spawns a child process)
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await delay(500);
      try {
        const resp = await fetch(`http://localhost:${safariDriverPort}/status`);
        const data = await resp.json();
        if (data?.value?.ready) { ready = true; break; }
      } catch {}
    }
    if (!ready) throw new Error("safaridriver did not become ready within 10s");

    this.logger.info("Creating WebDriver session with BiDi...");
    const response = await fetch(
      `http://localhost:${safariDriverPort}/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capabilities: {
            alwaysMatch: {
              browserName: "safari",
              webSocketUrl: true,
              "safari:experimentalWebSocketUrl": true,
            },
          },
        }),
      },
    );
    const data = await response.json();
    if (!data?.value?.sessionId) {
      throw new Error(`Session creation failed: ${JSON.stringify(data)}`);
    }
    this.sessionId = data.value.sessionId;
    const wsUrl = data.value.capabilities?.webSocketUrl;
    if (!wsUrl) throw new Error("No BiDi WebSocket URL");
    this.logger.info(`Session ${this.sessionId}`);
    this.logger.info(`BiDi WS: ${wsUrl}`);

    this.bidiWs = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      this.bidiWs.once("open", resolve);
      this.bidiWs.once("error", reject);
    });
    this.bidiWs.on("message", (raw) => this.#handleMessage(raw));
    this.bidiWs.on("close", () => this.logger.warn("BiDi WS closed"));

    const tree = await this.send("browsingContext.getTree", {});
    this.contextId = tree?.contexts?.[0]?.context;
    if (!this.contextId) throw new Error("No browsing context");
    this.logger.info(`Context: ${this.contextId}`);

    await this.send("session.subscribe", {
      events: [
        "log.entryAdded",
        "network.beforeRequestSent",
        "network.responseStarted",
        "network.responseCompleted",
        "network.fetchError",
        "browsingContext.domContentLoaded",
        "browsingContext.load",
        "browsingContext.navigationStarted",
      ],
    });
    this.logger.info("BiDi subscriptions active");

    // Move automation window off-screen unless SAFARI_DEV_WINDOW=1
    if (!showDevWindow) {
      try {
        await this.exec("window.moveTo(-10000, -10000);");
      } catch {}
    }
  }

  async stop() {
    try {
      if (this.sessionId) {
        await fetch(`http://localhost:${safariDriverPort}/session/${this.sessionId}`, { method: "DELETE" }).catch(() => {});
      }
    } catch {}
    this.bidiWs?.close();
    this.sdProcess?.kill();
    await delay(300);
    await this.#killPort(safariDriverPort);
    this.sdProcess = null;
    this.sessionId = null;
  }

  get connected() {
    return !!this.bidiWs && this.bidiWs.readyState === WebSocket.OPEN;
  }

  async send(method, params) {
    if (!this.connected) throw new Error("BiDi not connected");
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15000);
      this.pendingCommands.set(id, { resolve, reject, timer });
      this.bidiWs.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Execute JS via WebDriver HTTP — reliable for return values and large payloads. */
  async exec(script) {
    const response = await fetch(
      `http://localhost:${safariDriverPort}/session/${this.sessionId}/execute/sync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, args: [] }),
      },
    );
    const data = await response.json();
    return data?.value;
  }

  async navigate(url) {
    await this.send("browsingContext.navigate", {
      context: this.contextId,
      url,
      wait: "complete",
    });
    this.currentUrl = url;
  }

  #handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id !== undefined && msg.type !== "event") {
      const pending = this.pendingCommands.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCommands.delete(msg.id);
        if (msg.type === "error" || msg.error) {
          pending.reject(new Error(msg.error?.message || JSON.stringify(msg)));
        } else {
          pending.resolve(msg.result ?? msg);
        }
      }
      return;
    }
    if (msg.type === "event") {
      // Track URL/title
      if (msg.method === "browsingContext.load") {
        this.currentUrl = msg.params?.url || this.currentUrl;
      }
      if (msg.method === "browsingContext.navigationStarted") {
        this.currentUrl = msg.params?.url || this.currentUrl;
      }
      this.onEvent?.(msg.method, msg.params);
    }
  }
}

// ── Server ─────────────────────────────────────────────────────────

class DesktopSafariServer {
  constructor(logger) {
    this.logger = logger.scope("desktop");
    this.driver = new SafariBidiDriver(this.logger);
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.clients = new Set();
    this.isStopping = false;

    // State
    this.lastSnapshot = null;
    this.networkRequests = new Map();
    this.nextNetworkId = 1;
    this.animationEnabled = false;
    this.tracingActive = false;
    this.debuggerEnabled = false;
    this.scriptCache = new Map();
    this.resourceCache = new Map();
    this.nextScriptId = 1;
    this.scriptIdsByKey = new Map();
    this.pollTimer = null;
    this.bridgeInstalled = false;
  }

  async start() {
    this.driver.onEvent = (m, p) => this.#handleBidiEvent(m, p);
    await this.driver.start();
    this.#setupRoutes();
    this.#setupWs();
    await new Promise((resolve, reject) => {
      this.httpServer.listen(port, host, () => resolve());
      this.httpServer.on("error", reject);
    });

    const startUrl =
      desktopStartUrl ||
      `http://${host}:${port}${fixtureMountPath}/animation.html`;
    this.logger.info(`Navigating to ${startUrl}`);
    try {
      await this.driver.navigate(startUrl);
      await this.#installBridge();
      await this.#refreshSnapshot();
    } catch (e) {
      this.logger.warn("Start navigation:", e?.message);
    }

    // Poll for console events + DOM mutations + animations (lightweight, 500ms)
    this.pollTimer = setInterval(() => this.#poll(), 500);

    this.logger.info(`desktop safari bridge listening on http://${host}:${port}`);
  }

  async stop() {
    this.isStopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.driver.stop();
    await new Promise((r) => this.wss.close(() => r()));
    await new Promise((r) => this.httpServer.close(() => r()));
  }

  // ── Install page bridge ─────────────────────────────────────────

  async #installBridge() {
    try {
      await this.driver.exec(PAGE_BRIDGE_JS);
      this.bridgeInstalled = true;
    } catch (e) {
      this.logger.debug("Bridge install failed:", e?.message);
    }
  }

  // ── Lightweight poll (console + DOM dirty + animations) ──────────

  async #poll() {
    if (!this.clients.size || !this.driver.connected) return;
    try {
      // Drain console events
      const consoleEvents = await this.driver.exec(`
        const cdt = window.__cdt;
        if (!cdt) return [];
        const ev = cdt.consoleEvents.slice();
        cdt.consoleEvents.length = 0;
        return ev;
      `);
      if (Array.isArray(consoleEvents)) {
        for (const e of consoleEvents) this.#emitConsoleEvent(e);
      }

      // Drain network events
      const networkEvents = await this.driver.exec(`
        const cdt = window.__cdt;
        if (!cdt) return [];
        const ev = cdt.networkEvents.slice();
        cdt.networkEvents.length = 0;
        return ev;
      `);
      if (Array.isArray(networkEvents)) {
        for (const e of networkEvents) this.#emitNetworkEvent(e);
      }

      // Check DOM dirty flag
      const domDirty = await this.driver.exec(`
        const cdt = window.__cdt;
        if (!cdt) return false;
        const dirty = cdt.domDirty;
        cdt.domDirty = false;
        return dirty;
      `);
      if (domDirty) {
        await this.#refreshSnapshot();
        this.#broadcast({
          method: "DOM.documentUpdated",
          params: {},
        });
      }

      // Animations
      if (this.animationEnabled) {
        const animEvents = await this.driver.exec(`
          const cdt = window.__cdt;
          if (!cdt?.animDrain) return [];
          return cdt.animDrain();
        `);
        if (Array.isArray(animEvents)) {
          for (const ev of animEvents) this.#emitAnimationEvent(ev);
        }
      }
    } catch (e) {
      if (!this.bridgeInstalled || e?.message?.includes("timed out")) {
        try { await this.#installBridge(); } catch {}
      }
    }
  }

  #emitConsoleEvent(e) {
    const level = e.level === "warn" ? "warning" : e.level || "log";
    this.#broadcast({
      method: "Runtime.consoleAPICalled",
      params: {
        type: e.level === "warn" ? "warning" : e.level || "log",
        args: e.args || [{ type: "string", value: e.text || "" }],
        executionContextId: 1,
        timestamp: e.timestamp || Date.now(),
        stackTrace: { callFrames: [] },
      },
    });
    if (e.exception) {
      this.#broadcast({
        method: "Runtime.exceptionThrown",
        params: {
          timestamp: e.timestamp || Date.now(),
          exceptionDetails: {
            exceptionId: Date.now(),
            text: e.text || "Error",
            lineNumber: e.line || 0,
            columnNumber: e.col || 0,
            url: e.url || this.driver.currentUrl,
            stackTrace: { callFrames: [] },
            exception: { type: "object", subtype: "error", description: e.stack || e.text || "" },
          },
        },
      });
    }
    this.#broadcast({
      method: "Log.entryAdded",
      params: {
        entry: {
          source: "javascript",
          level,
          text: e.text || "",
          timestamp: e.timestamp || Date.now(),
          url: e.url || this.driver.currentUrl,
        },
      },
    });
  }

  #emitAnimationEvent(ev) {
    if (ev.kind === "created") {
      this.#broadcast({ method: "Animation.animationCreated", params: { id: ev.id } });
    } else if (ev.kind === "canceled") {
      this.#broadcast({ method: "Animation.animationCanceled", params: { id: ev.id } });
    } else if (ev.kind === "started" || ev.kind === "updated") {
      const a = ev.animation;
      if (a) {
        this.#broadcast({
          method: ev.kind === "started" ? "Animation.animationStarted" : "Animation.animationUpdated",
          params: { animation: a },
        });
      }
    }
  }

  #emitNetworkEvent(e) {
    const ts = Date.now() / 1000;
    if (e.kind === "request") {
      this.#broadcast({
        method: "Network.requestWillBeSent",
        params: {
          requestId: e.requestId, loaderId: "root", documentURL: this.driver.currentUrl,
          request: { url: e.url, method: e.method, headers: e.headers || {}, postData: e.postData, mixedContentType: "none", initialPriority: "High" },
          timestamp: ts, wallTime: ts, initiator: { type: "other" }, type: e.resourceType || "Fetch", frameId: "main",
        },
      });
    } else if (e.kind === "response") {
      this.networkBodies = this.networkBodies || new Map();
      this.networkBodies.set(e.requestId, { body: e.body || "", base64Encoded: false });
      this.#broadcast({
        method: "Network.responseReceived",
        params: {
          requestId: e.requestId, loaderId: "root", timestamp: ts, type: e.resourceType || "Fetch",
          response: { url: e.url, status: e.status, statusText: e.statusText, headers: e.headers || {}, mimeType: e.mimeType || "", encodedDataLength: e.encodedDataLength || 0, securityState: (e.url || "").startsWith("https:") ? "secure" : "insecure" },
          frameId: "main",
        },
      });
    } else if (e.kind === "finished") {
      this.#broadcast({ method: "Network.loadingFinished", params: { requestId: e.requestId, timestamp: ts, encodedDataLength: e.encodedDataLength || 0 } });
    } else if (e.kind === "failed") {
      this.#broadcast({ method: "Network.loadingFailed", params: { requestId: e.requestId, timestamp: ts, type: "Fetch", errorText: e.errorText || "Failed" } });
    }
  }

  // ── HTTP routes ─────────────────────────────────────────────────

  #setupRoutes() {
    this.app.use(fixtureMountPath, express.static(fixturesDir));

    this.app.get("/json/version", (_req, res) => {
      res.json({
        Browser: "Safari/26.4",
        "Protocol-Version": "1.3",
        "User-Agent": "Safari Desktop Bridge",
        "V8-Version": "0.0",
        "WebKit-Version": "Safari 26.4",
      });
    });

    this.app.get("/json/list", (_req, res) => {
      const url = this.lastSnapshot?.url || this.driver.currentUrl || "about:blank";
      const title = this.lastSnapshot?.title || this.driver.currentTitle || "Desktop Safari";
      res.json([{
        id: targetId, title, type: "page", url,
        devtoolsFrontendUrl: `${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`,
        webSocketDebuggerUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
      }]);
    });

    this.app.get("/json", (_req, res) => res.redirect("/json/list"));
    this.app.get("/__bridge/status", (_req, res) => {
      res.json({ connected: this.driver.connected, url: this.driver.currentUrl, title: this.driver.currentTitle });
    });
    this.app.get("/__bridge/navigate", async (req, res) => {
      const url = String(req.query.url || "");
      if (!url) return res.status(400).json({ error: "Missing url" });
      try {
        await this.driver.navigate(url);
        await this.#installBridge();
        await this.#refreshSnapshot();
        res.json({ ok: true, url: this.driver.currentUrl });
      } catch (error) {
        res.status(500).json({ ok: false, error: error?.message });
      }
    });
  }

  // ── WebSocket ───────────────────────────────────────────────────

  #setupWs() {
    this.wss.on("connection", (socket) => {
      this.clients.add(socket);
      socket.on("close", () => this.clients.delete(socket));
      socket.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.logger.debug("cdp <-", msg.method);
          const response = await this.#handleMessage(socket, msg);
          if (response) socket.send(JSON.stringify(response));
        } catch (error) {
          this.logger.error("ws error", error?.message);
        }
      });
    });
  }

  #broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const c of this.clients) {
      if (c.readyState === 1) c.send(data);
    }
  }

  // ── BiDi events ─────────────────────────────────────────────────

  #handleBidiEvent(method, params) {
    if (!this.clients.size) return;

    // Network events
    if (method === "network.beforeRequestSent") {
      const req = params?.request;
      if (!req) return;
      const requestId = req.request || `req-${this.nextNetworkId++}`;
      this.networkRequests.set(requestId, req);
      this.#broadcast({
        method: "Network.requestWillBeSent",
        params: {
          requestId, loaderId: "root", documentURL: this.driver.currentUrl,
          request: {
            url: req.url, method: req.method,
            headers: this.#bidiHeaders(req.headers),
            mixedContentType: "none", initialPriority: "High",
          },
          timestamp: (params.timestamp || Date.now()) / 1000,
          wallTime: Date.now() / 1000,
          initiator: { type: "other" },
          type: "Fetch", frameId: "main",
        },
      });
      return;
    }
    if (method === "network.responseCompleted") {
      const resp = params?.response;
      const req = params?.request;
      if (!resp) return;
      const requestId = req?.request || `req-${this.nextNetworkId++}`;
      const headers = this.#bidiHeaders(resp.headers);
      this.#broadcast({
        method: "Network.responseReceived",
        params: {
          requestId, loaderId: "root",
          timestamp: (params.timestamp || Date.now()) / 1000,
          type: "Fetch",
          response: {
            url: resp.url || req?.url || "", status: resp.status || 200,
            statusText: resp.statusText || "", headers,
            mimeType: headers["content-type"] || "",
            encodedDataLength: resp.bytesReceived || 0,
            securityState: (resp.url || "").startsWith("https:") ? "secure" : "insecure",
          },
          frameId: "main",
        },
      });
      this.#broadcast({
        method: "Network.loadingFinished",
        params: { requestId, timestamp: (params.timestamp || Date.now()) / 1000, encodedDataLength: resp.bytesReceived || 0 },
      });
      return;
    }
    if (method === "network.fetchError") {
      this.#broadcast({
        method: "Network.loadingFailed",
        params: {
          requestId: params?.request?.request || `req-${this.nextNetworkId++}`,
          timestamp: (params?.timestamp || Date.now()) / 1000,
          type: "Fetch", errorText: params?.errorText || "Failed",
        },
      });
      return;
    }

    // Page lifecycle
    if (method === "browsingContext.domContentLoaded") {
      this.#broadcast({ method: "Page.domContentEventFired", params: { timestamp: (params?.timestamp || Date.now()) / 1000 } });
      return;
    }
    if (method === "browsingContext.load") {
      this.driver.currentUrl = params?.url || this.driver.currentUrl;
      this.#broadcast({ method: "Page.loadEventFired", params: { timestamp: (params?.timestamp || Date.now()) / 1000 } });
      // Re-install bridge after navigation
      this.#installBridge().catch(() => {});
      return;
    }
    if (method === "browsingContext.navigationStarted") {
      this.driver.currentUrl = params?.url || this.driver.currentUrl;
      this.#broadcast({
        method: "Page.frameNavigated",
        params: {
          frame: { id: "main", loaderId: `loader-${Date.now()}`, url: params?.url || "", securityOrigin: "", mimeType: "text/html" },
          type: "Navigation",
        },
      });
      return;
    }

    // Log events from BiDi (backup)
    if (method === "log.entryAdded") {
      // These are handled by our page-side interceptor for reliability
      // Only forward BiDi log events that aren't from console API
      if (params?.type !== "console") {
        this.#emitConsoleEvent({
          level: params?.level || "info",
          text: params?.text || "",
          args: [{ type: "string", value: params?.text || "" }],
          timestamp: params?.timestamp || Date.now(),
        });
      }
    }
  }

  #bidiHeaders(headers) {
    const obj = {};
    if (Array.isArray(headers)) {
      for (const h of headers) obj[h.name] = h.value?.value || h.value || "";
    }
    return obj;
  }

  // ── CDP command handler ─────────────────────────────────────────

  async #handleMessage(socket, message) {
    const { id, method, params = {} } = message;

    if (STUB_METHODS.has(method)) return { id, result: {} };

    switch (method) {
      case "Browser.getVersion":
        return { id, result: { product: "Safari/26.4", revision: "desktop", userAgent: "Safari Desktop Bridge", jsVersion: "0.0", protocolVersion: "1.3" } };

      // ── Domain enables ──
      case "Page.enable":
        this.#broadcastLifecycle(socket);
        return { id, result: {} };

      case "Runtime.enable":
        socket.send(JSON.stringify({
          method: "Runtime.executionContextCreated",
          params: {
            context: { id: 1, origin: this.driver.currentUrl ? new URL(this.driver.currentUrl).origin : "", name: "top", uniqueId: "ctx", auxData: { isDefault: true, type: "default", frameId: "main" } },
          },
        }));
        return { id, result: {} };

      case "DOM.enable":
      case "CSS.enable":
      case "Network.enable":
      case "Network.disable":
      case "Overlay.enable":
        return { id, result: {} };

      case "Debugger.enable":
        this.debuggerEnabled = true;
        await this.#refreshScripts();
        this.#broadcastScripts();
        return { id, result: { debuggerId: "desktop-debugger" } };

      // ── DOM ──
      case "DOM.getDocument": {
        await this.#refreshSnapshot();
        return { id, result: { root: this.lastSnapshot?.root || {} } };
      }
      case "DOM.requestChildNodes": {
        const node = this.lastSnapshot?.nodes?.get(params.nodeId);
        if (node?.children?.length) {
          socket.send(JSON.stringify({ method: "DOM.setChildNodes", params: { parentId: params.nodeId, nodes: node.children } }));
        }
        return { id, result: {} };
      }
      case "DOM.describeNode":
        return { id, result: { node: this.lastSnapshot?.nodes?.get(params.nodeId || params.backendNodeId) || {} } };
      case "DOM.resolveNode": {
        const node = this.lastSnapshot?.nodes?.get(params.nodeId);
        return { id, result: { object: { type: "object", subtype: "node", className: node?.nodeName || "Node", description: node?.nodeName || "Node", objectId: `node:${params.nodeId}` } } };
      }
      case "DOM.pushNodesByBackendIdsToFrontend":
        return { id, result: { nodeIds: (params.backendNodeIds || []) } };
      case "DOM.getOuterHTML": {
        const node = this.lastSnapshot?.nodes?.get(params.nodeId);
        if (!node?.backendPath) return { id, result: { outerHTML: "" } };
        try {
          const html = await this.driver.exec(`
            const path = ${JSON.stringify(node.backendPath)};
            let c = document; for (const i of path) c = c?.childNodes?.[i];
            return c?.outerHTML ?? c?.nodeValue ?? "";
          `);
          return { id, result: { outerHTML: html || "" } };
        } catch { return { id, result: { outerHTML: "" } }; }
      }
      case "DOM.getBoxModel": {
        const node = this.lastSnapshot?.nodes?.get(params.nodeId);
        if (!node?.backendPath) return { id, result: {} };
        try {
          const rect = await this.driver.exec(`
            const path = ${JSON.stringify(node.backendPath)};
            let c = document; for (const i of path) c = c?.childNodes?.[i];
            if (!c?.getBoundingClientRect) return null;
            const r = c.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          `);
          if (!rect) return { id, result: {} };
          const { x, y, width, height } = rect;
          const q = [x, y, x + width, y, x + width, y + height, x, y + height];
          return { id, result: { model: { content: q, padding: q, border: q, margin: q, width, height } } };
        } catch { return { id, result: {} }; }
      }

      // ── CSS ──
      case "CSS.getComputedStyleForNode": {
        const node = this.lastSnapshot?.nodes?.get(params.nodeId);
        if (!node?.backendPath) return { id, result: { computedStyle: [] } };
        try {
          const style = await this.driver.exec(`
            const path = ${JSON.stringify(node.backendPath)};
            let c = document; for (const i of path) c = c?.childNodes?.[i];
            if (!c || c.nodeType !== 1) return [];
            const s = getComputedStyle(c);
            return Array.from(s).map(n => ({ name: n, value: s.getPropertyValue(n) }));
          `);
          return { id, result: { computedStyle: style || [] } };
        } catch { return { id, result: { computedStyle: [] } }; }
      }
      case "CSS.getMatchedStylesForNode":
        return { id, result: { inlineStyle: { cssProperties: [], shorthandEntries: [] }, attributesStyle: { cssProperties: [], shorthandEntries: [] }, matchedCSSRules: [], inherited: [], pseudoElements: [], cssKeyframesRules: [], parentLayoutNodeId: params.nodeId } };
      case "CSS.getAnimatedStylesForNode":
        return { id, result: { animationStyles: [], transitionsStyle: { cssProperties: [], shorthandEntries: [] } } };
      case "CSS.getPlatformFontsForNode":
        return { id, result: { fonts: [] } };
      case "CSS.getEnvironmentVariables":
        return { id, result: { variables: [] } };
      case "CSS.getInlineStylesForNode":
        return { id, result: { inlineStyle: { cssProperties: [], shorthandEntries: [] }, attributesStyle: { cssProperties: [], shorthandEntries: [] } } };

      // ── Overlay (highlighting) ──
      case "Overlay.highlightNode": {
        const nodeId = params.nodeId || params.backendNodeId;
        const node = this.lastSnapshot?.nodes?.get(nodeId);
        if (node?.backendPath) {
          this.driver.exec(`window.__cdt?.highlight?.(${JSON.stringify(node.backendPath)})`).catch(() => {});
        }
        return { id, result: {} };
      }
      case "Overlay.hideHighlight":
        this.driver.exec("window.__cdt?.hideHighlight?.()").catch(() => {});
        return { id, result: {} };
      case "Overlay.setShowViewportSizeOnResize":
      case "Overlay.setShowGridOverlays":
      case "Overlay.setShowFlexOverlays":
      case "Overlay.setShowScrollSnapOverlays":
      case "Overlay.setShowContainerQueryOverlays":
      case "Overlay.setShowIsolatedElements":
        return { id, result: {} };

      // ── Runtime ──
      case "Runtime.evaluate": {
        try {
          // Use WebDriver HTTP for reliable return values
          const value = await this.driver.exec(`return eval(${JSON.stringify(params.expression)})`);
          return { id, result: { result: this.#toRemoteObject(value) } };
        } catch (error) {
          return { id, result: { result: { type: "object", subtype: "error", description: error.message, className: "Error" }, exceptionDetails: { exceptionId: 1, text: error.message, lineNumber: 0, columnNumber: 0, exception: { type: "object", subtype: "error", description: error.message } } } };
        }
      }
      case "Runtime.callFunctionOn":
        return { id, result: { result: { type: "undefined" } } };
      case "Runtime.getProperties":
        return { id, result: { result: [] } };

      // ── Network ──
      case "Network.getResponseBody": {
        const cached = this.networkBodies?.get(params.requestId);
        return { id, result: cached || { body: "", base64Encoded: false } };
      }

      // ── Page ──
      case "Page.navigate": {
        try {
          await this.driver.navigate(params.url);
          await this.#installBridge();
          await this.#refreshSnapshot();
          return { id, result: { frameId: "main", loaderId: `loader-${Date.now()}`, url: params.url } };
        } catch (error) {
          return { id, error: { code: -32000, message: error.message } };
        }
      }
      case "Page.reload": {
        try {
          await this.driver.send("browsingContext.reload", { context: this.driver.contextId, wait: "complete" });
          await this.#installBridge();
          await this.#refreshSnapshot();
        } catch {}
        return { id, result: {} };
      }
      case "Page.getNavigationHistory":
        return { id, result: { currentIndex: 0, entries: [{ id: 0, url: this.driver.currentUrl, userTypedURL: this.driver.currentUrl, title: this.lastSnapshot?.title || "", transitionType: "typed" }] } };
      case "Page.getResourceTree": {
        await this.#refreshScripts();
        return { id, result: { frameTree: { frame: { id: "main", loaderId: "root", url: this.driver.currentUrl, domainAndRegistry: "", securityOrigin: this.driver.currentUrl ? new URL(this.driver.currentUrl).origin : "", mimeType: "text/html" }, resources: Array.from(this.scriptCache.values()).map(s => ({ url: s.url, type: "Script", mimeType: s.type, contentSize: s.source?.length || 0 })) } } };
      }
      case "Page.getResourceContent": {
        const cached = this.resourceCache.get(params.url);
        if (cached) return { id, result: { content: cached.content, base64Encoded: false } };
        try {
          const resp = await fetch(params.url);
          const content = await resp.text();
          this.resourceCache.set(params.url, { content, mimeType: resp.headers.get("content-type") || "" });
          return { id, result: { content, base64Encoded: false } };
        } catch { return { id, result: { content: "", base64Encoded: false } }; }
      }
      case "Page.getLayoutMetrics": {
        try {
          const v = await this.driver.exec("return {w:window.innerWidth,h:window.innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight}");
          const vp = { pageX: 0, pageY: 0, clientWidth: v?.w || 1280, clientHeight: v?.h || 720 };
          const vis = { ...vp, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 };
          return { id, result: { layoutViewport: vp, visualViewport: vis, contentSize: { x: 0, y: 0, width: v?.sw || 1280, height: v?.sh || 720 }, cssLayoutViewport: vp, cssVisualViewport: vis, cssContentSize: { x: 0, y: 0, width: v?.sw || 1280, height: v?.sh || 720 } } };
        } catch { const vp = { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 }; return { id, result: { layoutViewport: vp, visualViewport: { ...vp, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 }, contentSize: { x: 0, y: 0, width: 1280, height: 720 }, cssLayoutViewport: vp, cssVisualViewport: { ...vp, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 }, cssContentSize: { x: 0, y: 0, width: 1280, height: 720 } } }; }
      }

      // ── Debugger ──
      case "Debugger.getScriptSource":
        return { id, result: { scriptSource: this.scriptCache.get(params.scriptId)?.source || "" } };
      case "Debugger.getPossibleBreakpoints":
        return { id, result: { locations: [] } };
      case "Debugger.setBreakpointByUrl":
        return { id, result: { breakpointId: `bp-${Date.now()}`, locations: [] } };
      case "Debugger.removeBreakpoint":
      case "Debugger.setBreakpointsActive":
      case "Debugger.pause":
      case "Debugger.resume":
      case "Debugger.stepInto":
      case "Debugger.stepOver":
      case "Debugger.stepOut":
        return { id, result: {} };

      // ── Performance ──
      case "Performance.getMetrics": {
        try {
          const m = await this.driver.exec("return [{name:'Timestamp',value:Date.now()/1000},{name:'Documents',value:1},{name:'Nodes',value:document.getElementsByTagName('*').length}]");
          return { id, result: { metrics: m || [] } };
        } catch { return { id, result: { metrics: [] } }; }
      }

      // ── Tracing ──
      case "Tracing.start": this.tracingActive = true; return { id, result: {} };
      case "Tracing.end": this.tracingActive = false; this.#broadcast({ method: "Tracing.tracingComplete", params: { dataLossOccurred: false } }); return { id, result: {} };
      case "Tracing.getCategories": return { id, result: { categories: ["loading", "network", "devtools.timeline"] } };

      // ── Profiler ──
      case "Profiler.start":
      case "Profiler.stop":
        return { id, result: { profile: { nodes: [], startTime: 0, endTime: 0, samples: [], timeDeltas: [] } } };

      // ── Animation ──
      case "Animation.enable":
        this.animationEnabled = true;
        this.driver.exec("if(window.__cdt) window.__cdt.animEnabled = true; window.__cdt?.animScan?.()").catch(() => {});
        return { id, result: {} };
      case "Animation.disable":
        this.animationEnabled = false;
        this.driver.exec("if(window.__cdt) window.__cdt.animEnabled = false").catch(() => {});
        return { id, result: {} };
      case "Animation.getCurrentTime": {
        try {
          const sn = await this.driver.exec(`return window.__cdt?.animGet?.(${JSON.stringify(params.id)})`);
          return { id, result: { currentTime: Number(sn?.currentTime || 0) } };
        } catch { return { id, result: { currentTime: 0 } }; }
      }
      case "Animation.getPlaybackRate": {
        try {
          const r = await this.driver.exec("return window.__cdt?.animRate ?? 1");
          return { id, result: { playbackRate: Number(r || 1) } };
        } catch { return { id, result: { playbackRate: 1 } }; }
      }
      case "Animation.setPlaybackRate":
        this.driver.exec(`if(window.__cdt){window.__cdt.animRate=${Number(params.playbackRate)};window.__cdt.animScan?.()}`).catch(() => {});
        return { id, result: {} };
      case "Animation.seekAnimations": {
        const ids = JSON.stringify(params.animations || []);
        this.driver.exec(`{const c=window.__cdt;if(c){for(const id of ${ids}){const a=c.animLive[id];if(a)try{a.currentTime=${Number(params.currentTime||0)}}catch{}}c.animScan?.()}}`).catch(() => {});
        return { id, result: {} };
      }
      case "Animation.setPaused": {
        const ids = JSON.stringify(params.animations || []);
        const paused = !!params.paused;
        this.driver.exec(`{const c=window.__cdt;if(c){for(const id of ${ids}){const a=c.animLive[id];if(a)try{${paused ? "a.pause()" : "a.play();a.playbackRate=c.animRate"}}catch{}}c.animScan?.()}}`).catch(() => {});
        return { id, result: {} };
      }
      case "Animation.releaseAnimations":
      case "Animation.setTiming":
        return { id, result: {} };
      case "Animation.resolveAnimation":
        return { id, result: { remoteObject: { type: "object", className: "Animation", description: "Animation" } } };

      // ── Target ──
      case "Target.getTargets":
        return { id, result: { targetInfos: [{ targetId, type: "page", title: this.lastSnapshot?.title || "Desktop Safari", url: this.driver.currentUrl, attached: true }] } };

      // ── Storage ──
      case "Storage.getStorageKey":
        return { id, result: { storageKey: this.driver.currentUrl ? new URL(this.driver.currentUrl).origin : "" } };

      default:
        this.logger.debug(`unhandled: ${method}`);
        return { id, error: { code: -32601, message: `Not implemented: ${method}` } };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  #broadcastLifecycle(socket) {
    const url = this.driver.currentUrl || "";
    if (!url) return;
    const ts = Date.now() / 1000;
    for (const e of [
      { method: "Page.frameNavigated", params: { frame: { id: "main", loaderId: `loader-${Date.now()}`, url, securityOrigin: new URL(url).origin, mimeType: "text/html" }, type: "Navigation" } },
      { method: "Page.domContentEventFired", params: { timestamp: ts } },
      { method: "Page.loadEventFired", params: { timestamp: ts } },
    ]) {
      socket.send(JSON.stringify(e));
    }
  }

  async #refreshSnapshot() {
    try {
      const raw = await this.driver.exec(`
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
            base.documentURL = document.URL; base.baseURL = document.baseURI;
            base.xmlVersion = ""; base.compatibilityMode = document.compatMode;
          }
          if (node.nodeType === 1) base.frameId = "main";
          if (depth !== 0 && node.childNodes?.length) {
            base.children = Array.from(node.childNodes, (c, i) => visit(c, depth > 0 ? depth - 1 : depth));
          }
          return base;
        }
        return { root: visit(document, -1), url: document.URL, title: document.title };
      `);
      if (!raw?.root) return;
      const nodes = new Map();
      const index = (node, path) => {
        node.backendPath = path;
        nodes.set(node.nodeId, node);
        if (node.children) node.children.forEach((child, i) => index(child, [...path, i]));
      };
      index(raw.root, []);
      this.lastSnapshot = { root: raw.root, nodes, url: raw.url, title: raw.title };
      this.driver.currentUrl = raw.url || this.driver.currentUrl;
      this.driver.currentTitle = raw.title || this.driver.currentTitle;
    } catch (error) {
      this.logger.debug("snapshot failed:", error?.message);
    }
  }

  async #refreshScripts() {
    try {
      const scripts = await this.driver.exec(`
        return Array.from(document.scripts).map((s, i) => ({
          index: i, src: s.src || "", inline: !s.src,
          type: s.type || "", source: s.src ? "" : (s.textContent || ""),
        }));
      `);
      if (!Array.isArray(scripts)) return;
      const pageUrl = this.driver.currentUrl;
      const nextCache = new Map();
      for (const script of scripts) {
        const key = script.inline ? `inline:${pageUrl}:${script.index}` : `ext:${script.src}`;
        let scriptId = this.scriptIdsByKey.get(key);
        if (!scriptId) { scriptId = String(this.nextScriptId++); this.scriptIdsByKey.set(key, scriptId); }
        const url = script.inline ? `${pageUrl}#inline-script-${script.index + 1}` : script.src;
        let source = script.source;
        if (!script.inline && !this.resourceCache.has(url)) {
          try { const resp = await fetch(url); source = await resp.text(); this.resourceCache.set(url, { content: source, mimeType: "text/javascript" }); } catch { source = ""; }
        } else if (!script.inline) { source = this.resourceCache.get(url)?.content || ""; }
        nextCache.set(scriptId, { scriptId, url, source, type: script.type || "text/javascript", startLine: 0, endLine: source.split("\n").length, executionContextId: 1, hash: "", isModule: script.type === "module", sourceMapURL: this.#extractSourceMapURL(url, source) });
      }
      this.scriptCache = nextCache;
    } catch (error) { this.logger.debug("script refresh failed:", error?.message); }
  }

  #extractSourceMapURL(scriptUrl, source) {
    const match = /[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/m.exec(source || "");
    if (!match) return "";
    try { return new URL(match[1], scriptUrl).toString(); } catch { return match[1]; }
  }

  #broadcastScripts() {
    for (const s of this.scriptCache.values()) {
      this.#broadcast({
        method: "Debugger.scriptParsed",
        params: { scriptId: s.scriptId, url: s.url, startLine: s.startLine, startColumn: 0, endLine: s.endLine, endColumn: 0, executionContextId: s.executionContextId, hash: s.hash, isLiveEdit: false, sourceMapURL: s.sourceMapURL || undefined, hasSourceURL: false, isModule: s.isModule, length: s.source?.length || 0, scriptLanguage: "JavaScript", embedderName: s.url },
      });
    }
  }

  #toRemoteObject(value) {
    if (value === null) return { type: "object", subtype: "null", value: null, description: "null" };
    if (value === undefined) return { type: "undefined" };
    const t = typeof value;
    if (t === "object") return { type: "object", value, description: Array.isArray(value) ? `Array(${value.length})` : "Object", preview: { type: "object", overflow: false, properties: [] } };
    return { type: t, value, description: String(value) };
  }
}

// ── Entry point ────────────────────────────────────────────────────

export async function main() {
  const logger = new Logger();
  const server = new DesktopSafariServer(logger);
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`shutting down on ${signal}`);
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const preflight = await runDesktopPreflight({ bridgePort: port });
    if (preflight.safariVersion) logger.info(`Safari ${preflight.safariVersion}`);
    if (preflight.chromeVersion) logger.info(`Chrome ${preflight.chromeVersion}`);
    const compat = assessDesktopCompatibility(preflight);
    if (compat.status === "verified") logger.info(compat.summary);
    else { logger.warn(compat.summary); logger.warn(compat.notes); }

    await server.start();
    logger.info(`Open Chrome DevTools: ${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`);
    logger.info(`Fixture gallery: http://${host}:${port}${fixtureMountPath}/animation.html`);
    if (showDevWindow) logger.info("SAFARI_DEV_WINDOW=1: automation window visible for development");
    else logger.info("Safari automation window moved off-screen (set SAFARI_DEV_WINDOW=1 to show)");
  } catch (error) {
    logger.error(error?.message || String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
