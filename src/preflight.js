import fs from "fs/promises";
import net from "net";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const safariAppPath = "/Applications/Safari.app";
const chromeAppPath = "/Applications/Google Chrome.app";

async function canAccess(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function getSafariVersion() {
  if (!(await canAccess(safariAppPath))) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", [
      "read",
      `${safariAppPath}/Contents/Info`,
      "CFBundleShortVersionString",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getChromeVersion() {
  if (!(await canAccess(chromeAppPath))) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", [
      "read",
      `${chromeAppPath}/Contents/Info`,
      "CFBundleShortVersionString",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function assertPortAvailable(port, label) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new Error(
            `${label} port ${port} is already in use. Stop the conflicting process or change the port.`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(resolve);
    });
  });
}

export async function runDesktopPreflight({ bridgePort, fixturePort = null } = {}) {
  if (process.platform !== "darwin") {
    throw new Error("Desktop Safari bridging currently requires macOS.");
  }

  if (!(await canAccess(safariAppPath))) {
    throw new Error("Safari.app was not found in /Applications. Install Safari before running the desktop bridge.");
  }

  if (bridgePort) {
    await assertPortAvailable(bridgePort, "Bridge");
  }

  if (fixturePort) {
    await assertPortAvailable(fixturePort, "Fixture server");
  }

  return {
    safariVersion: await getSafariVersion(),
    chromeVersion: await getChromeVersion(),
  };
}

export function formatDesktopStartError(error) {
  const message = error?.message || String(error);

  if (message.includes("webinspectord socket not found")) {
    return [
      "Could not find Desktop Safari's Web Inspector socket.",
      "Fix:",
      "  1. Open Safari and load any page.",
      "  2. Enable the Develop menu: Safari → Settings → Advanced → Show features for web developers.",
      `Original error: ${message}`,
    ].join("\n");
  }

  if (message.includes("Safari not found in webinspectord")) {
    return [
      "Safari was not found in the Web Inspector daemon's application list.",
      "Fix: Open Safari with at least one tab and ensure the Develop menu is enabled.",
      `Original error: ${message}`,
    ].join("\n");
  }

  if (message.includes("No pages found")) {
    return [
      "Safari is running but has no inspectable pages.",
      "Fix: Open at least one tab in Safari.",
      `Original error: ${message}`,
    ].join("\n");
  }

  if (message.includes("Allow remote automation")) {
    return [
      "Safari rejected automation because remote automation is disabled.",
      "Fix: Safari > Settings > Developer > Enable `Allow Remote Automation`, then rerun `npm start`.",
      `Original error: ${message}`,
    ].join("\n");
  }

  if (message.includes("already paired with a different session")) {
    return [
      "Safari is already attached to another WebDriver session.",
      "Fix: stop any running `npm start` / `npm run verify` process and rerun.",
      `Original error: ${message}`,
    ].join("\n");
  }

  if (message.includes("Timed out")) {
    return [
      "Connection to Safari timed out.",
      "Fix: ensure Safari is open with at least one tab and the Develop menu is enabled.",
      `Original error: ${message}`,
    ].join("\n");
  }

  return message;
}
