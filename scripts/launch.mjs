#!/usr/bin/env node

// Single-command launcher for devtools-safari-bridge.
//
// Usage:  npm start
//
// What it does:
//   1. Runs environment checks (npm deps, simulator, device detection)
//   2. Starts both bridges (desktop on 9333, iOS on 9221)
//   3. Opens the target picker in the browser

import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import os from "os";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verbose = process.argv.includes("--verbose") || !!process.env.DEBUG;
const logFile = path.join(repoRoot, "launch.log");

function ts() { return new Date().toISOString(); }
function emit(prefix, msg) {
  const line = `${ts()} ${prefix} ${msg}`;
  console.log(`[launch] ${prefix} ${msg}`);
  fs.appendFile(logFile, line + "\n").catch(() => {});
}
function log(msg) { emit("   ", msg); }
function warn(msg) { emit(" ⚠ ", msg); }
function ok(msg) { emit(" ✓ ", msg); }
function fail(msg) { emit(" ✗ ", msg); }

async function run(cmd, cmdArgs, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, cmdArgs, {
      timeout: opts.timeout || 30_000,
      maxBuffer: 8 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
  } catch (error) {
    return { ok: false, stdout: (error.stdout || "").trim(), stderr: (error.stderr || error.message || "").trim() };
  }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// ── Step 1: Check npm dependencies ──

async function checkNodeDeps() {
  const nodeModules = path.join(repoRoot, "node_modules");
  if (!(await exists(nodeModules))) {
    log("Installing npm dependencies...");
    const result = await run("npm", ["install"], { cwd: repoRoot, timeout: 120_000 });
    if (!result.ok) {
      fail(`npm install failed: ${result.stderr}`);
      process.exit(1);
    }
    ok("npm dependencies installed");
  }
}

// ── Step 2: Detect environment ──

async function hasBootedSimulator() {
  const result = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  if (!result.ok) return false;
  try {
    const parsed = JSON.parse(result.stdout);
    for (const runtime of Object.values(parsed.devices || {})) {
      if (runtime.some((d) => d.state === "Booted")) return true;
    }
  } catch {}
  return false;
}

async function getConnectedDevices() {
  const devices = [];
  try {
    const { utilities } = await import("appium-ios-device");
    const udids = await utilities.getConnectedDevices();
    for (const udid of udids) {
      let name = udid, osVersion = "";
      try { name = await utilities.getDeviceName(udid); } catch {}
      try { osVersion = await utilities.getOSVersion(udid); } catch {}
      devices.push({ udid, name, osVersion });
    }
  } catch {}
  return devices;
}

// ── Step 3: Start bridges ──

function startBridge(label, script, env = {}) {
  const fullEnv = { ...process.env, ...env };
  if (verbose) fullEnv.DEBUG = "1";

  log(`Starting ${label}...`);
  const child = spawn("node", [script], {
    cwd: repoRoot,
    env: fullEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.log(line);
    }
  });
  child.stderr?.on("data", (data) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.log(line);
    }
  });

  child.on("exit", (code) => {
    log(`${label} exited (code ${code})`);
  });

  return child;
}

async function waitForReady(port, maxWait = 30_000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const result = await run("curl", ["-sf", `http://localhost:${port}/json/version`], { timeout: 3000 });
      if (result.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function openBrowser(url) {
  await run("open", [url]);
}

// ── Main ──

async function killPort(port) {
  const result = await run("lsof", ["-iTCP:" + port, "-P", "-t"]);
  if (result.ok && result.stdout) {
    const pids = [...new Set(result.stdout.split("\n").filter(Boolean))];
    for (const pid of pids) {
      await run("kill", ["-9", pid]);
    }
    if (pids.length) {
      log(`Killed ${pids.length} stale process(es) on port ${port}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function detectPublicHost() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) {
        return entry.address;
      }
    }
  }
  return "localhost";
}

async function main() {
  await fs.writeFile(logFile, `=== devtools-safari-bridge launch ${ts()} ===\n`).catch(() => {});
  log(`Session log: ${logFile}`);

  const enableIos = process.argv.includes("--ios") || !!process.env.ENABLE_IOS;

  await checkNodeDeps();

  // Kill stale processes
  const portsToKill = [killPort(9333)];
  if (enableIos) portsToKill.push(killPort(9221));
  await Promise.all(portsToKill);

  const children = [];

  // Desktop Safari bridge (always)
  const desktopChild = startBridge(
    "Desktop Safari bridge (port 9333)",
    path.join(repoRoot, "src", "desktop.js"),
  );
  children.push(desktopChild);

  // iOS bridge (only with --ios or ENABLE_IOS=1)
  if (enableIos) {
    const [sim, devices] = await Promise.all([hasBootedSimulator(), getConnectedDevices()]);
    if (devices.length) ok(`Found device: ${devices.map((d) => `${d.name} (iOS ${d.osVersion})`).join(", ")}`);
    if (sim) ok("Found booted iOS simulator");

    const publicHost = detectPublicHost();
    const iosChild = startBridge(
      "iOS bridge (port 9221)",
      path.join(repoRoot, "src", "simulator.js"),
      {
        DEVICE_PUBLIC_HOST: publicHost,
        SIMULATOR_START_URL: process.env.SIMULATOR_START_URL || "http://localhost:9221/__pages/demo.html",
        REAL_DEVICE_START_URL: process.env.REAL_DEVICE_START_URL || `http://${publicHost}:9221/__pages/demo.html`,
      },
    );
    children.push(iosChild);
  }

  // Clean shutdown
  const shutdown = () => {
    log("Shutting down...");
    for (const child of children) {
      try { child.kill("SIGINT"); } catch {}
    }
    setTimeout(() => {
      for (const child of children) {
        try { child.kill("SIGKILL"); } catch {}
      }
      process.exit(0);
    }, 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Wait for bridges
  log("Waiting for bridges...");
  const waitPromises = [waitForReady(9333, 30_000)];
  if (enableIos) waitPromises.push(waitForReady(9221, 30_000));
  const results = await Promise.all(waitPromises);

  const desktopReady = results[0];
  const iosReady = enableIos ? results[1] : false;

  if (desktopReady) {
    ok("Desktop bridge ready at http://localhost:9333/");
    log("Ensure Safari extension 'DevTools Safari Bridge' is enabled:");
    log("  Safari > Settings > Extensions > DevTools Safari Bridge");
  } else warn("Desktop bridge did not start within 30s");

  if (enableIos) {
    if (iosReady) ok("iOS bridge ready at http://localhost:9221/");
    else warn("iOS bridge did not start within 30s");
  }

  // Open chrome://inspect for the user to connect
  if (desktopReady) {
    log("Opening chrome://inspect — add localhost:9333 to discover targets");
    await openBrowser("chrome://inspect/#devices");
  }

  // Keep running — both bridges run as children
  await new Promise(() => {});
}

await main();
