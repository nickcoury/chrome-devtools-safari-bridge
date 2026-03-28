import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import safari from "selenium-webdriver/safari.js";
import { Builder } from "selenium-webdriver";
import { Logger } from "./logger.js";

const host = "localhost";
const port = Number(process.env.DESKTOP_PORT || 9333);
const frontendUrl =
  process.env.FRONTEND_URL || "devtools://devtools/bundled/inspector.html";
const targetId = "desktop-safari";

class DesktopSafariBackend {
  constructor(logger) {
    this.logger = logger.scope("backend");
    this.driver = null;
    this.lastSnapshot = null;
  }

  async start() {
    const options = new safari.Options();
    this.driver = await new Builder()
      .forBrowser("safari")
      .setSafariOptions(options)
      .build();
    await this.driver.get("https://example.com");
    await this.refreshSnapshot();
  }

  async stop() {
    if (this.driver) {
      await this.driver.quit();
      this.driver = null;
    }
  }

  async navigate(url) {
    await this.driver.get(url);
    await this.refreshSnapshot();
    return { frameId: "root" };
  }

  async getDocument() {
    await this.refreshSnapshot();
    return this.lastSnapshot.root;
  }

  async getNode(nodeId) {
    await this.refreshSnapshot();
    return this.lastSnapshot.nodes.get(nodeId) || null;
  }

  async requestChildNodes(nodeId) {
    await this.refreshSnapshot();
    const node = this.lastSnapshot.nodes.get(nodeId);
    return node?.children || [];
  }

  async describeNode(nodeId) {
    await this.refreshSnapshot();
    return this.lastSnapshot.nodes.get(nodeId) || null;
  }

  async evaluate(expression) {
    const result = await this.driver.executeScript(`return eval(arguments[0]);`, expression);
    return this.#toRemoteObject(result);
  }

  async getComputedStyle(nodeId) {
    await this.refreshSnapshot();
    const node = this.lastSnapshot.nodes.get(nodeId);
    if (!node?.backendPath) {
      return [];
    }
    return await this.driver.executeScript(
      `
      const path = arguments[0];
      let current = document;
      for (const index of path) {
        current = current.childNodes[index];
      }
      if (!current || current.nodeType !== Node.ELEMENT_NODE) {
        return [];
      }
      const style = getComputedStyle(current);
      return Array.from(style).map((name) => ({
        name,
        value: style.getPropertyValue(name),
      }));
      `,
      node.backendPath,
    );
  }

  async getOuterHTML(nodeId) {
    await this.refreshSnapshot();
    const node = this.lastSnapshot.nodes.get(nodeId);
    if (!node?.backendPath) {
      return "";
    }
    const html = await this.driver.executeScript(
      `
      const path = arguments[0];
      let current = document;
      for (const index of path) {
        current = current.childNodes[index];
      }
      return current?.outerHTML ?? current?.nodeValue ?? "";
      `,
      node.backendPath,
    );
    return html;
  }

  async getBoxModel(nodeId) {
    await this.refreshSnapshot();
    const node = this.lastSnapshot.nodes.get(nodeId);
    if (!node?.backendPath) {
      return null;
    }
    const rect = await this.driver.executeScript(
      `
      const path = arguments[0];
      let current = document;
      for (const index of path) {
        current = current.childNodes[index];
      }
      if (!current?.getBoundingClientRect) {
        return null;
      }
      const r = current.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height
      };
      `,
      node.backendPath,
    );
    if (!rect) {
      return null;
    }
    const { x, y, width, height } = rect;
    const quad = [x, y, x + width, y, x + width, y + height, x, y + height];
    return {
      model: {
        content: quad,
        padding: quad,
        border: quad,
        margin: quad,
        width,
        height,
      },
    };
  }

  async refreshSnapshot() {
    const snapshot = await this.driver.executeScript(`
      let nextId = 1;
      const nodes = [];
      function attrPairs(element) {
        const out = [];
        if (!element?.attributes) return out;
        for (const attr of element.attributes) {
          out.push(attr.name, attr.value);
        }
        return out;
      }
      function visit(node, path) {
        const nodeId = nextId++;
        const base = {
          nodeId,
          backendNodeId: nodeId,
          nodeType: node.nodeType,
          nodeName: node.nodeName,
          localName: node.localName || "",
          nodeValue: node.nodeValue || "",
          childNodeCount: node.childNodes ? node.childNodes.length : 0,
          children: [],
          attributes: node.nodeType === Node.ELEMENT_NODE ? attrPairs(node) : [],
          backendPath: path,
        };
        if (node.nodeType === Node.DOCUMENT_NODE) {
          base.documentURL = document.URL;
          base.baseURL = document.baseURI;
          base.xmlVersion = "";
          base.compatibilityMode = document.compatMode;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          base.frameId = "root";
        }
        nodes.push(base);
        if (node.childNodes?.length) {
          base.children = Array.from(node.childNodes, (child, index) =>
            visit(child, path.concat(index)),
          );
        }
        return base;
      }
      const root = visit(document, []);
      return { root, nodes, url: document.URL, title: document.title };
    `);

    const nodes = new Map();
    const index = (node) => {
      nodes.set(node.nodeId, node);
      for (const child of node.children || []) {
        index(child);
      }
    };
    index(snapshot.root);
    this.lastSnapshot = { ...snapshot, nodes };
    return this.lastSnapshot;
  }

  #toRemoteObject(value) {
    if (value === null) {
      return { type: "object", subtype: "null", value: null, description: "null" };
    }
    const type = typeof value;
    if (type === "object") {
      return {
        type: "object",
        value,
        description: Array.isArray(value) ? "Array" : "Object",
      };
    }
    return {
      type,
      value,
      description: String(value),
    };
  }
}

class DesktopSafariServer {
  constructor(logger) {
    this.logger = logger.scope("desktop");
    this.backend = new DesktopSafariBackend(this.logger);
    this.app = express();
    this.httpServer = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.httpServer });
  }

  async start() {
    await this.backend.start();
    this.#setupRoutes();
    this.#setupWs();
    await new Promise((resolve, reject) => {
      this.httpServer.listen(port, host, () => resolve());
      this.httpServer.on("error", reject);
    });
    this.logger.info(`desktop safari bridge listening on http://${host}:${port}`);
  }

  async stop() {
    await this.backend.stop();
    await new Promise((resolve) => this.wss.close(() => resolve()));
    await new Promise((resolve) => this.httpServer.close(() => resolve()));
  }

  #setupRoutes() {
    this.app.get("/json/version", (_req, res) => {
      res.json({
        Browser: "Safari/26.4",
        "Protocol-Version": "1.3",
        "User-Agent": "Safari Desktop Bridge",
        "V8-Version": "0.0",
        "WebKit-Version": "Safari 26.4",
      });
    });

    this.app.get("/json/list", async (_req, res) => {
      const snapshot = await this.backend.refreshSnapshot();
      res.json([
        {
          id: targetId,
          title: snapshot.title || "Desktop Safari",
          type: "page",
          url: snapshot.url,
          devtoolsFrontendUrl: `${frontendUrl}?ws=${host}:${port}/devtools/page/${targetId}`,
          webSocketDebuggerUrl: `ws://${host}:${port}/devtools/page/${targetId}`,
        },
      ]);
    });

    this.app.get("/json", async (_req, res) => {
      res.redirect("/json/list");
    });
  }

  #setupWs() {
    this.wss.on("connection", (socket) => {
      socket.on("message", async (raw) => {
        try {
          const message = JSON.parse(raw.toString());
          this.logger.debug("cdp <-", message.method);
          const response = await this.#handleMessage(socket, message);
          if (response) {
            socket.send(JSON.stringify(response));
          }
        } catch (error) {
          this.logger.error("websocket message failed", error);
        }
      });
    });
  }

  async #handleMessage(socket, message) {
    const { id, method, params = {} } = message;
    switch (method) {
      case "Browser.getVersion":
        return {
          id,
          result: {
            product: "Safari/26.4",
            revision: "desktop",
            userAgent: "Safari Desktop Bridge",
            jsVersion: "0.0",
            protocolVersion: "1.3",
          },
        };
      case "Schema.getDomains":
        return { id, result: { domains: [] } };
      case "Target.setDiscoverTargets":
      case "Target.setAutoAttach":
      case "Page.enable":
      case "Network.enable":
      case "Network.setAttachDebugStack":
      case "Runtime.enable":
      case "Runtime.runIfWaitingForDebugger":
      case "Runtime.addBinding":
      case "DOM.enable":
      case "DOM.setInspectedNode":
      case "CSS.enable":
      case "CSS.trackComputedStyleUpdates":
      case "CSS.takeComputedStyleUpdates":
      case "CSS.trackComputedStyleUpdatesForNode":
      case "Overlay.enable":
      case "Overlay.setShowViewportSizeOnResize":
      case "Overlay.setShowGridOverlays":
      case "Overlay.setShowFlexOverlays":
      case "Overlay.setShowScrollSnapOverlays":
      case "Overlay.setShowContainerQueryOverlays":
      case "Overlay.setShowIsolatedElements":
      case "Log.enable":
      case "Log.startViolationsReport":
      case "Accessibility.enable":
      case "Animation.enable":
      case "Autofill.enable":
      case "Autofill.setAddresses":
      case "Profiler.enable":
      case "Emulation.setEmulatedMedia":
      case "Emulation.setEmulatedVisionDeficiency":
      case "Emulation.setFocusEmulationEnabled":
      case "Audits.enable":
      case "ServiceWorker.enable":
      case "Inspector.enable":
      case "Target.setRemoteLocations":
      case "Network.setBlockedURLs":
      case "Network.emulateNetworkConditionsByRule":
      case "Network.overrideNetworkState":
      case "Network.clearAcceptedEncodingsOverride":
      case "Debugger.setPauseOnExceptions":
      case "Debugger.setAsyncCallStackDepth":
      case "Debugger.setBlackboxPatterns":
      case "DOMDebugger.setBreakOnCSPViolation":
      case "Page.setAdBlockingEnabled":
      case "Page.startScreencast":
      case "Page.addScriptToEvaluateOnNewDocument":
        return { id, result: {} };
      case "Debugger.enable":
        return { id, result: { debuggerId: "desktop-debugger" } };
      case "Target.getTargets":
        return {
          id,
          result: {
            targetInfos: [
              {
                targetId,
                type: "page",
                title: (await this.backend.refreshSnapshot()).title || "Desktop Safari",
                url: this.backend.lastSnapshot.url,
                attached: true,
                canAccessOpener: false,
                browserContextId: "default",
              },
            ],
          },
        };
      case "Page.getResourceTree":
        return {
          id,
          result: {
            frameTree: {
              frame: {
                id: "root",
                loaderId: "root",
                url: this.backend.lastSnapshot.url,
                domainAndRegistry: "",
                securityOrigin: new URL(this.backend.lastSnapshot.url).origin,
                mimeType: "text/html",
              },
              resources: [],
            },
          },
        };
      case "Page.getNavigationHistory":
        return {
          id,
          result: {
            currentIndex: 0,
            entries: [
              {
                id: 0,
                url: this.backend.lastSnapshot.url,
                userTypedURL: this.backend.lastSnapshot.url,
                title: this.backend.lastSnapshot.title,
                transitionType: "typed",
              },
            ],
          },
        };
      case "Page.navigate":
        return { id, result: await this.backend.navigate(params.url) };
      case "Runtime.evaluate":
        return { id, result: { result: await this.backend.evaluate(params.expression) } };
      case "Runtime.callFunctionOn":
        return {
          id,
          result: {
            result: {
              type: "undefined",
            },
          },
        };
      case "DOM.getDocument":
        return {
          id,
          result: { root: await this.backend.getDocument() },
        };
      case "DOM.requestChildNodes": {
        const nodes = await this.backend.requestChildNodes(params.nodeId);
        socket.send(
          JSON.stringify({
            method: "DOM.setChildNodes",
            params: {
              parentId: params.nodeId,
              nodes,
            },
          }),
        );
        return { id, result: {} };
      }
      case "DOM.describeNode":
        return { id, result: { node: await this.backend.describeNode(params.nodeId) } };
      case "DOM.pushNodesByBackendIdsToFrontend":
        return {
          id,
          result: {
            nodeIds: (params.backendNodeIds || []).map((backendNodeId) => backendNodeId),
          },
        };
      case "DOM.resolveNode": {
        const node = await this.backend.getNode(params.nodeId);
        return {
          id,
          result: {
            object: {
              type: "object",
              subtype: "node",
              className: node?.nodeName || "Node",
              description: node?.nodeName || "Node",
              objectId: `node:${params.nodeId}`,
            },
          },
        };
      }
      case "DOM.getOuterHTML":
        return { id, result: { outerHTML: await this.backend.getOuterHTML(params.nodeId) } };
      case "DOM.getBoxModel":
        return { id, result: await this.backend.getBoxModel(params.nodeId) || {} };
      case "CSS.getComputedStyleForNode":
        return {
          id,
          result: { computedStyle: await this.backend.getComputedStyle(params.nodeId) },
        };
      case "CSS.getMatchedStylesForNode":
        return {
          id,
          result: {
            inlineStyle: {
              styleSheetId: "inline",
              cssProperties: [],
              shorthandEntries: [],
            },
            attributesStyle: {
              styleSheetId: "attributes",
              cssProperties: [],
              shorthandEntries: [],
            },
            matchedCSSRules: [],
            inherited: [],
            pseudoElements: [],
            cssKeyframesRules: [],
            cssPositionFallbackRules: [],
            parentLayoutNodeId: params.nodeId,
          },
        };
      case "CSS.getAnimatedStylesForNode":
        return { id, result: { animationStyles: [] } };
      case "CSS.getPlatformFontsForNode":
        return { id, result: { fonts: [] } };
      case "CSS.getEnvironmentVariables":
        return { id, result: { variables: [] } };
      case "CSS.getInlineStylesForNode":
        return {
          id,
          result: {
            inlineStyle: {
              styleSheetId: "inline",
              cssProperties: [],
              shorthandEntries: [],
            },
            attributesStyle: {
              styleSheetId: "attributes",
              cssProperties: [],
              shorthandEntries: [],
            },
          },
        };
      case "Storage.getStorageKey":
        return {
          id,
          result: {
            storageKey: new URL(this.backend.lastSnapshot.url).origin,
          },
        };
      case "Runtime.releaseObject":
        return { id, result: {} };
      case "Overlay.highlightNode":
      case "Overlay.hideHighlight":
        return { id, result: {} };
      default:
        this.logger.debug(`unhandled cdp method ${method}`);
        return {
          id,
          error: {
            code: -32601,
            message: `Method not implemented: ${method}`,
          },
        };
    }
  }
}

const logger = new Logger();
const server = new DesktopSafariServer(logger);

const shutdown = async (signal) => {
  logger.info(`shutting down on ${signal}`);
  await server.stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await server.start();
