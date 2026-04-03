/**
 * Bridge platform discovery and connection.
 * Probes available platforms (iPhone, Simulator, Desktop) and connects CDPClient per target.
 */

import { CDPClient } from './cdp-client.mjs';

const IOS_PORT = 9221;
const DESKTOP_PORT = 9333;

export class BridgeClients {
  constructor() {
    this.platforms = [];
    this.clients = new Map();
  }

  /**
   * Discover available platforms by probing bridge endpoints.
   * Returns array of { name, port, target } objects.
   */
  async discover() {
    this.platforms = [];

    // Probe iOS bridge (port 9221)
    try {
      const resp = await fetch(`http://localhost:${IOS_PORT}/json/list`);
      const targets = await resp.json();

      // Group by platform type, prefer animation fixture page
      const byType = new Map();
      for (const target of targets) {
        const type = target.deviceType || (target.id?.startsWith('device:') ? 'device' : 'simulator');
        const name = type === 'device' ? 'iPhone' : 'Simulator';
        if (!byType.has(name)) byType.set(name, []);
        byType.get(name).push(target);
      }

      for (const [name, platformTargets] of byType) {
        // Prefer the animation fixture page
        const preferred = platformTargets.find(t =>
          t.url?.includes('animation') || t.title?.includes('Animation')
        ) || platformTargets[0];
        this.platforms.push({ name, port: IOS_PORT, target: preferred });
      }
    } catch {
      // iOS bridge not running
    }

    // Probe Desktop bridge (port 9333)
    try {
      const resp = await fetch(`http://localhost:${DESKTOP_PORT}/json/list`);
      const targets = await resp.json();
      if (targets.length > 0) {
        this.platforms.push({ name: 'Desktop', port: DESKTOP_PORT, target: targets[0] });
      }
    } catch {
      // Desktop bridge not running
    }

    return this.platforms;
  }

  /**
   * Connect to a specific platform and return its CDPClient.
   */
  async connect(platform) {
    const cdp = new CDPClient(platform.target.webSocketDebuggerUrl);
    await cdp.connect();
    this.clients.set(platform.name, cdp);
    return cdp;
  }

  /**
   * Navigate bridge target to fixture URL (needed for mobile targets).
   */
  async navigateToFixture(cdp, fixtureUrl) {
    try {
      await cdp.send('Page.navigate', { url: fixtureUrl });
      // Wait for page to load
      await new Promise(r => setTimeout(r, 3000));
    } catch {
      // Navigation might not be needed if already on fixture
    }
  }

  async closeAll() {
    for (const cdp of this.clients.values()) {
      cdp.close();
    }
    this.clients.clear();
  }
}
