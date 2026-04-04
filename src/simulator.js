import express from "express";
import http from "http";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import { Logger } from "./logger.js";
import {
  assertIosEnvironment,
  bootSimulator,
  launchRealDeviceSafari,
  launchSimulatorSafari,
  listRealDevices,
  listSimulators,
  MobileInspectorSession,
  navigateSimulatorToUrl,
  parseTargetId,
  probeRealDeviceWebInspector,
  probeSimulatorWebInspector,
  selectSimulator,
  shutdownSimulator,
  targetsFromProbe,
} from "./ios-webinspector.js";

const bindHost = process.env.DEVICE_BIND_HOST || "0.0.0.0";
const host = "localhost";
const listPort = Number(process.env.DEVICE_LIST_PORT || 9221);
const targetPort = Number(process.env.DEVICE_TARGET_PORT || 9222);
const simulatorId = process.env.DEVICE_ID || process.env.SIMULATOR_ID || "";
const simulatorName = process.env.SIMULATOR_NAME || "";
const realDeviceId = process.env.REAL_DEVICE_ID || "";
const simulatorStartUrl = process.env.SIMULATOR_START_URL || "";
const realDeviceStartUrl = process.env.REAL_DEVICE_START_URL || "";
const pagesMountPath = "/__pages";
const MAIN_FRAME_ID = "A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D5";
const MAIN_LOADER_ID = "F1E2D3C4B5A6F7E8D9C0B1A2F3E4D5C6";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pagesDir = path.join(repoRoot, "test", "pages");

function detectPublicHost() {
  if (process.env.DEVICE_PUBLIC_HOST) {
    return process.env.DEVICE_PUBLIC_HOST;
  }
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (
        entry.family === "IPv4" &&
        !entry.internal &&
        !entry.address.startsWith("169.254.")
      ) {
        return entry.address;
      }
    }
  }
  return host;
}

function selectRealDevice(devices, selector = {}) {
  const requestedId = selector.realDeviceId || "";
  if (requestedId) {
    return devices.find((device) => device.udid === requestedId) || null;
  }
  return devices[0] || null;
}

class IosControlServer {
  constructor(logger) {
    this.logger = logger.scope("ios");
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.targetPort = targetPort;
    this.selectedSimulatorId = simulatorId;
    this.selectedSimulatorName = simulatorName;
    this.selectedRealDeviceId = realDeviceId;
    this.startUrl = simulatorStartUrl;
    this.realDeviceStartUrl = realDeviceStartUrl;
    this.publicHost = detectPublicHost();
    this.lastTargets = [];
    this.lastProbeTime = 0;
    this.probeInFlight = null;
    this.probeCacheTtlMs = 30_000; // 30 sec — balance between freshness and not disrupting device
    this.clients = new Set();
    this.pollTimer = null;
    this.debuggerEnabled = false;
    this.animationDomainEnabled = false;
    this.domObserverEnabled = false;
    this.pollErrorCount = 0;
    this.maxPollErrors = 5;
    // Track simulators we booted so we can shut them down on exit
    this.bootedSimulators = new Set();
    // Performance instrumentation (enabled via BRIDGE_PERF=1)
    this.perfEnabled = !!process.env.BRIDGE_PERF;
    this.perfStats = { handlers: new Map(), pollTicks: 0, pollBusyTicks: 0, pollTotalMs: 0, eventsForwarded: 0 };
  }

  async start() {
    await assertIosEnvironment();
    this.#setupRoutes();
    this.#setupWs();
    await new Promise((resolve, reject) => {
      this.httpServer.listen(listPort, bindHost, () => resolve());
      this.httpServer.on("error", reject);
    });
    this.#startPolling();
    this.logger.info(`iOS helper listening on http://${host}:${listPort}`);
    // Warm the target cache in background so first page load is fast
    this.probe().catch((error) => {
      this.logger.debug(`initial probe failed: ${error?.message}`);
    });
    if (this.startUrl) {
      try {
        await this.navigate(this.startUrl, {
          simulatorId: this.selectedSimulatorId,
          simulatorName: this.selectedSimulatorName,
        });
      } catch (error) {
        this.logger.warn(`initial simulator navigation failed: ${error.message}`);
      }
    }
  }

  async stop() {
    this.#stopPolling();
    for (const client of this.clients) {
      client.socket.close();
      await client.session.disconnect().catch(() => {});
    }
    this.clients.clear();
    await new Promise((resolve) => this.wss.close(() => resolve()));
    await new Promise((resolve) => this.httpServer.close(() => resolve()));
    // Shut down simulators we booted (don't leave ghosts)
    for (const udid of this.bootedSimulators) {
      this.logger.info(`Shutting down simulator ${udid}`);
      try { await shutdownSimulator(udid); } catch {}
    }
    this.bootedSimulators.clear();
  }

  async getStatus() {
    const simulators = await listSimulators();
    const realDevices = await listRealDevices();
    const selectedSimulator = selectSimulator(simulators, {
      deviceId: this.selectedSimulatorId,
      simulatorName: this.selectedSimulatorName,
    });
    const selectedRealDevice = selectRealDevice(realDevices, {
      realDeviceId: this.selectedRealDeviceId,
    });
    return {
      developerDir: process.env.DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer",
      selectedSimulatorId: this.selectedSimulatorId,
      selectedSimulatorName: this.selectedSimulatorName,
      selectedRealDeviceId: this.selectedRealDeviceId,
      targetPort: this.targetPort,
      startUrl: this.startUrl,
      realDeviceStartUrl: this.realDeviceStartUrl,
      publicHost: this.publicHost,
      selectedSimulator,
      selectedRealDevice,
      simulators,
      realDevices,
      note:
        "Native iOS discovery and CDP target bridging are active for simulator and physical device pages.",
    };
  }

  async probe() {
    // Get status with resilience — listRealDevices can hang when device is disconnected.
    // Fetch simulators and real devices separately so one hanging doesn't block the other.
    let simulators = [], realDevices = [];
    try {
      simulators = await Promise.race([
        listSimulators(),
        new Promise((resolve) => setTimeout(() => resolve([]), 5_000)),
      ]);
    } catch { simulators = []; }
    try {
      realDevices = await Promise.race([
        listRealDevices(),
        new Promise((resolve) => setTimeout(() => resolve([]), 10_000)),
      ]);
    } catch { realDevices = []; }
    const selectedSimulator = selectSimulator(simulators, {
      deviceId: this.selectedSimulatorId,
      simulatorName: this.selectedSimulatorName,
    });
    const selectedRealDevice = selectRealDevice(realDevices, {
      realDeviceId: this.selectedRealDeviceId,
    });
    const status = { selectedSimulator, selectedRealDevice, simulators, realDevices };
    const probes = [];

    // Probe real device FIRST — the device's Web Inspector connection is fragile
    // and probing the simulator first can disrupt the device's availability state.
    // Use a hard timeout to prevent blocking when the device tunnel is down.
    if (status.selectedRealDevice) {
      try {
        const deviceProbeTimeout = 30_000; // 30s hard timeout
        let deviceProbe = await Promise.race([
          probeRealDeviceWebInspector(status.selectedRealDevice, this.logger),
          new Promise((_, reject) => setTimeout(() => reject(new Error("device probe timeout")), deviceProbeTimeout)),
        ]);
        if (!deviceProbe.pages.length && this.realDeviceStartUrl) {
          const launchResult = await launchRealDeviceSafari(
            status.selectedRealDevice.udid,
            this.realDeviceStartUrl,
          );
          if (!launchResult.ok) {
            this.logger.warn(`real-device safari launch failed: ${launchResult.error}`);
          } else {
            deviceProbe = await Promise.race([
              probeRealDeviceWebInspector(status.selectedRealDevice, this.logger),
              new Promise((_, reject) => setTimeout(() => reject(new Error("device probe timeout")), deviceProbeTimeout)),
            ]);
          }
        }
        probes.push(deviceProbe);
      } catch (err) {
        this.logger.warn(`real-device probe failed: ${err.message}`);
      }
    }

    if (status.selectedSimulator?.state === "Booted") {
      try {
        const simProbe = await Promise.race([
          probeSimulatorWebInspector(status.selectedSimulator, this.logger),
          new Promise((_, reject) => setTimeout(() => reject(new Error("simulator probe timeout")), 15_000)),
        ]);
        probes.push(simProbe);
      } catch (err) {
        this.logger.warn(`simulator probe failed: ${err.message}`);
      }
    }

    const targets = probes.flatMap((probe) => targetsFromProbe(probe, listPort));
    // Only update cached targets if we found some — don't clear valid targets
    // because a probe returned empty (device screen locked, Safari backgrounded, etc.)
    if (targets.length > 0 || this.lastTargets.length === 0) {
      this.lastTargets = targets;
    }
    this.lastProbeTime = Date.now();
    return {
      ...status,
      probes,
      targets,
    };
  }

  async cachedProbe() {
    // Always return cached targets immediately if we have any.
    // Trigger background refresh if stale, but don't wait for it.
    if (this.lastTargets.length) {
      if (Date.now() - this.lastProbeTime > this.probeCacheTtlMs && !this.probeInFlight) {
        this.probeInFlight = this.probe()
          .catch(() => {})
          .finally(() => { this.probeInFlight = null; });
      }
      return this.lastTargets;
    }
    // No cached targets — must wait for a fresh probe
    if (this.probeInFlight) {
      try {
        const result = await this.probeInFlight;
        return result.targets;
      } catch {
        return this.lastTargets;
      }
    }
    this.probeInFlight = this.probe().finally(() => { this.probeInFlight = null; });
    try {
      const result = await this.probeInFlight;
      return result.targets;
    } catch {
      return this.lastTargets;
    }
  }

  async boot(selector = {}) {
    const simulators = await listSimulators();
    const simulator = selectSimulator(simulators, {
      deviceId: selector.simulatorId || this.selectedSimulatorId,
      simulatorName: selector.simulatorName || this.selectedSimulatorName,
    });
    if (!simulator) {
      throw new Error("No available iOS simulator was found.");
    }
    // Only boot if not already booted
    if (simulator.state !== "Booted") {
      await bootSimulator(simulator.udid);
      this.bootedSimulators.add(simulator.udid);
      this.logger.info(`Booted simulator ${simulator.name} (${simulator.udid})`);
    }
    return simulator;
  }

  async launchSafari(selector = {}) {
    const simulator = await this.boot(selector);
    const result = await launchSimulatorSafari(simulator.udid);
    if (!result.ok) {
      this.logger.warn(`simulator safari launch failed: ${result.error}`);
    }
    return simulator;
  }

  async navigate(url, selector = {}) {
    const simulator = await this.launchSafari(selector);
    await navigateSimulatorToUrl(simulator.udid, url);
    return {
      simulator,
      url,
    };
  }

  async launchRealDevice(url = "", selector = {}) {
    const devices = await listRealDevices();
    const device = selectRealDevice(devices, {
      realDeviceId: selector.realDeviceId || this.selectedRealDeviceId,
    });
    if (!device) {
      throw new Error("No connected physical iPhone was found.");
    }
    const result = await launchRealDeviceSafari(device.udid, url);
    if (!result.ok) {
      throw new Error(result.error);
    }
    return {
      device,
      url,
      stdout: result.stdout,
    };
  }

  #setupWs() {
    this.wss.on("connection", async (socket, request) => {
      const url = request.url || "";
      const match = url.match(/^\/devtools\/page\/([^/?#]+)/);
      const encodedTargetId = match?.[1] || "";
      const decodedTargetId = decodeURIComponent(encodedTargetId);
      const target = parseTargetId(decodedTargetId);
      if (!target) {
        socket.close(1008, "Unknown mobile target");
        return;
      }
      // Enrich target with URL/title from cached target list
      const cachedTarget = this.lastTargets.find(t => t.id === decodedTargetId);
      if (cachedTarget) {
        target.url = cachedTarget.url;
        target.title = cachedTarget.title;
      }

      const session = new MobileInspectorSession({
        target,
        logger: this.logger.scope(`target:${target.type}:${target.udid.slice(0, 6)}`),
      });
      const sessionPromise = session.connect().catch((error) => {
        this.logger.error(`mobile attach failed for ${decodedTargetId}`, error);
        socket.close(1011, error?.message || "Attach failed");
        throw error;
      });

      const client = {
        socket,
        session,
        targetId: decodedTargetId,
        debuggerEnabled: false,
        animationDomainEnabled: false,
        domObserverEnabled: false,
        lastPauseEvent: null,
        callFrameMap: new Map(),
        scopeCache: new Map(),
        screencastTimer: null,
        tracing: false,
        tracingEvents: [],
      };
      this.clients.add(client);
      socket.on("error", (err) => {
        this.logger.debug(`client socket error: ${err?.message}`);
      });
      socket.on("close", () => {
        if (client.screencastTimer) {
          clearInterval(client.screencastTimer);
          client.screencastTimer = null;
        }
        if (client._traceUsageTimer) {
          clearInterval(client._traceUsageTimer);
          client._traceUsageTimer = null;
        }
        this.clients.delete(client);
        void session.disconnect();
      });
      socket.on("message", async (raw) => {
        try {
          await sessionPromise;
          const message = JSON.parse(raw.toString());
          // Session multiplexing: strip sessionId from incoming (flatten mode)
          const inSessionId = message.sessionId;
          if (inSessionId) delete message.sessionId;
          this.logger.debug("mobile cdp <-", message.method);
          if (message.method?.startsWith("Debugger.") || message.method?.startsWith("CSS.set") || message.method?.startsWith("DOM.set") || message.method?.startsWith("Tracing.") || message.method?.startsWith("Overlay.") || message.method?.startsWith("Page.stop") || message.method?.startsWith("Profiler.")) {
            this.logger.info(`CDP in: ${message.method} ${JSON.stringify(message.params || {}).slice(0, 300)}`);
          }
          // Global timeout: prevent any single CDP command from blocking the WebSocket
          const response = await Promise.race([
            this.#handleMessage(client, message),
            new Promise((resolve) => setTimeout(() => resolve({
              id: message.id,
              error: { code: -32000, message: `${message.method} timed out after 30s` },
            }), 30_000)),
          ]);
          if (response) {
            // Add sessionId to responses if incoming had one
            if (inSessionId) response.sessionId = inSessionId;
            if (message.method?.startsWith("CSS.set") || message.method?.startsWith("DOM.set")) {
              this.logger.info(`CDP out: ${message.method} ${JSON.stringify(response).slice(0, 500)}`);
            }
            socket.send(JSON.stringify(response));
          }
        } catch (error) {
          this.logger.error("mobile websocket message failed", error);
          socket.send(
            JSON.stringify({
              error: {
                code: -32000,
                message: error?.message || String(error),
              },
            }),
          );
        }
      });
    });
  }


  // Try native WebKit command, fall back to session method on failure
  async #tryNative(session, method, params, fallback) {
    try {
      return await session.rawWir.sendCommand(method, params);
    } catch {
      return fallback ? await fallback() : undefined;
    }
  }

  // ── CDP Message Router ──────────────────────────────────────────
  // Dispatches Chrome DevTools Protocol messages to domain-specific handlers.
  async #handleMessage(client, message) {
    const { id, method, params = {} } = message;
    const session = client.session;
    const domain = method.split(".")[0];
    const t0 = this.perfEnabled ? performance.now() : 0;

    let result;
    switch (domain) {
      case "DOM": result = await this.#handleDOM(id, method, params, client, session); break;
      case "CSS": result = await this.#handleCSS(id, method, params, client, session); break;
      case "Runtime": result = await this.#handleRuntime(id, method, params, client, session); break;
      case "Debugger": result = await this.#handleDebugger(id, method, params, client, session); break;
      case "Page": result = await this.#handlePage(id, method, params, client, session); break;
      case "Network": result = await this.#handleNetwork(id, method, params, client, session); break;
      case "Overlay": result = await this.#handleOverlay(id, method, params, client, session); break;
      case "Animation": result = await this.#handleAnimation(id, method, params, client, session); break;
      case "DOMDebugger": result = await this.#handleDOMDebugger(id, method, params, client, session); break;
      default: result = await this.#handleMisc(id, method, params, client, session);
    }
    if (this.perfEnabled) {
      const elapsed = performance.now() - t0;
      const stats = this.perfStats.handlers;
      const entry = stats.get(method) || { calls: 0, totalMs: 0, maxMs: 0 };
      entry.calls++;
      entry.totalMs += elapsed;
      if (elapsed > entry.maxMs) entry.maxMs = elapsed;
      stats.set(method, entry);
    }
    return result;
  }

  // ── DOM domain ──────────────────────────────────────────────────

  async #handleDOM(id, method, params, client, session) {
    switch (method) {
      case "DOM.enable":
        client.domObserverEnabled = true;
        await session.startDomObserver();
        return { id, result: {} };
      case "DOM.disable":
        client.domObserverEnabled = false;
        await session.stopDomObserver();
        return { id, result: {} };
      case "DOM.setInspectedNode":
        await session.setInspectedNode(params.nodeId || params.backendNodeId);
        return { id, result: {} };
      case "DOM.setOuterHTML":
        await this.#tryNative(session, "DOM.setOuterHTML", { nodeId: params.nodeId, outerHTML: params.outerHTML },
          () => session.setOuterHTML(params.nodeId, params.outerHTML));
        return { id, result: {} };
      case "DOM.setAttributeValue":
        await this.#tryNative(session, "DOM.setAttributeValue", { nodeId: params.nodeId, name: params.name, value: params.value },
          () => session.setAttributeValue(params.nodeId, params.name, params.value));
        return { id, result: {} };
      case "DOM.setAttributesAsText":
        await this.#tryNative(session, "DOM.setAttributesAsText", { nodeId: params.nodeId, text: params.text, name: params.name },
          () => session.setAttributesAsText(params.nodeId, params.text, params.name));
        return { id, result: {} };
      case "DOM.setNodeValue":
        await this.#tryNative(session, "DOM.setNodeValue", { nodeId: params.nodeId, value: params.value },
          () => session.setNodeValue(params.nodeId, params.value));
        return { id, result: {} };
      case "DOM.removeNode":
        await this.#tryNative(session, "DOM.removeNode", { nodeId: params.nodeId },
          () => session.removeNode(params.nodeId));
        return { id, result: {} };
      case "DOM.getDocument": {
        try {
          const nativeDoc = await session.rawWir.sendCommand("DOM.getDocument", {});
          if (nativeDoc?.root) {
            // Add Chrome-specific fields that WebKit doesn't return
            nativeDoc.root.compatibilityMode = nativeDoc.root.compatibilityMode || "NoQuirksMode";
            nativeDoc.root.isScrollable = nativeDoc.root.isScrollable ?? false;
            // Filter out the highlight overlay div
            const filterOverlay = (node) => {
              if (node.children) {
                node.children = node.children.filter(c => {
                  const attrs = c.attributes || [];
                  for (let i = 0; i < attrs.length; i += 2) {
                    if (attrs[i] === "id" && attrs[i + 1] === "__cdt_highlight_overlay") return false;
                  }
                  return true;
                });
                node.childNodeCount = node.children.length;
                for (const c of node.children) filterOverlay(c);
              }
            };
            filterOverlay(nativeDoc.root);
            // Pre-expand unexpanded nodes. WebKit returns shallow tree from getDocument.
            // Wait for children to arrive so the returned tree matches Chrome's behavior.
            const nodeIndex = new Map();
            const indexNodes = (node) => {
              nodeIndex.set(node.nodeId, node);
              for (const c of node.children || []) indexNodes(c);
            };
            indexNodes(nativeDoc.root);

            const toExpand = [];
            const findUnexpanded = (node) => {
              if (node.childNodeCount > 0 && (!node.children || node.children.length === 0)) {
                toExpand.push(node);
              }
              for (const c of node.children || []) findUnexpanded(c);
            };
            findUnexpanded(nativeDoc.root);

            if (toExpand.length > 0) {
              // Set up a temporary event listener to capture setChildNodes responses
              const pendingIds = new Set(toExpand.map(n => n.nodeId));
              let totalExpanded = 0;
              const MAX_EXPAND = 200; // Prevent runaway expansion on huge DOMs
              const childrenReceived = new Promise((resolve) => {
                const timeout = setTimeout(() => {
                  session.rawWir.removeListener("event", handler);
                  resolve();
                }, 2000); // Max 2s wait
                const handler = (method, params) => {
                  if (method === "DOM.setChildNodes" && params?.parentId && pendingIds.has(params.parentId)) {
                    const parent = nodeIndex.get(params.parentId);
                    if (parent && params.nodes) {
                      parent.children = params.nodes;
                      parent.childNodeCount = params.nodes.length;
                      totalExpanded++;
                      // Index new nodes and check if THEY need expansion (with depth limit)
                      if (totalExpanded < MAX_EXPAND) {
                        for (const child of params.nodes) {
                          indexNodes(child);
                          if (child.childNodeCount > 0 && (!child.children || child.children.length === 0)) {
                            pendingIds.add(child.nodeId);
                            session.rawWir.sendCommand("DOM.requestChildNodes", { nodeId: child.nodeId, depth: -1 }).catch(() => {});
                          }
                        }
                      }
                    }
                    pendingIds.delete(params.parentId);
                    if (pendingIds.size === 0) {
                      clearTimeout(timeout);
                      session.rawWir.removeListener("event", handler);
                      resolve();
                    }
                  }
                };
                session.rawWir.on("event", handler);
              });

              // Fire all requests
              for (const node of toExpand) {
                session.rawWir.sendCommand("DOM.requestChildNodes", { nodeId: node.nodeId, depth: -1 }).catch(() => {});
              }

              // Wait for children to arrive (up to 2s)
              await childrenReceived;

              // Filter overlay after expansion
              filterOverlay(nativeDoc.root);
            }
          }
          return { id, result: nativeDoc };
        } catch {
          return { id, result: { root: await session.getDocument() } };
        }
      }
      case "DOM.requestChildNodes": {
        try {
          // Use timeout — WebKit may not return a command response for requestChildNodes
          await Promise.race([
            session.rawWir.sendCommand("DOM.requestChildNodes", {
              nodeId: params.nodeId,
              depth: params.depth,
            }),
            new Promise(r => setTimeout(r, 3000)),
          ]);
          // WebKit will send DOM.setChildNodes events via the native event stream
        } catch {
          // Fallback to JS snapshot
          const nodes = await session.requestChildNodes(params.nodeId, params.depth);
          this.#send(client, { method: "DOM.setChildNodes", params: { parentId: params.nodeId, nodes } });
        }
        return { id, result: {} };
      }
      case "DOM.describeNode": {
        try {
          // Use DOM.resolveNode to get a remote object, then get its properties
          const resolved = await session.rawWir.sendCommand("DOM.resolveNode", { nodeId: params.nodeId });
          if (resolved?.object?.objectId) {
            const nodeInfo = await session.rawWir.sendCommand("Runtime.callFunctionOn", {
              objectId: resolved.object.objectId,
              functionDeclaration: `function(){return{nodeName:this.nodeName,localName:this.localName||"",nodeType:this.nodeType,nodeValue:this.nodeValue||"",childNodeCount:this.childNodes?.length||0}}`,
              returnByValue: true,
            });
            const info = nodeInfo?.result?.value || {};
            return { id, result: { node: {
              nodeId: params.nodeId,
              backendNodeId: params.nodeId,
              nodeType: info.nodeType || 1,
              nodeName: info.nodeName || "UNKNOWN",
              localName: info.localName || "",
              nodeValue: info.nodeValue || "",
              childNodeCount: info.childNodeCount || 0,
            } } };
          }
          // Fallback: walk the document tree
          const doc = await session.rawWir.sendCommand("DOM.getDocument", {});
          const findById = (n) => {
            if (n.nodeId === params.nodeId) return n;
            for (const c of n.children || []) { const found = findById(c); if (found) return found; }
            return null;
          };
          const node = findById(doc.root);
          if (node) {
            return { id, result: { node: {
              nodeId: node.nodeId, backendNodeId: node.nodeId,
              nodeType: node.nodeType, nodeName: node.nodeName,
              localName: node.localName || "", nodeValue: node.nodeValue || "",
              childNodeCount: node.childNodeCount || node.children?.length || 0,
              attributes: node.attributes,
            } } };
          }
          return { id, result: { node: { nodeType: 1, nodeName: "UNKNOWN" } } };
        } catch {
          return { id, result: { node: { nodeType: 1, nodeName: "UNKNOWN" } } };
        }
      }
      case "DOM.resolveNode": {
        try {
          const r = await session.rawWir.sendCommand("DOM.resolveNode", {
            nodeId: params.nodeId,
            objectGroup: params.objectGroup,
          });
          return { id, result: r };
        } catch {
          return { id, result: { object: { type: "object", subtype: "node", className: "Node", description: "Node", objectId: "node:" + params.nodeId } } };
        }
      }
      case "DOM.requestNode": {
        // Converts a Runtime objectId to a DOM nodeId
        try {
          const r = await session.rawWir.sendCommand("DOM.requestNode", { objectId: params.objectId });
          return { id, result: r };
        } catch {
          return { id, result: { nodeId: 0 } };
        }
      }
      case "DOM.pushNodesByBackendIdsToFrontend":
        return { id, result: { nodeIds: (params.backendNodeIds || []).map(bid => bid) } };
      case "DOM.getOuterHTML": {
        try {
          const r = await session.rawWir.sendCommand("DOM.getOuterHTML", { nodeId: params.nodeId });
          return { id, result: r };
        } catch {
          return { id, result: { outerHTML: await session.getOuterHTML(params.nodeId) } };
        }
      }
      case "DOM.getBoxModel": {
        // Try native DOM.resolveNode + JS eval for box model, fallback to session method
        try {
          const resolved = await session.rawWir.sendCommand("DOM.resolveNode", { nodeId: params.nodeId });
          if (resolved?.object?.objectId) {
            const boxResult = await session.rawWir.sendCommand("Runtime.callFunctionOn", {
              objectId: resolved.object.objectId,
              functionDeclaration: `function() {
                const el = this;
                if (!el?.getBoundingClientRect) return null;
                const r = el.getBoundingClientRect();
                const cs = el.nodeType === 1 ? getComputedStyle(el) : null;
                const mt = parseFloat(cs?.marginTop) || 0, mr = parseFloat(cs?.marginRight) || 0;
                const mb = parseFloat(cs?.marginBottom) || 0, ml = parseFloat(cs?.marginLeft) || 0;
                const pt = parseFloat(cs?.paddingTop) || 0, pr = parseFloat(cs?.paddingRight) || 0;
                const pb = parseFloat(cs?.paddingBottom) || 0, pl = parseFloat(cs?.paddingLeft) || 0;
                const bt = parseFloat(cs?.borderTopWidth) || 0, bri = parseFloat(cs?.borderRightWidth) || 0;
                const bb = parseFloat(cs?.borderBottomWidth) || 0, bli = parseFloat(cs?.borderLeftWidth) || 0;
                return { x: r.x, y: r.y, w: r.width, h: r.height, mt, mr, mb, ml, pt, pr, pb, pl, bt, bri, bb, bli };
              }`,
              returnByValue: true,
            });
            const d = boxResult?.result?.value;
            if (d) {
              const cx = d.x + d.bli + d.pl, cy = d.y + d.bt + d.pt;
              const cw = d.w - d.bli - d.bri - d.pl - d.pr, ch = d.h - d.bt - d.bb - d.pt - d.pb;
              const px = d.x + d.bli, py = d.y + d.bt;
              const pw = d.w - d.bli - d.bri, ph = d.h - d.bt - d.bb;
              const mx = d.x - d.ml, my = d.y - d.mt;
              const mw = d.w + d.ml + d.mr, mh = d.h + d.mt + d.mb;
              return { id, result: { model: {
                content: [cx, cy, cx + cw, cy, cx + cw, cy + ch, cx, cy + ch],
                padding: [px, py, px + pw, py, px + pw, py + ph, px, py + ph],
                border: [d.x, d.y, d.x + d.w, d.y, d.x + d.w, d.y + d.h, d.x, d.y + d.h],
                margin: [mx, my, mx + mw, my, mx + mw, my + mh, mx, my + mh],
                width: Math.round(d.w), height: Math.round(d.h),
              } } };
            }
          }
        } catch {}
        // Fallback
        return { id, result: (await session.getBoxModel(params.nodeId)) || {} };
      }
      case "DOM.performSearch": {
        try {
          const sr = await session.rawWir.sendCommand("DOM.performSearch", {
            query: params.query,
            nodeIds: params.nodeIds,
          });
          client.lastSearchId = sr?.searchId;
          return { id, result: { searchId: sr?.searchId || "0", resultCount: sr?.resultCount || 0 } };
        } catch {
          return { id, result: { searchId: "0", resultCount: 0 } };
        }
      }
      case "DOM.getSearchResults": {
        try {
          const sr = await session.rawWir.sendCommand("DOM.getSearchResults", {
            searchId: params.searchId,
            fromIndex: params.fromIndex,
            toIndex: params.toIndex,
          });
          return { id, result: { nodeIds: sr?.nodeIds || [] } };
        } catch {
          return { id, result: { nodeIds: [] } };
        }
      }
      case "DOM.discardSearchResults":
        try { await session.rawWir.sendCommand("DOM.discardSearchResults", { searchId: params.searchId }); } catch {}
        return { id, result: {} };
      case "DOM.getEventListenersForNode": {
        try {
          const el = await session.rawWir.sendCommand("DOM.getEventListenersForNode", {
            nodeId: params.nodeId,
          });
          return { id, result: { listeners: el?.listeners || [] } };
        } catch {
          return { id, result: { listeners: [] } };
        }
      }
      case "DOM.getAccessibilityPropertiesForNode": {
        try {
          const ax = await session.rawWir.sendCommand("DOM.getAccessibilityPropertiesForNode", {
            nodeId: params.nodeId,
          });
          return { id, result: { properties: ax?.properties || ax || {} } };
        } catch {
          return { id, result: { properties: {} } };
        }
      }
      case "DOM.setInspectModeEnabled": {
        try {
          await session.rawWir.sendCommand("DOM.setInspectModeEnabled", {
            enabled: params.enabled,
            highlightConfig: params.highlightConfig,
          });
        } catch {}
        return { id, result: {} };
      }
      case "DOM.querySelector": {
        try {
          const qr = await session.rawWir.sendCommand("DOM.querySelector", {
            nodeId: params.nodeId,
            selector: params.selector,
          });
          return { id, result: { nodeId: qr?.nodeId || 0 } };
        } catch {
          return { id, result: { nodeId: 0 } };
        }
      }
      case "DOM.querySelectorAll": {
        try {
          const qr = await session.rawWir.sendCommand("DOM.querySelectorAll", {
            nodeId: params.nodeId,
            selector: params.selector,
          });
          return { id, result: { nodeIds: qr?.nodeIds || [] } };
        } catch {
          return { id, result: { nodeIds: [] } };
        }
      }
      case "DOM.undo":
        try { await session.rawWir.sendCommand("DOM.undo", {}); } catch {}
        return { id, result: {} };
      case "DOM.redo":
        try { await session.rawWir.sendCommand("DOM.redo", {}); } catch {}
        return { id, result: {} };
      case "DOM.markUndoableState":
        try { await session.rawWir.sendCommand("DOM.markUndoableState", {}); } catch {}
        return { id, result: {} };
      default:
        return null;
    }
  }

  // ── CSS domain ──────────────────────────────────────────────────

  async #handleCSS(id, method, params, client, session) {
    switch (method) {
      case "CSS.enable":
      case "CSS.disable":
        client.domObserverEnabled = true;
        await session.startDomObserver();
        return { id, result: {} };
      case "CSS.getComputedStyleForNode": {
        try {
          const nativeComputed = await session.rawWir.sendCommand("CSS.getComputedStyleForNode", {
            nodeId: params.nodeId,
          });
          return { id, result: nativeComputed };
        } catch {
          return { id, result: { computedStyle: await session.getComputedStyle(params.nodeId) } };
        }
      }
      case "CSS.getMatchedStylesForNode": {
        try {
          const nativeCss = await session.rawWir.sendCommand("CSS.getMatchedStylesForNode", {
            nodeId: params.nodeId,
            includePseudo: params.includePseudo,
            includeInherited: params.includeInherited,
          });
          // WebKit doesn't include inlineStyle — supplement via JS
          if (!nativeCss.inlineStyle) {
            nativeCss.inlineStyle = await this.#readInlineStyle(session, params.nodeId);
          }
          return { id, result: nativeCss };
        } catch {
          return { id, result: await session.getMatchedStyles(params.nodeId) };
        }
      }
      case "CSS.getInlineStylesForNode": {
        const inlineStyle = await this.#readInlineStyle(session, params.nodeId);
        return {
          id,
          result: {
            inlineStyle,
            attributesStyle: { styleSheetId: "attributes", cssProperties: [], shorthandEntries: [] },
          },
        };
      }
      case "CSS.getPlatformFontsForNode":
        return { id, result: { fonts: [] } };
      case "CSS.getSupportedCSSProperties": {
        try {
          const r = await session.rawWir.sendCommand("CSS.getSupportedCSSProperties", {});
          return { id, result: r };
        } catch { return { id, result: { cssProperties: [] } }; }
      }
      case "CSS.forcePseudoState": {
        // Map CDP nodeId to WebKit nodeId — use our node's backendNodeId
        const fpNode = await session.getNode(params.nodeId);
        if (fpNode) {
          try {
            await session.rawWir.sendCommand("CSS.forcePseudoState", {
              nodeId: params.nodeId,
              forcedPseudoClasses: params.forcedPseudoClasses || [],
            });
          } catch {}
        }
        return { id, result: {} };
      }
      case "CSS.getAnimatedStylesForNode":
        return {
          id,
          result: await session.getAnimatedStyles(params.nodeId),
        };
      case "CSS.getEnvironmentVariables":
        return { id, result: { variables: [] } };
      case "CSS.trackComputedStyleUpdates":
      case "CSS.trackComputedStyleUpdatesForNode":
        return { id, result: {} };
      case "CSS.takeComputedStyleUpdates":
        return { id, result: { nodeIds: [] } };
      case "CSS.getLonghandProperties":
        return { id, result: { properties: [] } };
      case "CSS.setStyleTexts": {
        const edits = params.edits || [];
        const results = [];
        for (const edit of edits) {
          // Inline style edit: styleSheetId = "inline:nodeId"
          if (edit.styleSheetId?.startsWith("inline:")) {
            const nodeId = Number(edit.styleSheetId.split(":")[1]);
            const text = edit.text || "";
            // Set the style attribute directly on the HTML element — fast, shows in DOM
            try {
              await session.rawWir.sendCommand("DOM.setAttributeValue", {
                nodeId, name: "style", value: text,
              });
            } catch {}
            results.push(this.#parseInlineStyleText(edit.styleSheetId, text));
            continue;
          }
          // Native WebKit CSS.setStyleText for stylesheet rules
          if (edit.styleSheetId) {
            try {
              const nativeResult = await session.rawWir.sendCommand("CSS.setStyleText", {
                styleId: edit.styleId || { styleSheetId: edit.styleSheetId, ordinal: 0 },
                text: edit.text,
              });
              results.push(nativeResult?.style || { styleSheetId: edit.styleSheetId, cssProperties: [], shorthandEntries: [] });
              continue;
            } catch {}
          }
          // Fallback
          const editResult = await session.setStyleText(edit);
          results.push(editResult);
        }
        return { id, result: { styles: results } };
      }
      case "CSS.setStyleSheetText": {
        try {
          const r = await session.rawWir.sendCommand("CSS.setStyleSheetText", {
            styleSheetId: params.styleSheetId,
            text: params.text,
          });
          return { id, result: r || { sourceMapURL: "" } };
        } catch { return { id, result: { sourceMapURL: "" } }; }
      }
      case "CSS.addRule": {
        try {
          const r = await session.rawWir.sendCommand("CSS.addRule", {
            styleSheetId: params.styleSheetId || "1",
            ruleText: params.ruleText,
          });
          return { id, result: r || { rule: {} } };
        } catch { return { id, result: { rule: {} } }; }
      }
      case "CSS.setRuleSelector": {
        try {
          const r = await session.rawWir.sendCommand("CSS.setRuleSelector", params);
          return { id, result: r };
        } catch { return { id, result: {} }; }
      }
      case "CSS.getStyleSheet": {
        try {
          const r = await session.rawWir.sendCommand("CSS.getStyleSheet", {
            styleSheetId: params.styleSheetId,
          });
          return { id, result: r };
        } catch { return { id, result: {} }; }
      }
      default:
        return null;
    }
  }

  // ── Runtime domain ──────────────────────────────────────────────

  async #handleRuntime(id, method, params, client, session) {
    switch (method) {
      case "Runtime.runIfWaitingForDebugger":
      case "Runtime.addBinding":
      case "Runtime.removeBinding":
        return { id, result: {} };
      case "Runtime.enable": {
        // Use the target's known URL for origin — lastSnapshot may not be populated yet
        const pageUrl = session.lastSnapshot?.url || session.target?.url || "";
        let pageOrigin = "";
        try { pageOrigin = new URL(pageUrl).origin; } catch { pageOrigin = pageUrl; }
        this.#send(client, {
          method: "Runtime.executionContextCreated",
          params: {
            context: {
              id: 1,
              origin: pageOrigin,
              name: "top",
              uniqueId: `mobile-context-${client.targetId}`,
              auxData: {
                isDefault: true,
                type: "default",
                frameId: MAIN_FRAME_ID,
              },
            },
          },
        });
        return { id, result: {} };
      }
      case "Runtime.evaluate": {
        // Use native WebKit Runtime.evaluate for full fidelity (objectId, exceptions, etc.)
        try {
          // If awaitPromise, wrap the expression to resolve the promise
          let expression = params.expression;
          const wkParams = {
            expression,
            objectGroup: params.objectGroup || "console",
            includeCommandLineAPI: params.includeCommandLineAPI || false,
            doNotPauseOnExceptionsAndMuteConsole: params.silent || false,
            returnByValue: params.returnByValue || false,
            generatePreview: params.generatePreview || false,
            saveResult: params.saveResult || false,
            emulateUserGesture: params.userGesture || false,
          };
          let nativeResult;
          if (params.awaitPromise) {
            // WebKit doesn't have awaitPromise. Wrap expression to resolve inline.
            // Use an async IIFE that awaits and returns the value directly.
            wkParams.expression = `(async()=>{return await(${expression})})()
              .then(v=>(typeof v==='object'&&v!==null)?JSON.stringify(v):v)`;
            // First get the promise
            const promiseResult = await session.rawWir.sendCommand("Runtime.evaluate", {
              ...wkParams, returnByValue: false,
            });
            // Try Runtime.awaitPromise (WebKit may support it)
            if (promiseResult?.result?.objectId) {
              try {
                nativeResult = await session.rawWir.sendCommand("Runtime.awaitPromise", {
                  promiseObjectId: promiseResult.result.objectId,
                  returnByValue: params.returnByValue || false,
                  generatePreview: params.generatePreview || false,
                });
              } catch {
                // awaitPromise not supported — fallback: evaluate directly with await
                nativeResult = await session.rawWir.sendCommand("Runtime.evaluate", {
                  ...wkParams,
                  expression: `(async()=>{return await(${expression})})().then(v=>v)`,
                  returnByValue: params.returnByValue || false,
                });
              }
            } else {
              nativeResult = promiseResult;
            }
          } else {
            nativeResult = await session.rawWir.sendCommand("Runtime.evaluate", wkParams);
          }
          // Translate WebKit result to CDP format
          const result = {};
          if (nativeResult?.result) {
            result.result = {
              type: nativeResult.result.type,
              subtype: nativeResult.result.subtype,
              value: nativeResult.result.value,
              description: nativeResult.result.description || "",
              className: nativeResult.result.className,
              objectId: nativeResult.result.objectId,
            };
            if (nativeResult.result.preview) {
              result.result.preview = nativeResult.result.preview;
            }
          }
          if (nativeResult?.wasThrown) {
            result.exceptionDetails = {
              exceptionId: 1,
              text: nativeResult.result?.description || "Thrown",
              lineNumber: 0,
              columnNumber: 0,
              exception: result.result,
            };
          }
          return { id, result };
        } catch {
          // Fallback to session.evaluate for compatibility
          try {
            const evalResult = await session.evaluate(params.expression);
            return { id, result: { result: evalResult } };
          } catch (err2) {
            return { id, result: { result: { type: "undefined" }, exceptionDetails: { exceptionId: 1, text: err2.message, lineNumber: 0, columnNumber: 0 } } };
          }
        }
      }
      case "Runtime.releaseObject":
        try { await session.rawWir.sendCommand("Runtime.releaseObject", { objectId: params.objectId }); } catch {}
        return { id, result: {} };
      case "Runtime.releaseObjectGroup":
        try { await session.rawWir.sendCommand("Runtime.releaseObjectGroup", { objectGroup: params.objectGroup }); } catch {}
        return { id, result: {} };
      case "Runtime.getProperties": {
        const objectId = params.objectId || "";
        // Check scope cache first
        if (client.scopeCache?.has(objectId)) {
          return { id, result: { result: client.scopeCache.get(objectId) } };
        }
        // For node references, return empty
        if (objectId.startsWith("node:")) {
          return { id, result: { result: [] } };
        }
        // Use native Runtime.getProperties for WebKit objectIds and scope objects
        try {
          const nativeResult = await session.rawWir.sendCommand("Runtime.getProperties", {
            objectId,
            ownProperties: params.ownProperties !== false,
            generatePreview: params.generatePreview || false,
            fetchStart: params.fetchStart,
            fetchCount: params.fetchCount,
          });
          // Translate WebKit property descriptors to CDP format
          const properties = (nativeResult?.properties || []).map(p => ({
            name: p.name,
            value: p.value ? {
              type: p.value.type,
              subtype: p.value.subtype,
              value: p.value.value,
              description: p.value.description || "",
              className: p.value.className || "",
              objectId: p.value.objectId,
              preview: p.value.preview ? {
                type: p.value.preview.type,
                subtype: p.value.preview.subtype,
                description: p.value.preview.description || "",
                overflow: p.value.preview.overflow || false,
                properties: (p.value.preview.properties || []).map(pp => ({
                  name: pp.name,
                  type: pp.type,
                  value: pp.value !== undefined ? String(pp.value) : undefined,
                  subtype: pp.subtype,
                })),
              } : undefined,
            } : { type: "undefined" },
            writable: p.writable !== false,
            configurable: p.configurable !== false,
            enumerable: p.enumerable !== false,
            isOwn: p.isOwn !== false,
          }));
          // WebKit doesn't return 'length' for arrays with ownProperties — Chrome does.
          // Add it if there are index properties but no length.
          const hasIndexProps = properties.some(p => /^\d+$/.test(p.name));
          const hasLength = properties.some(p => p.name === "length");
          if (hasIndexProps && !hasLength) {
            const count = properties.filter(p => /^\d+$/.test(p.name)).length;
            properties.push({
              name: "length",
              value: { type: "number", value: count, description: String(count) },
              writable: true,
              configurable: false,
              enumerable: false,
              isOwn: true,
            });
          }
          const internalProperties = (nativeResult?.internalProperties || []).map(p => ({
            name: p.name,
            value: p.value ? {
              type: p.value.type,
              subtype: p.value.subtype,
              value: p.value.value,
              description: p.value.description || "",
              objectId: p.value.objectId,
            } : { type: "undefined" },
          }));
          return { id, result: { result: properties, internalProperties } };
        } catch (e) {
          this.logger.debug(`getProperties failed for ${objectId}: ${e.message}`);
          return { id, result: { result: [] } };
        }
      }
      case "Runtime.callFunctionOn": {
        try {
          const nativeResult = await session.rawWir.sendCommand("Runtime.callFunctionOn", {
            objectId: params.objectId,
            functionDeclaration: params.functionDeclaration,
            arguments: params.arguments,
            returnByValue: params.returnByValue,
            generatePreview: params.generatePreview,
            objectGroup: params.objectGroup,
          });
          if (nativeResult?.wasThrown) {
            return { id, result: {
              result: nativeResult?.result || { type: "undefined" },
              exceptionDetails: { text: nativeResult?.result?.description || "Error", exceptionId: 1, lineNumber: 0, columnNumber: 0 },
            } };
          }
          const r = nativeResult?.result || { type: "undefined" };
          // Ensure returnByValue semantics match Chrome
          if (params.returnByValue && r.objectId) {
            delete r.objectId;
          }
          return { id, result: { result: r } };
        } catch (error) {
          // Fallback to evaluate for expressions without objectId
          if (!params.objectId) {
            try {
              const callArgs = (params.arguments || []).map(a => {
                if (a.value !== undefined) return JSON.stringify(a.value);
                return "undefined";
              }).join(", ");
              const callResult = await session.evaluate(
                "(function() { var fn = " + params.functionDeclaration + "; return fn(" + callArgs + "); })()"
              );
              return { id, result: { result: callResult } };
            } catch {}
          }
          return { id, result: { result: { type: "undefined" } } };
        }
      }
      default:
        return null;
    }
  }

  // ── Debugger domain ─────────────────────────────────────────────

  async #handleDebugger(id, method, params, client, session) {
    switch (method) {
      case "Debugger.enable": {
        client.debuggerEnabled = true;
        // Ensure native debugger is enabled with full capabilities
        if (!session.nativeDebuggerEnabled) {
          try {
            await session.rawWir.sendCommand("Debugger.enable");
            session.nativeDebuggerEnabled = true;
            await session.rawWir.sendCommand("Debugger.setBreakpointsActive", { active: true }).catch(() => {});
            await session.rawWir.sendCommand("Debugger.setPauseOnDebuggerStatements", { enabled: true }).catch(() => {});
          } catch {}
        }
        // Drain any buffered scriptParsed events into the cache
        session.drainNativeScriptsParsed();
        // Send all known scripts from the deduplicated cache (no duplicates)
        for (const [scriptId, script] of session.scriptCacheData) {
          this.#send(client, {
            method: "Debugger.scriptParsed",
            params: this.#translateScriptParsed({ scriptId, ...script }),
          });
        }
        return { id, result: { debuggerId: "mobile-debugger" } };
      }
      case "Debugger.disable":
        client.debuggerEnabled = false;
        return { id, result: {} };
      case "Debugger.pause":
        try { await session.sendNativeDebuggerCommand("Debugger.pause"); } catch {}
        return { id, result: {} };
      case "Debugger.resume":
        try { await session.sendNativeDebuggerCommand("Debugger.resume"); } catch {}
        client.lastPauseEvent = null;
        this.#send(client, { method: "Debugger.resumed", params: {} });
        return { id, result: {} };
      case "Debugger.stepInto":
        try { await session.sendNativeDebuggerCommand("Debugger.stepInto"); } catch {}
        this.#send(client, { method: "Debugger.resumed", params: {} });
        return { id, result: {} };
      case "Debugger.stepOver":
        try { await session.sendNativeDebuggerCommand("Debugger.stepOver"); } catch {}
        this.#send(client, { method: "Debugger.resumed", params: {} });
        return { id, result: {} };
      case "Debugger.stepOut":
        try { await session.sendNativeDebuggerCommand("Debugger.stepOut"); } catch {}
        this.#send(client, { method: "Debugger.resumed", params: {} });
        return { id, result: {} };
      case "Debugger.setBreakpointByUrl": {
        try {
          const bpParams = {
            url: params.url,
            lineNumber: params.lineNumber,
            columnNumber: params.columnNumber,
          };
          if (params.urlRegex) bpParams.urlRegex = params.urlRegex;
          if (params.condition) bpParams.options = { condition: params.condition };
          const result = await session.sendNativeDebuggerCommand("Debugger.setBreakpointByUrl", bpParams);
          return { id, result: { breakpointId: result.breakpointId || `bp-${Date.now()}`, locations: result.locations || [] } };
        } catch (e) {
          return { id, result: { breakpointId: `bp-${Date.now()}`, locations: [] } };
        }
      }
      case "Debugger.setBreakpoint": {
        try {
          const loc = params.location || {};
          // Try native Debugger.setBreakpoint first (WebKit supports this directly)
          try {
            const bpParams = {
              location: { scriptId: String(loc.scriptId), lineNumber: loc.lineNumber || 0, columnNumber: loc.columnNumber || 0 },
            };
            if (params.condition) bpParams.options = { condition: params.condition };
            const nativeResult = await Promise.race([
              session.sendNativeDebuggerCommand("Debugger.setBreakpoint", bpParams),
              new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
            ]);
            if (nativeResult?.breakpointId) {
              return { id, result: {
                breakpointId: nativeResult.breakpointId,
                actualLocation: nativeResult.actualLocation || nativeResult.location || loc,
              } };
            }
          } catch {}
          // Fallback: convert to setBreakpointByUrl
          const scriptData = session.scriptCacheData?.get(String(loc.scriptId));
          if (scriptData?.url) {
            const result = await Promise.race([
              session.sendNativeDebuggerCommand("Debugger.setBreakpointByUrl", {
                url: scriptData.url,
                lineNumber: loc.lineNumber || 0,
                columnNumber: loc.columnNumber,
              }),
              new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
            ]);
            return { id, result: {
              breakpointId: result.breakpointId,
              actualLocation: result.locations?.[0] || loc,
            } };
          }
          return { id, result: { breakpointId: `bp-${loc.scriptId}-${loc.lineNumber}`, actualLocation: loc } };
        } catch {
          const loc = params.location || {};
          return { id, result: { breakpointId: `bp-${loc.scriptId || Date.now()}-${loc.lineNumber || 0}`, actualLocation: loc } };
        }
      }
      case "Debugger.removeBreakpoint":
        try { await session.sendNativeDebuggerCommand("Debugger.removeBreakpoint", { breakpointId: params.breakpointId }); } catch {}
        return { id, result: {} };
      case "Debugger.setPauseOnExceptions": {
        // WebKit uses separate commands for exceptions vs debugger statements
        const state = params.state || "none";
        try {
          if (state === "all") {
            await session.sendNativeDebuggerCommand("Debugger.setPauseOnExceptions", { state: "all" });
          } else if (state === "uncaught") {
            await session.sendNativeDebuggerCommand("Debugger.setPauseOnExceptions", { state: "uncaught" });
          } else {
            await session.sendNativeDebuggerCommand("Debugger.setPauseOnExceptions", { state: "none" });
          }
        } catch {}
        return { id, result: {} };
      }
      case "Debugger.setBreakpointsActive":
        try { await session.sendNativeDebuggerCommand("Debugger.setBreakpointsActive", { active: params.active !== false }); } catch {}
        return { id, result: {} };
      case "Debugger.getScriptSource": {
        const source = await session.getNativeScriptSource(params.scriptId);
        return { id, result: { scriptSource: source } };
      }
      case "Debugger.getPossibleBreakpoints": {
        try {
          const pbpResult = await session.sendNativeDebuggerCommand("Debugger.getPossibleBreakpoints", {
            start: params.start,
            end: params.end,
          });
          // WebKit returns { locations: [{ scriptId, lineNumber, columnNumber }] }
          return { id, result: { locations: (pbpResult?.locations || []).map(l => ({
            scriptId: String(l.scriptId),
            lineNumber: l.lineNumber,
            columnNumber: l.columnNumber || 0,
          })) } };
        } catch {
          // Fallback: return the start location as the only possible breakpoint
          return { id, result: { locations: params.start ? [params.start] : [] } };
        }
      }
      case "Debugger.setAsyncCallStackDepth":
        try { await session.sendNativeDebuggerCommand("Debugger.setAsyncStackTraceDepth", { maxDepth: params.maxDepth || 0 }); } catch {}
        return { id, result: {} };
      case "Debugger.setBlackboxPatterns":
      case "Debugger.setBlackboxedRanges":
        return { id, result: {} };
      case "Debugger.evaluateOnCallFrame": {
        // Map CDP callFrameId back to WebKit's native callFrameId
        const webkitFrameId = client.callFrameMap?.get(params.callFrameId) ?? params.callFrameId;
        try {
          const result = await session.sendNativeDebuggerCommand("Debugger.evaluateOnCallFrame", {
            callFrameId: webkitFrameId,
            expression: params.expression,
            objectGroup: params.objectGroup || "console",
            generatePreview: params.generatePreview !== false,
            returnByValue: params.returnByValue,
          });
          // Handle WebKit error format
          if (result?.wasThrown) {
            return { id, result: {
              result: { type: "object", subtype: "error", className: "Error", description: result?.result?.description || "Error" },
              exceptionDetails: { exceptionId: 1, text: result?.result?.description || "Error", lineNumber: 0, columnNumber: 0 },
            } };
          }
          return { id, result: { result: result?.result || { type: "undefined" } } };
        } catch (e) {
          // Fallback to global evaluate
          return { id, result: { result: await session.evaluate(params.expression) } };
        }
      }
      default:
        return null;
    }
  }

  // ── Page domain ─────────────────────────────────────────────────

  async #handlePage(id, method, params, client, session) {
    switch (method) {
      case "Page.enable":
        client.domObserverEnabled = true;
        await session.startDomObserver();
        await this.#emitPageLifecycle(client);
        return { id, result: {} };
      case "Page.addScriptToEvaluateOnNewDocument":
      case "Page.setAdBlockingEnabled":
        return { id, result: {} };
      case "Page.getResourceTree": {
        const rtUrl = session.lastSnapshot?.url || session.target?.url || "about:blank";
        let rtOrigin = "";
        try { rtOrigin = new URL(rtUrl).origin; } catch {}
        // Build resources list from known scripts and the page itself
        const resources = [{ url: rtUrl, type: "Document", mimeType: "text/html", contentSize: 0 }];
        for (const [, script] of session.scriptCacheData) {
          if (script.url && script.url !== rtUrl) {
            resources.push({ url: script.url, type: "Script", mimeType: "application/javascript", contentSize: 0 });
          }
        }
        return {
          id,
          result: {
            frameTree: {
              frame: {
                id: MAIN_FRAME_ID,
                loaderId: MAIN_LOADER_ID,
                url: rtUrl,
                domainAndRegistry: "",
                securityOrigin: rtOrigin,
                mimeType: "text/html",
              },
              resources,
            },
          },
        };
      }
      case "Page.getFrameTree": {
        const ftUrl = session.lastSnapshot?.url || session.target?.url || "about:blank";
        let ftOrigin = "";
        try { ftOrigin = new URL(ftUrl).origin; } catch {}
        return {
          id,
          result: {
            frameTree: {
              frame: {
                id: MAIN_FRAME_ID,
                loaderId: MAIN_LOADER_ID,
                url: ftUrl,
                domainAndRegistry: "",
                securityOrigin: ftOrigin,
                mimeType: "text/html",
              },
            },
          },
        };
      }
      case "Page.getNavigationHistory":
        return {
          id,
          result: {
            currentIndex: 0,
            entries: [
              {
                id: 0,
                url: session.lastSnapshot?.url || "about:blank",
                userTypedURL: session.lastSnapshot?.url || "about:blank",
                title: session.lastSnapshot?.title || "Mobile Safari",
                transitionType: "typed",
              },
            ],
          },
        };
      case "Page.navigate": {
        client.scopeCache.clear();
        client.callFrameMap.clear();
        const result = await session.navigate(params.url);
        await this.#emitPageLifecycle(client);
        return { id, result };
      }
      case "Page.stopLoading":
        return { id, result: {} };
      case "Page.reload": {
        client.scopeCache.clear();
        client.callFrameMap.clear();
        if (params.ignoreCache) {
          try { await session.rawWir.sendCommand("Network.setResourceCachingDisabled", { disabled: true }); } catch {}
        }
        // Use native Page.reload
        try {
          await session.rawWir.sendCommand("Page.reload", { ignoreCache: params.ignoreCache || false });
        } catch {
          // Fallback to re-navigating
          const currentUrl = session.lastSnapshot?.url || session.target?.url || "about:blank";
          await session.navigate(currentUrl);
        }
        if (params.ignoreCache) {
          try { await session.rawWir.sendCommand("Network.setResourceCachingDisabled", { disabled: false }); } catch {}
        }
        await this.#emitPageLifecycle(client);
        return { id, result: {} };
      }
      case "Page.getLayoutMetrics":
        return { id, result: await session.getLayoutMetrics() };
      case "Page.startScreencast": {
        // Screencast only works for simulators (via simctl screenshot).
        // Real devices don't have a screenshot API — skip to avoid
        // showing blank/corrupted preview in DevTools.
        if (session.target?.type === "simulator") {
          const maxWidth = params.maxWidth || 800;
          const maxHeight = params.maxHeight || 600;
          const interval = params.everyNthFrame || 3;
          client.screencastTimer = setInterval(async () => {
            try {
              const data = await session.captureScreenshot("jpeg");
              if (data) {
                this.#send(client, {
                  method: "Page.screencastFrame",
                  params: {
                    data,
                    metadata: {
                      offsetTop: 0,
                      pageScaleFactor: 1,
                      deviceWidth: maxWidth,
                      deviceHeight: maxHeight,
                      scrollOffsetX: 0,
                      scrollOffsetY: 0,
                      timestamp: Date.now() / 1000,
                    },
                    sessionId: 1,
                  },
                });
              }
            } catch {}
          }, interval * 500);
        }
        return { id, result: {} };
      }
      case "Page.stopScreencast":
        if (client.screencastTimer) {
          clearInterval(client.screencastTimer);
          client.screencastTimer = null;
        }
        return { id, result: {} };
      case "Page.screencastFrameAck":
        return { id, result: {} };
      case "Page.getResourceContent": {
        // Fetch resource content via page-side XHR
        const resourceUrl = params.url || "";
        try {
          const content = await session.evaluate(`
            (function() {
              var url = ${JSON.stringify(resourceUrl)};
              if (!url || url === "about:blank") return document.documentElement.outerHTML;
              try {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url, false);
                xhr.send(null);
                return xhr.status === 200 ? xhr.responseText : null;
              } catch(e) {
                return document.documentElement.outerHTML;
              }
            })()
          `);
          return {
            id,
            result: {
              content: content?.value || content?.description || "",
              base64Encoded: false,
            },
          };
        } catch {
          return { id, result: { content: "", base64Encoded: false } };
        }
      }
      case "Page.captureScreenshot": {
        try {
          const screenshotData = await session.captureScreenshot(params.format || "png");
          return { id, result: { data: screenshotData } };
        } catch (error) {
          return { id, result: { data: "" }, error: { message: error?.message || "Screenshot failed" } };
        }
      }
      case "Page.getCookies": {
        try {
          const cookies = await session.rawWir.sendCommand("Page.getCookies", {});
          return { id, result: { cookies: cookies?.cookies || [] } };
        } catch { return { id, result: { cookies: [] } }; }
      }
      case "Page.setCookie":
        try { await session.rawWir.sendCommand("Page.setCookie", params); } catch {}
        return { id, result: { success: true } };
      case "Page.deleteCookie":
        try { await session.rawWir.sendCommand("Page.deleteCookie", { cookieName: params.cookieName, url: params.url }); } catch {}
        return { id, result: {} };
      case "Page.setEmulatedMedia":
        try { await session.rawWir.sendCommand("Page.setEmulatedMedia", { media: params.media || "" }); } catch {}
        return { id, result: {} };
      case "Page.setShowPaintRects":
        try { await session.rawWir.sendCommand("Page.setShowPaintRects", { result: params.result }); } catch {}
        return { id, result: {} };
      case "Page.overrideUserAgent":
        try { await session.rawWir.sendCommand("Page.overrideUserAgent", { value: params.userAgent }); } catch {}
        return { id, result: {} };
      case "Page.overrideSetting":
        try { await session.rawWir.sendCommand("Page.overrideSetting", params); } catch {}
        return { id, result: {} };
      case "Page.searchInResource": {
        try {
          const sr = await session.rawWir.sendCommand("Page.searchInResource", {
            frameId: params.frameId || "0.1",
            url: params.url,
            query: params.query,
            caseSensitive: params.caseSensitive,
            isRegex: params.isRegex,
          });
          return { id, result: { result: sr?.result || [] } };
        } catch { return { id, result: { result: [] } }; }
      }
      case "Page.searchInResources": {
        try {
          const sr = await session.rawWir.sendCommand("Page.searchInResources", {
            text: params.query || params.text,
            caseSensitive: params.caseSensitive,
            isRegex: params.isRegex,
          });
          return { id, result: { result: sr?.result || [] } };
        } catch { return { id, result: { result: [] } }; }
      }
      case "Page.setBootstrapScript":
        try { await session.rawWir.sendCommand("Page.setBootstrapScript", { source: params.source }); } catch {}
        return { id, result: {} };
      default:
        return null;
    }
  }

  // ── Network domain ──────────────────────────────────────────────

  async #handleNetwork(id, method, params, client, session) {
    switch (method) {
      case "Network.enable":
      case "Network.setAttachDebugStack":
        client.domObserverEnabled = true;
        await session.startDomObserver();
        return { id, result: {} };
      case "Network.disable":
        return { id, result: {} };
      case "Network.getResponseBody": {
        const body = await session.getResponseBody(params.requestId);
        return { id, result: body };
      }
      case "Network.setBlockedURLs":
      case "Network.emulateNetworkConditions":
      case "Network.emulateNetworkConditionsByRule":
      case "Network.overrideNetworkState":
      case "Network.clearAcceptedEncodingsOverride":
        return { id, result: {} };
      case "Network.setCacheDisabled":
        try { await session.rawWir.sendCommand("Network.setResourceCachingDisabled", { disabled: params.cacheDisabled }); } catch {}
        return { id, result: {} };
      case "Network.setExtraHTTPHeaders":
        try { await session.rawWir.sendCommand("Network.setExtraHTTPHeaders", { headers: params.headers }); } catch {}
        return { id, result: {} };
      case "Network.getSerializedCertificate": {
        try {
          const cert = await session.rawWir.sendCommand("Network.getSerializedCertificate", { requestId: params.requestId });
          return { id, result: cert };
        } catch { return { id, result: { tableNames: [] } }; }
      }
      default:
        return null;
    }
  }

  // ── Overlay domain ──────────────────────────────────────────────

  async #handleOverlay(id, method, params, client, session) {
    switch (method) {
      case "Overlay.enable":
      case "Overlay.disable":
        return { id, result: {} };
      case "Overlay.highlightNode": {
        const hlNodeId = params.nodeId || params.backendNodeId;
        if (hlNodeId) {
          session.highlightNode(hlNodeId, params.highlightConfig).catch(() => {});
        }
        return { id, result: {} };
      }
      case "Overlay.highlightRect":
        session.highlightRect(params.x, params.y, params.width, params.height, params.color).catch(() => {});
        return { id, result: {} };
      case "Overlay.hideHighlight":
        session.hideHighlight().catch(() => {});
        return { id, result: {} };
      case "Overlay.setShowViewportSizeOnResize":
      case "Overlay.setShowGridOverlays":
      case "Overlay.setShowFlexOverlays":
      case "Overlay.setShowScrollSnapOverlays":
      case "Overlay.setShowContainerQueryOverlays":
      case "Overlay.setShowIsolatedElements":
        return { id, result: {} };
      default:
        return null;
    }
  }

  // ── Animation domain ────────────────────────────────────────────

  async #handleAnimation(id, method, params, client, session) {
    switch (method) {
      case "Animation.enable": {
        client.animationDomainEnabled = true;
        // Install lightweight animation tracker via Runtime.evaluate
        try {
          await session.rawWir.sendCommand("Runtime.evaluate", {
            expression: `(() => {
              if (window.__cdtAnimTracker) return;
              const t = window.__cdtAnimTracker = { ids: new WeakMap(), nextId: 1, known: {}, rate: 1 };
              t.getId = (a) => { let i = t.ids.get(a); if (!i) { i = "anim:" + t.nextId++; t.ids.set(a, i); } return i; };
              t.snap = (a) => {
                const e = a.effect, tm = e?.getTiming?.() || {}, kf = e?.getKeyframes?.() || [];
                return { id: t.getId(a), name: a.animationName || a.transitionProperty || a.id || a.constructor?.name || "animation",
                  pausedState: a.playState === "paused", playState: a.playState || "idle",
                  playbackRate: a.playbackRate ?? 1, startTime: a.startTime, currentTime: a.currentTime,
                  type: a.constructor?.name?.includes("CSSAnimation") ? "CSSAnimation" : a.constructor?.name?.includes("Transition") ? "CSSTransition" : "WebAnimation",
                  cssId: "", source: { delay: Number(tm.delay||0), endDelay: Number(tm.endDelay||0),
                    duration: typeof tm.duration === "number" ? tm.duration : parseFloat(tm.duration)||0,
                    iterations: Number.isFinite(Number(tm.iterations)) ? Number(tm.iterations) : -1,
                    direction: tm.direction||"normal", fill: tm.fill||"none", easing: tm.easing||"linear",
                    backendNodeId: 0, keyframesRule: { name: a.animationName||"", keyframes: kf.map(k=>({
                      offset: typeof k.offset==="number"?Math.round(k.offset*100)+"%":"0%", easing: k.easing||"linear" })) } } };
              };
            })()`,
            returnByValue: true,
          });
        } catch {}
        // Scan for existing animations and emit animationStarted events
        try {
          const result = await session.rawWir.sendCommand("Runtime.evaluate", {
            expression: `(() => {
              const t = window.__cdtAnimTracker; if (!t) return [];
              return document.getAnimations({subtree:true}).map(a => {
                const s = t.snap(a); t.known[s.id] = true; return s;
              });
            })()`,
            returnByValue: true,
          });
          for (const anim of result?.result?.value || []) {
            // Fix Chrome-incompatible fields
            if (anim.source) {
              if (anim.source.iterations === null) anim.source.iterations = Infinity;
              // Add keyframe values if missing
              if (anim.source.keyframesRule?.keyframes) {
                anim.source.keyframesRule.keyframes = anim.source.keyframesRule.keyframes.map(k => ({
                  ...k, value: k.value || "",
                }));
              }
            }
            this.#send(client, { method: "Animation.animationCreated", params: { id: anim.id } });
            this.#send(client, { method: "Animation.animationStarted", params: { animation: anim } });
          }
        } catch {}
        return { id, result: {} };
      }
      case "Animation.disable":
        client.animationDomainEnabled = false;
        return { id, result: {} };
      case "Animation.getCurrentTime": {
        try {
          const r = await session.rawWir.sendCommand("Runtime.evaluate", {
            expression: `(() => { const t = window.__cdtAnimTracker; if (!t) return 0; for (const a of document.getAnimations({subtree:true})) { if (t.getId(a) === ${JSON.stringify(params.id)}) return a.currentTime; } return 0; })()`,
            returnByValue: true,
          });
          return { id, result: { currentTime: r?.result?.value ?? 0 } };
        } catch { return { id, result: { currentTime: 0 } }; }
      }
      case "Animation.getPlaybackRate": {
        try {
          const r = await session.rawWir.sendCommand("Runtime.evaluate", {
            expression: "window.__cdtAnimTracker?.rate || 1",
            returnByValue: true,
          });
          return { id, result: { playbackRate: r?.result?.value ?? 1 } };
        } catch { return { id, result: { playbackRate: 1 } }; }
      }
      case "Animation.releaseAnimations":
        return { id, result: {} };
      case "Animation.resolveAnimation": {
        try {
          const r = await session.rawWir.sendCommand("Runtime.evaluate", {
            expression: `(() => { const t = window.__cdtAnimTracker; if (!t) return null; for (const a of document.getAnimations({subtree:true})) { if (t.getId(a) === ${JSON.stringify(params.animationId)}) return a; } return null; })()`,
          });
          return { id, result: { remoteObject: r?.result || { type: "object", className: "Animation", description: "Animation" } } };
        } catch { return { id, result: { remoteObject: { type: "object", className: "Animation" } } }; }
      }
      case "Animation.seekAnimations": {
        const ids = JSON.stringify(params.animations || []);
        const time = params.currentTime || 0;
        try {
          await session.rawWir.sendCommand("Runtime.evaluate", {
            expression: `(() => { const t = window.__cdtAnimTracker; if (!t) return; const ids = new Set(${ids}); for (const a of document.getAnimations({subtree:true})) { if (ids.has(t.getId(a))) { try { a.currentTime = ${time}; } catch{} } } })()`,
            returnByValue: true,
          });
        } catch {}
        return { id, result: {} };
      }
      case "Animation.setPaused": {
        const ids = JSON.stringify(params.animations || []);
        const paused = !!params.paused;
        try {
          await session.rawWir.sendCommand("Runtime.evaluate", {
            expression: `(() => { const t = window.__cdtAnimTracker; if (!t) return; const ids = new Set(${ids}); for (const a of document.getAnimations({subtree:true})) { if (ids.has(t.getId(a))) { try { ${paused} ? a.pause() : (a.play(), a.playbackRate = t.rate); } catch{} } } })()`,
            returnByValue: true,
          });
        } catch {}
        return { id, result: {} };
      }
      case "Animation.setPlaybackRate": {
        const rate = params.playbackRate || 1;
        try {
          await session.rawWir.sendCommand("Runtime.evaluate", {
            expression: `(() => { const t = window.__cdtAnimTracker; if (!t) return; t.rate = ${rate}; for (const a of document.getAnimations({subtree:true})) { try { a.playbackRate = ${rate}; } catch{} } })()`,
            returnByValue: true,
          });
        } catch {}
        return { id, result: {} };
      }
      case "Animation.setTiming":
        return { id, result: {} };
      default:
        return null;
    }
  }

  // ── DOMDebugger domain ──────────────────────────────────────────

  async #handleDOMDebugger(id, method, params, client, session) {
    switch (method) {
      case "DOMDebugger.setDOMBreakpoint":
        try { await session.rawWir.sendCommand("DOMDebugger.setDOMBreakpoint", { nodeId: params.nodeId, type: params.type }); } catch {}
        return { id, result: {} };
      case "DOMDebugger.removeDOMBreakpoint":
        try { await session.rawWir.sendCommand("DOMDebugger.removeDOMBreakpoint", { nodeId: params.nodeId, type: params.type }); } catch {}
        return { id, result: {} };
      case "DOMDebugger.setEventListenerBreakpoint":
      case "DOMDebugger.setEventBreakpoint":
        try { await session.rawWir.sendCommand("DOMDebugger.setEventBreakpoint", { eventName: params.eventName || params.eventType, caseSensitive: true, isRegex: false }); } catch {}
        return { id, result: {} };
      case "DOMDebugger.removeEventListenerBreakpoint":
      case "DOMDebugger.removeEventBreakpoint":
        try { await session.rawWir.sendCommand("DOMDebugger.removeEventBreakpoint", { eventName: params.eventName || params.eventType }); } catch {}
        return { id, result: {} };
      case "DOMDebugger.setXHRBreakpoint":
        try { await session.rawWir.sendCommand("DOMDebugger.setURLBreakpoint", { url: params.url, isRegex: params.isRegex || false }); } catch {}
        return { id, result: {} };
      case "DOMDebugger.removeXHRBreakpoint":
        try { await session.rawWir.sendCommand("DOMDebugger.removeURLBreakpoint", { url: params.url }); } catch {}
        return { id, result: {} };
      case "DOMDebugger.setInstrumentationBreakpoint":
      case "DOMDebugger.removeInstrumentationBreakpoint":
      case "DOMDebugger.setBreakOnCSPViolation":
        return { id, result: {} };
      default:
        return null;
    }
  }

  // ── Misc / small domains ────────────────────────────────────────

  async #handleMisc(id, method, params, client, session) {
    switch (method) {
      // ── Browser domain ──
      case "Browser.getVersion":
        return {
          id,
          result: {
            product: "MobileSafari/bridge",
            revision: client.targetId,
            userAgent: "Safari iOS Bridge",
            jsVersion: "JavaScriptCore",
            protocolVersion: "1.3",
          },
        };

      // ── Schema domain ──
      case "Schema.getDomains":
        return { id, result: { domains: [] } };

      // ── Target domain ──
      case "Target.setDiscoverTargets":
        return { id, result: {} };
      case "Target.setAutoAttach":
        // Session multiplexing: tell DevTools we've attached to the target.
        // This populates the Sources file tree.
        // Safe because: we strip sessionId from incoming and add to responses.
        if (params.flatten && !client.sessionId) {
          client.sessionId = client.targetId;
          this.#send(client, {
            method: "Target.attachedToTarget",
            params: {
              sessionId: client.sessionId,
              targetInfo: {
                targetId: client.targetId,
                type: "page",
                title: session.lastSnapshot?.title || session.target?.title || "",
                url: session.lastSnapshot?.url || session.target?.url || "",
                attached: true,
                canAccessOpener: false,
              },
              waitingForDebugger: false,
            },
          });
        }
        return { id, result: {} };
      case "Target.setRemoteLocations":
        return { id, result: {} };
      case "Target.getTargets":
        return {
          id,
          result: {
            targetInfos: [
              {
                targetId: client.targetId,
                type: "page",
                title: session.lastSnapshot?.title || "Mobile Safari",
                url: session.lastSnapshot?.url || "",
                attached: true,
                canAccessOpener: false,
                browserContextId: "default",
              },
            ],
          },
        };

      // ── Inspector domain ──
      case "Inspector.enable":
        return { id, result: {} };

      // ── Accessibility domain ──
      case "Accessibility.enable":
        return { id, result: {} };

      // ── Autofill domain ──
      case "Autofill.enable":
      case "Autofill.setAddresses":
        return { id, result: {} };

      // ── Audits domain ──
      case "Audits.enable":
        return { id, result: {} };

      // ── ServiceWorker domain ──
      case "ServiceWorker.enable":
        return { id, result: {} };

      // ── Emulation domain ──
      case "Emulation.setEmulatedVisionDeficiency":
      case "Emulation.setFocusEmulationEnabled":
      case "Emulation.setEmulatedMedia":
        // Forward to WebKit's Page.setEmulatedMedia for dark mode / print preview
        if (params.media || params.features?.length) {
          try {
            await session.rawWir.sendCommand("Page.setEmulatedMedia", {
              media: params.media || "",
            });
          } catch {}
        }
        return { id, result: {} };

      // ── Performance domain ──
      case "Performance.enable":
      case "Performance.disable":
        return { id, result: {} };
      case "Performance.getMetrics": {
        try {
          const metricsResult = await session.rawWir.sendCommand("Runtime.evaluate", {
            expression: `({
              Timestamp: performance.now() / 1000,
              Documents: document.querySelectorAll('*').length,
              JSHeapUsedSize: performance.memory?.usedJSHeapSize || 0,
              JSHeapTotalSize: performance.memory?.totalJSHeapSize || 0,
              Nodes: document.querySelectorAll('*').length,
              LayoutCount: 0,
              ScriptDuration: 0,
              TaskDuration: 0,
            })`,
            returnByValue: true,
          });
          const data = metricsResult?.result?.value || {};
          const metrics = Object.entries(data).map(([name, value]) => ({ name, value }));
          return { id, result: { metrics } };
        } catch {
          return { id, result: { metrics: [] } };
        }
      }

      // ── Profiler domain ──
      case "Profiler.enable":
      case "Profiler.disable":
      case "Profiler.setSamplingInterval":
        return { id, result: {} };
      case "Profiler.start": {
        client._profilerStartTime = Date.now();
        client._profilerTrackingData = null;
        try {
          // Listen for ScriptProfiler.trackingComplete event
          const trackingPromise = new Promise((resolve) => {
            const timeout = setTimeout(() => { session.rawWir.removeListener("event", handler); resolve(null); }, 30000);
            const handler = (method, params) => {
              if (method === "ScriptProfiler.trackingComplete") {
                clearTimeout(timeout);
                session.rawWir.removeListener("event", handler);
                resolve(params);
              }
            };
            session.rawWir.on("event", handler);
            client._profilerTrackingResolver = resolve;
          });
          client._profilerTrackingPromise = trackingPromise;
          await session.rawWir.sendCommand("ScriptProfiler.startTracking", { includeSamples: true });
        } catch {}
        return { id, result: {} };
      }
      case "Profiler.stop": {
        try {
          await session.rawWir.sendCommand("ScriptProfiler.stopTracking");
          // Wait for trackingComplete event (has the actual profiling data)
          const trackingData = await Promise.race([
            client._profilerTrackingPromise || Promise.resolve(null),
            new Promise(r => setTimeout(() => r(null), 5000)),
          ]);
          const profile = this.#buildChromeProfile(trackingData, client._profilerStartTime || Date.now(), session);
          client._profilerTrackingPromise = null;
          return { id, result: { profile } };
        } catch {
          return { id, result: { profile: { nodes: [{ id: 1, callFrame: { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 }, children: [] }], startTime: 0, endTime: 0, samples: [], timeDeltas: [] } } };
        }
      }

      // ── Tracing domain ──
      case "Tracing.start": {
        client.traceEvents = [];
        client.tracing = true;
        client.traceStartTime = Date.now();
        // Start WebKit Timeline recording in background (don't await — it may hang)
        session.rawWir.sendCommand("Timeline.enable", {})
          .then(() => session.rawWir.sendCommand("Timeline.start", {}))
          .catch(() => {});
        // Start ScriptProfiler for JS flame chart data
        client._profilerTrackingData = null;
        const profilerPromise = new Promise((resolve) => {
          const timeout = setTimeout(() => { session.rawWir.removeListener("event", handler); resolve(null); }, 60000);
          const handler = (method, params) => {
            if (method === "ScriptProfiler.trackingComplete") {
              clearTimeout(timeout);
              session.rawWir.removeListener("event", handler);
              resolve(params);
            }
          };
          session.rawWir.on("event", handler);
        });
        client._profilerTrackingPromise = profilerPromise;
        session.rawWir.sendCommand("ScriptProfiler.startTracking", { includeSamples: true }).catch(() => {});
        // Match Chrome's behavior: send only bufferUsage during recording,
        // send dataCollected + tracingComplete on Tracing.end
        const traceClient = client;
        // Send periodic bufferUsage events every 500ms while recording
        client._traceUsageTimer = setInterval(() => {
          const evtCount = traceClient.traceEvents?.length || 0;
          this.#send(traceClient, { method: "Tracing.bufferUsage", params: {
            percentFull: Math.min(0.5, evtCount / 10000),
            eventCount: evtCount,
            value: Math.min(0.5, evtCount / 10000),
          } });
        }, 500);
        return { id, result: {} };
      }
      case "Tracing.end": {
        client.tracing = false;
        // Stop buffer usage timer
        if (client._traceUsageTimer) { clearInterval(client._traceUsageTimer); client._traceUsageTimer = null; }
        // Stop Timeline in background
        session.rawWir.sendCommand("Timeline.stop", {}).catch(() => {});
        await new Promise(r => setTimeout(r, 200));
        // Drain remaining Timeline events
        const nativeOther = session.drainNativeOtherEvents();
        for (const evt of nativeOther) {
          if (evt.method === "Timeline.eventRecorded" && evt.params?.record) {
            this.#flattenTimelineRecord(evt.params.record, client.traceEvents, client.traceStartTime);
          }
        }
        const traceEvents = client.traceEvents || [];
        const startTs = (client.traceStartTime || Date.now()) * 1000;
        const pageUrl = session.lastSnapshot?.url || session.target?.url || "";

        // Also stop ScriptProfiler and collect JS profiling data
        let profileTraceEvents = [];
        try {
          session.rawWir.sendCommand("ScriptProfiler.stopTracking").catch(() => {});
          // Wait for trackingComplete event
          const trackingData = await Promise.race([
            client._profilerTrackingPromise || Promise.resolve(null),
            new Promise(r => setTimeout(() => r(null), 3000)),
          ]);
          if (trackingData?.samples?.stackTraces?.length) {
            const profile = this.#buildChromeProfile(trackingData, client.traceStartTime, session);
            // Add Profile + ProfileChunk trace events for the flame chart
            // Add (program) and (idle) nodes like Chrome does
            if (!profile.nodes.find(n => n.callFrame?.functionName === "(program)")) {
              const progId = profile.nodes.length + 1;
              const idleId = profile.nodes.length + 2;
              profile.nodes.push(
                { id: progId, callFrame: { codeType: "other", functionName: "(program)", scriptId: 0 }, parent: 1 },
                { id: idleId, callFrame: { codeType: "other", functionName: "(idle)", scriptId: 0 }, parent: 1 },
              );
            }
            profileTraceEvents.push(
              { cat: "disabled-by-default-v8.cpu_profiler", name: "Profile", ph: "P", pid: 1, tid: 1, ts: startTs, id: "0x1", args: { data: { startTime: profile.startTime } } },
              { cat: "disabled-by-default-v8.cpu_profiler", name: "ProfileChunk", ph: "P", pid: 1, tid: 1, ts: startTs, id: "0x1", args: {
                data: {
                  cpuProfile: { nodes: profile.nodes, samples: profile.samples },
                  timeDeltas: profile.timeDeltas,
                },
              } },
            );
          }
        } catch {}

        // Prepend metadata (matching Chrome's format)
        traceEvents.unshift(
          { cat: "__metadata", name: "thread_name", ph: "M", pid: 1, tid: 0, ts: 0, args: { name: "CrRendererMain" } },
          { cat: "__metadata", name: "process_name", ph: "M", pid: 1, tid: 0, ts: 0, args: { name: "Renderer" } },
          { cat: "disabled-by-default-devtools.timeline", name: "TracingStartedInBrowser", ph: "I", ts: startTs, pid: 1, tid: 0, s: "t", args: { data: { frameTreeNodeId: 1, persistentIds: true, frames: [{ frame: MAIN_FRAME_ID, url: pageUrl, name: "", processId: 1 }] } } },
        );
        // Add profile data to trace events
        traceEvents.push(...profileTraceEvents);
        // Build trace matching Chrome's exact format
        const endTs = Date.now() * 1000;
        const cleanEvents = [
          // Minimal metadata — match Chrome exactly
          { cat: "__metadata", name: "process_name", ph: "M", pid: 1, tid: 0, ts: 0, args: { name: "Browser" } },
          { cat: "__metadata", name: "thread_name", ph: "M", pid: 1, tid: 0, ts: 0, args: { name: "CrBrowserMain" } },
          { cat: "__metadata", name: "process_name", ph: "M", pid: 2, tid: 0, ts: 0, args: { name: "Renderer" } },
          { cat: "__metadata", name: "thread_name", ph: "M", pid: 2, tid: 1, ts: 0, args: { name: "CrRendererMain" } },
          { cat: "__metadata", name: "process_uptime_seconds", ph: "M", pid: 1, tid: 0, ts: 0, args: { uptime: 0 } },
          // TracingStartedInBrowser — use SEPARATE process for renderer
          { cat: "disabled-by-default-devtools.timeline", name: "TracingStartedInBrowser", ph: "I", ts: startTs, pid: 1, tid: 0, s: "t",
            args: { data: { frameTreeNodeId: 1, persistentIds: true, frames: [{ frame: MAIN_FRAME_ID, url: pageUrl, name: "", processId: 2 }] } } },
          // Empty RunTask on renderer
          { cat: "toplevel", name: "RunTask", ph: "X", pid: 2, tid: 1, ts: startTs, dur: endTs - startTs, args: {} },
        ];
        // Add profile events on the renderer process
        for (const pe of profileTraceEvents) { pe.pid = 2; pe.tid = 1; }
        cleanEvents.push(...profileTraceEvents);
        this.#send(client, { method: "Tracing.dataCollected", params: { value: cleanEvents } });
        this.#send(client, { method: "Tracing.tracingComplete", params: { dataLossOccurred: false } });
        session.rawWir.sendCommand("Timeline.disable", {}).catch(() => {});
        return { id, result: {} };
      }
      case "Tracing.getCategories":
        return { id, result: { categories: [
          "disabled-by-default-devtools.timeline",
          "devtools.timeline",
          "v8.execute",
          "blink.user_timing",
        ] } };

      // ── HeapProfiler / Heap domain ──
      case "HeapProfiler.enable":
        try { await session.rawWir.sendCommand("Heap.enable", {}); } catch {}
        return { id, result: {} };
      case "HeapProfiler.disable":
        try { await session.rawWir.sendCommand("Heap.disable", {}); } catch {}
        return { id, result: {} };
      case "HeapProfiler.collectGarbage":
        try { await session.rawWir.sendCommand("Heap.gc", {}); } catch {}
        return { id, result: {} };
      case "HeapProfiler.takeHeapSnapshot": {
        try {
          const snapshot = await session.rawWir.sendCommand("Heap.snapshot", {});
          if (snapshot?.snapshotData) {
            // Stream the snapshot data as chunks
            const data = snapshot.snapshotData;
            const chunkSize = 100000;
            for (let i = 0; i < data.length; i += chunkSize) {
              this.#send(client, {
                method: "HeapProfiler.addHeapSnapshotChunk",
                params: { chunk: data.slice(i, i + chunkSize) },
              });
            }
          }
        } catch {}
        return { id, result: {} };
      }

      // ── Input domain (stubs) ──
      case "Input.dispatchMouseEvent":
      case "Input.dispatchKeyEvent":
      case "Input.dispatchTouchEvent":
        return { id, result: {} };

      // ── Console / Log domain ──
      case "Console.enable":
      case "Console.disable":
        return { id, result: {} };
      case "Console.clearMessages":
        try { await session.rawWir.sendCommand("Console.clearMessages", {}); } catch {}
        return { id, result: {} };
      case "Log.enable":
      case "Log.disable":
        return { id, result: {} };
      case "Log.clear":
        try { await session.rawWir.sendCommand("Console.clearMessages", {}); } catch {}
        return { id, result: {} };
      case "Log.startViolationsReport":
        return { id, result: {} };

      // ── DOMStorage domain ──
      case "DOMStorage.enable":
        try { await session.rawWir.sendCommand("DOMStorage.enable", {}); } catch {}
        return { id, result: {} };
      case "DOMStorage.disable":
        try { await session.rawWir.sendCommand("DOMStorage.disable", {}); } catch {}
        return { id, result: {} };
      case "DOMStorage.getDOMStorageItems": {
        try {
          const items = await session.rawWir.sendCommand("DOMStorage.getDOMStorageItems", {
            storageId: params.storageId,
          });
          return { id, result: { entries: items?.entries || [] } };
        } catch { return { id, result: { entries: [] } }; }
      }
      case "DOMStorage.setDOMStorageItem":
        try { await session.rawWir.sendCommand("DOMStorage.setDOMStorageItem", params); } catch {}
        return { id, result: {} };
      case "DOMStorage.removeDOMStorageItem":
        try { await session.rawWir.sendCommand("DOMStorage.removeDOMStorageItem", params); } catch {}
        return { id, result: {} };

      // ── IndexedDB domain ──
      case "IndexedDB.enable":
        try { await session.rawWir.sendCommand("IndexedDB.enable", {}); } catch {}
        return { id, result: {} };
      case "IndexedDB.disable":
        try { await session.rawWir.sendCommand("IndexedDB.disable", {}); } catch {}
        return { id, result: {} };
      case "IndexedDB.requestDatabaseNames": {
        try {
          const r = await session.rawWir.sendCommand("IndexedDB.requestDatabaseNames", {
            securityOrigin: params.securityOrigin,
          });
          return { id, result: { databaseNames: r?.databaseNames || [] } };
        } catch { return { id, result: { databaseNames: [] } }; }
      }
      case "IndexedDB.requestDatabase": {
        try {
          const r = await session.rawWir.sendCommand("IndexedDB.requestDatabase", {
            securityOrigin: params.securityOrigin,
            databaseName: params.databaseName,
          });
          return { id, result: { databaseWithObjectStores: r?.databaseWithObjectStores || {} } };
        } catch { return { id, result: { databaseWithObjectStores: {} } }; }
      }
      case "IndexedDB.requestData": {
        try {
          const r = await session.rawWir.sendCommand("IndexedDB.requestData", params);
          return { id, result: r || { objectStoreDataEntries: [], hasMore: false } };
        } catch { return { id, result: { objectStoreDataEntries: [], hasMore: false } }; }
      }
      case "IndexedDB.clearObjectStore":
        try { await session.rawWir.sendCommand("IndexedDB.clearObjectStore", params); } catch {}
        return { id, result: {} };

      // ── LayerTree domain ──
      case "LayerTree.enable":
        try { await session.rawWir.sendCommand("LayerTree.enable", {}); } catch {}
        return { id, result: {} };
      case "LayerTree.disable":
        try { await session.rawWir.sendCommand("LayerTree.disable", {}); } catch {}
        return { id, result: {} };
      case "LayerTree.layersForNode": {
        try {
          const r = await session.rawWir.sendCommand("LayerTree.layersForNode", { nodeId: params.nodeId });
          return { id, result: r };
        } catch { return { id, result: { layers: [] } }; }
      }
      case "LayerTree.reasonsForCompositingLayer": {
        try {
          const r = await session.rawWir.sendCommand("LayerTree.reasonsForCompositingLayer", { layerId: params.layerId });
          return { id, result: r };
        } catch { return { id, result: { compositingReasons: {} } }; }
      }

      // ── Timeline domain ──
      case "Timeline.enable":
        try { await session.rawWir.sendCommand("Timeline.enable", {}); } catch {}
        return { id, result: {} };
      case "Timeline.disable":
        try { await session.rawWir.sendCommand("Timeline.disable", {}); } catch {}
        return { id, result: {} };
      case "Timeline.start":
        try { await session.rawWir.sendCommand("Timeline.start", {}); } catch {}
        return { id, result: {} };
      case "Timeline.stop":
        try { await session.rawWir.sendCommand("Timeline.stop", {}); } catch {}
        return { id, result: {} };

      // ── Memory domain ──
      case "Memory.enable":
        try { await session.rawWir.sendCommand("Memory.enable", {}); } catch {}
        return { id, result: {} };
      case "Memory.disable":
        try { await session.rawWir.sendCommand("Memory.disable", {}); } catch {}
        return { id, result: {} };
      case "Memory.startTracking":
        try { await session.rawWir.sendCommand("Memory.startTracking", {}); } catch {}
        return { id, result: {} };
      case "Memory.stopTracking":
        try { await session.rawWir.sendCommand("Memory.stopTracking", {}); } catch {}
        return { id, result: {} };

      // ── Storage domain ──
      case "Storage.getStorageKey": {
        const stUrl = session.lastSnapshot?.url || session.target?.url || "about:blank";
        let storageKey = "";
        try {
          storageKey = new URL(stUrl).origin;
        } catch {
          storageKey = stUrl;
        }
        return { id, result: { storageKey } };
      }

      default:
        // Return empty success for unhandled methods instead of error.
        // DevTools' internal state machines can block forever on error responses
        // (e.g., Runtime.removeBinding blocking Performance recording).
        // Empty success is always safe — DevTools handles missing data gracefully.
        this.logger.debug(`unhandled mobile cdp method ${method} → stub {}`);
        return { id, result: {} };
    }
  }

  #send(client, payload, { skipSessionId = false } = {}) {
    if (client.socket.readyState === client.socket.OPEN) {
      // Add sessionId to events for session multiplexing (flatten mode)
      // But skip for certain events that should be top-level
      if (!skipSessionId && client.sessionId && payload.method && !payload.sessionId) {
        payload = { ...payload, sessionId: client.sessionId };
      }
      client.socket.send(JSON.stringify(payload));
    }
  }

  // ── Native WebKit event translators ──────────────────────────────

  #broadcastNativeConsoleEvent(client, event) {
    // WebKit Console.messageAdded → CDP Runtime.consoleAPICalled + Log.entryAdded
    const msg = event.message || event;
    const level = msg.level || "log";
    const text = msg.text || "";
    // Map WebKit console type → CDP type (table, dir, dirxml, assert, etc.)
    const msgType = msg.type || "log";
    const cdpType = msgType === "log" ? (level === "warning" ? "warning" : level)
      : msgType === "dir" ? "dir"
      : msgType === "dirxml" ? "dirxml"
      : msgType === "table" ? "table"
      : msgType === "trace" ? "trace"
      : msgType === "assert" ? "assert"
      : msgType === "count" ? "count"
      : msgType === "timing" ? "timeEnd"
      : (level === "warning" ? "warning" : level);

    // Console events from native WebKit should NOT have sessionId —
    // DevTools filters console messages that come from a child session scope.
    // These are page-level events, not session-scoped.
    // Skip sessionId — DevTools filters console messages that have sessionId
    // because it treats them as belonging to a child target, not the main page.
    this.#send(client, {
      method: "Runtime.consoleAPICalled",
      params: {
        type: cdpType,
        args: (msg.parameters || [{ type: "string", value: text }]).map(p => {
          if (p.type) return p;
          return { type: "string", value: String(p) };
        }),
        executionContextId: 1,
        timestamp: (msg.timestamp || Date.now() / 1000) * 1000,
        stackTrace: {
          callFrames: (msg.stackTrace?.callFrames || msg.stackTrace || []).map(f => ({
            functionName: f.functionName || "",
            scriptId: String(f.scriptId || "0"),
            url: f.url || "",
            lineNumber: f.lineNumber || 0,
            columnNumber: f.columnNumber || 0,
          })),
        },
      },
    }, { skipSessionId: true });
    this.#send(client, {
      method: "Log.entryAdded",
      params: {
        entry: {
          source: msg.source === "network" ? "network" : "javascript",
          level: level === "debug" ? "verbose" : level,
          text,
          timestamp: (msg.timestamp || Date.now() / 1000) * 1000,
          url: msg.url || "",
          lineNumber: msg.line || 0,
        },
      },
    }, { skipSessionId: true });
  }

  #broadcastNativeNetworkEvent(client, { method, params }) {
    // Forward WebKit network events with enriched details
    // Skip sessionId — network events are page-level, not session-scoped
    const sendOpts = { skipSessionId: true };
    switch (method) {
      case "Network.requestWillBeSent":
        this.#send(client, {
          method: "Network.requestWillBeSent",
          params: {
            requestId: String(params.requestId),
            loaderId: String(params.loaderId || "root"),
            documentURL: params.documentURL || "",
            request: {
              url: params.request?.url || "",
              method: params.request?.method || "GET",
              headers: params.request?.headers || {},
              postData: params.request?.postData,
              hasPostData: !!params.request?.postData,
              mixedContentType: "none",
              initialPriority: params.request?.initialPriority || "High",
              referrerPolicy: params.request?.referrerPolicy || "strict-origin-when-cross-origin",
            },
            timestamp: params.timestamp,
            wallTime: params.wallTime || Date.now() / 1000,
            initiator: params.initiator || { type: "script" },
            type: params.type || "Fetch",
            frameId: params.frameId || "root",
            hasUserGesture: false,
            redirectResponse: params.redirectResponse,
          },
        }, sendOpts);
        break;
      case "Network.responseReceived":
        this.#send(client, {
          method: "Network.responseReceived",
          params: {
            requestId: String(params.requestId),
            loaderId: String(params.loaderId || "root"),
            timestamp: params.timestamp,
            type: params.type || "Fetch",
            response: {
              url: params.response?.url || "",
              status: params.response?.status || 0,
              statusText: params.response?.statusText || "",
              headers: params.response?.headers || {},
              mimeType: params.response?.mimeType || "",
              connectionReused: params.response?.connectionReused || false,
              connectionId: params.response?.connectionId || 0,
              encodedDataLength: params.response?.encodedDataLength ||
                parseInt(params.response?.headers?.["content-length"]) || 0,
              securityState: params.response?.security || "neutral",
              timing: params.response?.timing ? {
                requestTime: params.response.timing.requestTime || 0,
                dnsStart: params.response.timing.domainLookupStart || -1,
                dnsEnd: params.response.timing.domainLookupEnd || -1,
                connectStart: params.response.timing.connectStart || -1,
                connectEnd: params.response.timing.connectEnd || -1,
                sslStart: params.response.timing.secureConnectionStart || -1,
                sslEnd: -1,
                sendStart: params.response.timing.requestStart || -1,
                sendEnd: params.response.timing.requestStart || -1,
                receiveHeadersEnd: params.response.timing.responseStart || -1,
              } : undefined,
            },
            frameId: params.frameId || "root",
          },
        }, sendOpts);
        break;
      case "Network.loadingFinished":
        this.#send(client, {
          method: "Network.loadingFinished",
          params: {
            requestId: String(params.requestId),
            timestamp: params.timestamp,
            encodedDataLength: params.metrics?.responseBodyBytesReceived ||
              params.sourceMapPayload?.length || 0,
          },
        }, sendOpts);
        break;
      case "Network.loadingFailed":
        this.#send(client, {
          method: "Network.loadingFailed",
          params: {
            requestId: String(params.requestId),
            timestamp: params.timestamp,
            type: "Fetch",
            errorText: params.errorText || "Loading failed",
            canceled: params.canceled || false,
          },
        }, sendOpts);
        break;
      case "Network.dataReceived":
        this.#send(client, {
          method: "Network.dataReceived",
          params: {
            requestId: String(params.requestId),
            timestamp: params.timestamp,
            dataLength: params.dataLength || 0,
            encodedDataLength: params.encodedDataLength || 0,
          },
        }, sendOpts);
        break;
      default:
        // Forward other Network events as-is
        this.#send(client, { method, params }, sendOpts);
        break;
    }
  }

  #handleNativeDebuggerEvent(client, { method, params }) {
    switch (method) {
      case "Debugger.paused": {
        // Translate WebKit pause event to CDP format
        // Preserve WebKit's native callFrameIds for evaluateOnCallFrame
        client.callFrameMap = new Map();
        const callFrames = (params.callFrames || []).map((f, i) => {
          const cdpFrameId = String(i);
          const webkitFrameId = f.callFrameId;
          client.callFrameMap.set(cdpFrameId, webkitFrameId);
          return {
            callFrameId: cdpFrameId,
            functionName: f.functionName || "",
            location: {
              scriptId: String(f.location?.scriptId || "0"),
              lineNumber: f.location?.lineNumber || 0,
              columnNumber: f.location?.columnNumber || 0,
            },
            url: f.url || "",
            scopeChain: (f.scopeChain || []).map(s => ({
              type: this.#translateScopeType(s.type),
              object: {
                type: "object",
                objectId: s.object?.objectId || `scope-${i}`,
                className: s.object?.className || "Object",
                description: s.object?.description || "Object",
              },
              name: s.name || "",
            })),
            this: f.this || { type: "object", className: "Window", description: "Window" },
          };
        });
        // Include async stack trace if available
        const asyncStackTrace = params.asyncStackTrace ? {
          description: params.asyncStackTrace.description || "async",
          callFrames: (params.asyncStackTrace.callFrames || []).map(f => ({
            functionName: f.functionName || "",
            scriptId: String(f.scriptId || "0"),
            url: f.url || "",
            lineNumber: f.lineNumber || 0,
            columnNumber: f.columnNumber || 0,
          })),
          parent: params.asyncStackTrace.parentStackTrace ? {
            description: params.asyncStackTrace.parentStackTrace.description || "",
            callFrames: (params.asyncStackTrace.parentStackTrace.callFrames || []).map(f => ({
              functionName: f.functionName || "",
              scriptId: String(f.scriptId || "0"),
              url: f.url || "",
              lineNumber: f.lineNumber || 0,
              columnNumber: f.columnNumber || 0,
            })),
          } : undefined,
        } : undefined;
        const pauseEvent = {
          callFrames,
          reason: this.#translatePauseReason(params.reason),
          data: params.data || {},
          asyncStackTrace,
        };
        client.lastPauseEvent = pauseEvent;
        this.#send(client, { method: "Debugger.paused", params: pauseEvent });
        break;
      }
      case "Debugger.resumed":
        client.lastPauseEvent = null;
        this.#send(client, { method: "Debugger.resumed", params: {} });
        break;
      case "Debugger.breakpointResolved":
        this.#send(client, {
          method: "Debugger.breakpointResolved",
          params: {
            breakpointId: params.breakpointId,
            location: {
              scriptId: String(params.location?.scriptId || "0"),
              lineNumber: params.location?.lineNumber || 0,
              columnNumber: params.location?.columnNumber || 0,
            },
          },
        });
        break;
    }
  }

  #translateScopeType(webkitType) {
    // WebKit scope types → CDP scope types
    const map = {
      global: "global",
      globalLexicalEnvironment: "script",
      closure: "closure",
      functionName: "local",
      local: "local",
      nestedLexical: "block",
      with: "with",
      catch: "catch",
    };
    return map[webkitType] || "local";
  }

  #translatePauseReason(webkitReason) {
    const map = {
      Breakpoint: "other",
      DebuggerStatement: "debugCommand",
      PauseOnNextStatement: "other",
      Exception: "exception",
      Assert: "assert",
      CSPViolation: "CSPViolation",
      Microtask: "other",
      Timer: "other",
      AnimationFrame: "other",
      EventListener: "EventListener",
      XHR: "XHR",
    };
    return map[webkitReason] || "other";
  }

  /**
   * Convert WebKit ScriptProfiler.trackingComplete data to Chrome's Profiler.stop format.
   * WebKit provides stack traces with timestamps; Chrome needs a tree of call frames with samples.
   */
  #buildChromeProfile(trackingData, startTimeMs, session) {
    const startTime = startTimeMs * 1000; // Chrome uses microseconds
    const endTime = Date.now() * 1000;

    // Root node — matches Chrome's format: uses `parent` field, not `children`
    const nodes = [{ id: 1, callFrame: { codeType: "other", functionName: "(root)", scriptId: 0 } }];
    const samples = [];
    const timeDeltas = [];

    if (!trackingData?.samples?.stackTraces?.length) {
      return { nodes, startTime: startTimeMs * 1000, endTime, samples: [], timeDeltas: [] };
    }

    const traces = trackingData.samples.stackTraces;
    let nextNodeId = 2;
    // Map from "parentId:sourceID:line:col:name" → nodeId for deduplication
    const frameToNode = new Map();

    for (let i = 0; i < traces.length; i++) {
      const trace = traces[i];
      const frames = trace.stackFrames || [];
      if (frames.length === 0) {
        samples.push(1);
        timeDeltas.push(i === 0 ? 0 : Math.round((traces[i].timestamp - traces[i - 1].timestamp) * 1e6));
        continue;
      }

      // Walk frames from bottom (root-most) to top (leaf)
      let parentId = 1;
      let leafId = 1;
      for (let j = frames.length - 1; j >= 0; j--) {
        const f = frames[j];
        const key = `${parentId}:${f.sourceID || 0}:${f.line || 0}:${f.column || 0}:${f.name || ""}`;
        let nodeId = frameToNode.get(key);
        if (!nodeId) {
          nodeId = nextNodeId++;
          frameToNode.set(key, nodeId);
          const scriptUrl = session?.scriptCacheData?.get(String(f.sourceID))?.url || f.url || "";
          nodes.push({
            id: nodeId,
            callFrame: {
              codeType: "JS",
              functionName: f.name || "(anonymous)",
              scriptId: Number(f.sourceID) || 0,
              url: scriptUrl,
              lineNumber: (f.line || 1) - 1,
              columnNumber: (f.column || 1) - 1,
            },
            parent: parentId,
          });
        }
        parentId = nodeId;
        leafId = nodeId;
      }

      samples.push(leafId);
      timeDeltas.push(i === 0 ? 0 : Math.round((traces[i].timestamp - traces[i - 1].timestamp) * 1e6));
    }

    return { nodes, startTime: startTimeMs * 1000, endTime, samples, timeDeltas };
  }

  #translateScriptParsed(webkitScript) {
    const url = webkitScript.sourceURL || webkitScript.url || "";
    return {
      scriptId: String(webkitScript.scriptId),
      url,
      startLine: webkitScript.startLine || 0,
      startColumn: webkitScript.startColumn || 0,
      endLine: webkitScript.endLine || 0,
      endColumn: webkitScript.endColumn || 0,
      executionContextId: 1,
      hash: webkitScript.hash || "",
      isLiveEdit: false,
      isModule: webkitScript.module || false,
      length: webkitScript.length || 0,
      sourceMapURL: webkitScript.sourceMapURL || "",
      hasSourceURL: !!(webkitScript.sourceURL),
      scriptLanguage: "JavaScript",
      embedderName: url,
      executionContextAuxData: { isDefault: true, type: "default", frameId: MAIN_FRAME_ID },
    };
  }

  #flattenTimelineRecord(record, out, baseTime, pid = 1, tid = 1) {
    // Map WebKit Timeline record types to Chrome Trace categories/names
    const typeMap = {
      RenderingFrame: "devtools.timeline,RenderingFrame",
      RecalculateStyles: "devtools.timeline,RecalculateStyles",
      Layout: "devtools.timeline,Layout",
      Paint: "devtools.timeline,Paint",
      Composite: "devtools.timeline,CompositeLayers",
      ScheduleStyleRecalculation: "devtools.timeline,ScheduleStyleRecalculation",
      InvalidateLayout: "devtools.timeline,InvalidateLayout",
      FunctionCall: "devtools.timeline,FunctionCall",
      EvaluateScript: "devtools.timeline,EvaluateScript",
      TimerFire: "devtools.timeline,TimerFire",
      TimerInstall: "devtools.timeline,TimerInstall",
      TimerRemove: "devtools.timeline,TimerRemove",
      FireAnimationFrame: "devtools.timeline,FireAnimationFrame",
      RequestAnimationFrame: "devtools.timeline,RequestAnimationFrame",
      EventDispatch: "devtools.timeline,EventDispatch",
      XHRReadyStateChange: "devtools.timeline,XHRReadyStateChange",
      XHRLoad: "devtools.timeline,XHRLoad",
      ParseHTML: "devtools.timeline,ParseHTML",
    };
    const type = record.type || "Other";
    const mapped = typeMap[type] || `devtools.timeline,${type}`;
    const [cat, name] = mapped.split(",");
    // Convert WebKit seconds to absolute microseconds
    // baseTime is Date.now() at recording start (ms), record.startTime is seconds since page load
    const baseUs = (baseTime || 0) * 1000; // ms → μs
    const startUs = baseUs + (record.startTime || 0) * 1e6;
    const endUs = baseUs + (record.endTime || record.startTime || 0) * 1e6;
    const dur = endUs > startUs ? endUs - startUs : 0;

    out.push({
      cat,
      name,
      ph: dur > 0 ? "X" : "I",
      pid,
      tid,
      ts: Math.round(startUs),
      dur: dur > 0 ? Math.round(dur) : undefined,
      args: record.data || {},
    });

    for (const child of record.children || []) {
      this.#flattenTimelineRecord(child, out, baseTime, pid, tid);
    }
  }

  async #emitPageLifecycle(client) {
    const session = client.session;
    // Use existing URL if available — skip slow refreshSnapshot unless needed
    const url = session.lastSnapshot?.url || session.target?.url || "about:blank";
    const title = session.lastSnapshot?.title || session.target?.title || "Mobile Safari";
    this.#send(client, {
      method: "Page.frameStartedLoading",
      params: {
        frameId: MAIN_FRAME_ID,
      },
    });
    this.#send(client, {
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: MAIN_FRAME_ID,
          loaderId: MAIN_LOADER_ID,
          url,
          domainAndRegistry: "",
          securityOrigin: this.#safeOrigin(url),
          mimeType: "text/html",
        },
        type: "Navigation",
      },
    });
    this.#send(client, {
      method: "DOM.documentUpdated",
      params: {},
    });
    this.#send(client, {
      method: "Page.domContentEventFired",
      params: {
        timestamp: Date.now() / 1000,
      },
    });
    this.#send(client, {
      method: "Page.loadEventFired",
      params: {
        timestamp: Date.now() / 1000,
      },
    });
    this.#send(client, {
      method: "Page.frameStoppedLoading",
      params: {
        frameId: MAIN_FRAME_ID,
      },
    });
    this.#send(client, {
      method: "Target.targetInfoChanged",
      params: {
        targetInfo: {
          targetId: client.targetId,
          type: "page",
          title,
          url,
          attached: true,
          canAccessOpener: false,
          browserContextId: "default",
        },
      },
    });
  }

  #esc(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  #safeOrigin(url) {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  }

  async #readInlineStyle(session, nodeId) {
    const ssid = "inline:" + nodeId;
    // Read the style attribute directly from the DOM node — fast, no JS execution needed
    try {
      const attrs = await session.rawWir.sendCommand("DOM.getAttributes", { nodeId });
      const attrList = attrs?.attributes || [];
      let styleText = "";
      for (let i = 0; i < attrList.length; i += 2) {
        if (attrList[i] === "style") { styleText = attrList[i + 1] || ""; break; }
      }
      return this.#parseInlineStyleText(ssid, styleText);
    } catch {
      return { styleSheetId: ssid, cssProperties: [], shorthandEntries: [], cssText: "", range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 } };
    }
  }

  #parseInlineStyleText(styleSheetId, text) {
    let col = 0;
    const props = (text || "").split(";").filter(Boolean).map(s => s.trim()).filter(Boolean).map(decl => {
      const colon = decl.indexOf(":");
      const name = colon >= 0 ? decl.slice(0, colon).trim() : decl.trim();
      let value = colon >= 0 ? decl.slice(colon + 1).trim() : "";
      const important = /!important/i.test(value);
      if (important) value = value.replace(/!important/i, "").trim();
      const propText = name + ": " + value + (important ? " !important" : "") + ";";
      const startCol = col;
      col += propText.length + 1;
      return { name, value, important, implicit: false, text: propText, disabled: false,
        range: { startLine: 0, startColumn: startCol, endLine: 0, endColumn: startCol + propText.length } };
    });
    const cssText = props.map(p => p.text).join(" ");
    return { styleSheetId, cssProperties: props, shorthandEntries: [], cssText,
      range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: cssText.length } };
  }

  #startPolling() {
    this.lastPollTime = Date.now();
    this.pollTimer = setInterval(async () => {
      // Detect sleep/wake: if more than 5s since last poll, likely woke from sleep
      const now = Date.now();
      const elapsed = now - this.lastPollTime;
      this.lastPollTime = now;
      if (elapsed > 5000 && this.clients.size) {
        this.logger.info(`Detected wake from sleep (${Math.round(elapsed / 1000)}s gap) — re-probing targets`);
        try {
          await this.probe();
        } catch {}
        // Attempt reconnect for all clients
        for (const client of this.clients) {
          if (client.session && !client.session.isConnected) {
            this.logger.info("Reconnecting session after wake...");
            await client.session.tryReconnect().catch(() => {});
          }
        }
      }

      if (!this.clients.size) return;
      const stale = [];
      for (const client of this.clients) {
        if (client.socket.readyState !== client.socket.OPEN) {
          stale.push(client);
          continue;
        }
        if (!client.session?.isConnected) {
          // Don't mark as stale if the session is still connecting
          if (client.session?._connectPromise || client.session?.reconnecting) {
            continue;
          }
          // Only try reconnect if the session was previously connected
          if (client.session?.rawWir) {
            const reconnected = await client.session?.tryReconnect?.().catch(() => false);
            if (!reconnected) {
              stale.push(client);
            }
          }
          continue;
        }
        try {
          const pollT0 = this.perfEnabled ? performance.now() : 0;
          // Drain native WebKit events (pushed by the transport, not polled)
          const nativeConsole = client.session.drainNativeConsoleEvents();
          for (const event of nativeConsole) {
            this.#broadcastNativeConsoleEvent(client, event);
          }
          const nativeNetwork = client.session.drainNativeNetworkEvents();
          for (const event of nativeNetwork) {
            this.#broadcastNativeNetworkEvent(client, event);
          }
          const nativeDebugger = client.session.drainNativeDebuggerEvents();
          for (const event of nativeDebugger) {
            this.#handleNativeDebuggerEvent(client, event);
          }
          const nativeScripts = client.session.drainNativeScriptsParsed();
          if (client.debuggerEnabled) {
            for (const script of nativeScripts) {
              this.#send(client, {
                method: "Debugger.scriptParsed",
                params: this.#translateScriptParsed(script),
              });
            }
          }
          // Forward selected native events — filter aggressively to avoid flooding DevTools
          const nativeOther = client.session.drainNativeOtherEvents();
          for (const event of nativeOther) {
            const m = event.method;
            // Tracing: buffer timeline events during recording
            if (client.tracing && m === "Timeline.eventRecorded" && event.params?.record) {
              if (!client.traceEvents) client.traceEvents = [];
              this.#flattenTimelineRecord(event.params.record, client.traceEvents, client.traceStartTime);
              continue;
            }
            // Skip noisy/internal events that cause lag or confusion
            if (!m) continue;
            if (m === "DOM.setChildNodes") { this.#send(client, event); continue; }
            if (m.startsWith("Timeline.")) continue;
            if (m === "DOM.documentUpdated") continue;
            if (m === "DOM.childNodeCountUpdated") continue;
            if (m === "Page.defaultUserPreferencesDidChange") continue;
            // Forward navigation events — but don't send context destroy/create
            // (those cause DevTools to invalidate all IDs and blank panels)
            if (m === "Page.frameNavigated" || m === "Debugger.globalObjectCleared") {
              this.#send(client, event);
              continue;
            }
            // Forward DOMStorage/IndexedDB/LayerTree/Heap events
            if (m.startsWith("DOMStorage.") || m.startsWith("IndexedDB.") ||
                m.startsWith("LayerTree.") || m.startsWith("Heap.") ||
                m.startsWith("CSS.styleSheet")) {
              this.#send(client, event); continue;
            }
            // Skip all other noisy DOM/CSS mutation events
            if (m.startsWith("DOM.") || m.startsWith("CSS.")) continue;
            // Forward everything else
            this.#send(client, event);
          }
          // DOM mutations come via native WebKit events (DOM.childNodeInserted etc.)
          this.pollErrorCount = 0;
          if (this.perfEnabled) {
            const pollElapsed = performance.now() - pollT0;
            this.perfStats.pollTicks++;
            this.perfStats.pollTotalMs += pollElapsed;
            const eventCount = nativeConsole.length + nativeNetwork.length + nativeDebugger.length + nativeScripts.length + nativeOther.length;
            if (eventCount > 0) {
              this.perfStats.pollBusyTicks++;
              this.perfStats.eventsForwarded += eventCount;
            }
          }
        } catch (error) {
          this.pollErrorCount++;
          this.logger.debug(`poll error (${this.pollErrorCount}): ${error?.message}`);
          if (this.pollErrorCount >= this.maxPollErrors) {
            this.logger.warn("too many poll errors, attempting reconnect");
            await client.session?.tryReconnect?.().catch(() => {});
            this.pollErrorCount = 0;
          }
        }
      }
      for (const client of stale) {
        this.clients.delete(client);
        await client.session?.disconnect?.().catch(() => {});
        this.logger.debug("cleaned up stale client");
      }
    }, 200);
  }

  #stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  #broadcastConsoleEvent(client, event) {
    if (event.kind === "console-api") {
      this.#send(client, {
        method: "Runtime.consoleAPICalled",
        params: {
          type: event.level === "warn" ? "warning" : event.level,
          args: event.args || [{ type: "string", value: event.text }],
          executionContextId: 1,
          timestamp: event.timestamp,
          stackTrace: { callFrames: event.stackTrace || [] },
        },
      });
      this.#send(client, {
        method: "Log.entryAdded",
        params: {
          entry: {
            source: "javascript",
            level: event.level === "debug" ? "verbose" : event.level,
            text: event.text,
            timestamp: event.timestamp,
            url: "",
            lineNumber: 0,
          },
        },
      });
    } else if (event.kind === "exception") {
      this.#send(client, {
        method: "Runtime.exceptionThrown",
        params: {
          timestamp: event.timestamp,
          exceptionDetails: {
            exceptionId: Date.now(),
            text: event.text,
            lineNumber: event.lineNumber || 0,
            columnNumber: event.columnNumber || 0,
            url: event.url || "",
            exception: {
              type: "object",
              subtype: "error",
              className: "Error",
              description: event.text,
            },
            executionContextId: 1,
          },
        },
      });
      this.#send(client, {
        method: "Log.entryAdded",
        params: {
          entry: {
            source: "javascript",
            level: "error",
            text: event.text,
            timestamp: event.timestamp,
            url: event.url || "",
            lineNumber: event.lineNumber || 0,
          },
        },
      });
    }
  }

  #broadcastNetworkEvent(client, event) {
    const type = event.resourceType || "Fetch";
    const session = client.session;

    if (event.kind === "request") {
      this.#send(client, {
        method: "Network.requestWillBeSent",
        params: {
          requestId: event.requestId,
          loaderId: MAIN_LOADER_ID,
          documentURL: session.lastSnapshot?.url || "",
          request: {
            url: event.url,
            method: event.method,
            headers: event.headers || {},
            postData: event.postData || undefined,
            hasPostData: !!event.hasPostData || !!event.postData,
            mixedContentType: "none",
            initialPriority: "High",
            referrerPolicy: "strict-origin-when-cross-origin",
          },
          timestamp: event.monotonicTime,
          wallTime: event.timestamp / 1000,
          initiator: { type: type === "XHR" ? "xmlhttprequest" : "script" },
          type,
          frameId: MAIN_FRAME_ID,
          hasUserGesture: false,
        },
      });
    } else if (event.kind === "response") {
      this.#send(client, {
        method: "Network.responseReceived",
        params: {
          requestId: event.requestId,
          loaderId: MAIN_LOADER_ID,
          timestamp: event.monotonicTime,
          type,
          response: {
            url: event.url,
            status: event.status,
            statusText: event.statusText,
            headers: event.headers || {},
            mimeType: event.mimeType || "",
            charset: "",
            connectionReused: false,
            connectionId: 0,
            encodedDataLength: event.encodedDataLength || 0,
            securityState: (event.url || "").startsWith("https:") ? "secure" : "insecure",
            protocol: (event.url || "").startsWith("https:") ? "h2" : "http/1.1",
            fromDiskCache: false,
            fromServiceWorker: false,
            fromPrefetchCache: false,
            responseTime: event.timestamp,
          },
          frameId: MAIN_FRAME_ID,
        },
      });
    } else if (event.kind === "finished") {
      this.#send(client, {
        method: "Network.loadingFinished",
        params: {
          requestId: event.requestId,
          timestamp: event.monotonicTime,
          encodedDataLength: event.encodedDataLength || 0,
        },
      });
    } else if (event.kind === "failed") {
      this.#send(client, {
        method: "Network.loadingFailed",
        params: {
          requestId: event.requestId,
          timestamp: event.monotonicTime,
          type: "Fetch",
          errorText: event.errorText || "Request failed",
          canceled: !!event.canceled,
        },
      });
    }
  }

  #handleDebuggerEvent(client, event) {
    if (event.kind !== "paused") return;
    client.lastPauseEvent = event;
    const meta = event.meta || {};
    const session = client.session;
    // Map location through source maps
    const uiLocation = session.mapToUiLocation(
      meta.url || "",
      Number(meta.lineNumber || 0),
      Number(meta.columnNumber || 0),
    );

    // Build scope chain from captured variables
    const scopeVars = event.scopeVars || {};
    const scopeProperties = Object.entries(scopeVars).map(([name, remoteObj]) => ({
      name,
      value: remoteObj || { type: "undefined" },
      writable: true,
      configurable: true,
      enumerable: true,
      isOwn: true,
    }));

    // Store scope for Runtime.getProperties calls
    const scopeObjectId = `scope:${event.pauseId}:local`;
    client.scopeCache.set(scopeObjectId, scopeProperties);

    const scopeChain = [];
    if (Object.keys(scopeVars).length > 0) {
      scopeChain.push({
        type: "local",
        object: {
          type: "object",
          objectId: scopeObjectId,
          className: "Object",
          description: "Local",
        },
        name: meta.functionName || "(anonymous)",
      });
    }
    scopeChain.push({
      type: "global",
      object: {
        type: "object",
        objectId: "scope:global",
        className: "Window",
        description: "Window",
      },
    });

    this.#send(client, {
      method: "Debugger.paused",
      params: {
        callFrames: [{
          callFrameId: `pause:${Date.now()}:0`,
          functionName: meta.functionName || "(anonymous)",
          location: {
            scriptId: uiLocation.scriptId,
            lineNumber: uiLocation.lineNumber,
            columnNumber: uiLocation.columnNumber,
          },
          url: uiLocation.url,
          scopeChain,
          this: { type: "object", description: "Window", className: "Window", objectId: "scope:this" },
        }],
        reason: event.reason || "other",
        hitBreakpoints: event.hitBreakpoints || [],
      },
    });
  }

  #setupRoutes() {
    this.app.use(pagesMountPath, express.static(pagesDir));

    // Favicon — suppress 404
    this.app.get("/favicon.ico", (_req, res) => res.status(204).end());

    this.app.get("/", async (_req, res) => {
      const mobileTargets = await this.cachedProbe();

      // Also discover desktop Safari targets if the desktop bridge is running
      let desktopTargets = [];
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const dRes = await fetch("http://localhost:9333/json/list", { signal: controller.signal });
        clearTimeout(timeout);
        const dList = await dRes.json();
        desktopTargets = dList.map((t) => ({
          ...t,
          deviceName: "Desktop Safari",
          deviceType: "desktop",
          _desktopPort: 9333,
        }));
      } catch {}

      const allTargets = [...desktopTargets, ...mobileTargets];
      const rows = allTargets.map((t, i) => {
        const targetId = encodeURIComponent(t.id || `target-${i}`);
        const isDesktop = t.deviceType === "desktop";
        const openAction = isDesktop
          ? `openDesktop(this, '${this.#esc(t.webSocketDebuggerUrl?.replace("ws://", "") || "")}')`
          : `openTarget(this, '${targetId}')`;
        return `<tr>
          <td>${this.#esc(t.deviceName || "unknown")}</td>
          <td>${this.#esc(t.deviceType || t.type || "")}</td>
          <td><a href="${this.#esc(t.url || "")}" target="_blank">${this.#esc(t.title || t.url || "(untitled)")}</a></td>
          <td>
            <button class="btn btn-open" onclick="${openAction}">Inspect</button>
          </td>
        </tr>`;
      }).join("\n");
      const targets = allTargets;

      res.type("html").send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Safari CDP Bridge — Targets</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 1.4em; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #ddd; }
  th { background: #f5f5f5; font-weight: 600; }
  a { color: #0066cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #888; padding: 20px 0; }
  .refresh { margin-top: 16px; }
  .btn { display: inline-block; padding: 4px 10px; border-radius: 4px; font-size: 13px; cursor: pointer; border: 1px solid #ccc; background: #f8f8f8; color: #333; text-decoration: none; margin-right: 4px; }
  .btn:hover { background: #eee; }
  .btn-open { background: #0066cc; color: white; border-color: #0052a3; }
  .btn-open:hover { background: #0052a3; }
  .toast { position: fixed; bottom: 20px; right: 20px; background: #333; color: white; padding: 10px 16px; border-radius: 8px; font-size: 14px; display: none; z-index: 999; }
  .tip { margin-top: 16px; padding: 12px; background: #fff8e1; border: 1px solid #ffcc02; border-radius: 6px; font-size: 13px; line-height: 1.5; }
  .tip code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
  .navigate-form { display: flex; gap: 8px; margin-top: 16px; }
  .navigate-form input { flex: 1; padding: 6px 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
  .navigate-form select { padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
</style></head><body>
<h1>Safari CDP Bridge — Targets</h1>
${targets.length ? `<table>
  <thead><tr><th>Device</th><th>Type</th><th>Page</th><th>Actions</th></tr></thead>
  <tbody>${rows}</tbody>
</table>` : '<p class="empty">No targets found. Make sure Safari is open on the device/simulator, or that the desktop bridge is running.</p>'}
<div class="navigate-form">
  <select id="nav-target">
    <option value="desktop">Desktop Safari</option>
    <option value="simulator">Simulator</option>
    <option value="device">iPhone</option>
  </select>
  <input type="text" id="nav-url" placeholder="Enter URL to navigate..." value="http://localhost:9221/__pages/demo.html">
  <button class="btn btn-open" onclick="navigateTo()">Go</button>
</div>
<div class="tip">
  <strong>Inspect</strong> opens Chrome DevTools for that target.<br>
  <strong>Navigate</strong> loads a URL on the selected target. Desktop Safari uses its own automated window.<br>
  If Inspect doesn't work, open <code>chrome://inspect</code> in Chrome, click "Configure", add <code>localhost:${listPort}</code> and <code>localhost:9333</code>.
</div>
<p class="refresh"><a href="/">Refresh</a> &middot; <a href="/json/list">JSON</a> &middot; <a href="/targets">Full status</a></p>
<script>
function openTarget(btn, targetId) {
  btn.textContent = 'Opening...';
  btn.disabled = true;
  btn.style.opacity = '0.6';
  fetch('/open/' + targetId).then(function() {
    setTimeout(function() { btn.textContent = 'Inspect'; btn.disabled = false; btn.style.opacity = '1'; }, 3000);
  }).catch(function() {
    btn.textContent = 'Failed'; btn.style.opacity = '1';
    setTimeout(function() { btn.textContent = 'Inspect'; btn.disabled = false; }, 2000);
  });
}
function openDesktop(btn, wsPath) {
  btn.textContent = 'Opening...';
  btn.disabled = true;
  btn.style.opacity = '0.6';
  fetch('/open-desktop?ws=' + encodeURIComponent(wsPath)).then(function() {
    setTimeout(function() { btn.textContent = 'Inspect'; btn.disabled = false; btn.style.opacity = '1'; }, 3000);
  }).catch(function() {
    btn.textContent = 'Failed'; btn.style.opacity = '1';
    setTimeout(function() { btn.textContent = 'Inspect'; btn.disabled = false; }, 2000);
  });
}
function navigateTo() {
  var target = document.getElementById('nav-target').value;
  var url = document.getElementById('nav-url').value;
  if (!url) return;
  var endpoint;
  if (target === 'desktop') {
    endpoint = 'http://localhost:9333/__bridge/navigate?url=' + encodeURIComponent(url);
  } else if (target === 'device') {
    endpoint = '/device/navigate?url=' + encodeURIComponent(url);
  } else {
    endpoint = '/navigate?url=' + encodeURIComponent(url);
  }
  fetch(endpoint).then(function(r) { return r.json(); }).then(function(data) {
    if (data.ok) { setTimeout(function() { location.reload(); }, 2000); }
    else { alert('Navigate failed: ' + (data.error || 'unknown')); }
  }).catch(function(e) { alert('Navigate failed: ' + e.message); });
}
</script>
</body></html>`);
    });

    // Server-side DevTools opener — bypasses devtools:// security restriction
    this.app.get("/open/:targetId", async (req, res) => {
      const targetId = req.params.targetId;
      const wsPath = `localhost:${listPort}/devtools/page/${targetId}`;
      const devtoolsUrl = `devtools://devtools/bundled/inspector.html?ws=${wsPath}`;

      // Just return success — the button already shows "Opening..." via onclick
      res.json({ ok: true });

      // Open DevTools in background
      try {
        const { execFile: ef } = await import("child_process");
        const { promisify: p } = await import("util");
        await p(ef)("open", ["-a", "Google Chrome", devtoolsUrl]);
      } catch (error) {
        this.logger.warn(`Failed to open DevTools: ${error?.message}`);
      }
    });

    this.app.get("/open-desktop", async (req, res) => {
      const wsPath = req.query.ws || "";
      const devtoolsUrl = `devtools://devtools/bundled/inspector.html?ws=${wsPath}`;
      res.json({ ok: true });
      try {
        const { execFile: ef } = await import("child_process");
        const { promisify: p } = await import("util");
        await p(ef)("open", ["-a", "Google Chrome", devtoolsUrl]);
      } catch (error) {
        this.logger.warn(`Failed to open desktop DevTools: ${error?.message}`);
      }
    });

    this.app.get("/json/version", (_req, res) => {
      res.json({
        Browser: "iOS Web Inspector Helper",
        "Protocol-Version": "1.3",
        "User-Agent": "Safari iOS Helper",
        "Target-Port": String(this.targetPort),
        Note: "Returns native-discovered iOS targets. Full CDP bridging remains in progress.",
      });
    });

    // Performance stats endpoint (enable with BRIDGE_PERF=1)
    this.app.get("/perf", (_req, res) => {
      if (!this.perfEnabled) {
        return res.json({ enabled: false, hint: "Start with BRIDGE_PERF=1 to enable" });
      }
      const handlers = [...this.perfStats.handlers.entries()]
        .map(([method, s]) => ({ method, calls: s.calls, totalMs: Math.round(s.totalMs), avgMs: Math.round(s.totalMs / s.calls), maxMs: Math.round(s.maxMs) }))
        .sort((a, b) => b.totalMs - a.totalMs);
      const idlePercent = this.perfStats.pollTicks > 0
        ? ((1 - this.perfStats.pollBusyTicks / this.perfStats.pollTicks) * 100).toFixed(1)
        : "N/A";
      res.json({
        enabled: true,
        poll: {
          ticks: this.perfStats.pollTicks,
          busyTicks: this.perfStats.pollBusyTicks,
          idlePercent,
          totalMs: Math.round(this.perfStats.pollTotalMs),
          avgMs: this.perfStats.pollTicks > 0 ? (this.perfStats.pollTotalMs / this.perfStats.pollTicks).toFixed(2) : 0,
          eventsForwarded: this.perfStats.eventsForwarded,
        },
        handlers: {
          total: handlers.reduce((s, h) => s + h.calls, 0),
          byTime: handlers.slice(0, 20),
        },
      });
    });

    this.app.get("/json/list", async (_req, res) => {
      try {
        // Hard timeout: always respond within 15s, even if probes hang
        const targets = await Promise.race([
          this.cachedProbe(),
          new Promise((resolve) => setTimeout(() => resolve(this.lastTargets), 15_000)),
        ]);
        res.json(targets);
      } catch (error) {
        this.logger.error("json/list probe failed", error);
        res.json(this.lastTargets);
      }
    });

    this.app.get("/json", async (_req, res) => {
      res.redirect("/json/list");
    });

    this.app.get("/simulators", async (_req, res) => {
      const status = await this.getStatus();
      res.json({
        selectedSimulator: status.selectedSimulator,
        simulators: status.simulators,
      });
    });

    this.app.get("/devices", async (_req, res) => {
      const status = await this.getStatus();
      res.json({
        selectedRealDevice: status.selectedRealDevice,
        realDevices: status.realDevices,
      });
    });

    this.app.get("/targets", async (_req, res) => {
      try {
        const result = await Promise.race([
          this.probe(),
          new Promise((resolve) => setTimeout(() => resolve({ targets: this.lastTargets, timeout: true }), 15_000)),
        ]);
        res.json(result);
      } catch (error) {
        res.json({ ok: false, error: error.message, targets: this.lastTargets });
      }
    });

    this.app.get("/inspector/targets/:targetId", async (req, res) => {
      const targets = await this.cachedProbe();
      const target = targets.find((entry) => entry.id === req.params.targetId);
      if (!target) {
        res.status(404).json({ ok: false, error: "Unknown target id." });
        return;
      }
      res.json({ ok: true, target });
    });

    this.app.get("/boot", async (req, res) => {
      try {
        const simulator = await this.boot({
          simulatorId: String(req.query.udid || this.selectedSimulatorId || ""),
          simulatorName: String(req.query.name || this.selectedSimulatorName || ""),
        });
        res.json({ ok: true, simulator });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    this.app.get("/launch", async (req, res) => {
      try {
        const simulator = await this.launchSafari({
          simulatorId: String(req.query.udid || this.selectedSimulatorId || ""),
          simulatorName: String(req.query.name || this.selectedSimulatorName || ""),
        });
        res.json({ ok: true, simulator, app: "com.apple.mobilesafari" });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    this.app.get("/navigate", async (req, res) => {
      const url = String(req.query.url || "");
      if (!url) {
        res.status(400).json({ ok: false, error: "Missing url query parameter." });
        return;
      }
      try {
        const result = await this.navigate(url, {
          simulatorId: String(req.query.udid || this.selectedSimulatorId || ""),
          simulatorName: String(req.query.name || this.selectedSimulatorName || ""),
        });
        res.json({ ok: true, ...result });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    this.app.get("/device/launch", async (req, res) => {
      try {
        const result = await this.launchRealDevice("", {
          realDeviceId: String(req.query.udid || this.selectedRealDeviceId || ""),
        });
        res.json({ ok: true, ...result, app: "com.apple.mobilesafari" });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });

    this.app.get("/device/navigate", async (req, res) => {
      const url = String(req.query.url || "");
      if (!url) {
        res.status(400).json({ ok: false, error: "Missing url query parameter." });
        return;
      }
      try {
        const result = await this.launchRealDevice(url, {
          realDeviceId: String(req.query.udid || this.selectedRealDeviceId || ""),
        });
        res.json({ ok: true, ...result, app: "com.apple.mobilesafari" });
      } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
      }
    });
  }
}

export async function main() {
  const logger = new Logger();

  // Start tunnel registry server to bridge Apple's CoreDevice tunnel
  // to appium-ios-remotexpc's expected format
  const { TunnelRegistryServer } = await import("./tunnel-registry.js");
  const tunnelRegistry = new TunnelRegistryServer({ logger });
  try {
    const tunnelPort = await tunnelRegistry.start();
    logger.info(`Tunnel registry bridging Apple tunnels on port ${tunnelPort}`);
  } catch (error) {
    logger.warn(`Tunnel registry failed to start: ${error?.message}`);
    logger.warn("Real device debugging may not work for iOS 18+ devices");
  }

  const server = new IosControlServer(logger);

  const shutdown = async (signal) => {
    logger.info(`shutting down on ${signal}`);
    await tunnelRegistry.stop();
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception:", error?.message);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection:", reason?.message || reason);
    // Don't exit on unhandled rejections — just log
  });

  try {
    await server.start();
    logger.info(`Target probe: http://${host}:${listPort}/targets`);
    logger.info(`Simulator status: http://${host}:${listPort}/simulators`);
    logger.info(`Real devices: http://${host}:${listPort}/devices`);
    logger.info(
      `Built-in pages: http://${host}:${listPort}${pagesMountPath}/demo.html`,
    );
    logger.info(
      `Navigate helper: http://${host}:${listPort}/navigate?url=${encodeURIComponent(`http://${host}:${listPort}${pagesMountPath}/demo.html`)}`,
    );
    logger.info(
      `Real-device fixture URL: http://${server.publicHost}:${listPort}${pagesMountPath}/demo.html`,
    );
  } catch (error) {
    logger.error(error?.message || String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
