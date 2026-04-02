#!/usr/bin/env node
/**
 * Quick diagnostic to check Desktop Safari WIR socket availability.
 * Run: node scripts/diagnose-wir.mjs
 */

import fs from "fs/promises";
import path from "path";
import net from "node:net";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

async function main() {
  console.log("=== Desktop Safari WIR Socket Diagnostic ===\n");

  // Check if Safari is running
  try {
    const { stdout } = await execFileAsync("pgrep", ["-x", "Safari"]);
    console.log("✓ Safari is running (PID:", stdout.trim() + ")");
  } catch {
    console.log("✗ Safari does not appear to be running. Open Safari first.");
  }

  // Check if webinspectord is running
  try {
    const { stdout } = await execFileAsync("pgrep", ["-x", "webinspectord"]);
    console.log("✓ webinspectord is running (PID:", stdout.trim() + ")");
  } catch {
    console.log("✗ webinspectord is not running. It should start with Safari.");
  }

  // Check for Develop menu
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", [
      "read", "com.apple.Safari", "IncludeDevelopMenu",
    ]);
    const enabled = stdout.trim() === "1";
    console.log(enabled
      ? "✓ Safari Develop menu is enabled"
      : "⚠ Safari Develop menu appears disabled. Enable it in Safari → Settings → Advanced.");
  } catch {
    console.log("⚠ Could not check Develop menu setting (may be fine on newer Safari).");
  }

  // Check WebKit developer extras
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", [
      "read", "com.apple.Safari", "WebKitDeveloperExtrasEnabledPreferenceKey",
    ]);
    console.log("  WebKitDeveloperExtras:", stdout.trim());
  } catch {
    console.log("  WebKitDeveloperExtras: not set (may be fine)");
  }

  // Scan /private/tmp for webinspectord sockets
  console.log("\n--- Scanning /private/tmp for webinspectord sockets ---");
  let socketFound = false;
  try {
    const tmpEntries = await fs.readdir("/private/tmp");
    for (const dir of tmpEntries) {
      if (!dir.startsWith("com.apple.launchd.")) continue;
      const fullDir = path.join("/private/tmp", dir);
      let files;
      try { files = await fs.readdir(fullDir); } catch { continue; }
      for (const file of files) {
        if (file.includes("webinspect") || file.includes("safari") || file.includes("webkit")) {
          const socketPath = path.join(fullDir, file);
          const isSim = file.includes("_sim");
          console.log(`  ${isSim ? "(sim)" : "(desktop)"} ${socketPath}`);
          socketFound = true;
        }
      }
    }
  } catch (e) {
    console.log("  Error scanning /private/tmp:", e.message);
  }
  if (!socketFound) {
    console.log("  No webinspectord sockets found in /private/tmp");
  }

  // Try lsof
  console.log("\n--- lsof for webinspectord ---");
  try {
    const { stdout } = await execFileAsync("lsof", ["-aU", "-c", "webinspectord"], { timeout: 5000 });
    const lines = stdout.split("\n").filter(l => l.trim());
    if (lines.length > 0) {
      for (const line of lines.slice(0, 15)) {
        console.log("  " + line);
      }
    } else {
      console.log("  (no output)");
    }
  } catch (e) {
    console.log("  lsof failed:", e.message);
  }

  // Try lsof for Safari
  console.log("\n--- lsof for Safari Unix sockets ---");
  try {
    const { stdout } = await execFileAsync("lsof", ["-aU", "-c", "Safari"], { timeout: 5000 });
    const lines = stdout.split("\n").filter(l => l.trim());
    if (lines.length > 0) {
      for (const line of lines.slice(0, 15)) {
        console.log("  " + line);
      }
    } else {
      console.log("  (no output)");
    }
  } catch (e) {
    console.log("  lsof Safari failed:", e.message);
  }

  // Also check for any web inspector related sockets more broadly
  console.log("\n--- All sockets in /private/tmp (sample) ---");
  try {
    const tmpEntries = await fs.readdir("/private/tmp");
    for (const dir of tmpEntries) {
      if (!dir.startsWith("com.apple.launchd.")) continue;
      const fullDir = path.join("/private/tmp", dir);
      let files;
      try { files = await fs.readdir(fullDir); } catch { continue; }
      for (const file of files) {
        console.log(`  ${path.join(fullDir, file)}`);
      }
    }
  } catch (e) {
    console.log("  Error:", e.message);
  }

  // Check if we can connect to any found socket
  if (socketFound) {
    console.log("\n--- Trying to connect to found socket(s) ---");
    try {
      const tmpEntries = await fs.readdir("/private/tmp");
      for (const dir of tmpEntries) {
        if (!dir.startsWith("com.apple.launchd.")) continue;
        const fullDir = path.join("/private/tmp", dir);
        let files;
        try { files = await fs.readdir(fullDir); } catch { continue; }
        for (const file of files) {
          if (!file.includes("webinspect")) continue;
          const socketPath = path.join(fullDir, file);
          try {
            await new Promise((resolve, reject) => {
              const sock = net.connect(socketPath);
              sock.once("connect", () => {
                console.log(`  ✓ Connected to ${socketPath}`);
                sock.destroy();
                resolve();
              });
              sock.once("error", (e) => {
                console.log(`  ✗ Failed to connect to ${socketPath}: ${e.message}`);
                reject(e);
              });
              setTimeout(() => {
                sock.destroy();
                reject(new Error("timeout"));
              }, 3000);
            });
          } catch {}
        }
      }
    } catch {}
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
