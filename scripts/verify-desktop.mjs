import http from "http";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import WebSocket from "ws";
import { formatDesktopStartError, runDesktopPreflight } from "../src/preflight.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixturesDir = path.join(repoRoot, "fixtures");
const fixturePort = Number(process.env.FIXTURE_PORT || 8010);
const bridgePort = Number(process.env.DESKTOP_PORT || 9333);
const bridgeUrl = `ws://localhost:${bridgePort}/devtools/page/desktop-safari`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function startFixtureServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
      const normalized = requestPath === "/" ? "/index.html" : requestPath;
      const targetPath = path.join(fixturesDir, normalized);
      const content = await fs.readFile(targetPath);
      const ext = path.extname(targetPath);
      const contentType = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".map": "application/json; charset=utf-8",
      }[ext] || "text/plain; charset=utf-8";
      res.writeHead(200, { "content-type": contentType });
      res.end(content);
    } catch (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Not found: ${error.message}`);
    }
  });
  return new Promise((resolve) => {
    server.listen(fixturePort, "127.0.0.1", () => resolve(server));
  });
}

function startBridge() {
  const child = spawn("node", ["./src/desktop.js"], {
    cwd: repoRoot,
    env: { ...process.env, DESKTOP_PORT: String(bridgePort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

class CdpClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!pending) {
          return;
        }
        if (message.error) {
          pending.reject(new Error(message.error.message));
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      this.events.push(message);
    });
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }

  async close() {
    if (!this.ws) {
      return;
    }
    this.ws.close();
    await new Promise((resolve) => this.ws.once("close", resolve));
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  async waitForEvent(method, timeoutMs = 10000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const index = this.events.findIndex((event) => event.method === method);
      if (index >= 0) {
        return this.events.splice(index, 1)[0];
      }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${method}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function findNodeByAttribute(node, name, value) {
  if (!node) {
    return null;
  }
  const attributes = Array.isArray(node.attributes) ? node.attributes : [];
  for (let i = 0; i < attributes.length; i += 2) {
    if (attributes[i] === name && attributes[i + 1] === value) {
      return node;
    }
  }
  for (const child of node.children || []) {
    const match = findNodeByAttribute(child, name, value);
    if (match) {
      return match;
    }
  }
  return null;
}

async function waitForProtocolEvent(client, method, predicate = () => true, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const index = client.events.findIndex(
      (event) => event.method === method && predicate(event),
    );
    if (index >= 0) {
      return client.events.splice(index, 1)[0];
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${method}`);
}

async function verifyElements(client) {
  await client.send("Page.enable");
  await client.send("DOM.enable");
  await client.send("Page.navigate", { url: `http://127.0.0.1:${fixturePort}/debugger.html` });
  await sleep(1000);
  const documentResult = await client.send("DOM.getDocument");
  assert(documentResult.root?.nodeName === "#document", "DOM root was not returned");
}

async function verifySourceMappedBreakpoint(client) {
  await client.send("Runtime.enable");
  await client.send("Debugger.enable");
  await client.send("Page.navigate", { url: `http://127.0.0.1:${fixturePort}/mapped-async.html` });
  await sleep(1500);

  const parsedScripts = client.events
    .filter((event) => event.method === "Debugger.scriptParsed")
    .map((event) => event.params.url);
  assert(
    parsedScripts.includes(`http://127.0.0.1:${fixturePort}/mapped-async.ts`),
    "Original mapped source was not exposed as a virtual script",
  );

  await client.send("Debugger.setBreakpointByUrl", {
    url: `http://127.0.0.1:${fixturePort}/mapped-async.ts`,
    lineNumber: 2,
    columnNumber: 0,
  });
  await client.send("Runtime.evaluate", { expression: "window.runMappedFixture();" });
  const pause = await client.waitForEvent("Debugger.paused", 8000);
  const frame = pause.params.callFrames[0];
  assert(frame.url === `http://127.0.0.1:${fixturePort}/mapped-async.ts`, "Pause URL was not mapped");
  assert(frame.location.scriptId !== "0", "Pause scriptId was not resolved");
  await client.send("Debugger.resume");
}

async function verifyProfiler(client) {
  await client.send("Profiler.enable");
  await client.send("Page.navigate", { url: `http://127.0.0.1:${fixturePort}/debugger.html` });
  await sleep(1500);
  await client.send("Profiler.start");
  await client.send("Runtime.evaluate", { expression: "document.getElementById('run').click();" });
  await sleep(1000);
  const profile = await client.send("Profiler.stop");
  const frames = profile.profile.nodes.filter((node) => node.id !== 1).map((node) => node.callFrame.url);
  assert(
    frames.includes(`http://127.0.0.1:${fixturePort}/debugger.html`),
    "Profile output did not include source-linked fixture frames",
  );
}

async function verifyAnimationInspection(client) {
  await client.send("Animation.enable");
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  await client.send("Page.navigate", { url: `http://127.0.0.1:${fixturePort}/animation.html` });
  await sleep(1500);

  const cssAnimationStarted = await waitForProtocolEvent(
    client,
    "Animation.animationStarted",
    (event) => event.params?.animation?.type === "CSSAnimation",
    8000,
  );
  const webAnimationStarted = await waitForProtocolEvent(
    client,
    "Animation.animationStarted",
    (event) => event.params?.animation?.type === "WebAnimation",
    8000,
  );

  const cssAnimationId = cssAnimationStarted.params.animation.id;
  const webAnimationId = webAnimationStarted.params.animation.id;

  const playbackRate = await client.send("Animation.getPlaybackRate");
  assert(playbackRate.playbackRate === 1, "Initial animation playback rate was not 1");

  await client.send("Animation.setPlaybackRate", { playbackRate: 2 });
  const updatedPlaybackRate = await client.send("Animation.getPlaybackRate");
  assert(updatedPlaybackRate.playbackRate === 2, "Animation playback rate did not update");

  const beforePause = await client.send("Animation.getCurrentTime", { id: cssAnimationId });
  await client.send("Animation.setPaused", { animations: [cssAnimationId], paused: true });
  await sleep(700);
  const afterPause = await client.send("Animation.getCurrentTime", { id: cssAnimationId });
  assert(
    Math.abs(afterPause.currentTime - beforePause.currentTime) < 50,
    "Paused animation time continued advancing",
  );

  await client.send("Animation.seekAnimations", {
    animations: [cssAnimationId],
    currentTime: 400,
  });
  await sleep(150);
  const soughtTime = await client.send("Animation.getCurrentTime", { id: cssAnimationId });
  assert(
    Math.abs(soughtTime.currentTime - 400) < 120,
    "Animation seek did not update currentTime",
  );

  const resolvedAnimation = await client.send("Animation.resolveAnimation", {
    animationId: cssAnimationId,
  });
  assert(
    resolvedAnimation.remoteObject?.className === "Animation",
    "Animation did not resolve to a remote object",
  );

  await client.send("Animation.setTiming", {
    animationId: webAnimationId,
    duration: 2600,
    delay: 120,
  });
  const timingUpdate = await waitForProtocolEvent(
    client,
    "Animation.animationUpdated",
    (event) =>
      event.params?.animation?.id === webAnimationId &&
      event.params?.animation?.source?.duration === 2600,
    8000,
  );
  assert(
    timingUpdate.params.animation.source.delay === 120,
    "Animation timing delay did not update",
  );

  const documentResult = await client.send("DOM.getDocument");
  const boxNode = findNodeByAttribute(documentResult.root, "id", "box");
  assert(boxNode?.nodeId, "Animation fixture node was not found");

  const animatedStyles = await client.send("CSS.getAnimatedStylesForNode", {
    nodeId: boxNode.nodeId,
  });
  assert(
    animatedStyles.animationStyles?.length > 0,
    "Animated styles did not include CSS animation data",
  );

  await client.send("Runtime.evaluate", { expression: "window.runAnimationFixture();" });
  await sleep(300);
  const transitionStyles = await client.send("CSS.getAnimatedStylesForNode", {
    nodeId: boxNode.nodeId,
  });
  const transitionProperties = (transitionStyles.transitionsStyle?.cssProperties || []).map(
    (property) => property.name,
  );
  assert(
    transitionProperties.includes("opacity") ||
      transitionProperties.includes("transform") ||
      transitionProperties.includes("background-color"),
    "Animated styles did not include transition properties",
  );

  await client.send("Animation.releaseAnimations", { animations: [webAnimationId] });
}

async function main() {
  let fixtureServer;
  let bridge;
  const client = new CdpClient(bridgeUrl);
  try {
    await runDesktopPreflight({ bridgePort, fixturePort });
    fixtureServer = await startFixtureServer();
    bridge = startBridge();
    await waitForHttp(`http://localhost:${bridgePort}/json/version`);
    await client.connect();
    await verifyElements(client);
    await verifySourceMappedBreakpoint(client);
    await verifyProfiler(client);
    await verifyAnimationInspection(client);
    console.log("Desktop bridge verification passed.");
  } catch (error) {
    console.error(formatDesktopStartError(error));
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => fixtureServer?.close(() => resolve()) || resolve());
    if (bridge && !bridge.killed) {
      bridge.kill("SIGTERM");
      await new Promise((resolve) => bridge.once("exit", resolve));
    }
  }
}

await main();
