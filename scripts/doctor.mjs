#!/usr/bin/env node

// Unified environment diagnostics for the devtools-safari-bridge.
// Checks desktop Safari, iOS simulator, and real device prerequisites.

import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { assessDesktopCompatibility } from "../src/compatibility.js";
import { getSafariVersion, getChromeVersion } from "../src/preflight.js";

const execFileAsync = promisify(execFile);
const defaultDeveloperDir = "/Applications/Xcode.app/Contents/Developer";
const developerDir = process.env.DEVELOPER_DIR || defaultDeveloperDir;

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, { allowFailure = false, env = process.env } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { env });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    if (!allowFailure) throw error;
    return { ok: false, stdout: error.stdout?.trim?.() || "", stderr: error.stderr?.trim?.() || error.message };
  }
}

let exitCode = 0;

function check(ok, label, detail = "") {
  const prefix = ok ? "OK" : "FAIL";
  if (!ok) exitCode = 1;
  console.log(`${prefix}  ${label}${detail ? `: ${detail}` : ""}`);
}

async function checkDesktop() {
  console.log("\n── Desktop Safari ──\n");

  const safariVersion = await getSafariVersion();
  check(!!safariVersion, "Safari.app", safariVersion || "not found in /Applications");

  const chromeVersion = await getChromeVersion();
  check(!!chromeVersion, "Google Chrome", chromeVersion || "not found in /Applications");

  if (safariVersion) {
    const compat = assessDesktopCompatibility({ safariVersion, chromeVersion });
    check(compat.status !== "unverified", `Compatibility (${compat.status})`, compat.summary);
  }

  console.log("\nReminder: Safari > Settings > Advanced > Enable `Allow Remote Automation`");
}

async function checkIos() {
  console.log("\n── iOS ──\n");

  const env = { ...process.env, DEVELOPER_DIR: developerDir };

  const developerDirExists = await exists(developerDir);
  check(developerDirExists, "Xcode Developer dir", developerDir);
  if (!developerDirExists) return;

  const simctl = await run("/usr/bin/xcrun", ["simctl", "list", "devices", "available"], { allowFailure: true, env });
  check(simctl.ok, "simctl", simctl.ok ? "usable" : simctl.stderr);

  if (simctl.ok) {
    const booted = await run("/usr/bin/xcrun", ["simctl", "list", "devices", "booted"], { allowFailure: true, env });
    const bootedLine = booted.stdout.split("\n").find((line) => line.includes("(Booted)"));
    check(true, "Booted simulator", bootedLine || "none");
  }

  let connectedDevices = [];
  try {
    const { utilities } = await import("appium-ios-device");
    connectedDevices = await utilities.getConnectedDevices();
  } catch (error) {
    check(false, "Native iPhone discovery", error.message);
  }
  if (connectedDevices.length) {
    check(true, "Native iPhone discovery", connectedDevices.join(", "));
  } else {
    check(true, "Native iPhone discovery", "no paired iOS devices detected");
  }

  if (connectedDevices.length) {
    const { utilities } = await import("appium-ios-device");
    for (const udid of connectedDevices) {
      let osVersion = "", deviceName = udid;
      try { osVersion = await utilities.getOSVersion(udid); } catch {}
      try { deviceName = await utilities.getDeviceName(udid); } catch {}
      check(true, `Device: ${deviceName}`, `iOS ${osVersion || "unknown"}`);
      const major = parseInt(osVersion.split(".")[0], 10) || 0;
      if (major >= 18) {
        const lsofCheck = await run("lsof", ["-iTCP:62078", "-sTCP:LISTEN", "-P", "-n"], { allowFailure: true });
        const tunnelRunning = lsofCheck.ok && lsofCheck.stdout.includes("62078");
        check(tunnelRunning, "iOS 18+ tunnel", tunnelRunning ? "running on port 62078" : "not running — npm start will attempt to set it up");
      }
    }
  }
}

async function main() {
  console.log("devtools-safari-bridge doctor\n");
  console.log(`Platform: ${process.platform}`);
  console.log(`Node: ${process.version}`);

  await checkDesktop();
  await checkIos();

  console.log(exitCode === 0 ? "\nAll checks passed." : "\nSome checks failed.");
  process.exitCode = exitCode;
}

await main();
