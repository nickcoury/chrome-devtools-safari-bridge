/**
 * WIR-based driver for Desktop Safari.
 *
 * Replaces Selenium WebDriver to avoid Safari's automation lock.
 * Connects to Safari's Web Inspector daemon (webinspectord) via its
 * native Unix socket, using the same binary-plist WIR protocol that
 * the iOS simulator bridge uses. This lets Chrome DevTools inspect
 * Safari pages while the user retains full mouse/keyboard interaction.
 *
 * Public API intentionally mirrors the subset of Selenium's WebDriver
 * that DesktopSafariBackend uses, so the swap is nearly transparent.
 */

import net from "node:net";
import fs from "fs/promises";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  services as iosDeviceServices,
} from "appium-ios-device";

const execFileAsync = promisify(execFile);
const defaultTimeoutMs = 15_000;
const safariBundleId = "com.apple.Safari";

// ── Socket discovery ────────────────────────────────────────────────

/**
 * Find the Desktop Safari webinspectord Unix socket.
 * The daemon writes a socket into a launchd-managed directory under
 * /private/tmp.  Simulator sockets contain "_sim" in the name;
 * the desktop socket does not.
 */
export async function findDesktopWebInspectorSocket() {
  // Method 1: scan launchd directories
  try {
    const tmpEntries = await fs.readdir("/private/tmp");
    for (const dir of tmpEntries) {
      if (!dir.startsWith("com.apple.launchd.")) continue;
      const fullDir = path.join("/private/tmp", dir);
      let files;
      try {
        files = await fs.readdir(fullDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.includes("webinspectord") && !file.includes("_sim")) {
          return path.join(fullDir, file);
        }
      }
    }
  } catch {}

  // Method 2: ask lsof
  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-aU", "-c", "webinspectord", "-F", "n"],
      { timeout: 5000 },
    );
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n/") && line.includes("webinspectord") && !line.includes("_sim")) {
        return line.slice(1);
      }
    }
    // Fallback: any non-sim socket from webinspectord
    for (const line of stdout.split("\n")) {
      if (line.startsWith("n/") && !line.includes("_sim")) {
        return line.slice(1);
      }
    }
  } catch {}

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// ── WirDriver ───────────────────────────────────────────────────────

/**
 * Drop-in replacement for Selenium WebDriver that talks the native
 * Web Inspector Remote (WIR) protocol over a Unix socket.
 *
 * Only the methods actually called by DesktopSafariBackend are
 * implemented.  Everything goes through Runtime.evaluate so the
 * page-side instrumentation bridge is identical.
 */
export class WirDriver {
  constructor(logger) {
    this.logger = logger;
    this.socket = null;
    this.service = null;
    this.connected = false;

    // WIR session identifiers
    this.connId = `desktop-wir-${Date.now()}`;
    this.senderId = `desktop-sender-${Date.now()}`;
    this.appId = null;
    this.pageId = null;
    this.targetId = null;

    // Pending message tracking
    this.pendingTopLevel = new Map();
    this.pendingCommands = new Map();
    this.nextMessageId = 1;

    // Discovered state
    this.apps = {};
    this.pages = {};
    this.socketPath = null;

    // Event callbacks
    this._onEvent = null;          // (method, params) => void — protocol events
    this._onTargetChanged = null;  // () => void — target ID changed (navigation)
  }

  // ── Public API (mirrors Selenium WebDriver) ──────────────────────

  /**
   * Connect to Desktop Safari's Web Inspector daemon.
   * Discovers the socket, enumerates Safari's open pages, and
   * attaches to the first non-about: page.
   */
  async connect() {
    this.socketPath = await findDesktopWebInspectorSocket();
    if (!this.socketPath) {
      throw new Error(
        "Desktop Safari webinspectord socket not found.\n" +
        "Make sure:\n" +
        "  1. Safari is running with at least one tab open\n" +
        "  2. The Develop menu is enabled:\n" +
        "     Safari → Settings → Advanced → Show features for web developers",
      );
    }
    this.logger?.info?.(`WIR socket: ${this.socketPath}`);

    // Connect the raw socket
    this.socket = net.connect(this.socketPath);
    this.socket.setNoDelay(true);
    this.socket.setKeepAlive(true);
    this.socket.on("close", () => {
      this.connected = false;
    });

    // Wrap in appium-ios-device's WebInspectorService for binary-plist framing
    this.service = await iosDeviceServices.startWebInspectorService(
      "desktop-safari",
      {
        socket: this.socket,
        isSimulator: true, // tells the service to use the provided socket directly
        osVersion: "15.0",
        verbose: Boolean(process.env.DEBUG),
        verboseHexDump: false,
      },
    );
    this.service.listenMessage((message) => {
      this.#handleMessage(message);
    });

    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
    this.connected = true;
    this.logger?.info?.("WIR transport connected");

    // Phase 1: Report our identifier
    this.#sendWir("_rpc_reportIdentifier:", {
      WIRConnectionIdentifierKey: this.connId,
    });

    // Phase 2: Get application dictionary and find Safari
    await this.#discoverSafariApp();

    // Phase 3: Get page listing and pick a page
    await this.#discoverPages();

    // Phase 4: Attach to the selected page
    this.#sendWir("_rpc_forwardSocketSetup:", {
      WIRConnectionIdentifierKey: this.connId,
      WIRApplicationIdentifierKey: this.appId,
      WIRPageIdentifierKey: Number(this.pageId),
      WIRSenderKey: this.senderId,
      WIRAutomaticallyPause: false,
    });

    await withTimeout(
      this.#waitForTargetId(),
      defaultTimeoutMs,
      "desktop target creation",
    );
    this.logger?.info?.(
      `Attached to page ${this.pageId} (target ${this.targetId}): ${this.pages[this.pageId]?.title || "(untitled)"}`,
    );
    // Brief settle time
    await delay(500);
  }

  /** Disconnect and clean up. */
  async quit() {
    try { this.service?.close(); } catch {}
    try { this.socket?.destroy(); } catch {}
    this.connected = false;
    this.pendingTopLevel.clear();
    this.pendingCommands.clear();
  }

  /** Navigate to a URL. */
  async get(url) {
    // Use Page.navigate when the target is ready
    try {
      await this.sendCommand("Page.navigate", { url });
    } catch {
      // Fallback: direct location change
      await this.executeScript(`window.location.href = ${JSON.stringify(url)}`);
    }
    // Wait for the page to load before returning
    await delay(1500);
    // Re-establish target if navigation caused a provisional target swap
    // (Safari often creates a new target on cross-origin navigation)
  }

  /** Return current URL. */
  async getCurrentUrl() {
    return await this.executeScript("return document.URL");
  }

  /** Compatibility shim for capability inspection. */
  async getCapabilities() {
    const map = new Map([
      ["browserName", "Safari"],
      ["browserVersion", "26"],
      ["platformName", "macOS"],
      ["webSocketUrl", ""],
      ["safari:automaticInspection", false],
    ]);
    return { map_: map };
  }

  /**
   * Execute JavaScript in the inspected page.
   *
   * Mirrors Selenium's executeScript:
   *   - The script is treated as a function body (may use `return`).
   *   - Extra arguments are available as `arguments[0]`, `arguments[1]`, …
   *   - The return value is deserialized by value.
   */
  async executeScript(script, ...args) {
    if (!this.connected) {
      throw new Error("WirDriver is not connected");
    }
    // Inline arguments[N] references with JSON-serialized values
    let expression = script;
    for (let i = args.length - 1; i >= 0; i--) {
      expression = expression.replaceAll(
        `arguments[${i}]`,
        JSON.stringify(args[i]),
      );
    }
    // Wrap in a function so `return` works (same as Selenium)
    const wrapped = `(function() { ${expression} })()`;
    const response = await this.sendCommand("Runtime.evaluate", {
      expression: wrapped,
      returnByValue: true,
      emulateUserGesture: true,
    });

    if (response?.result?.type === "undefined") {
      return undefined;
    }
    if (response?.wasThrown || response?.result?.subtype === "error") {
      const msg =
        response?.result?.description ||
        response?.result?.value ||
        "Script execution failed";
      throw new Error(msg);
    }
    if (Object.prototype.hasOwnProperty.call(response?.result || {}, "value")) {
      return response.result.value;
    }
    return response?.result?.description || response;
  }

  // ── Target enumeration (for the target picker page) ──────────────

  /**
   * Return an array of { appId, pageId, title, url } for all
   * inspectable Safari pages.
   */
  async getInspectablePages() {
    if (!this.connected) {
      return [];
    }
    try {
      await this.#refreshPages();
    } catch {}
    return Object.entries(this.pages).map(([id, info]) => ({
      appId: this.appId,
      pageId: Number(id),
      title: info.title || "(untitled)",
      url: info.url || "",
    }));
  }

  // ── Low-level WIR command transport ──────────────────────────────

  /** Send a WebKit Inspector command through the WIR tunnel. */
  async sendCommand(method, params = {}) {
    if (!this.connected) {
      throw new Error("WIR transport not connected");
    }
    const innerId = this.nextMessageId++;
    const payload = { id: innerId, method, params };
    const socketPayload = this.targetId
      ? {
          id: this.nextMessageId++,
          method: "Target.sendMessageToTarget",
          params: {
            targetId: this.targetId,
            message: JSON.stringify(payload),
          },
        }
      : payload;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(innerId);
        reject(new Error(`${method} timed out after ${defaultTimeoutMs}ms`));
      }, defaultTimeoutMs);

      this.pendingCommands.set(innerId, { resolve, reject, timer });

      try {
        this.#sendWir("_rpc_forwardSocketData:", {
          WIRConnectionIdentifierKey: this.connId,
          WIRApplicationIdentifierKey: this.appId,
          WIRPageIdentifierKey: Number(this.pageId),
          WIRSenderKey: this.senderId,
          WIRSocketDataKey: Buffer.from(JSON.stringify(socketPayload)),
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingCommands.delete(innerId);
        reject(error);
      }
    });
  }

  // ── Private: WIR protocol plumbing ───────────────────────────────

  /** Fire-and-forget a WIR selector. */
  #sendWir(selector, argument) {
    if (!this.service) {
      throw new Error("WIR service not ready");
    }
    this.service.sendMessage({
      __selector: selector,
      __argument: argument,
    });
  }

  /** Send a WIR selector and wait for a matching response. */
  #sendAndWait(selector, argument, { expectSelector, validate, sendMessage = true } = {}) {
    const expect = expectSelector || selector;
    return new Promise((resolve, reject) => {
      const token = Symbol(expect);
      const timer = setTimeout(() => {
        this.pendingTopLevel.delete(token);
        reject(new Error(`${selector} timed out after ${defaultTimeoutMs}ms`));
      }, defaultTimeoutMs);
      this.pendingTopLevel.set(token, {
        expectSelector: expect,
        validate: validate || null,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      try {
        if (sendMessage) {
          this.#sendWir(selector, argument);
        }
      } catch (error) {
        clearTimeout(timer);
        this.pendingTopLevel.delete(token);
        reject(error);
      }
    });
  }

  /** Handle all incoming WIR messages. */
  #handleMessage(message) {
    const selector = message?.__selector || "";
    if (process.env.DEBUG) {
      this.logger?.debug?.(
        `WIR ← ${selector} ${selector === "_rpc_applicationSentData:" ? "(data)" : JSON.stringify(message?.__argument || {}).slice(0, 300)}`,
      );
    }

    // Deliver to any pending top-level waiters
    for (const [token, pending] of this.pendingTopLevel) {
      if (pending.expectSelector !== selector) continue;
      if (pending.validate && !pending.validate(message)) continue;
      this.pendingTopLevel.delete(token);
      pending.resolve(message);
      break;
    }

    // Track application dictionary updates
    if (selector === "_rpc_applicationConnected:" || selector === "_rpc_applicationUpdated:") {
      const appDict = message?.__argument?.WIRApplicationDictionaryKey || {};
      Object.assign(this.apps, appDict);
    }
    if (selector === "_rpc_reportConnectedApplicationList:") {
      const appDict = message?.__argument?.WIRApplicationDictionaryKey || {};
      this.apps = appDict;
    }

    // Track page listing updates
    if (selector === "_rpc_applicationSentListing:") {
      const appId = message?.__argument?.WIRApplicationIdentifierKey;
      if (appId === this.appId) {
        const listing = message?.__argument?.WIRListingKey || {};
        this.pages = listing;
      }
    }

    // Handle data messages (command responses, target events)
    if (selector !== "_rpc_applicationSentData:") return;

    const rawPayload =
      message.__argument?.WIRMessageDataKey ||
      message.__argument?.WIRSocketDataKey;
    if (!rawPayload) return;

    let parsed = rawPayload;
    if (Buffer.isBuffer(rawPayload)) {
      try { parsed = JSON.parse(rawPayload.toString("utf8")); } catch { return; }
    } else if (typeof rawPayload === "string") {
      try { parsed = JSON.parse(rawPayload); } catch { return; }
    }

    if (process.env.DEBUG && parsed?.method) {
      this.logger?.debug?.(
        `WIR data: ${parsed.method} ${JSON.stringify(parsed.params || {}).slice(0, 200)}`,
      );
    }

    // Target lifecycle
    if (parsed?.method === "Target.targetCreated") {
      const info = parsed.params?.targetInfo || {};
      if (info.type === "page" || !this.targetId) {
        this.targetId = info.targetId || parsed.params?.targetId || this.targetId;
      }
      return;
    }
    if (parsed?.method === "Target.didCommitProvisionalTarget") {
      this.targetId =
        parsed.params?.newTargetId || parsed.params?.targetId || this.targetId;
      this._onTargetChanged?.();
      return;
    }
    if (parsed?.method === "Target.dispatchMessageFromTarget") {
      try {
        parsed = JSON.parse(parsed.params?.message || "{}");
      } catch { return; }
    }

    // Emit protocol events (messages with method but no id)
    if (parsed?.method && parsed?.id === undefined) {
      this._onEvent?.(parsed.method, parsed.params || {});
      return;
    }

    // Resolve pending commands (messages with id)
    if (parsed?.id !== undefined) {
      const pending = this.pendingCommands.get(Number(parsed.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCommands.delete(Number(parsed.id));
        if (parsed.error) {
          pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
        } else {
          pending.resolve(parsed.result ?? parsed);
        }
      }
    }
  }

  // ── Private: discovery helpers ───────────────────────────────────

  async #discoverSafariApp() {
    // Ask for the application list
    this.#sendWir("_rpc_getConnectedApplications:", {});

    // Wait for a response that contains Safari
    let lastError = null;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        await this.#sendAndWait(
          "_rpc_reportConnectedApplicationList:",
          {},
          {
            expectSelector: "_rpc_reportConnectedApplicationList:",
            sendMessage: false,
            validate: (msg) => {
              const dict = msg?.__argument?.WIRApplicationDictionaryKey || {};
              return Object.values(dict).some(
                (app) =>
                  app?.WIRApplicationBundleIdentifierKey === safariBundleId ||
                  app?.WIRApplicationIdentifierKey?.includes?.("Safari"),
              );
            },
          },
        );
        break;
      } catch (error) {
        lastError = error;
        // Re-request
        this.#sendWir("_rpc_getConnectedApplications:", {});
        await delay(500 * attempt);
      }
    }

    // Find Safari in whatever apps we've accumulated
    const safariEntry = Object.entries(this.apps).find(
      ([, app]) => app?.WIRApplicationBundleIdentifierKey === safariBundleId,
    );
    if (safariEntry) {
      this.appId = safariEntry[0];
      this.logger?.info?.(`Found Safari: appId=${this.appId}`);
      return;
    }
    // Fallback: pick any app that looks like Safari
    const fallback = Object.entries(this.apps).find(
      ([id, app]) =>
        id.includes("Safari") ||
        (app?.WIRApplicationNameKey || "").includes("Safari"),
    );
    if (fallback) {
      this.appId = fallback[0];
      this.logger?.info?.(`Found Safari (fallback): appId=${this.appId}`);
      return;
    }

    throw new Error(
      "Safari not found in webinspectord application list.\n" +
      "Make sure Safari is running with the Develop menu enabled.\n" +
      `Apps found: ${Object.keys(this.apps).join(", ") || "(none)"}`,
    );
  }

  async #discoverPages() {
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        await this.#sendAndWait(
          "_rpc_forwardGetListing:",
          {
            WIRConnectionIdentifierKey: this.connId,
            WIRApplicationIdentifierKey: this.appId,
          },
          {
            expectSelector: "_rpc_applicationSentListing:",
            validate: (msg) =>
              msg?.__argument?.WIRApplicationIdentifierKey === this.appId &&
              Object.keys(msg?.__argument?.WIRListingKey || {}).length > 0,
          },
        );
        break;
      } catch (error) {
        lastError = error;
        await delay(500 * attempt);
      }
    }

    if (Object.keys(this.pages).length === 0) {
      throw new Error(
        "No pages found in Safari.\n" +
        "Open at least one tab in Safari and try again.",
      );
    }

    // Pick a page: prefer non-about: pages
    const realPage = Object.entries(this.pages).find(
      ([, info]) => info?.WIRURLKey && !info.WIRURLKey.startsWith("about:"),
    );
    const firstPage = realPage || Object.entries(this.pages)[0];
    this.pageId = Number(firstPage[0]);

    // Normalize page info for easier access
    const normalized = {};
    for (const [id, info] of Object.entries(this.pages)) {
      normalized[id] = {
        title: info?.WIRTitleKey || info?.title || "",
        url: info?.WIRURLKey || info?.url || "",
        type: info?.WIRTypeKey || "page",
      };
    }
    this.pages = normalized;

    this.logger?.info?.(
      `Found ${Object.keys(this.pages).length} page(s): ${JSON.stringify(this.pages)}`,
    );
  }

  async #refreshPages() {
    try {
      await this.#sendAndWait(
        "_rpc_forwardGetListing:",
        {
          WIRConnectionIdentifierKey: this.connId,
          WIRApplicationIdentifierKey: this.appId,
        },
        {
          expectSelector: "_rpc_applicationSentListing:",
          validate: (msg) =>
            msg?.__argument?.WIRApplicationIdentifierKey === this.appId,
        },
      );
      // Normalize
      const normalized = {};
      for (const [id, info] of Object.entries(this.pages)) {
        normalized[id] = {
          title: info?.WIRTitleKey || info?.title || "",
          url: info?.WIRURLKey || info?.url || "",
          type: info?.WIRTypeKey || info?.type || "page",
        };
      }
      this.pages = normalized;
    } catch {}
  }

  #waitForTargetId() {
    if (this.targetId) {
      return Promise.resolve(this.targetId);
    }
    return new Promise((resolve) => {
      const poll = () => {
        if (this.targetId) {
          resolve(this.targetId);
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }
}
