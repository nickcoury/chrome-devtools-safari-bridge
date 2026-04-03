/**
 * Chrome reference target.
 * Launches Chrome with Puppeteer, serves the fixture page, exposes CDP.
 */

import puppeteer from 'puppeteer';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { PuppeteerCDPAdapter } from './cdp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../pages');

// Events we want to capture from Chrome
const CDP_EVENTS = [
  'Runtime.consoleAPICalled',
  'Runtime.executionContextCreated',
  'Runtime.executionContextDestroyed',
  'Debugger.scriptParsed',
  'Debugger.paused',
  'Debugger.resumed',
  'Debugger.breakpointResolved',
  'Network.requestWillBeSent',
  'Network.responseReceived',
  'Network.dataReceived',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'DOM.setChildNodes',
  'DOM.childNodeInserted',
  'DOM.childNodeRemoved',
  'DOM.attributeModified',
  'DOM.attributeRemoved',
  'CSS.styleSheetAdded',
  'CSS.styleSheetChanged',
  'Animation.animationCreated',
  'Animation.animationStarted',
  'Animation.animationCanceled',
  'HeapProfiler.addHeapSnapshotChunk',
  'Tracing.dataCollected',
  'Tracing.tracingComplete',
  'Profiler.consoleProfileStarted',
  'Profiler.consoleProfileFinished',
  'Log.entryAdded',
];

export class ChromeReference {
  constructor() {
    this.browser = null;
    this.page = null;
    this.cdp = null;
    this.server = null;
    this.port = null;
  }

  async start() {
    // Start fixture server
    const app = express();
    app.use('/__pages', express.static(FIXTURES_DIR));
    this.server = await new Promise((resolve) => {
      const srv = app.listen(0, () => resolve(srv));
    });
    this.port = this.server.address().port;

    // Launch Chrome
    this.browser = await puppeteer.launch({
      headless: true,
      channel: 'chrome',
      args: ['--no-first-run', '--no-default-browser-check'],
    });

    this.page = await this.browser.newPage();
    const session = await this.page.createCDPSession();

    // Wrap in our adapter
    this.cdp = new PuppeteerCDPAdapter(session);
    this.cdp.subscribeEvents(CDP_EVENTS);

    // Navigate to fixture
    await this.page.goto(`http://localhost:${this.port}/__pages/animation.html`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    });

    return this.cdp;
  }

  get fixtureUrl() {
    return `http://localhost:${this.port}/__pages/animation.html`;
  }

  async close() {
    this.cdp?.close();
    // browser.close() can hang — use timeout + force kill
    if (this.browser) {
      try {
        await Promise.race([
          this.browser.close(),
          new Promise(r => setTimeout(r, 5000)),
        ]);
      } catch {}
      // Force kill the browser process if close didn't work
      try { this.browser.process()?.kill('SIGKILL'); } catch {}
    }
    this.server?.close();
  }
}
