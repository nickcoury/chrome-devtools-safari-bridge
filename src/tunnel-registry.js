// Local tunnel registry server that bridges Apple's existing CoreDevice tunnel
// to the appium-ios-remotexpc tunnel registry API format.
//
// Apple's remoted/remotepairingd already creates a utun tunnel for iOS 18+ devices.
// This server discovers the tunnel address via `xcrun devicectl` and serves it
// in the format that appium-ios-remotexpc expects, eliminating the need for
// pymobiledevice3's tunnel.

import { execFile } from "child_process";
import { promisify } from "util";
import http from "http";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { BaseItem, strongbox } from "@appium/strongbox";

const execFileAsync = promisify(execFile);
const TUNNEL_CONTAINER_NAME = "appium-xcuitest-driver";

export class TunnelRegistryServer {
  constructor({ logger } = {}) {
    this.logger = logger || console;
    this.server = null;
    this.port = 0;
    this.tunnels = {};
  }

  async discoverAppleTunnels() {
    try {
      const tmpFile = path.join(os.tmpdir(), `safari-cdt-devicectl-${Date.now()}.json`);
      await execFileAsync("xcrun", [
        "devicectl", "list", "devices", "-j", tmpFile,
      ], { timeout: 10_000 });
      const jsonContent = await fs.readFile(tmpFile, "utf8");
      await fs.unlink(tmpFile).catch(() => {});
      const data = JSON.parse(jsonContent);
      const devices = data?.result?.devices || [];
      const tunnels = {};

      for (const device of devices) {
        const cp = device.connectionProperties || {};
        const hp = device.hardwareProperties || {};
        const dp = device.deviceProperties || {};
        const tunnelIP = cp.tunnelIPAddress;

        if (!tunnelIP) continue;

        const udid = hp.udid || "";
        if (!udid) continue;

        // Find the RSD port by scanning the tunnel.
        // Port 62078 is lockdown (not RSD). The RSD service is typically on 49152.
        let rsdPort = 49152;
        try {
          const scanResult = await execFileAsync("bash", ["-c",
            `for p in 49152 49153 49154 58783; do nc -zv -6 -w 1 ${tunnelIP} $p 2>&1 | grep succeeded && echo "PORT:$p" && break; done`,
          ], { timeout: 10_000 });
          const portMatch = scanResult.stdout.match(/PORT:(\d+)/);
          if (portMatch) rsdPort = parseInt(portMatch[1], 10);
        } catch {}

        tunnels[udid] = {
          udid,
          deviceId: 0,
          address: tunnelIP,
          rsdPort,
          packetStreamPort: rsdPort,
          connectionType: cp.transportType === "wired" ? "USB" : "Network",
          productId: 0,
          createdAt: Date.now(),
        };

        this.logger.info?.(
          `[tunnel-registry] Found Apple tunnel for ${dp.name || udid}: ${tunnelIP}:${rsdPort}`,
        );
      }

      this.tunnels = tunnels;
      return tunnels;
    } catch (error) {
      this.logger.warn?.(`[tunnel-registry] Discovery failed: ${error?.message}`);
      return this.tunnels;
    }
  }

  async start() {
    await this.discoverAppleTunnels();

    if (Object.keys(this.tunnels).length === 0) {
      this.logger.warn?.("[tunnel-registry] No Apple tunnels found — no iOS 18+ devices connected?");
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "application/json");

        // Strip /remotexpc prefix — appium queries /remotexpc/tunnels/:udid
        let url = req.url || "/";
        if (url.startsWith("/remotexpc")) {
          url = url.slice("/remotexpc".length) || "/";
        }

        // GET /tunnels — full registry
        if (url === "/" || url === "/tunnels") {
          res.end(JSON.stringify({
            tunnels: this.tunnels,
            metadata: {
              lastUpdated: new Date().toISOString(),
              totalTunnels: Object.keys(this.tunnels).length,
              activeTunnels: Object.keys(this.tunnels).length,
            },
          }));
          return;
        }

        // GET /tunnels/:udid
        const udidMatch = url.match(/^\/tunnels\/([^/]+)$/);
        if (udidMatch) {
          const udid = decodeURIComponent(udidMatch[1]);
          // Try exact match first, then partial match
          const entry = this.tunnels[udid] ||
            Object.values(this.tunnels).find((t) => udid.includes(t.udid) || t.udid.includes(udid));
          if (entry) {
            res.end(JSON.stringify(entry));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Not found" }));
          }
          return;
        }

        // GET /:udid (some clients query without /tunnels prefix)
        const directMatch = url.match(/^\/([0-9a-fA-F-]{10,})$/);
        if (directMatch) {
          const udid = decodeURIComponent(directMatch[1]);
          const entry = this.tunnels[udid] ||
            Object.values(this.tunnels).find((t) => udid.includes(t.udid) || t.udid.includes(udid));
          if (entry) {
            res.end(JSON.stringify(entry));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Not found" }));
          }
          return;
        }

        // GET /device/:id
        const deviceIdMatch = url.match(/^\/device\/(\d+)$/);
        if (deviceIdMatch) {
          const deviceId = parseInt(deviceIdMatch[1], 10);
          const entry = Object.values(this.tunnels).find((t) => t.deviceId === deviceId);
          if (entry) {
            res.end(JSON.stringify(entry));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "Not found" }));
          }
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
      });

      this.server.listen(0, "127.0.0.1", async () => {
        this.port = this.server.address().port;
        this.logger.info?.(`[tunnel-registry] Registry server on http://127.0.0.1:${this.port}`);

        // Write port to strongbox so appium-ios-remotexpc can find it
        try {
          const box = strongbox(TUNNEL_CONTAINER_NAME);
          const item = new BaseItem("tunnelRegistryPort", box);
          await item.write(String(this.port));
          this.logger.info?.(`[tunnel-registry] Registered port ${this.port} in strongbox`);
        } catch (error) {
          this.logger.warn?.(`[tunnel-registry] Failed to write strongbox: ${error?.message}`);
        }

        resolve(this.port);
      });

      this.server.on("error", reject);
    });
  }

  async stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    // Clean up strongbox
    try {
      const box = strongbox(TUNNEL_CONTAINER_NAME);
      const item = new BaseItem("tunnelRegistryPort", box);
      await item.write("");
    } catch {}
  }

  async refresh() {
    await this.discoverAppleTunnels();
  }
}
