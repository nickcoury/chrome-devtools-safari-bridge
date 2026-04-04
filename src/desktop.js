/**
 * Desktop Safari CDP bridge — Safari Web Extension transport.
 *
 * The Safari Web Extension injects a content script into pages that:
 *   1. Opens a WebSocket directly to this server at /__extension
 *   2. Pushes events (console, network, DOM mutations, animations) proactively
 *   3. Responds to commands (getSnapshot, getComputedStyle, highlight, etc.)
 *
 * This server translates Chrome DevTools Protocol (CDP) ↔ extension messages.
 * No safaridriver, no automation banner, no browser lock-up.
 */

import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";
import { assessDesktopCompatibility } from "./compatibility.js";
import { Logger } from "./logger.js";
import { formatDesktopStartError, runDesktopPreflight } from "./preflight.js";

const host = "localhost";
const port = Number(process.env.DESKTOP_PORT || 9333);
const frontendUrl =
  process.env.FRONTEND_URL || "devtools://devtools/bundled/inspector.html";
const targetId = "desktop-safari";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pagesDir = path.join(repoRoot, "test", "pages");
const fixtureMountPath = "/__pages";

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
  "Profiler.setSamplingInterval",
  "Runtime.releaseObject",
  "Runtime.releaseObjectGroup",
  // suspendAllTargets() sends these before Performance recording:
  "Overlay.disable",
  "Page.stopLoading",
  "DOM.disable",
  "CSS.disable",
  "Console.enable",
  "Console.disable",
  "Console.clearMessages",
  "Log.disable",
  "DOMStorage.enable",
  "DOMStorage.disable",
  "IndexedDB.enable",
  "IndexedDB.disable",
  "HeapProfiler.enable",
  "HeapProfiler.disable",
  "HeapProfiler.collectGarbage",
  "Memory.enable",
  "Memory.disable",
  "LayerTree.enable",
  "LayerTree.disable",
]);

// ── Extension Connection (direct WebSocket from content script) ─────

class ExtensionConnection {
  constructor(logger) {
    this.logger = logger;
    this.ws = null;
    this.connected = false;
    this.currentUrl = "";
    this.currentTitle = "";
    this.pendingRequests = new Map();
    this.nextReqId = 1;
    this.onEvent = null; // (kind, events) => void — for push events
    this.onContentReady = null; // () => void
  }

  attach(ws) {
    if (this.ws) {
      // Close old connection
      try { this.ws.close(); } catch {}
    }
    this.ws = ws;
    this.connected = true;
    this.logger.info("Content script connected via WebSocket");

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this.#handleMessage(msg);
    });

    ws.on("close", () => {
      if (this.ws === ws) {
        this.logger.warn("Content script disconnected");
        this.connected = false;
        this.ws = null;
        for (const [, req] of this.pendingRequests) {
          clearTimeout(req.timer);
          req.reject(new Error("Content script disconnected"));
        }
        this.pendingRequests.clear();
      }
    });
  }

  /** Send a command to the content script and wait for response. */
  async send(type, params = {}, timeout = 5000) {
    if (!this.connected) throw new Error("Content script not connected");
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Content script request timed out: ${type}`));
      }, timeout);
      this.pendingRequests.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, type, ...params }));
    });
  }

  /** Fire-and-forget command to content script. */
  sendNoWait(type, params = {}) {
    if (!this.connected) return;
    const id = this.nextReqId++;
    this.ws.send(JSON.stringify({ id, type, ...params }));
  }

  #handleMessage(msg) {
    // Response to a command we sent
    if (msg.type === "response" && msg.id !== undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg.response);
      }
      return;
    }

    // Content script ready notification
    if (msg.type === "contentReady") {
      this.currentUrl = msg.url || this.currentUrl;
      this.currentTitle = msg.title || this.currentTitle;
      this.logger.info(`Content ready: ${msg.url}`);
      this.onContentReady?.();
      return;
    }

    // Push events from content script
    if (msg.type === "events") {
      this.onEvent?.(msg.kind, msg.events);
      return;
    }
  }
}

// ── Server ─────────────────────────────────────────────────────────

class DesktopSafariServer {
  constructor(logger) {
    this.logger = logger.scope("desktop");
    this.ext = new ExtensionConnection(this.logger);
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.cdpWss = new WebSocketServer({ noServer: true });
    this.extWss = new WebSocketServer({ noServer: true });
    this.clients = new Set();
    this.isStopping = false;

    // State
    this.lastSnapshot = null;
    this.networkBodies = new Map();
    this.animationEnabled = false;
    this.tracingActive = false;
    this.debuggerEnabled = false;
    this.scriptCache = new Map();
    this.resourceCache = new Map();
    this.nextScriptId = 1;
    this.scriptIdsByKey = new Map();
  }

  async start() {
    // Wire up extension events
    this.ext.onEvent = (kind, events) => this.#handleExtensionEvent(kind, events);
    this.ext.onContentReady = () => this.#handleContentReady();

    this.#setupRoutes();
    this.#setupCdpWs();

    await new Promise((resolve, reject) => {
      this.httpServer.listen(port, host, () => resolve());
      this.httpServer.on("error", reject);
    });

    // Route WebSocket upgrades
    this.httpServer.on("upgrade", (request, socket, head) => {
      const pathname = new URL(request.url, `http://${host}:${port}`).pathname;
      if (pathname === "/__extension") {
        this.extWss.handleUpgrade(request, socket, head, (ws) => {
          this.ext.attach(ws);
        });
      } else if (pathname.startsWith("/devtools/page/")) {
        this.cdpWss.handleUpgrade(request, socket, head, (ws) => {
          this.cdpWss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    this.logger.info(`Desktop Safari bridge listening on http://${host}:${port}`);
    this.logger.info("Waiting for Safari extension to connect...");
    this.logger.info("(Open any page in Safari with the extension enabled)");
  }

  async stop() {
    this.isStopping = true;
    await new Promise((r) => this.cdpWss.close(() => r()));
    await new Promise((r) => this.extWss.close(() => r()));
    await new Promise((r) => this.httpServer.close(() => r()));
  }

  // ── Handle push events from content script ────────────────────────

  #handleExtensionEvent(kind, events) {
    if (!this.clients.size) return;

    if (kind === "console" && Array.isArray(events)) {
      for (const e of events) this.#emitConsoleEvent(e);
    } else if (kind === "network" && Array.isArray(events)) {
      for (const e of events) this.#emitNetworkEvent(e);
    } else if (kind === "domDirty") {
      // Refresh the cached snapshot but DON'T broadcast DOM.documentUpdated —
      // that causes DevTools to re-fetch the entire DOM tree on every mutation,
      // which blanks the Elements panel. DevTools requests the tree on demand.
      this.#refreshSnapshot().catch(() => {});
    } else if (kind === "animation" && Array.isArray(events)) {
      for (const ev of events) this.#emitAnimationEvent(ev);
    }
  }

  #handleContentReady() {
    if (!this.clients.size) return;
    const url = this.ext.currentUrl || "";
    let origin = "";
    try { origin = new URL(url).origin; } catch {}
    const ts = Date.now() / 1000;
    this.#broadcast({
      method: "Page.frameNavigated",
      params: {
        frame: { id: "main", loaderId: `loader-${Date.now()}`, url, securityOrigin: origin, mimeType: "text/html" },
        type: "Navigation",
      },
    });
    this.#broadcast({ method: "Page.domContentEventFired", params: { timestamp: ts } });
    this.#broadcast({ method: "Page.loadEventFired", params: { timestamp: ts } });

    // Refresh snapshot after page settles
    setTimeout(async () => {
      try {
        await this.#refreshSnapshot();
        this.#broadcast({ method: "DOM.documentUpdated", params: {} });
      } catch {}
    }, 300);
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
            lineNumber: e.line || 0, columnNumber: e.col || 0,
            url: e.url || this.ext.currentUrl,
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
          source: "javascript", level,
          text: e.text || "",
          timestamp: e.timestamp || Date.now(),
          url: e.url || this.ext.currentUrl,
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
      if (ev.animation) {
        this.#broadcast({
          method: ev.kind === "started" ? "Animation.animationStarted" : "Animation.animationUpdated",
          params: { animation: ev.animation },
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
          requestId: e.requestId, loaderId: "root", documentURL: this.ext.currentUrl,
          request: { url: e.url, method: e.method, headers: e.headers || {}, postData: e.postData, mixedContentType: "none", initialPriority: "High" },
          timestamp: ts, wallTime: ts, initiator: { type: "other" }, type: e.resourceType || "Fetch", frameId: "main",
        },
      });
    } else if (e.kind === "response") {
      this.networkBodies.set(e.requestId, { body: e.body || "", base64Encoded: false });
      this.#broadcast({
        method: "Network.responseReceived",
        params: {
          requestId: e.requestId, loaderId: "root", timestamp: ts, type: e.resourceType || "Fetch",
          response: {
            url: e.url, status: e.status, statusText: e.statusText,
            headers: e.headers || {}, mimeType: e.mimeType || "",
            encodedDataLength: e.encodedDataLength || 0,
            securityState: (e.url || "").startsWith("https:") ? "secure" : "insecure"
          },
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
    this.app.use(fixtureMountPath, express.static(pagesDir));

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
      const url = this.lastSnapshot?.url || this.ext.currentUrl || "about:blank";
      const title = this.lastSnapshot?.title || this.ext.currentTitle || "Desktop Safari";
      res.json([{
        id: targetId, title, type: "page", url,
        devtoolsFrontendUrl: `${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`,
        webSocketDebuggerUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
      }]);
    });

    this.app.get("/json", (_req, res) => res.redirect("/json/list"));

    this.app.get("/__bridge/status", (_req, res) => {
      res.json({
        connected: this.ext.connected,
        url: this.ext.currentUrl,
        title: this.ext.currentTitle,
        transport: "extension",
      });
    });
  }

  // ── CDP WebSocket ─────────────────────────────────────────────────

  #setupCdpWs() {
    this.cdpWss.on("connection", (socket) => {
      this.clients.add(socket);
      this.logger.info("DevTools client connected");
      socket.on("close", () => {
        this.clients.delete(socket);
        this.logger.info("DevTools client disconnected");
      });
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

  // ── CDP command handler ─────────────────────────────────────────

  async #handleMessage(socket, message) {
    const { id, method, params = {} } = message;

    if (STUB_METHODS.has(method)) return { id, result: {} };

    switch (method) {
      case "Browser.getVersion":
        return { id, result: { product: "Safari/26.4", revision: "desktop", userAgent: "Safari Desktop Bridge", jsVersion: "0.0", protocolVersion: "1.3" } };

      case "Page.enable":
        this.#broadcastLifecycle(socket);
        return { id, result: {} };

      case "Runtime.enable":
        socket.send(JSON.stringify({
          method: "Runtime.executionContextCreated",
          params: {
            context: {
              id: 1,
              origin: (() => { try { return new URL(this.ext.currentUrl).origin; } catch { return ""; } })(),
              name: "top", uniqueId: "ctx",
              auxData: { isDefault: true, type: "default", frameId: "main" }
            },
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
      case "DOM.querySelector": {
        // Use evaluate to run querySelector in the page, then match to snapshot nodeId
        if (!this.lastSnapshot?.root) {
          await this.#refreshSnapshot();
        }
        try {
          // Find the context node from snapshot
          const contextNode = this.lastSnapshot?.nodes?.get(params.nodeId);
          const contextPath = contextNode?.backendPath || [];
          // Run querySelector in page context and get the result's path
          const resp = await this.ext.send("evaluate", {
            expression: `(() => {
              let ctx = document;
              const path = ${JSON.stringify(contextPath)};
              for (const i of path) ctx = ctx?.childNodes?.[i];
              if (!ctx) return null;
              const el = (ctx.querySelector || ctx.querySelectorAll) ? ctx.querySelector(${JSON.stringify(params.selector)}) : null;
              if (!el) return null;
              // Build path from document root
              const buildPath = (node) => {
                const p = [];
                let cur = node;
                while (cur && cur !== document) {
                  const parent = cur.parentNode;
                  if (!parent) break;
                  p.unshift(Array.from(parent.childNodes).indexOf(cur));
                  cur = parent;
                }
                return p;
              };
              return { path: buildPath(el) };
            })()`,
          });
          if (resp?.value?.path) {
            // Match path to snapshot nodeId
            const pathStr = JSON.stringify(resp.value.path);
            for (const [nodeId, node] of this.lastSnapshot?.nodes || []) {
              if (JSON.stringify(node.backendPath) === pathStr) {
                return { id, result: { nodeId } };
              }
            }
            // Node not in snapshot — refresh and try again
            await this.#refreshSnapshot();
            for (const [nodeId, node] of this.lastSnapshot?.nodes || []) {
              if (JSON.stringify(node.backendPath) === pathStr) {
                return { id, result: { nodeId } };
              }
            }
          }
        } catch {}
        return { id, result: { nodeId: 0 } };
      }
      case "DOM.querySelectorAll": {
        try {
          const contextNode = this.lastSnapshot?.nodes?.get(params.nodeId);
          const contextPath = contextNode?.backendPath || [];
          const resp = await this.ext.send("evaluate", {
            expression: `(() => {
              let ctx = document;
              const path = ${JSON.stringify(contextPath)};
              for (const i of path) ctx = ctx?.childNodes?.[i];
              if (!ctx) return [];
              const els = ctx.querySelectorAll(${JSON.stringify(params.selector)});
              return Array.from(els).map(el => {
                const p = [];
                let cur = el;
                while (cur && cur !== document) {
                  const parent = cur.parentNode;
                  if (!parent) break;
                  p.unshift(Array.from(parent.childNodes).indexOf(cur));
                  cur = parent;
                }
                return p;
              });
            })()`,
          });
          if (Array.isArray(resp?.value)) {
            const nodeIds = [];
            for (const path of resp.value) {
              const pathStr = JSON.stringify(path);
              for (const [nodeId, node] of this.lastSnapshot?.nodes || []) {
                if (JSON.stringify(node.backendPath) === pathStr) {
                  nodeIds.push(nodeId);
                  break;
                }
              }
            }
            return { id, result: { nodeIds } };
          }
        } catch {}
        return { id, result: { nodeIds: [] } };
      }
      case "DOM.performSearch": {
        try {
          const resp = await this.ext.send("evaluate", {
            expression: `document.querySelectorAll(${JSON.stringify(params.query || '*')}).length`,
          });
          const count = typeof resp?.value === 'number' ? resp.value : 0;
          return { id, result: { searchId: "search-1", resultCount: count } };
        } catch {}
        return { id, result: { searchId: "search-1", resultCount: 0 } };
      }
      case "DOM.getSearchResults":
        return { id, result: { nodeIds: [] } };
      case "DOM.discardSearchResults":
        return { id, result: {} };
      case "DOM.setAttributeValue":
      case "DOM.setAttributesAsText":
      case "DOM.setNodeValue":
      case "DOM.removeNode":
      case "DOM.setOuterHTML":
      case "DOM.setInspectedNode":
      case "DOM.markUndoableState":
        return { id, result: {} };
      case "DOM.pushNodesByBackendIdsToFrontend":
        return { id, result: { nodeIds: (params.backendNodeIds || []) } };
      case "DOM.getOuterHTML": {
        const node = this.lastSnapshot?.nodes?.get(params.nodeId);
        if (!node?.backendPath) return { id, result: { outerHTML: "" } };
        try {
          const resp = await this.ext.send("getOuterHTML", { path: node.backendPath });
          return { id, result: { outerHTML: resp?.html || "" } };
        } catch { return { id, result: { outerHTML: "" } }; }
      }
      case "DOM.getBoxModel": {
        const node = this.lastSnapshot?.nodes?.get(params.nodeId);
        if (!node?.backendPath) return { id, result: {} };
        try {
          const rect = await this.ext.send("getBoxModel", { path: node.backendPath });
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
          const style = await this.ext.send("getComputedStyle", { path: node.backendPath });
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
          this.ext.sendNoWait("highlight", { path: node.backendPath });
        }
        return { id, result: {} };
      }
      case "Overlay.hideHighlight":
        this.ext.sendNoWait("hideHighlight");
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
          const resp = await this.ext.send("evaluate", { expression: params.expression });
          if (resp?.error) {
            return { id, result: { result: { type: "object", subtype: "error", description: resp.error, className: "Error" }, exceptionDetails: { exceptionId: 1, text: resp.error, lineNumber: 0, columnNumber: 0, exception: { type: "object", subtype: "error", description: resp.error } } } };
          }
          return { id, result: { result: this.#toRemoteObject(resp?.value) } };
        } catch (error) {
          return { id, result: { result: { type: "object", subtype: "error", description: error.message, className: "Error" } } };
        }
      }
      case "Runtime.callFunctionOn":
        return { id, result: { result: { type: "undefined" } } };
      case "Runtime.getProperties":
        return { id, result: { result: [] } };

      // ── Network ──
      case "Network.getResponseBody": {
        const cached = this.networkBodies.get(params.requestId);
        return { id, result: cached || { body: "", base64Encoded: false } };
      }

      // ── Page ──
      case "Page.navigate":
        // Can't navigate from extension — would need tabs API in background
        return { id, result: { frameId: "main", loaderId: `loader-${Date.now()}`, url: params.url } };
      case "Page.reload":
        return { id, result: {} };
      case "Page.getNavigationHistory":
        return { id, result: { currentIndex: 0, entries: [{ id: 0, url: this.ext.currentUrl, userTypedURL: this.ext.currentUrl, title: this.lastSnapshot?.title || "", transitionType: "typed" }] } };
      case "Page.getResourceTree": {
        await this.#refreshScripts();
        const origin = (() => { try { return new URL(this.ext.currentUrl).origin; } catch { return ""; } })();
        return { id, result: { frameTree: { frame: { id: "main", loaderId: "root", url: this.ext.currentUrl, domainAndRegistry: "", securityOrigin: origin, mimeType: "text/html" }, resources: Array.from(this.scriptCache.values()).map(s => ({ url: s.url, type: "Script", mimeType: s.type, contentSize: s.source?.length || 0 })) } } };
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
          const v = await this.ext.send("getLayoutMetrics");
          const vp = { pageX: 0, pageY: 0, clientWidth: v?.w || 1280, clientHeight: v?.h || 720 };
          const vis = { ...vp, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 };
          return { id, result: { layoutViewport: vp, visualViewport: vis, contentSize: { x: 0, y: 0, width: v?.sw || 1280, height: v?.sh || 720 }, cssLayoutViewport: vp, cssVisualViewport: vis, cssContentSize: { x: 0, y: 0, width: v?.sw || 1280, height: v?.sh || 720 } } };
        } catch {
          const vp = { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 };
          return { id, result: { layoutViewport: vp, visualViewport: { ...vp, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 }, contentSize: { x: 0, y: 0, width: 1280, height: 720 }, cssLayoutViewport: vp, cssVisualViewport: { ...vp, offsetX: 0, offsetY: 0, scale: 1, zoom: 1 }, cssContentSize: { x: 0, y: 0, width: 1280, height: 720 } } };
        }
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
          const m = await this.ext.send("getPerformanceMetrics");
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
        this.ext.sendNoWait("animEnable");
        return { id, result: {} };
      case "Animation.disable":
        this.animationEnabled = false;
        this.ext.sendNoWait("animDisable");
        return { id, result: {} };
      case "Animation.getCurrentTime": {
        try {
          const sn = await this.ext.send("animGetCurrent", { animId: params.id });
          return { id, result: { currentTime: Number(sn?.currentTime || 0) } };
        } catch { return { id, result: { currentTime: 0 } }; }
      }
      case "Animation.getPlaybackRate": {
        try {
          const r = await this.ext.send("animGetRate");
          return { id, result: { playbackRate: Number(r?.rate || 1) } };
        } catch { return { id, result: { playbackRate: 1 } }; }
      }
      case "Animation.setPlaybackRate":
        this.ext.sendNoWait("animSetRate", { rate: Number(params.playbackRate) });
        return { id, result: {} };
      case "Animation.seekAnimations":
        this.ext.sendNoWait("animSeek", { ids: params.animations || [], currentTime: Number(params.currentTime || 0) });
        return { id, result: {} };
      case "Animation.setPaused":
        this.ext.sendNoWait("animSetPaused", { ids: params.animations || [], paused: !!params.paused });
        return { id, result: {} };
      case "Animation.releaseAnimations":
      case "Animation.setTiming":
        return { id, result: {} };
      case "Animation.resolveAnimation":
        return { id, result: { remoteObject: { type: "object", className: "Animation", description: "Animation" } } };

      // ── Target ──
      case "Target.getTargets":
        return { id, result: { targetInfos: [{ targetId, type: "page", title: this.lastSnapshot?.title || "Desktop Safari", url: this.ext.currentUrl, attached: true }] } };

      // ── Storage ──
      case "Storage.getStorageKey":
        return { id, result: { storageKey: (() => { try { return new URL(this.ext.currentUrl).origin; } catch { return ""; } })() } };

      default:
        this.logger.debug(`unhandled: ${method}`);
        return { id, error: { code: -32601, message: `Not implemented: ${method}` } };
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  #broadcastLifecycle(socket) {
    const url = this.ext.currentUrl || "";
    if (!url) return;
    const ts = Date.now() / 1000;
    let origin = "";
    try { origin = new URL(url).origin; } catch {}
    for (const e of [
      { method: "Page.frameNavigated", params: { frame: { id: "main", loaderId: `loader-${Date.now()}`, url, securityOrigin: origin, mimeType: "text/html" }, type: "Navigation" } },
      { method: "Page.domContentEventFired", params: { timestamp: ts } },
      { method: "Page.loadEventFired", params: { timestamp: ts } },
    ]) {
      socket.send(JSON.stringify(e));
    }
  }

  async #refreshSnapshot() {
    try {
      const raw = await this.ext.send("getSnapshot", {}, 10000);
      if (!raw?.root) return;
      const nodes = new Map();
      const index = (node, nodePath) => {
        node.backendPath = nodePath;
        nodes.set(node.nodeId, node);
        if (node.children) node.children.forEach((child, i) => index(child, [...nodePath, i]));
      };
      index(raw.root, []);
      this.lastSnapshot = { root: raw.root, nodes, url: raw.url, title: raw.title };
      this.ext.currentUrl = raw.url || this.ext.currentUrl;
      this.ext.currentTitle = raw.title || this.ext.currentTitle;
    } catch (error) {
      this.logger.debug("snapshot failed:", error?.message);
    }
  }

  async #refreshScripts() {
    try {
      const scripts = await this.ext.send("getScripts");
      if (!Array.isArray(scripts)) return;
      const pageUrl = this.ext.currentUrl;
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
        nextCache.set(scriptId, {
          scriptId, url, source, type: script.type || "text/javascript",
          startLine: 0, endLine: source.split("\n").length,
          executionContextId: 1, hash: "", isModule: script.type === "module",
          sourceMapURL: this.#extractSourceMapURL(url, source)
        });
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
        params: {
          scriptId: s.scriptId, url: s.url, startLine: s.startLine, startColumn: 0,
          endLine: s.endLine, endColumn: 0, executionContextId: s.executionContextId,
          hash: s.hash, isLiveEdit: false, sourceMapURL: s.sourceMapURL || undefined,
          hasSourceURL: false, isModule: s.isModule, length: s.source?.length || 0,
          scriptLanguage: "JavaScript", embedderName: s.url
        },
      });
    }
  }

  #toRemoteObject(value) {
    if (value === null) return { type: "object", subtype: "null", value: null, description: "null" };
    if (value === undefined) return { type: "undefined" };
    const t = typeof value;
    if (t === "object") return {
      type: "object", value,
      description: Array.isArray(value) ? `Array(${value.length})` : "Object",
      preview: { type: "object", overflow: false, properties: [] }
    };
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
  } catch (error) {
    logger.error(error?.message || String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
