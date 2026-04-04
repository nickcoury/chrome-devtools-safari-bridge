import { EventEmitter } from "node:events";
import fs from "fs/promises";
import net from "node:net";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  services as iosDeviceServices,
  utilities as iosDeviceUtilities,
} from "appium-ios-device";
import {
  TraceMap,
  originalPositionFor,
  generatedPositionFor,
} from "@jridgewell/trace-mapping";

const execFileAsync = promisify(execFile);
const defaultDeveloperDir = "/Applications/Xcode.app/Contents/Developer";
const mobileSafariBundleId = "com.apple.mobilesafari";
const defaultProbeTimeoutMs = 15_000;
const frontendUrl =
  process.env.FRONTEND_URL || "devtools://devtools/bundled/devtools_app.html";

function createDeveloperEnv() {
  return {
    ...process.env,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR || defaultDeveloperDir,
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runXcrun(args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/xcrun", args, {
      env: createDeveloperEnv(),
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      ok: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };
  } catch (error) {
    if (!allowFailure) {
      throw new Error(error.stderr?.trim?.() || error.message);
    }
    return {
      ok: false,
      stdout: error.stdout?.trim?.() || "",
      stderr: error.stderr?.trim?.() || error.message,
    };
  }
}

async function runDevicectl(args, { allowFailure = false } = {}) {
  return await runXcrun(["devicectl", ...args], { allowFailure });
}

export async function assertIosEnvironment() {
  const developerDir = createDeveloperEnv().DEVELOPER_DIR;
  if (!(await pathExists(developerDir))) {
    throw new Error(
      `Developer directory not found at ${developerDir}. Install Xcode or set DEVELOPER_DIR.`,
    );
  }
  return {
    developerDir,
  };
}

export async function listSimulators() {
  const devicesResult = await runXcrun(["simctl", "list", "devices", "--json"]);
  const runtimesResult = await runXcrun(["simctl", "list", "runtimes", "--json"]);
  const devices = JSON.parse(devicesResult.stdout).devices || {};
  const runtimes = JSON.parse(runtimesResult.stdout).runtimes || [];
  const runtimeNames = new Map(
    runtimes.map((runtime) => [runtime.identifier, runtime.name]),
  );

  const simulators = [];
  for (const [runtimeId, runtimeDevices] of Object.entries(devices)) {
    for (const device of runtimeDevices) {
      if (!device.isAvailable) {
        continue;
      }
      simulators.push({
        type: "simulator",
        udid: device.udid,
        name: device.name,
        state: device.state,
        runtimeId,
        runtimeName: runtimeNames.get(runtimeId) || runtimeId,
        platformVersion:
          runtimeNames.get(runtimeId)?.replace(/^iOS\s+/, "") ||
          runtimeId.replace(/^.*iOS-/, "").replace(/-/g, "."),
        deviceTypeIdentifier: device.deviceTypeIdentifier,
        lastBootedAt: device.lastBootedAt || "",
      });
    }
  }

  simulators.sort((left, right) => {
    if (left.state === "Booted" && right.state !== "Booted") {
      return -1;
    }
    if (left.state !== "Booted" && right.state === "Booted") {
      return 1;
    }
    return left.name.localeCompare(right.name);
  });

  return simulators;
}

export function selectSimulator(simulators, selector = {}) {
  const requestedId = selector.deviceId || "";
  const requestedName = selector.simulatorName || "";

  if (requestedId) {
    return simulators.find((simulator) => simulator.udid === requestedId) || null;
  }

  if (requestedName) {
    return (
      simulators.find((simulator) => simulator.name === requestedName) ||
      simulators.find((simulator) => simulator.name.includes(requestedName)) ||
      null
    );
  }

  return (
    simulators.find((simulator) => simulator.state === "Booted") ||
    simulators.find((simulator) => simulator.deviceTypeIdentifier.includes("iPhone")) ||
    simulators[0] ||
    null
  );
}

export async function bootSimulator(udid) {
  const bootResult = await runXcrun(["simctl", "boot", udid], { allowFailure: true });
  if (
    !bootResult.ok &&
    !bootResult.stderr.includes("Unable to boot device in current state: Booted")
  ) {
    throw new Error(bootResult.stderr || `Failed to boot simulator ${udid}`);
  }
  await runXcrun(["simctl", "bootstatus", udid, "-b"]);
}

export async function shutdownSimulator(udid) {
  await runXcrun(["simctl", "shutdown", udid], { allowFailure: true });
}

export async function launchSimulatorSafari(udid) {
  const result = await runXcrun([
    "simctl",
    "launch",
    "--terminate-running-process",
    udid,
    mobileSafariBundleId,
  ], { allowFailure: true });
  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr,
    };
  }
  return {
    ok: true,
  };
}

export async function navigateSimulatorToUrl(udid, url) {
  await runXcrun(["simctl", "openurl", udid, url]);
}

export async function launchRealDeviceSafari(udid, url = "") {
  const args = [
    "device",
    "process",
    "launch",
    "--device",
    udid,
    "--terminate-existing",
  ];
  if (url) {
    args.push("--payload-url", url);
  }
  args.push(mobileSafariBundleId);
  const result = await runDevicectl(args, { allowFailure: true });
  if (!result.ok) {
    return {
      ok: false,
      error: result.stderr || result.stdout || `Failed to launch Safari on ${udid}`,
    };
  }
  return {
    ok: true,
    stdout: result.stdout,
  };
}

export async function resolveSimulatorWebInspectorSocket(udid) {
  let stdout = "";
  try {
    const result = await execFileAsync("lsof", ["-aUc", "launchd_sim"], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    if (error.code === 1 && !error.stdout && !error.stderr) {
      return null;
    }
    throw error;
  }
  const udidPattern = new RegExp(`([0-9]{1,5}).+${udid}`);
  const udidMatch = stdout.match(udidPattern);
  if (!udidMatch) {
    return null;
  }
  const pidPattern = new RegExp(
    `${udidMatch[1]}.+\\s+(\\S+com\\.apple\\.webinspectord_sim\\.socket)`,
  );
  const pidMatch = stdout.match(pidPattern);
  return pidMatch?.[1] || null;
}

export async function listRealDevices() {
  const udids = await iosDeviceUtilities.getConnectedDevices();
  const devices = [];
  for (const udid of udids) {
    let name = udid;
    let platformVersion = "";
    try {
      name = await iosDeviceUtilities.getDeviceName(udid);
    } catch {}
    try {
      platformVersion = await iosDeviceUtilities.getOSVersion(udid);
    } catch {}
    devices.push({
      type: "device",
      udid,
      name,
      state: "connected",
      platformVersion,
    });
  }
  return devices;
}

function normalizePageArray(pageDict) {
  return Object.values(pageDict || {})
    .filter(
      (entry) =>
        !entry?.WIRTypeKey ||
        entry.WIRTypeKey === "WIRTypeWeb" ||
        entry.WIRTypeKey === "WIRTypeWebPage" ||
        entry.WIRTypeKey === "WIRTypePage",
    )
    .map((entry) => ({
      id: String(entry.WIRPageIdentifierKey),
      title: entry.WIRTitleKey || "",
      url: entry.WIRURLKey || "",
      isKey: Boolean(entry.WIRConnectionIdentifierKey),
      type: entry.WIRTypeKey || "WIRTypeWeb",
    }));
}

export function parseTargetId(targetId) {
  const parts = String(targetId || "").split(":");
  if (parts.length < 4) {
    return null;
  }
  const type = parts[0];
  const udid = parts[1];
  const pageId = parts.at(-1);
  const appId = parts.slice(2, -1).join(":");
  if (!type || !udid || !appId || !pageId) {
    return null;
  }
  return {
    type,
    udid,
    appId: `${appId.includes("PID") ? appId : `PID:${appId}`}`,
    pageId,
  };
}

function normalizeAppDictionary(appDict) {
  return Object.entries(appDict || {}).map(([appId, entry]) => ({
    appId,
    name: entry.WIRApplicationNameKey || entry.name || "",
    bundleId: entry.WIRApplicationBundleIdentifierKey || entry.bundleId || "",
    isActive: Boolean(entry.WIRIsApplicationActiveKey ?? entry.isActive),
    isAutomationEnabled: entry.WIRRemoteAutomationEnabledKey || entry.isAutomationEnabled || "Unknown",
    isProxy: Boolean(entry.WIRIsApplicationProxyKey ?? entry.isProxy),
    hostId: entry.WIRHostApplicationIdentifierKey || entry.hostId || "",
  }));
}

async function withTimeout(task, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function connectInspector({
  udid,
  platformVersion,
  socketPath,
  realDevice = false,
  logger,
}) {
  // Direct WIR probe — no appium-remote-debugger dependency.
  // Connects to the Web Inspector socket, enumerates apps and pages, disconnects.
  let socket = null;
  let service = null;
  try {
    if (realDevice) {
      service = await iosDeviceServices.startWebInspectorService(udid, {
        isSimulator: false,
        osVersion: platformVersion,
        verbose: false,
        verboseHexDump: false,
      });
    } else {
      socket = net.connect(socketPath);
      socket.setNoDelay(true);
      socket.setKeepAlive(true);
      service = await iosDeviceServices.startWebInspectorService(udid, {
        socket,
        isSimulator: true,
        osVersion: platformVersion,
        verbose: false,
        verboseHexDump: false,
      });
    }

    // Wait for socket connection (simulator only)
    if (socket) {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    }

    const connId = `probe-${Date.now()}`;
    const messageBuffer = [];
    service.listenMessage((msg) => {
      messageBuffer.push(msg);
      if (process.env.DEBUG) {
        logger?.debug?.(`probe WIR <- ${msg.__selector} ${JSON.stringify(msg.__argument || {}).slice(0, 100)}`);
      }
    });

    // Helper: wait for a message matching selector (checks buffer first, then polls)
    const waitFor = (selector, validate, timeout = 10000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${selector} timeout`)), timeout);
      const check = () => {
        for (let i = 0; i < messageBuffer.length; i++) {
          const msg = messageBuffer[i];
          if (msg.__selector === selector && (!validate || validate(msg))) {
            messageBuffer.splice(i, 1);
            clearTimeout(timer);
            resolve(msg);
            return;
          }
        }
        setTimeout(check, 50);
      };
      check();
    });

    // Step 1: Report identifier + request apps
    service.sendMessage({ __selector: "_rpc_reportIdentifier:", __argument: { WIRConnectionIdentifierKey: connId } });

    // Step 2: Wait for the app list (WebKit sends it after reportIdentifier)
    const appListMsg = await waitFor("_rpc_reportConnectedApplicationList:", null, 10000);
    const appDict = appListMsg?.__argument?.WIRApplicationDictionaryKey || {};
    const apps = normalizeAppDictionary(appDict);

    // Step 3: Get page listing — only query Safari and WebContent processes
    const pages = [];
    const errors = [];
    const safariApps = apps.filter(a =>
      a.bundleId === mobileSafariBundleId ||
      a.bundleId === "com.apple.WebKit.WebContent" ||
      (a.isActive && a.name === "Safari")
    );
    for (const app of safariApps) {
      try {
        service.sendMessage({
          __selector: "_rpc_forwardGetListing:",
          __argument: { WIRConnectionIdentifierKey: connId, WIRApplicationIdentifierKey: app.appId },
        });
        const listingMsg = await waitFor("_rpc_applicationSentListing:", (msg) =>
          msg.__argument?.WIRApplicationIdentifierKey === app.appId, 5000);
        const pageDict = listingMsg?.__argument?.WIRListingKey || {};
        const pageArray = normalizePageArray(pageDict);
        for (const page of pageArray) {
          pages.push({ appId: app.appId, appName: app.name, bundleId: app.bundleId, ...page });
        }
      } catch (error) {
        logger?.debug?.(`page listing for ${app.appId} (${app.bundleId}) failed: ${error.message}`);
        errors.push({ appId: app.appId, bundleId: app.bundleId, message: error.message });
      }
    }

    return { connected: true, apps, pages, errors, usesWebInspectorShim: false };
  } catch (error) {
    logger?.debug?.("web inspector probe failed", error?.message || String(error));
    return { connected: false, apps: [], pages: [], errors: [{ message: error.message }], usesWebInspectorShim: false };
  } finally {
    try { service?.close(); } catch {}
    try { socket?.destroy(); } catch {}
  }
}

export async function probeSimulatorWebInspector(simulator, logger) {
  const socketPath = await resolveSimulatorWebInspectorSocket(simulator.udid);
  if (!socketPath) {
    return {
      type: "simulator",
      device: simulator,
      socketPath: null,
      connected: false,
      apps: [],
      pages: [],
      errors: [{ message: "No simulator Web Inspector socket was found." }],
    };
  }
  const snapshot = await connectInspector(
    {
      udid: simulator.udid,
      platformVersion: simulator.platformVersion,
      socketPath,
      realDevice: false,
      logger,
    },
    logger,
  );
  return {
    type: "simulator",
    device: simulator,
    socketPath,
    ...snapshot,
  };
}

export async function probeRealDeviceWebInspector(device, logger) {
  const snapshot = await connectInspector(
    {
      udid: device.udid,
      platformVersion: device.platformVersion,
      realDevice: true,
      logger,
    },
    logger,
  );
  return {
    type: "device",
    device,
    ...snapshot,
  };
}

function titleFromPage(page) {
  return page.title || page.url || "Mobile Safari";
}

export function targetsFromProbe(probe, listPort) {
  if (!probe?.pages?.length) {
    return [];
  }
  return [...probe.pages]
    .sort((left, right) => Number(right.id) - Number(left.id))
    .map((page) => ({
    id: `${probe.type}:${probe.device.udid}:${page.appId}:${page.id}`,
    parentId: probe.device.udid,
    title: titleFromPage(page),
    type: "page",
    deviceType: probe.type,
    deviceName: probe.device.name,
    deviceUdid: probe.device.udid,
    bundleId: page.bundleId,
    url: page.url || "",
    description: `${probe.device.name} via native Web Inspector`,
    faviconUrl: "",
    devtoolsFrontendUrl: `${frontendUrl}?ws=localhost:${listPort}/devtools/page/${encodeURIComponent(`${probe.type}:${probe.device.udid}:${page.appId}:${page.id}`)}`,
    webSocketDebuggerUrl: `ws://localhost:${listPort}/devtools/page/${encodeURIComponent(`${probe.type}:${probe.device.udid}:${page.appId}:${page.id}`)}`,
    metadataUrl: `http://localhost:${listPort}/inspector/targets/${encodeURIComponent(`${probe.type}:${probe.device.udid}:${page.appId}:${page.id}`)}`,
  }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RawWirConnection extends EventEmitter {
  constructor({ udid, platformVersion, socketPath, appId, pageId, realDevice, logger }) {
    super();
    this.udid = udid;
    this.platformVersion = platformVersion;
    this.socketPath = socketPath;
    this.appId = appId;
    this.pageId = pageId;
    this.realDevice = realDevice;
    this.logger = logger;
    this.connId = `codex-${Date.now()}`;
    this.senderId = `codex-sender-${Date.now()}`;
    this.socket = null;
    this.service = null;
    this.pendingTopLevel = new Map();
    this.pendingCommands = new Map();
    this.targetId = null;
    this.connected = false;
    this.nextMessageId = 1;
  }

  async connect() {
    if (this.connected) {
      return;
    }
    this.logger?.debug?.(
      `${this.realDevice ? "device" : "sim"} wir connect start ${this.appId}/${this.pageId}`,
    );
    if (this.realDevice) {
      this.service = await iosDeviceServices.startWebInspectorService(this.udid, {
        isSimulator: false,
        osVersion: this.platformVersion,
        verbose: Boolean(process.env.DEBUG),
        verboseHexDump: false,
      });
    } else {
      this.socket = net.connect(this.socketPath);
      this.socket.setNoDelay(true);
      this.socket.setKeepAlive(true);
      this.socket.on("close", () => {
        this.connected = false;
      });
      this.service = await iosDeviceServices.startWebInspectorService(this.udid, {
        socket: this.socket,
        isSimulator: true,
        osVersion: this.platformVersion,
        verbose: Boolean(process.env.DEBUG),
        verboseHexDump: false,
      });
    }
    this.service.listenMessage((message) => {
      void this.#handleMessage(message);
    });
    if (this.socket) {
      await new Promise((resolve, reject) => {
        this.socket.once("connect", resolve);
        this.socket.once("error", reject);
      });
    }
    this.connected = true;
    this.logger?.debug?.(`${this.realDevice ? "device" : "sim"} wir transport connected`);

    await this.#sendSelector(
      "_rpc_reportIdentifier:",
      {
        WIRConnectionIdentifierKey: this.connId,
      },
      { waitForEvent: false },
    );
    await this.#waitForApplicationDictionary();
    this.logger?.debug?.(`${this.realDevice ? "device" : "sim"} wir app list received`);
    await this.#waitForPageListing();
    this.logger?.debug?.(`${this.realDevice ? "device" : "sim"} wir listing received`);
    await this.#sendSelector(
      "_rpc_forwardSocketSetup:",
      {
        WIRConnectionIdentifierKey: this.connId,
        WIRApplicationIdentifierKey: this.appId,
        WIRPageIdentifierKey: Number(this.pageId),
        WIRSenderKey: this.senderId,
        WIRAutomaticallyPause: false,
      },
      { waitForEvent: false },
    );
    this.logger?.debug?.(`${this.realDevice ? "device" : "sim"} wir socket setup sent`);
    try {
      await withTimeout(
        this.#waitForTargetId(),
        this.realDevice ? defaultProbeTimeoutMs : 5000,
        `${this.realDevice ? "device" : "simulator"} target creation`,
      );
      this.logger?.debug?.(
        `${this.realDevice ? "device" : "sim"} wir target ready ${this.targetId}`,
      );
    } catch {
      // Simulators may not use Target multiplexing — proceed without targetId.
      // Commands will be sent directly without Target.sendMessageToTarget wrapping.
      this.logger?.debug?.(`${this.realDevice ? "device" : "sim"} wir proceeding without targetId (direct mode)`);
    }
  }

  async disconnect() {
    try { this.socket?.removeAllListeners(); } catch {}
    try { this.service?.close(); } catch {}
    try { this.socket?.destroy(); } catch {}
    this.connected = false;
    this.socket = null;
    this.service = null;
    this.pendingTopLevel.clear();
    this.pendingCommands.clear();
  }

  async sendCommand(method, params = {}) {
    await this.connect();
    const innerId = this.nextMessageId++;
    const payload = {
      id: innerId,
      method,
      params,
    };
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
        reject(new Error(`${method} timed out after ${defaultProbeTimeoutMs}ms`));
      }, defaultProbeTimeoutMs);
      this.pendingCommands.set(innerId, { resolve, reject, timer });
      void this.#sendSelector(
        "_rpc_forwardSocketData:",
        {
          WIRConnectionIdentifierKey: this.connId,
          WIRApplicationIdentifierKey: this.appId,
          WIRPageIdentifierKey: Number(this.pageId),
          WIRSenderKey: this.senderId,
          WIRSocketDataKey: Buffer.from(JSON.stringify(socketPayload)),
        },
        { waitForEvent: false },
      ).catch((error) => {
        clearTimeout(timer);
        this.pendingCommands.delete(innerId);
        reject(error);
      });
    });
  }

  async #waitForTargetId() {
    if (this.targetId) {
      return this.targetId;
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`No targetId arrived for ${this.appId}/${this.pageId}.`));
      }, defaultProbeTimeoutMs);
      const poll = () => {
        if (this.targetId) {
          clearTimeout(timer);
          resolve(this.targetId);
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }

  async #waitForApplicationDictionary() {
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await this.#sendSelector(
          "_rpc_getConnectedApplications:",
          {},
          { waitForEvent: false },
        );
        await this.#sendSelector(
          "_rpc_reportConnectedApplicationList:",
          {},
          {
            expectSelector: "_rpc_reportConnectedApplicationList:",
            sendMessage: false,
            validate: (plist) =>
              Object.prototype.hasOwnProperty.call(
                plist.__argument?.WIRApplicationDictionaryKey || {},
                this.appId,
              ),
          },
        );
        return;
      } catch (error) {
        lastError = error;
        await delay(500 * attempt);
      }
    }
    throw lastError || new Error(`App dictionary never included ${this.appId}.`);
  }

  async #waitForPageListing() {
    let lastError = null;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await this.#sendSelector(
          "_rpc_forwardGetListing:",
          {
            WIRConnectionIdentifierKey: this.connId,
            WIRApplicationIdentifierKey: this.appId,
          },
          {
            expectSelector: "_rpc_applicationSentListing:",
            validate: (plist) =>
              plist.__argument?.WIRApplicationIdentifierKey === this.appId &&
              Object.prototype.hasOwnProperty.call(
                plist.__argument?.WIRListingKey || {},
                Number(this.pageId),
              ),
          },
        );
        return;
      } catch (error) {
        lastError = error;
        await delay(500 * attempt);
      }
    }
    throw lastError || new Error(`Page listing never included ${this.appId}/${this.pageId}.`);
  }

  async #sendSelector(selector, argument, options = {}) {
    if (!this.connected) {
      throw new Error("Raw WIR transport is not connected.");
    }
    const {
      expectSelector = selector,
      validate = null,
      waitForEvent = true,
      sendMessage = true,
    } = options;
    if (!waitForEvent) {
      this.service.sendMessage({
        __selector: selector,
        __argument: argument,
      });
      return null;
    }
    return await new Promise((resolve, reject) => {
      const token = Symbol(expectSelector);
      const timer = setTimeout(() => {
        this.pendingTopLevel.delete(token);
        reject(new Error(`${selector} timed out after ${defaultProbeTimeoutMs}ms`));
      }, defaultProbeTimeoutMs);
      this.pendingTopLevel.set(token, {
        expectSelector,
        validate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      try {
        if (sendMessage) {
          this.service.sendMessage({
            __selector: selector,
            __argument: argument,
          });
        }
      } catch (error) {
        clearTimeout(timer);
        this.pendingTopLevel.delete(token);
        reject(error);
      }
    });
  }

  async #handleMessage(message) {
    const selector = message?.__selector || "";

    // Log all incoming messages for debugging
    if (process.env.DEBUG) {
      this.logger?.debug?.(
        `WIR <- ${selector} ${selector === "_rpc_applicationSentData:" ? "(data)" : JSON.stringify(message?.__argument || {}).slice(0, 200)}`,
      );
    }

    for (const [token, pending] of this.pendingTopLevel) {
      if (pending.expectSelector !== selector) {
        continue;
      }
      if (pending.validate && !pending.validate(message)) {
        continue;
      }
      this.pendingTopLevel.delete(token);
      pending.resolve(message);
      break;
    }

    if (selector !== "_rpc_applicationSentData:") {
      return;
    }
    const rawPayload =
      message.__argument?.WIRMessageDataKey || message.__argument?.WIRSocketDataKey;
    if (!rawPayload) {
      return;
    }
    let parsed = rawPayload;
    if (Buffer.isBuffer(rawPayload)) {
      try {
        parsed = JSON.parse(rawPayload.toString("utf8"));
      } catch {
        return;
      }
    } else if (typeof rawPayload === "string") {
      try {
        parsed = JSON.parse(rawPayload);
      } catch {
        return;
      }
    }
    // Log all parsed WIR data messages for debugging
    if (process.env.DEBUG && parsed?.method) {
      this.logger?.debug?.(`WIR data method: ${parsed.method} ${JSON.stringify(parsed.params || {}).slice(0, 200)}`);
    }

    if (parsed?.method === "Target.targetCreated") {
      const targetInfo = parsed.params?.targetInfo || {
        targetId: parsed.params?.targetId || null,
        type: null,
      };
      if (targetInfo.type === "page") {
        this.targetId = targetInfo.targetId;
      } else if (!this.targetId) {
        this.targetId = targetInfo.targetId;
      }
      return;
    }
    if (parsed?.method === "Target.didCommitProvisionalTarget") {
      this.targetId =
        parsed.params?.newTargetId || parsed.params?.targetId || this.targetId;
      return;
    }
    if (parsed?.method === "Target.dispatchMessageFromTarget") {
      try {
        parsed = JSON.parse(parsed.params?.message || "{}");
      } catch {
        return;
      }
    }
    // Check if this is a response to a pending command
    if (parsed?.id !== undefined && parsed?.id !== null) {
      const pending = this.pendingCommands.get(Number(parsed.id));
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingCommands.delete(Number(parsed.id));
        if (parsed.error) {
          pending.reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
        } else {
          pending.resolve(parsed.result ?? parsed);
        }
        return;
      }
    }
    // Unsolicited event from WebKit — emit it
    if (parsed?.method) {
      if (process.env.DEBUG) {
        this.logger?.debug?.(`WIR event -> emit: ${parsed.method}`);
      }
      this.emit("event", parsed.method, parsed.params || {});
    }
  }
}

export class MobileInspectorSession {
  constructor({ target, logger }) {
    this.target = target;
    this.logger = logger;
    this.rpcClient = null;
    this.rawWir = null;
    this.connected = false;
    this.lastSnapshot = null;
    this.nextNodeId = 1;
    this.networkBodies = new Map();
    this.scriptCacheData = new Map();
    this.scriptUrlToId = new Map(); // URL → scriptId index for O(1) lookups
    this.nextScriptIdCounter = 1;
    this.scriptIdsByKey = new Map();
    this.sourceMapCache = new Map();
    this.resourceCache = new Map();
    this.reconnecting = false;

    // Native event buffers — populated by WIR event listener
    this.nativeConsoleEvents = [];
    this.nativeNetworkEvents = [];
    this.nativeDebuggerEvents = [];
    this.nativeScriptsParsed = [];
    this.nativeOtherEvents = [];
    // Track which native domains are enabled
    this.nativeDebuggerEnabled = false;
    this.nativeConsoleEnabled = false;
    this.nativeNetworkEnabled = false;
  }

  async connect() {
    if (this.connected) {
      return;
    }
    // Prevent concurrent connect attempts
    if (this._connectPromise) {
      return this._connectPromise;
    }
    this._connectPromise = this._doConnect();
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  async _doConnect() {
    const transport = await this.#resolveTransport();
    this.rawWir = new RawWirConnection({
      udid: transport.udid,
      platformVersion: transport.platformVersion,
      socketPath: transport.socketPath,
      appId: this.target.appId,
      pageId: this.target.pageId,
      realDevice: transport.realDevice,
      logger: this.logger,
    });
    await this.rawWir.connect();
    this.connected = true;
    this.lastSnapshot = {
      url: "",
      title: "",
      root: null,
      nodes: new Map(),
    };

    // Listen for all native WebKit events from the WIR transport
    this.rawWir.on("event", (method, params) => {
      this.#handleNativeEvent(method, params);
    });

    // Give the WIR connection a moment to settle before enabling native domains.
    // Real devices need time for the Target protocol to stabilize.
    await new Promise((r) => setTimeout(r, this.target?.type === "device" ? 800 : 300));

    // Enable native WebKit domains — these give us real events instead of polling
    await this.#enableNativeDomains();

    // All domains now use native WebKit protocol — no cooperative instrumentation needed
  }

  async #enableNativeDomains() {
    const enable = async (domain) => {
      try {
        await this.rawWir.sendCommand(`${domain}.enable`, {});
        this.logger?.debug?.(`native ${domain}.enable OK`);
        return true;
      } catch (e) {
        this.logger?.debug?.(`native ${domain}.enable failed: ${e.message}`);
        return false;
      }
    };
    this.nativeConsoleEnabled = await enable("Console");
    this.nativeNetworkEnabled = await enable("Network");
    this.nativeDebuggerEnabled = await enable("Debugger");
    if (this.nativeDebuggerEnabled) {
      // Activate breakpoints and pause-on-debugger-statements by default
      try { await this.rawWir.sendCommand("Debugger.setBreakpointsActive", { active: true }); } catch {}
      try { await this.rawWir.sendCommand("Debugger.setPauseAllowedByPagePolicy", { allowed: true }); } catch {}
      // WebKit requires explicit opt-in to pause on `debugger` statements (Chrome does this implicitly)
      try { await this.rawWir.sendCommand("Debugger.setPauseOnDebuggerStatements", { enabled: true }); } catch {}
    }
    try { await enable("Page"); } catch {}
    // DOM, CSS, DOMStorage enabled lazily when DevTools requests them —
    // enabling them eagerly floods the event stream with mutation/style events
    // on dynamic pages, causing severe lag.
  }

  #handleNativeEvent(method, params) {
    // Debugger events
    if (method === "Debugger.scriptParsed") {
      // Filter out injected/internal scripts
      const url = params.url || "";
      const sourceURL = params.sourceURL || "";
      if (sourceURL.startsWith("__InjectedScript") || sourceURL.startsWith("__WebInspector")) return;
      if (params.isContentScript) return;
      if (url.startsWith("user-script:")) return;
      // Filter out eval'd scripts with no meaningful URL (instrumentation injections)
      if (!url && !sourceURL) return;
      this.nativeScriptsParsed.push(params);
      // Also update scriptCacheData for getScriptSource
      const scriptId = String(params.scriptId);
      if (!this.scriptCacheData.has(scriptId)) {
        const scriptUrl = sourceURL || url || "";
        if (scriptUrl) this.scriptUrlToId.set(scriptUrl, scriptId);
        this.scriptCacheData.set(scriptId, {
          url: scriptUrl,
          startLine: params.startLine || 0,
          endLine: params.endLine || 0,
          executionContextId: 1,
          hash: "",
          isModule: params.module || false,
          sourceMapURL: params.sourceMapURL || "",
          source: null, // lazy-loaded on getScriptSource
          kind: "generated",
        });
        // If script has a source map, fetch it async and create virtual source scripts
        if (params.sourceMapURL) {
          this.#processSourceMap(scriptId, scriptUrl, params.sourceMapURL).catch(e => {
            this.logger?.debug?.(`source map processing failed for ${scriptUrl}: ${e.message}`);
          });
        }
      }
      return;
    }
    if (method === "Debugger.paused") {
      this.nativeDebuggerEvents.push({ method, params });
      return;
    }
    if (method === "Debugger.resumed") {
      this.nativeDebuggerEvents.push({ method, params });
      return;
    }
    if (method === "Debugger.breakpointResolved") {
      this.nativeDebuggerEvents.push({ method, params });
      return;
    }

    // Console events
    if (method === "Console.messageAdded") {
      this.nativeConsoleEvents.push(params);
      return;
    }

    // Network events
    if (method.startsWith("Network.")) {
      this.nativeNetworkEvents.push({ method, params });
      return;
    }

    // All other domain events — buffer generically for forwarding (cap at 500 to prevent memory growth)
    if (this.nativeOtherEvents.length < 500) {
      this.nativeOtherEvents.push({ method, params });
    }
  }

  // Fast check: any events waiting to be drained?
  get hasPendingEvents() {
    return this.nativeConsoleEvents.length > 0 ||
      this.nativeNetworkEvents.length > 0 ||
      this.nativeDebuggerEvents.length > 0 ||
      this.nativeScriptsParsed.length > 0 ||
      this.nativeOtherEvents.length > 0;
  }

  // Drain native console events
  drainNativeConsoleEvents() {
    const events = this.nativeConsoleEvents.splice(0);
    return events;
  }

  // Drain native network events (replaces cooperative polling)
  drainNativeNetworkEvents() {
    const events = this.nativeNetworkEvents.splice(0);
    return events;
  }

  // Drain native debugger events
  drainNativeDebuggerEvents() {
    const events = this.nativeDebuggerEvents.splice(0);
    return events;
  }

  // Drain native scriptParsed events
  drainNativeScriptsParsed() {
    const events = this.nativeScriptsParsed.splice(0);
    return events;
  }

  // Drain other native events (DOMStorage, LayerTree, Timeline, etc.)
  drainNativeOtherEvents() {
    return this.nativeOtherEvents.splice(0);
  }

  // Send a native debugger command
  async sendNativeDebuggerCommand(method, params = {}) {
    if (!this.nativeDebuggerEnabled) {
      throw new Error("Native debugger not enabled");
    }
    return await this.rawWir.sendCommand(method, params);
  }

  // Get script source via native protocol
  async getNativeScriptSource(scriptId) {
    const cached = this.scriptCacheData.get(scriptId);
    if (cached?.source != null) return cached.source;
    try {
      const result = await this.rawWir.sendCommand("Debugger.getScriptSource", { scriptId });
      const source = result?.scriptSource || "";
      if (cached) cached.source = source;
      return source;
    } catch (e) {
      this.logger?.debug?.(`getScriptSource(${scriptId}) failed: ${e.message}`);
      return "";
    }
  }

  async disconnect() {
    if (this.rawWir) {
      this.rawWir.removeAllListeners("event");
      await this.rawWir.disconnect();
      this.rawWir = null;
    }
    this.connected = false;
    this.rpcClient = null;
    this.remoteDebugger = null;
    // Clear event buffers to prevent stale data on reconnect
    this.nativeConsoleEvents = [];
    this.nativeNetworkEvents = [];
    this.nativeDebuggerEvents = [];
    this.nativeScriptsParsed = [];
    this.nativeOtherEvents = [];
    this.networkBodies.clear();
  }

  async refreshSnapshot() {
    await this.connect();
    const root = await this.#executeAndReturn(`
      (() => {
        let nextId = 1;
        function attrPairs(element) {
          const out = [];
          if (!element?.attributes) return out;
          for (const attr of element.attributes) out.push(attr.name, attr.value);
          return out;
        }
        function visit(node, path, depth) {
          const item = {
            nodeId: nextId++,
            backendNodeId: nextId - 1,
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
            item.documentURL = document.URL;
            item.baseURL = document.baseURI;
            item.xmlVersion = "";
            item.compatibilityMode = document.compatMode;
          }
          if (node.nodeType === Node.ELEMENT_NODE) {
            item.frameId = "root";
          }
          if (depth !== 0 && node.childNodes?.length) {
            item.children = Array.from(node.childNodes, (child, index) =>
              visit(child, path.concat(index), depth > 0 ? depth - 1 : depth),
            );
          }
          return item;
        }
        return {
          root: visit(document, [], -1),
          url: document.URL,
          title: document.title,
        };
      })()
    `);
    const nodes = new Map();
    const index = (node) => {
      nodes.set(node.nodeId, node);
      for (const child of node.children || []) {
        index(child);
      }
    };
    index(root.root);
    this.nextNodeId = Math.max(...nodes.keys()) + 1;
    this.lastSnapshot = {
      ...root,
      nodes,
    };
    return this.lastSnapshot;
  }

  async getDocument() {
    // Use cached snapshot if less than 2s old — avoid hammering the device
    if (this.lastSnapshot?.root && this._snapshotTime && Date.now() - this._snapshotTime < 2000) {
      return this.lastSnapshot.root;
    }
    const snapshot = await this.refreshSnapshot();
    this._snapshotTime = Date.now();
    return snapshot.root;
  }

  async getNode(nodeId) {
    if (!this.lastSnapshot?.nodes?.has(nodeId)) {
      // Only refresh if we truly don't have the node
      if (!this._snapshotTime || Date.now() - this._snapshotTime > 10000) {
        await this.refreshSnapshot();
        this._snapshotTime = Date.now();
      }
    }
    return this.lastSnapshot.nodes.get(nodeId) || null;
  }

  async requestChildNodes(nodeId, depth = -1) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) {
      return [];
    }
    if (Array.isArray(node.children) && node.children.length) {
      return node.children;
    }
    const fetchDepth = depth === -1 ? 10 : Math.max(depth, 2);
    const children = await this.#executeAndReturn(`
      (() => {
        function attrPairs(element) {
          const out = [];
          if (!element?.attributes) return out;
          for (const attr of element.attributes) out.push(attr.name, attr.value);
          return out;
        }
        function visit(node, path, depth) {
          const item = {
            nodeType: node.nodeType,
            nodeName: node.nodeName,
            localName: node.localName || "",
            nodeValue: node.nodeValue || "",
            childNodeCount: node.childNodes ? node.childNodes.length : 0,
            children: [],
            attributes: node.nodeType === Node.ELEMENT_NODE ? attrPairs(node) : [],
            backendPath: path,
            frameId: node.nodeType === Node.ELEMENT_NODE ? "root" : undefined,
          };
          if (depth > 0 && node.childNodes?.length) {
            item.children = Array.from(node.childNodes, (child, i) =>
              visit(child, path.concat(i), depth - 1)
            );
          }
          return item;
        }
        const path = ${JSON.stringify(node.backendPath)};
        let current = document;
        for (const index of path) current = current.childNodes[index];
        return Array.from(current?.childNodes || [], (child, index) =>
          visit(child, path.concat(index), ${fetchDepth}),
        );
      })()
    `);
    const assignIds = (n) => {
      n.nodeId = this.nextNodeId++;
      n.backendNodeId = n.nodeId;
      this.lastSnapshot.nodes.set(n.nodeId, n);
      for (const c of n.children || []) assignIds(c);
    };
    for (const child of children) assignIds(child);
    node.children = children;
    return children;
  }

  async describeNode(nodeId) {
    return await this.getNode(nodeId);
  }

  async evaluate(expression) {
    const value = await this.#executeAndReturn(expression);
    return this.#toRemoteObject(value);
  }

  async navigate(url) {
    await this.connect();
    // Use native Page.navigate if connected, fallback to simctl/launch
    try {
      const result = await this.rawWir.sendCommand("Page.navigate", { url });
      await delay(500);
      return {
        frameId: result?.frameId || "root",
        loaderId: result?.loaderId || `mobile-loader-${Date.now()}`,
        url,
      };
    } catch {
      // Fallback to platform-specific navigation
      if (this.target.type === "simulator") {
        await navigateSimulatorToUrl(this.target.udid, url);
      } else {
        const result = await launchRealDeviceSafari(this.target.udid, url);
        if (!result.ok) {
          throw new Error(result.error);
        }
      }
      await delay(1_000);
      return {
        frameId: "root",
        loaderId: `mobile-loader-${Date.now()}`,
        url,
      };
    }
  }

  async getOuterHTML(nodeId) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) {
      return "";
    }
    return await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
        let current = document;
        for (const index of path) {
          current = current.childNodes[index];
        }
        return current?.outerHTML ?? current?.nodeValue ?? "";
      })()
    `);
  }

  async getBoxModel(nodeId) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) {
      return null;
    }
    const data = await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
        let el = document;
        for (const i of path) el = el?.childNodes?.[i];
        if (!el?.getBoundingClientRect) return null;
        const r = el.getBoundingClientRect();
        const cs = el.nodeType === 1 ? getComputedStyle(el) : null;
        const mt = parseFloat(cs?.marginTop) || 0;
        const mr = parseFloat(cs?.marginRight) || 0;
        const mb = parseFloat(cs?.marginBottom) || 0;
        const ml = parseFloat(cs?.marginLeft) || 0;
        const pt = parseFloat(cs?.paddingTop) || 0;
        const pr = parseFloat(cs?.paddingRight) || 0;
        const pb = parseFloat(cs?.paddingBottom) || 0;
        const pl = parseFloat(cs?.paddingLeft) || 0;
        const bt = parseFloat(cs?.borderTopWidth) || 0;
        const bri = parseFloat(cs?.borderRightWidth) || 0;
        const bb = parseFloat(cs?.borderBottomWidth) || 0;
        const bli = parseFloat(cs?.borderLeftWidth) || 0;
        return { x: r.x, y: r.y, w: r.width, h: r.height,
          mt, mr, mb, ml, pt, pr, pb, pl, bt, bri, bb, bli };
      })()
    `);
    if (!data) return null;
    const { x, y, w, h, mt, mr, mb, ml, pt, pr, pb, pl, bt, bri, bb, bli } = data;
    // Content box (innermost)
    const cx = x + bli + pl, cy = y + bt + pt;
    const cw = w - bli - bri - pl - pr, ch = h - bt - bb - pt - pb;
    // Padding box
    const px = x + bli, py = y + bt;
    const pw = w - bli - bri, ph = h - bt - bb;
    // Margin box (outermost)
    const mx = x - ml, my = y - mt;
    const mw = w + ml + mr, mh = h + mt + mb;
    const quad = (qx, qy, qw, qh) => [qx, qy, qx+qw, qy, qx+qw, qy+qh, qx, qy+qh];
    return {
      model: {
        content: quad(cx, cy, cw, ch),
        padding: quad(px, py, pw, ph),
        border: quad(x, y, w, h),
        margin: quad(mx, my, mw, mh),
        width: Math.round(w),
        height: Math.round(h),
      },
    };
  }

  // ── Element Highlighting ──────────────────────────────────────────

  async highlightNode(nodeId, highlightConfig = {}) {
    // Use DOM.resolveNode + callFunctionOn — no snapshot lookup needed
    try {
      const resolved = await this.rawWir.sendCommand("DOM.resolveNode", { nodeId, objectGroup: "highlight" });
      if (!resolved?.object?.objectId) return;
      const cc = highlightConfig?.contentColor || { r: 111, g: 168, b: 220, a: 0.66 };
      const mc = highlightConfig?.marginColor || { r: 246, g: 178, b: 107, a: 0.66 };
      await this.rawWir.sendCommand("Runtime.callFunctionOn", {
        objectId: resolved.object.objectId,
        functionDeclaration: `function(cc,mc){
          if(!this.getBoundingClientRect)return;
          var r=this.getBoundingClientRect(),cs=this.nodeType===1?getComputedStyle(this):null;
          var o=document.getElementById('__cdt_highlight_overlay');
          if(!o){o=document.createElement('div');o.id='__cdt_highlight_overlay';document.documentElement.appendChild(o);}
          o.style.cssText='position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;';
          var rgba=function(c){return 'rgba('+c.r+','+c.g+','+c.b+','+(c.a||0.5)+')';};
          var tag=this.tagName?this.tagName.toLowerCase():'',eid=this.id?'#'+this.id:'';
          o.innerHTML='<div style="position:fixed;pointer-events:none;z-index:2147483647;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px;background:'+rgba(cc)+';border:1px solid rgba('+cc.r+','+cc.g+','+cc.b+',0.8);"></div>'+
            '<div style="position:fixed;z-index:2147483647;pointer-events:none;background:rgba(0,0,0,0.8);color:#fff;font:11px/1.3 monospace;padding:2px 6px;border-radius:3px;white-space:nowrap;left:'+r.left+'px;top:'+(r.top>24?r.top-20:r.bottom+4)+'px;">'+tag+eid+' '+Math.round(r.width)+'\\u00d7'+Math.round(r.height)+'</div>';
          o.style.display='block';
        }`,
        arguments: [{ value: cc }, { value: mc }],
      });
    } catch {}
  }

  async highlightRect(x, y, width, height, color) {
    const c = color || { r: 111, g: 168, b: 220, a: 0.66 };
    await this.#executeAndReturn(`
      (() => {
        let overlay = document.getElementById('__cdt_highlight_overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = '__cdt_highlight_overlay';
          overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;';
          document.documentElement.appendChild(overlay);
        }
        overlay.innerHTML = '<div style="position:fixed;pointer-events:none;z-index:2147483647;'+
          'left:${x}px;top:${y}px;width:${width}px;height:${height}px;'+
          'background:rgba(${c.r},${c.g},${c.b},${c.a || 0.5});"></div>';
        overlay.style.display = 'block';
      })()
    `);
  }

  async hideHighlight() {
    try {
      await this.rawWir.sendCommand("Runtime.evaluate", {
        expression: "(() => { var el = document.getElementById('__cdt_highlight_overlay'); if (el) { el.style.display = 'none'; el.innerHTML = ''; } })()",
      });
    } catch {}
  }

  // ── DOM Editing ───────────────────────────────────────────────────

  async setOuterHTML(nodeId, outerHTML) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) return;
    await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
        let el = document;
        for (const i of path) el = el?.childNodes?.[i];
        if (!el) return;
        if (el.nodeType === 1) {
          el.outerHTML = ${JSON.stringify(outerHTML)};
        } else if (el.nodeType === 3 || el.nodeType === 8) {
          el.nodeValue = ${JSON.stringify(outerHTML)};
        }
      })()
    `);
    this._snapshotTime = 0; // invalidate cache
  }

  async setAttributeValue(nodeId, name, value) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) return;
    await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
        let el = document;
        for (const i of path) el = el?.childNodes?.[i];
        if (el?.setAttribute) el.setAttribute(${JSON.stringify(name)}, ${JSON.stringify(value)});
      })()
    `);
    this._snapshotTime = 0;
  }

  async setAttributesAsText(nodeId, text, name) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) return;
    await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
        let el = document;
        for (const i of path) el = el?.childNodes?.[i];
        if (!el?.setAttribute) return;
        // Remove old attribute if renaming
        if (${JSON.stringify(name)} && ${JSON.stringify(name)} !== '') {
          el.removeAttribute(${JSON.stringify(name)});
        }
        // Parse "attr1=val1 attr2=val2" text
        const tmp = document.createElement('div');
        tmp.innerHTML = '<span ' + ${JSON.stringify(text)} + '></span>';
        const span = tmp.firstChild;
        if (span?.attributes) {
          for (const attr of span.attributes) {
            el.setAttribute(attr.name, attr.value);
          }
        }
      })()
    `);
    this._snapshotTime = 0;
  }

  async setNodeValue(nodeId, value) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) return;
    await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
        let el = document;
        for (const i of path) el = el?.childNodes?.[i];
        if (el) el.nodeValue = ${JSON.stringify(value)};
      })()
    `);
    this._snapshotTime = 0;
  }

  async removeNode(nodeId) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) return;
    await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
        let el = document;
        for (const i of path) el = el?.childNodes?.[i];
        if (el?.parentNode) el.parentNode.removeChild(el);
      })()
    `);
    this._snapshotTime = 0;
  }

  async setInspectedNode(nodeId) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) return;
    await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
        let el = document;
        for (const i of path) el = el?.childNodes?.[i];
        window.$4 = window.$3;
        window.$3 = window.$2;
        window.$2 = window.$1;
        window.$1 = window.$0;
        window.$0 = el;
      })()
    `);
  }

  async getInlineStyles(nodeId) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) return [];
    return await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
        let el = document;
        for (const i of path) el = el?.childNodes?.[i];
        if (!el?.style) return [];
        const props = [];
        for (let i = 0; i < el.style.length; i++) {
          const name = el.style[i];
          props.push({
            name,
            value: el.style.getPropertyValue(name),
            important: el.style.getPropertyPriority(name) === "important",
            implicit: false,
            text: name + ": " + el.style.getPropertyValue(name) +
              (el.style.getPropertyPriority(name) ? " !important" : "") + ";",
            range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
          });
        }
        return props;
      })()
    `);
  }

  async getComputedStyle(nodeId) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) {
      return [];
    }
    return await this.#executeAndReturn(`
      (() => {
        const path = ${JSON.stringify(node.backendPath)};
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
      })()
    `);
  }

  async getMatchedStyles(nodeId) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) {
      return {
        inlineStyle: { styleSheetId: "inline", cssProperties: [], shorthandEntries: [] },
        matchedCSSRules: [],
      };
    }
    const result = await this.#executeAndReturn(`
      (() => {
        var path = ${JSON.stringify(node.backendPath)};
        var current = document;
        for (var i = 0; i < path.length; i++) {
          current = current.childNodes[path[i]];
        }
        if (!current || current.nodeType !== Node.ELEMENT_NODE) {
          return { inlineStyle: [], matchedCSSRules: [] };
        }

        // Inline styles
        var inlineProps = [];
        var inline = current.style;
        if (inline) {
          for (var j = 0; j < inline.length; j++) {
            var name = inline[j];
            inlineProps.push({
              name: name,
              value: inline.getPropertyValue(name),
              important: inline.getPropertyPriority(name) === "important",
              implicit: false,
              text: name + ": " + inline.getPropertyValue(name) + (inline.getPropertyPriority(name) ? " !important" : ""),
              disabled: false,
              range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
            });
          }
        }

        // Matched CSS rules via CSSOM stylesheet enumeration
        var matchedRules = [];
        try {
          for (var si = 0; si < document.styleSheets.length; si++) {
            var sheet = document.styleSheets[si];
            var rules;
            try { rules = sheet.cssRules || sheet.rules; }
            catch (e) { continue; } // Cross-origin sheets throw SecurityError
            if (!rules) continue;
            var sheetHref = sheet.href || ("style-" + si);
            for (var ri = 0; ri < rules.length; ri++) {
              var rule = rules[ri];
              if (rule.type !== 1) continue; // CSSStyleRule only
              var selectorText = rule.selectorText || "";
              var matches = false;
              try { matches = current.matches(selectorText); }
              catch (e) { continue; }
              if (!matches) continue;
              var ruleStyle = rule.style;
              var ruleProps = [];
              for (var rp = 0; rp < ruleStyle.length; rp++) {
                var rpName = ruleStyle[rp];
                ruleProps.push({
                  name: rpName,
                  value: ruleStyle.getPropertyValue(rpName),
                  important: ruleStyle.getPropertyPriority(rpName) === "important",
                  implicit: false,
                  text: rpName + ": " + ruleStyle.getPropertyValue(rpName) + (ruleStyle.getPropertyPriority(rpName) ? " !important" : ""),
                  disabled: false,
                  range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
                });
              }
              matchedRules.push({
                matchingSelectors: [0],
                rule: {
                  selectorList: {
                    selectors: selectorText.split(",").map(function(s) { return { text: s.trim() }; }),
                    text: selectorText,
                  },
                  origin: sheet.href ? "regular" : "inspector",
                  styleSheetId: sheetHref + ":" + ri,
                  style: {
                    styleSheetId: sheetHref + ":" + ri,
                    cssProperties: ruleProps,
                    shorthandEntries: [],
                    cssText: rule.cssText || "",
                  },
                },
              });
            }
          }
        } catch (e) { /* CSSOM enumeration failed, return empty */ }

        return {
          inlineStyle: inlineProps,
          matchedCSSRules: matchedRules,
        };
      })()
    `) || { inlineStyle: [], matchedCSSRules: [] };

    return {
      inlineStyle: {
        styleSheetId: "inline",
        cssProperties: result.inlineStyle || [],
        shorthandEntries: [],
      },
      matchedCSSRules: result.matchedCSSRules || [],
    };
  }

  async getAnimatedStyles(nodeId) {
    const node = await this.getNode(nodeId);
    if (!node?.backendPath) {
      return {
        animationStyles: [],
        transitionsStyle: { cssProperties: [], shorthandEntries: [] },
        inherited: [],
      };
    }
    const result = await this.#executeAndReturn(`
      (() => {
        var path = ${JSON.stringify(node.backendPath)};
        var current = document;
        for (var i = 0; i < path.length; i++) {
          current = current.childNodes[path[i]];
        }
        if (!current || current.nodeType !== Node.ELEMENT_NODE) {
          return { animationStyles: [], transitionProperties: [] };
        }
        var animations = current.getAnimations ? current.getAnimations() : [];
        var computed = getComputedStyle(current);
        var animStyles = [];
        var transitionProperties = [];

        for (var j = 0; j < animations.length; j++) {
          var anim = animations[j];
          var effect = anim.effect;
          var propNames = [];
          if (effect && effect.getKeyframes) {
            var keyframes = effect.getKeyframes();
            for (var k = 0; k < keyframes.length; k++) {
              for (var p in keyframes[k]) {
                if (["offset", "computedOffset", "easing", "composite"].indexOf(p) === -1 && propNames.indexOf(p) === -1) {
                  propNames.push(p);
                }
              }
            }
          }
          var cssProps = propNames.map(function(name) {
            return { name: name, value: computed.getPropertyValue(name) };
          }).filter(function(p) { return p.value; });

          var ctorName = (anim.constructor && anim.constructor.name) || "";
          if (ctorName === "CSSTransition") {
            for (var t = 0; t < cssProps.length; t++) {
              transitionProperties.push(cssProps[t]);
            }
          } else {
            animStyles.push({
              name: anim.animationName || anim.id || "animation",
              style: cssProps,
            });
          }
        }
        return { animationStyles: animStyles, transitionProperties: transitionProperties };
      })()
    `) || { animationStyles: [], transitionProperties: [] };

    const toCssStyle = (props) => ({
      cssProperties: (props || []).map((p) => ({
        name: p.name,
        value: p.value,
        important: false,
        implicit: false,
        text: `${p.name}: ${p.value}`,
        disabled: false,
      })),
      shorthandEntries: [],
    });

    return {
      animationStyles: (result.animationStyles || []).map((a) => ({
        name: a.name,
        style: toCssStyle(a.style),
      })),
      transitionsStyle: toCssStyle(result.transitionProperties),
      inherited: [],
    };
  }

  async setStyleText(edit) {
    // edit: { styleSheetId, range, text }
    const text = edit.text || "";
    const styleSheetId = edit.styleSheetId || "";

    // Inline style edit: styleSheetId = "inline:nodeId"
    if (styleSheetId.startsWith("inline:")) {
      const nodeId = Number(styleSheetId.split(":")[1]);
      const node = await this.getNode(nodeId);
      if (node?.backendPath) {
        const result = await this.#executeAndReturn(`
          (() => {
            const path = ${JSON.stringify(node.backendPath)};
            let el = document;
            for (const i of path) el = el?.childNodes?.[i];
            if (!el?.style) return { cssProperties: [] };
            el.style.cssText = ${JSON.stringify(text)};
            const props = [];
            for (let i = 0; i < el.style.length; i++) {
              const name = el.style[i];
              props.push({
                name,
                value: el.style.getPropertyValue(name),
                important: el.style.getPropertyPriority(name) === "important",
              });
            }
            return { cssProperties: props };
          })()
        `);
        return {
          styleSheetId,
          cssProperties: (result?.cssProperties || []).map((p) => ({
            name: p.name, value: p.value,
            important: p.important || false, implicit: false,
            text: `${p.name}: ${p.value}${p.important ? " !important" : ""}`,
            disabled: false,
            range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
          })),
          shorthandEntries: [],
          cssText: text,
        };
      }
    }

    // Stylesheet rule edit
    const result = await this.#executeAndReturn(`
      (() => {
        var text = ${JSON.stringify(text)};
        var ssid = ${JSON.stringify(styleSheetId)};
        function parseProps(cssText) {
          var props = [];
          var parts = cssText.split(";");
          for (var i = 0; i < parts.length; i++) {
            var part = parts[i].trim();
            if (!part) continue;
            var colonIdx = part.indexOf(":");
            if (colonIdx < 0) continue;
            var name = part.substring(0, colonIdx).trim();
            var value = part.substring(colonIdx + 1).trim();
            var important = value.indexOf("!important") >= 0;
            if (important) value = value.replace("!important", "").trim();
            props.push({ name: name, value: value, important: important });
          }
          return props;
        }
        var parts = ssid.split(":");
        var ruleIndex = parseInt(parts.pop(), 10);
        var sheetRef = parts.join(":");
        for (var si = 0; si < document.styleSheets.length; si++) {
          var sheet = document.styleSheets[si];
          var href = sheet.href || ("style-" + si);
          if (href !== sheetRef) continue;
          try {
            var rules = sheet.cssRules || sheet.rules;
            if (rules && rules[ruleIndex]) {
              rules[ruleIndex].style.cssText = text;
              var ruleStyle = rules[ruleIndex].style;
              var props = [];
              for (var rp = 0; rp < ruleStyle.length; rp++) {
                var rpName = ruleStyle[rp];
                props.push({
                  name: rpName,
                  value: ruleStyle.getPropertyValue(rpName),
                  important: ruleStyle.getPropertyPriority(rpName) === "important",
                });
              }
              return { cssProperties: props, ok: true };
            }
          } catch (e) {}
        }
        return { cssProperties: parseProps(text), ok: false };
      })()
    `);

    return {
      styleSheetId,
      cssProperties: (result?.cssProperties || []).map((p) => ({
        name: p.name,
        value: p.value,
        important: p.important || false,
        implicit: false,
        text: `${p.name}: ${p.value}${p.important ? " !important" : ""}`,
        disabled: false,
        range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
      })),
      shorthandEntries: [],
      cssText: text,
    };
  }

  async captureScreenshot(format = "png") {
    // Try simulator screenshot via simctl first
    if (this.target?.type === "simulator" && this.target?.udid) {
      try {
        const tmpFile = `/tmp/safari-cdt-screenshot-${Date.now()}.${format}`;
        await execFileAsync("xcrun", ["simctl", "io", this.target.udid, "screenshot", "--type", format, tmpFile]);
        const data = await fs.readFile(tmpFile);
        await fs.unlink(tmpFile).catch(() => {});
        return data.toString("base64");
      } catch (e) {
        this.logger?.debug?.(`simctl screenshot failed: ${e.message}`);
      }
    }
    // Fallback: capture via page-side canvas rendering
    try {
      const dataUrl = await this.#executeAndReturn(`
        (() => {
          try {
            var canvas = document.createElement("canvas");
            var dpr = window.devicePixelRatio || 1;
            canvas.width = window.innerWidth * dpr;
            canvas.height = window.innerHeight * dpr;
            var ctx = canvas.getContext("2d");
            ctx.scale(dpr, dpr);
            // Draw a white background
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            // Attempt html2canvas-style rendering is not available here,
            // so return a data URL of the viewport dimensions
            return canvas.toDataURL("image/${format === "jpeg" ? "jpeg" : "png"}");
          } catch (e) { return null; }
        })()
      `);
      if (dataUrl && dataUrl.startsWith("data:")) {
        return dataUrl.split(",")[1] || "";
      }
    } catch {}
    return "";
  }

  async getLayoutMetrics() {
    const metrics = await this.#executeAndReturn(`
      (() => ({
        width: window.innerWidth || document.documentElement.clientWidth || 0,
        height: window.innerHeight || document.documentElement.clientHeight || 0,
        scrollWidth: document.documentElement.scrollWidth || 0,
        scrollHeight: document.documentElement.scrollHeight || 0,
      }))()
    `);
    return {
      layoutViewport: {
        pageX: 0,
        pageY: 0,
        clientWidth: metrics.width,
        clientHeight: metrics.height,
      },
      visualViewport: {
        offsetX: 0,
        offsetY: 0,
        pageX: 0,
        pageY: 0,
        clientWidth: metrics.width,
        clientHeight: metrics.height,
        scale: 1,
        zoom: 1,
      },
      contentSize: {
        x: 0,
        y: 0,
        width: metrics.scrollWidth || metrics.width,
        height: metrics.scrollHeight || metrics.height,
      },
      cssLayoutViewport: {
        pageX: 0,
        pageY: 0,
        clientWidth: metrics.width,
        clientHeight: metrics.height,
      },
      cssVisualViewport: {
        offsetX: 0,
        offsetY: 0,
        pageX: 0,
        pageY: 0,
        clientWidth: metrics.width,
        clientHeight: metrics.height,
        scale: 1,
        zoom: 1,
      },
      cssContentSize: {
        x: 0,
        y: 0,
        width: metrics.scrollWidth || metrics.width,
        height: metrics.scrollHeight || metrics.height,
      },
    };
  }

  // DOM observer stubs — native DOM events handle this now
  async startDomObserver() {}
  async stopDomObserver() {}

  async setBreakpointByUrl(params) {
    await this.refreshScripts();
    const resolved = this.#resolveBreakpointLocations(params);
    const breakpointId = `breakpoint:${this.nextBreakpointId++}`;

    for (const location of resolved) {
      this.breakpoints.set(
        `${breakpointId}:${location.url}:${location.lineNumber}:${location.columnNumber}`,
        {
          breakpointId,
          url: location.url,
          lineNumber: location.lineNumber,
          columnNumber: location.matchColumnNumber ?? location.columnNumber,
          condition: params.condition || "",
        },
      );
    }

    await this.syncDebuggerConfig();

    return {
      breakpointId,
      locations: resolved.map((loc) => ({
        scriptId: loc.scriptId,
        lineNumber: loc.lineNumber,
        columnNumber: loc.columnNumber,
      })),
    };
  }

  #resolveBreakpointLocations(params) {
    const requestedUrl = params.url || "";
    const requestedLine = Number(params.lineNumber || 0);
    const requestedColumn = Number(params.columnNumber || 0);
    const locations = [];

    for (const script of this.scriptCacheData.values()) {
      // Direct URL match on a generated script
      if (script.url === requestedUrl && script.kind !== "source") {
        locations.push({
          scriptId: script.scriptId,
          url: script.url,
          lineNumber: requestedLine,
          columnNumber: requestedColumn,
          matchColumnNumber: requestedColumn,
        });
        continue;
      }

      // Source map reverse lookup: source → generated
      if (!script.sourceMapURL) continue;
      const sourceMapRecord = this.sourceMapCache.get(script.sourceMapURL);
      if (!sourceMapRecord) continue;
      const sourceIndex = sourceMapRecord.resolvedSources.findIndex(
        (sourceUrl) => sourceUrl === requestedUrl,
      );
      if (sourceIndex === -1) continue;

      const generated = generatedPositionFor(sourceMapRecord.traceMap, {
        source: sourceMapRecord.parsed.sources[sourceIndex],
        line: requestedLine + 1,
        column: requestedColumn,
      });
      if (!generated?.line) continue;

      locations.push({
        scriptId: script.scriptId,
        url: script.url,
        lineNumber: Math.max(0, generated.line - 1),
        columnNumber: Math.max(0, generated.column || 0),
        matchColumnNumber: requestedColumn > 0 ? Math.max(0, generated.column || 0) : undefined,
      });
    }

    return locations;
  }


  async refreshScripts() {
    await this.ensureInstrumented();
    try {
      const scripts = await this.#executeAndReturn(`
        (() => {
          return Array.from(document.scripts || []).map(function(script, index) {
            var source = "";
            if (script.src) {
              // For external scripts, try to get source via XHR (same-origin only)
              try {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", script.src, false);
                xhr.send(null);
                if (xhr.status === 200) source = xhr.responseText || "";
              } catch (e) {}
            } else {
              source = script.textContent || "";
            }
            return {
              index: index,
              src: script.src || "",
              inline: !script.src,
              type: script.type || "",
              source: source,
            };
          });
        })()
      `) || [];

      const nextCache = new Map();
      const nextUrlIndex = new Map();
      for (const script of scripts) {
        const url = script.src || `${this.lastSnapshot?.url || "page"}:inline-${script.index}`;
        const key = `${this.lastSnapshot?.url || ""}:${url}`;
        let scriptId = this.scriptIdsByKey.get(key);
        if (!scriptId) {
          scriptId = String(this.nextScriptIdCounter++);
          this.scriptIdsByKey.set(key, scriptId);
        }

        const source = script.source || "";
        let sourceMapURL = "";
        try {
          sourceMapURL = await this.#discoverSourceMap(url, source);
        } catch (e) {
          this.logger?.debug?.(`source map discovery failed for ${url}: ${e.message}`);
        }

        if (url) nextUrlIndex.set(url, scriptId);
        nextCache.set(scriptId, {
          scriptId,
          kind: "generated",
          url,
          source,
          sourceMapURL,
          startLine: 0,
          endLine: source.split("\n").length,
          executionContextId: 1,
          isModule: script.type === "module",
          hash: this.#simpleHash(source),
        });

        // Create virtual source scripts from source map
        if (sourceMapURL) {
          const sourceMapRecord = this.sourceMapCache.get(sourceMapURL);
          if (sourceMapRecord?.resolvedSources?.length) {
            for (const sourceUrl of sourceMapRecord.resolvedSources) {
              const sourceKey = `source:${sourceUrl}`;
              let sourceScriptId = this.scriptIdsByKey.get(sourceKey);
              if (!sourceScriptId) {
                sourceScriptId = String(this.nextScriptIdCounter++);
                this.scriptIdsByKey.set(sourceKey, sourceScriptId);
              }
              const sourceResource = this.resourceCache.get(sourceUrl);
              const sourceContent = sourceResource?.content || "";
              if (sourceUrl) nextUrlIndex.set(sourceUrl, sourceScriptId);
              nextCache.set(sourceScriptId, {
                scriptId: sourceScriptId,
                kind: "source",
                url: sourceUrl,
                source: sourceContent,
                sourceMapURL: "",
                startLine: 0,
                endLine: sourceContent.split("\n").length,
                executionContextId: 1,
                isModule: false,
                hash: this.#simpleHash(sourceContent),
                sourceMappedFrom: scriptId,
              });
            }
          }
        }
      }
      this.scriptCacheData = nextCache;
      this.scriptUrlToId = nextUrlIndex;
      return nextCache;
    } catch {
      return this.scriptCacheData;
    }
  }

  async #processSourceMap(scriptId, scriptUrl, sourceMapURL) {
    // Resolve the source map URL relative to the script
    let mapUrl;
    try {
      mapUrl = new URL(sourceMapURL, scriptUrl).toString();
    } catch {
      return;
    }
    if (this.sourceMapCache.has(mapUrl)) {
      // Already processed — just create virtual scripts if not already done
      const record = this.sourceMapCache.get(mapUrl);
      this.#createVirtualScripts(scriptId, mapUrl, record);
      return;
    }
    // Fetch the source map content via page-side fetch
    const mapContent = await this.#executeAndReturn(`
      (() => {
        var url = ${JSON.stringify(mapUrl)};
        if (url.startsWith("data:")) {
          try { var parts = url.split(","); return parts[0].indexOf("base64") >= 0 ? atob(parts[1]) : decodeURIComponent(parts[1]); }
          catch { return null; }
        }
        try { var xhr = new XMLHttpRequest(); xhr.open("GET", url, false); xhr.send(null); return xhr.status === 200 ? xhr.responseText : null; }
        catch { return null; }
      })()
    `);
    if (!mapContent) return;
    try {
      const parsed = JSON.parse(mapContent);
      const resolvedSources = (parsed.sources || []).map(s => {
        try { return new URL(s, mapUrl).toString(); } catch { return s; }
      });
      const record = { parsed, traceMap: new TraceMap(parsed), resolvedSources };
      this.sourceMapCache.set(mapUrl, record);
      // Cache source contents
      for (let i = 0; i < (parsed.sources || []).length; i++) {
        if (typeof parsed.sourcesContent?.[i] === "string") {
          this.resourceCache.set(resolvedSources[i], {
            url: resolvedSources[i], content: parsed.sourcesContent[i],
            mimeType: "text/plain", base64Encoded: false,
          });
        }
      }
      this.#createVirtualScripts(scriptId, mapUrl, record);
    } catch (e) {
      this.logger?.debug?.(`source map parse failed for ${mapUrl}: ${e.message}`);
    }
  }

  #createVirtualScripts(parentScriptId, sourceMapURL, record) {
    for (const sourceUrl of record.resolvedSources) {
      // Skip if already created
      let exists = false;
      for (const [, s] of this.scriptCacheData) {
        if (s.url === sourceUrl && s.kind === "source") { exists = true; break; }
      }
      if (exists) continue;
      const virtualId = `src-${this.nextScriptIdCounter++}`;
      const content = this.resourceCache.get(sourceUrl)?.content || "";
      const lineCount = content.split("\n").length;
      this.scriptCacheData.set(virtualId, {
        url: sourceUrl,
        startLine: 0,
        endLine: lineCount,
        executionContextId: 1,
        hash: "",
        isModule: false,
        sourceMapURL: "",
        source: content,
        kind: "source",
        sourceMappedFrom: parentScriptId,
      });
      // Push as a scriptParsed event so DevTools shows the source file
      this.nativeScriptsParsed.push({
        scriptId: virtualId,
        url: sourceUrl,
        startLine: 0,
        startColumn: 0,
        endLine: lineCount,
        endColumn: 0,
        isContentScript: false,
        module: false,
        sourceMapURL: "",
      });
    }
  }

  async #discoverSourceMap(scriptUrl, source) {
    const match = /[#@]\s*sourceMappingURL\s*=\s*(\S+)\s*$/m.exec(source);
    if (!match) return "";

    let mapUrl;
    try {
      mapUrl = new URL(match[1], scriptUrl).toString();
    } catch {
      return "";
    }

    if (this.sourceMapCache.has(mapUrl)) return mapUrl;

    try {
      // Try to load via page-side fetch (handles same-origin and data: URLs)
      const mapContent = await this.#executeAndReturn(`
        (() => {
          var url = ${JSON.stringify(mapUrl)};
          // Handle data: URLs
          if (url.startsWith("data:")) {
            try {
              var parts = url.split(",");
              var isBase64 = parts[0].indexOf("base64") >= 0;
              return isBase64 ? atob(parts[1]) : decodeURIComponent(parts[1]);
            } catch (e) { return null; }
          }
          // Synchronous XHR for same-origin maps
          try {
            var xhr = new XMLHttpRequest();
            xhr.open("GET", url, false);
            xhr.send(null);
            return xhr.status === 200 ? xhr.responseText : null;
          } catch (e) { return null; }
        })()
      `);

      if (!mapContent) return "";

      const parsed = JSON.parse(mapContent);
      const resolvedSources = Array.isArray(parsed.sources)
        ? parsed.sources.map((sourcePath) => {
            try { return new URL(sourcePath, mapUrl).toString(); }
            catch { return sourcePath; }
          })
        : [];

      this.sourceMapCache.set(mapUrl, {
        parsed,
        traceMap: new TraceMap(parsed),
        resolvedSources,
      });

      // Cache source contents from the source map
      if (Array.isArray(parsed.sources)) {
        for (let i = 0; i < parsed.sources.length; i++) {
          const sourceUrl = resolvedSources[i];
          const sourceContent = parsed.sourcesContent?.[i];
          if (typeof sourceContent === "string") {
            this.resourceCache.set(sourceUrl, {
              url: sourceUrl,
              content: sourceContent,
              mimeType: "text/plain",
              base64Encoded: false,
            });
          }
        }
      }

      return mapUrl;
    } catch (error) {
      this.logger?.debug?.("source map load failed", mapUrl, error?.message);
      return "";
    }
  }

  mapToUiLocation(url, lineNumber, columnNumber) {
    for (const script of this.scriptCacheData.values()) {
      if (script.url !== url || !script.sourceMapURL || script.kind !== "generated") {
        continue;
      }
      const sourceMapRecord = this.sourceMapCache.get(script.sourceMapURL);
      if (!sourceMapRecord) continue;

      const original = originalPositionFor(sourceMapRecord.traceMap, {
        line: lineNumber + 1,
        column: columnNumber,
      });
      if (!original?.source || !original.line) continue;

      const sourceIndex = sourceMapRecord.parsed.sources.indexOf(original.source);
      const sourceUrl = sourceIndex >= 0
        ? sourceMapRecord.resolvedSources[sourceIndex]
        : (() => { try { return new URL(original.source, script.sourceMapURL).toString(); } catch { return original.source; } })();

      return {
        scriptId: this.findScriptIdForUrl(sourceUrl),
        url: sourceUrl,
        lineNumber: Math.max(0, original.line - 1),
        columnNumber: Math.max(0, original.column || 0),
      };
    }
    return {
      scriptId: this.findScriptIdForUrl(url),
      url,
      lineNumber,
      columnNumber,
    };
  }

  findScriptIdForUrl(url) {
    for (const script of this.scriptCacheData.values()) {
      if (script.url === url) return script.scriptId;
    }
    return "0";
  }

  #simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return String(Math.abs(hash));
  }

  async getResponseBody(requestId) {
    // Check cooperative cache first
    const cached = this.networkBodies.get(requestId);
    if (cached) return cached;
    // Try native Network.getResponseBody
    if (this.nativeNetworkEnabled && this.rawWir?.connected) {
      try {
        const result = await this.rawWir.sendCommand("Network.getResponseBody", { requestId });
        if (result?.body !== undefined) {
          const body = { body: result.body, base64Encoded: result.base64Encoded || false };
          this.networkBodies.set(requestId, body);
          // Evict oldest entries to prevent unbounded memory growth
          if (this.networkBodies.size > 500) {
            const keys = [...this.networkBodies.keys()];
            for (let i = 0; i < 100; i++) this.networkBodies.delete(keys[i]);
          }
          return body;
        }
      } catch (e) {
        this.logger?.debug?.(`getResponseBody native failed for ${requestId}: ${e.message}`);
      }
    }
    return { body: "", base64Encoded: false };
  }

  async tryReconnect() {
    if (this.reconnecting) return false;
    this.reconnecting = true;
    try {
      if (this.rawWir) {
        await this.rawWir.disconnect().catch(() => {});
        this.rawWir = null;
      }
      this.connected = false;
      await this.connect();
      this.reconnecting = false;
      return true;
    } catch (error) {
      this.reconnecting = false;
      this.logger?.debug?.("reconnect failed", error?.message);
      return false;
    }
  }

  get isConnected() {
    return this.connected && this.rawWir?.connected;
  }

  async #resolveTransport() {
    if (this.target.type === "simulator") {
      const simulators = await listSimulators();
      const simulator = simulators.find((entry) => entry.udid === this.target.udid);
      if (!simulator) {
        throw new Error(`Simulator ${this.target.udid} was not found.`);
      }
      const socketPath = await resolveSimulatorWebInspectorSocket(simulator.udid);
      if (!socketPath) {
        throw new Error(`No Web Inspector socket found for simulator ${simulator.udid}.`);
      }
      return {
        udid: simulator.udid,
        platformVersion: simulator.platformVersion,
        socketPath,
        realDevice: false,
      };
    }

    const devices = await listRealDevices();
    const device = devices.find((entry) => entry.udid === this.target.udid);
    if (!device) {
      throw new Error(`Real device ${this.target.udid} was not found.`);
    }
    return {
      udid: device.udid,
      platformVersion: device.platformVersion,
      socketPath: undefined,
      realDevice: true,
    };
  }

  async #executeAndReturn(expression) {
    await this.connect();
    const response = await this.rawWir.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    if (response?.result?.type === "undefined") {
      return undefined;
    }
    if (Object.prototype.hasOwnProperty.call(response?.result || {}, "value")) {
      return response.result.value;
    }
    return response?.result?.description || response;
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
