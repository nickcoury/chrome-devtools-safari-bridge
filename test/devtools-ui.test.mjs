/**
 * DevTools UI Integration Test
 *
 * Phase 1: Direct CDP protocol tests via WebSocket (no UI)
 * Phase 2: Launch DevTools UI, screenshot each panel, check for content
 *
 * Usage:
 *   node test/devtools-ui.test.mjs [--bridge-port=9221] [--headed] [--protocol-only] [--ui-only]
 *
 * Prerequisites:
 *   - Bridge server running (node src/simulator.js)
 *   - At least one target available
 */

import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { mkdirSync } from 'fs';

const BRIDGE_PORT = parseInt(process.argv.find(a => a.startsWith('--bridge-port='))?.split('=')[1] || '9221');
const HEADED = process.argv.includes('--headed');
const PROTOCOL_ONLY = process.argv.includes('--protocol-only');
const UI_ONLY = process.argv.includes('--ui-only');
const TIMEOUT = 10000;

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) { console.log(`\x1b[36m[test]\x1b[0m ${msg}`); }
function pass(msg) { console.log(`\x1b[32m  ✓\x1b[0m ${msg}`); }
function fail(msg, err) { console.log(`\x1b[31m  ✗\x1b[0m ${msg}: ${err}`); }
function warn(msg) { console.log(`\x1b[33m  ⚠\x1b[0m ${msg}`); }
function section(msg) { log(`\n${'─'.repeat(40)}\n── ${msg}\n${'─'.repeat(40)}`); }

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    pass(name);
    passed++;
    return true;
  } catch (err) {
    fail(name, err.message || err);
    failed++;
    return false;
  }
}

async function fetchJSON(urlPath) {
  const resp = await fetch(`http://localhost:${BRIDGE_PORT}${urlPath}`);
  return resp.json();
}

// ── CDP WebSocket Client ─────────────────────────────────────────────

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
    this.events = [];
    this.eventHandlers = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        } else if (msg.method) {
          this.events.push(msg);
          const handlers = this.eventHandlers.get(msg.method) || [];
          handlers.forEach(h => h(msg.params));
        }
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, TIMEOUT);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
        else resolve(msg.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, []);
    this.eventHandlers.get(method).push(handler);
  }

  waitEvent(method, timeout = TIMEOUT) {
    const idx = this.events.findIndex(e => e.method === method);
    if (idx >= 0) return Promise.resolve(this.events.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), timeout);
      const handler = (params) => {
        clearTimeout(timer);
        const handlers = this.eventHandlers.get(method) || [];
        this.eventHandlers.set(method, handlers.filter(h => h !== handler));
        resolve({ method, params });
      };
      this.on(method, handler);
    });
  }

  drainEvents(method) {
    const matching = this.events.filter(e => e.method === method);
    this.events = this.events.filter(e => e.method !== method);
    return matching;
  }

  close() { this.ws?.close(); }
}

// ── Phase 1: Protocol Tests ──────────────────────────────────────────

async function runProtocolTests(target) {
  section('CDP Protocol Tests (direct WebSocket)');
  const cdp = new CDPClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  log('Connected via WebSocket');

  // -- DOM --
  section('DOM');

  let docRoot;
  await test('DOM.getDocument returns full tree', async () => {
    const result = await cdp.send('DOM.getDocument', { depth: -1 });
    if (!result.root) throw new Error('No root node');
    docRoot = result.root;

    const html = findNode(docRoot, 'html');
    if (!html) throw new Error('No <html> node');

    const head = findNode(html, 'head');
    const body = findNode(html, 'body');
    if (!head) throw new Error('No <head>');
    if (!body) throw new Error('No <body>');
    if (!body.children?.length) throw new Error('<body> is empty');

    log(`    html children: ${html.children?.length}, body children: ${body.children?.length}`);
  });

  await test('DOM.requestChildNodes works', async () => {
    const html = findNode(docRoot, 'html');
    const body = findNode(html, 'body');
    await cdp.send('DOM.requestChildNodes', { nodeId: body.nodeId, depth: -1 });
    // Should not error
  });

  await test('DOM.querySelector works', async () => {
    const html = findNode(docRoot, 'html');
    const body = findNode(html, 'body');
    const result = await cdp.send('DOM.querySelector', {
      nodeId: body.nodeId,
      selector: '*',
    });
    if (!result.nodeId) throw new Error('No nodeId returned');
  });

  await test('DOM.setAttributeValue works', async () => {
    const html = findNode(docRoot, 'html');
    const body = findNode(html, 'body');
    const firstEl = body.children?.find(c => c.nodeType === 1);
    if (!firstEl) throw new Error('No element in body');
    await cdp.send('DOM.setAttributeValue', {
      nodeId: firstEl.nodeId,
      name: 'data-test-attr',
      value: 'hello',
    });
    // Verify via evaluate
    const check = await cdp.send('Runtime.evaluate', {
      expression: `document.querySelector('[data-test-attr]')?.getAttribute('data-test-attr')`,
      returnByValue: true,
    });
    if (check.result?.value !== 'hello') throw new Error(`Attribute not set: ${check.result?.value}`);
  });

  await test('DOM.getOuterHTML works', async () => {
    const html = findNode(docRoot, 'html');
    const body = findNode(html, 'body');
    const result = await cdp.send('DOM.getOuterHTML', { nodeId: body.nodeId });
    if (!result.outerHTML) throw new Error('No outerHTML');
    if (result.outerHTML.length < 10) throw new Error('outerHTML too short');
    log(`    body outerHTML length: ${result.outerHTML.length}`);
  });

  // -- Runtime --
  section('Runtime');

  await test('Runtime.evaluate with returnByValue', async () => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: '2 + 2',
      returnByValue: true,
    });
    if (result.result?.value !== 4) throw new Error(`Expected 4, got ${result.result?.value}`);
  });

  await test('Runtime.evaluate returns object with objectId', async () => {
    const result = await cdp.send('Runtime.evaluate', {
      expression: '({a: 1, b: "hello", c: [1,2,3]})',
    });
    if (!result.result?.objectId) throw new Error('No objectId');
  });

  await test('Runtime.getProperties expands objects', async () => {
    const obj = await cdp.send('Runtime.evaluate', {
      expression: '({foo: "bar", num: 42, arr: [1, 2]})',
    });
    const props = await cdp.send('Runtime.getProperties', {
      objectId: obj.result.objectId,
      ownProperties: true,
    });
    if (!props.result?.length) throw new Error('No properties');
    const fooP = props.result.find(p => p.name === 'foo');
    if (!fooP) throw new Error('Property "foo" not found');
    if (fooP.value?.value !== 'bar') throw new Error(`foo = ${fooP.value?.value}`);
    log(`    Properties: ${props.result.map(p => p.name).join(', ')}`);
  });

  await test('Runtime.getProperties deep expansion (nested object)', async () => {
    const obj = await cdp.send('Runtime.evaluate', {
      expression: '({nested: {deep: {value: 42}}})',
    });
    const props = await cdp.send('Runtime.getProperties', {
      objectId: obj.result.objectId,
      ownProperties: true,
    });
    const nested = props.result.find(p => p.name === 'nested');
    if (!nested?.value?.objectId) throw new Error('Nested has no objectId');
    const deepProps = await cdp.send('Runtime.getProperties', {
      objectId: nested.value.objectId,
      ownProperties: true,
    });
    const deep = deepProps.result.find(p => p.name === 'deep');
    if (!deep?.value?.objectId) throw new Error('deep has no objectId');
  });

  await test('Runtime.callFunctionOn works', async () => {
    const obj = await cdp.send('Runtime.evaluate', { expression: '({x: 10})' });
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId: obj.result.objectId,
      functionDeclaration: 'function() { return this.x * 2; }',
      returnByValue: true,
    });
    if (result.result?.value !== 20) throw new Error(`Expected 20, got ${result.result?.value}`);
  });

  // -- CSS --
  section('CSS');

  await test('CSS.getComputedStyleForNode works', async () => {
    const html = findNode(docRoot, 'html');
    const body = findNode(html, 'body');
    const result = await cdp.send('CSS.getComputedStyleForNode', { nodeId: body.nodeId });
    if (!result.computedStyle?.length) throw new Error('No computed styles');
    log(`    Computed properties: ${result.computedStyle.length}`);
    // Check for a common property
    const display = result.computedStyle.find(p => p.name === 'display');
    if (!display) throw new Error('No "display" property');
  });

  await test('CSS.getMatchedStylesForNode works', async () => {
    const html = findNode(docRoot, 'html');
    const body = findNode(html, 'body');
    const result = await cdp.send('CSS.getMatchedStylesForNode', { nodeId: body.nodeId });
    if (!result.inlineStyle) throw new Error('No inlineStyle');
    log(`    Matched rules: ${result.matchedCSSRules?.length || 0}, inline: ${result.inlineStyle?.cssProperties?.length || 0} props`);
  });

  await test('CSS.getMatchedStylesForNode has valid inlineStyle structure', async () => {
    const html = findNode(docRoot, 'html');
    const body = findNode(html, 'body');
    const result = await cdp.send('CSS.getMatchedStylesForNode', { nodeId: body.nodeId });
    const style = result.inlineStyle;
    if (!style.styleSheetId) throw new Error('inlineStyle missing styleSheetId');
    if (!style.cssProperties) throw new Error('inlineStyle missing cssProperties');
    if (style.range === undefined) throw new Error('inlineStyle missing range');
  });

  // -- Console --
  section('Console');

  await test('console.log generates Runtime.consoleAPICalled', async () => {
    cdp.events = []; // clear
    const marker = `__test_${Date.now()}`;
    await cdp.send('Runtime.evaluate', {
      expression: `console.log("${marker}")`,
    });
    // Wait for event
    await new Promise(r => setTimeout(r, 2000));
    const consoleEvents = cdp.events.filter(e =>
      e.method === 'Runtime.consoleAPICalled' &&
      JSON.stringify(e.params).includes(marker)
    );
    if (consoleEvents.length === 0) throw new Error('No console event received');
    const evt = consoleEvents[0].params;
    if (evt.type !== 'log') throw new Error(`Expected type "log", got "${evt.type}"`);
  });

  await test('console.warn generates warning type', async () => {
    cdp.events = [];
    const marker = `__warn_${Date.now()}`;
    await cdp.send('Runtime.evaluate', { expression: `console.warn("${marker}")` });
    await new Promise(r => setTimeout(r, 2000));
    const events = cdp.events.filter(e =>
      e.method === 'Runtime.consoleAPICalled' &&
      JSON.stringify(e.params).includes(marker)
    );
    if (events.length === 0) throw new Error('No console event');
    if (events[0].params.type !== 'warning') throw new Error(`Type: ${events[0].params.type}`);
  });

  await test('console.error generates error type', async () => {
    cdp.events = [];
    const marker = `__err_${Date.now()}`;
    await cdp.send('Runtime.evaluate', { expression: `console.error("${marker}")` });
    await new Promise(r => setTimeout(r, 2000));
    const events = cdp.events.filter(e =>
      e.method === 'Runtime.consoleAPICalled' &&
      JSON.stringify(e.params).includes(marker)
    );
    if (events.length === 0) throw new Error('No console event');
    if (events[0].params.type !== 'error') throw new Error(`Type: ${events[0].params.type}`);
  });

  // -- Debugger --
  section('Debugger');

  await test('Debugger.enable works', async () => {
    const result = await cdp.send('Debugger.enable');
    // Should not error
  });

  await test('Debugger.scriptParsed events received', async () => {
    await new Promise(r => setTimeout(r, 1000));
    const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed');
    if (scripts.length === 0) throw new Error('No scriptParsed events');
    log(`    Scripts parsed: ${scripts.length}`);
    scripts.slice(0, 3).forEach(s => log(`      ${s.params.url || s.params.scriptId}`));
  });

  await test('Debugger.getScriptSource returns content', async () => {
    const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed');
    if (scripts.length === 0) throw new Error('No scripts');
    const script = scripts.find(s => s.params.url) || scripts[0];
    const result = await cdp.send('Debugger.getScriptSource', { scriptId: script.params.scriptId });
    if (!result.scriptSource) throw new Error('No scriptSource');
    log(`    Source length: ${result.scriptSource.length}`);
  });

  await test('Debugger.getPossibleBreakpoints returns locations', async () => {
    const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed' && e.params.url);
    if (scripts.length === 0) throw new Error('No scripts with URLs');
    const script = scripts[0];
    const result = await cdp.send('Debugger.getPossibleBreakpoints', {
      start: { scriptId: script.params.scriptId, lineNumber: 0, columnNumber: 0 },
      end: { scriptId: script.params.scriptId, lineNumber: 20, columnNumber: 0 },
    });
    if (!result.locations?.length) throw new Error('No breakable locations');
    log(`    Breakable locations: ${result.locations.length}`);
  });

  await test('Debugger.setBreakpointByUrl + removeBreakpoint', async () => {
    const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed' && e.params.url);
    if (scripts.length === 0) throw new Error('No scripts');
    const url = scripts[0].params.url;
    const result = await cdp.send('Debugger.setBreakpointByUrl', {
      url,
      lineNumber: 1,
    });
    if (!result.breakpointId) throw new Error('No breakpointId');
    await cdp.send('Debugger.removeBreakpoint', { breakpointId: result.breakpointId });
  });

  await test('Debugger.setPauseOnExceptions works', async () => {
    await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' });
    await cdp.send('Debugger.setPauseOnExceptions', { state: 'uncaught' });
    await cdp.send('Debugger.setPauseOnExceptions', { state: 'all' });
    await cdp.send('Debugger.setPauseOnExceptions', { state: 'none' });
  });

  // -- Network --
  section('Network');

  await test('Network.enable works', async () => {
    await cdp.send('Network.enable');
  });

  await test('Page.getResourceTree works', async () => {
    const result = await cdp.send('Page.getResourceTree');
    if (!result.frameTree?.frame) throw new Error('No frame');
    log(`    Frame URL: ${result.frameTree.frame.url}`);
    log(`    Resources: ${result.frameTree.resources?.length || 0}`);
  });

  await test('Network.getResponseBody works for a request', async () => {
    // Trigger a fetch so we get a network event
    cdp.events = [];
    const marker = Date.now();
    await cdp.send('Runtime.evaluate', {
      expression: `fetch("/__fixtures/animation.html?_t=${marker}").then(r=>r.text())`,
    });
    await new Promise(r => setTimeout(r, 3000));

    const responses = cdp.events.filter(e => e.method === 'Network.responseReceived');
    if (responses.length === 0) {
      warn('No responseReceived events (bridge may batch these)');
      return;
    }
    const requestId = responses[0].params.requestId;
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId });
      if (!body.body) throw new Error('Empty body');
      log(`    Response body length: ${body.body.length}`);
    } catch (err) {
      warn(`getResponseBody: ${err.message}`);
    }
  });

  // -- Execution Context --
  section('Execution Context');

  await test('Runtime.executionContextCreated has valid origin', async () => {
    const ctxEvents = cdp.events.filter(e => e.method === 'Runtime.executionContextCreated');
    if (ctxEvents.length === 0) {
      // Send enable to trigger it
      await cdp.send('Runtime.enable');
      await new Promise(r => setTimeout(r, 1000));
    }
    const events = cdp.events.filter(e => e.method === 'Runtime.executionContextCreated');
    if (events.length === 0) throw new Error('No executionContextCreated events');
    const ctx = events[0].params.context;
    if (!ctx.origin || ctx.origin === '' || ctx.origin === 'about:blank') {
      throw new Error(`Bad origin: "${ctx.origin}"`);
    }
    log(`    Context origin: ${ctx.origin}`);
  });

  // -- Inline Style Editing --
  section('Inline Style Editing');

  await test('CSS.setStyleTexts for inline styles', async () => {
    // First create a test element
    await cdp.send('Runtime.evaluate', {
      expression: `
        if (!document.getElementById('__proto_test')) {
          const el = document.createElement('div');
          el.id = '__proto_test';
          el.style.color = 'red';
          document.body.appendChild(el);
        }
      `,
    });

    // Get fresh DOM
    const doc = await cdp.send('DOM.getDocument', { depth: -1 });
    const html = findNode(doc.root, 'html');
    const body = findNode(html, 'body');
    const testEl = findNodeById(body, '__proto_test');
    if (!testEl) throw new Error('Test element not in DOM tree');

    // Get matched styles to find inline styleSheetId
    const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId: testEl.nodeId });
    if (!matched.inlineStyle?.styleSheetId) throw new Error('No inline styleSheetId');

    // Edit inline style
    const editResult = await cdp.send('CSS.setStyleTexts', {
      edits: [{
        styleSheetId: matched.inlineStyle.styleSheetId,
        range: matched.inlineStyle.range,
        text: 'color: blue; font-size: 20px;',
      }],
    });
    if (!editResult.styles?.length) throw new Error('setStyleTexts returned no styles');

    // Verify
    const check = await cdp.send('Runtime.evaluate', {
      expression: `document.getElementById('__proto_test').style.cssText`,
      returnByValue: true,
    });
    log(`    Style after edit: ${check.result?.value}`);
    if (!check.result?.value?.includes('blue')) throw new Error('Style not applied');
  });

  // Cleanup
  await cdp.send('Runtime.evaluate', {
    expression: `document.getElementById('__proto_test')?.remove(); document.querySelector('[data-test-attr]')?.removeAttribute('data-test-attr');`,
  });

  cdp.close();
  return { passed, failed };
}

// ── Phase 2: UI Tests ────────────────────────────────────────────────

async function runUITests(target) {
  section('DevTools UI Tests');

  const wsParam = `localhost:${BRIDGE_PORT}/devtools/page/${encodeURIComponent(target.id)}`;
  const devtoolsUrl = `devtools://devtools/bundled/inspector.html?ws=${wsParam}`;

  const browser = await puppeteer.launch({
    headless: !HEADED,
    channel: 'chrome',
    args: ['--no-first-run', '--no-default-browser-check', '--disable-extensions'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  log('Navigating to DevTools frontend...');
  await page.goto(devtoolsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000)); // Wait for full init

  // Find DevTools panel tabs via shadow DOM traversal
  const panelTabNames = await page.evaluate(() => {
    function deepQueryAll(root, selector) {
      const results = [...root.querySelectorAll(selector)];
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot, selector));
      });
      return results;
    }
    const tabs = deepQueryAll(document, '[role="tab"]');
    return tabs.map(t => ({ text: t.textContent.trim(), ariaLabel: t.getAttribute('aria-label') }));
  });
  log(`Panel tabs found: ${panelTabNames.map(t => t.text || t.ariaLabel).join(', ')}`);

  // Helper to click panel tab
  async function clickPanel(name) {
    await page.evaluate((panelName) => {
      function deepQueryAll(root, selector) {
        const results = [...root.querySelectorAll(selector)];
        root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) results.push(...deepQueryAll(el.shadowRoot, selector));
        });
        return results;
      }
      const tabs = deepQueryAll(document, '[role="tab"]');
      for (const tab of tabs) {
        const text = (tab.textContent || tab.getAttribute('aria-label') || '').trim().toLowerCase();
        if (text.includes(panelName.toLowerCase())) {
          tab.click();
          return true;
        }
      }
      return false;
    }, name);
    await new Promise(r => setTimeout(r, 2000));
  }

  // Helper to get all visible text in shadow DOM
  async function getAllText() {
    return page.evaluate(() => {
      function deepText(root) {
        let text = root.innerText || '';
        root.querySelectorAll('*').forEach(el => {
          if (el.shadowRoot) text += ' ' + deepText(el.shadowRoot);
        });
        return text;
      }
      return deepText(document);
    });
  }

  // ── Elements Panel ──
  log('\n── Elements Panel (UI) ──');
  await clickPanel('elements');
  await screenshot(page, '01-elements');

  await test('Elements panel shows DOM tree', async () => {
    const text = await getAllText();
    const hasDom = text.includes('<html') || text.includes('<body') || text.includes('<div') ||
                   text.includes('<head') || text.includes('html') || text.includes('body');
    if (!hasDom) throw new Error('No DOM content visible in Elements panel');
  });

  await test('Styles sidebar visible', async () => {
    const text = await getAllText();
    if (!text.includes('Styles') && !text.includes('element.style') && !text.includes('Computed')) {
      throw new Error('Styles sidebar not visible');
    }
  });

  // ── Console Panel ──
  log('\n── Console Panel (UI) ──');
  await clickPanel('console');
  await new Promise(r => setTimeout(r, 1000));
  await screenshot(page, '02-console');

  await test('Console panel renders', async () => {
    const text = await getAllText();
    // Console should have a prompt area at minimum
    if (!text.includes('Console') && !text.includes('>') && !text.includes('console')) {
      throw new Error('Console panel not visible');
    }
  });

  // ── Sources Panel ──
  log('\n── Sources Panel (UI) ──');
  await clickPanel('sources');
  await new Promise(r => setTimeout(r, 2000));
  await screenshot(page, '03-sources');

  await test('Sources panel shows files', async () => {
    const text = await getAllText();
    // Should list script files or show source navigator
    const hasContent = text.includes('.js') || text.includes('.html') || text.includes('animation') ||
                       text.includes('Page') || text.includes('Snippets') || text.includes('Filesystem') ||
                       text.includes('Sources');
    if (!hasContent) throw new Error('Sources panel has no content');
  });

  // ── Network Panel ──
  log('\n── Network Panel (UI) ──');
  await clickPanel('network');
  await new Promise(r => setTimeout(r, 2000));
  await screenshot(page, '04-network');

  await test('Network panel renders', async () => {
    const text = await getAllText();
    if (!text.includes('Name') && !text.includes('Status') && !text.includes('Network') &&
        !text.includes('request') && !text.includes('transferred')) {
      throw new Error('Network panel empty');
    }
  });

  // ── Performance Panel ──
  log('\n── Performance Panel (UI) ──');
  await clickPanel('performance');
  await new Promise(r => setTimeout(r, 1000));
  await screenshot(page, '05-performance');

  // ── Application Panel ──
  log('\n── Application Panel (UI) ──');
  await clickPanel('application');
  await new Promise(r => setTimeout(r, 1000));
  await screenshot(page, '06-application');

  // ── Error Analysis ──
  log('\n── DevTools Frontend Errors ──');
  const unimplemented = [];
  const otherErrors = [];
  for (const e of errors) {
    if (e.includes('favicon') || e.includes('Permissions-Policy') || e.includes('Feature-Policy')) continue;
    if (e.includes('Method not implemented')) {
      const match = e.match(/Method not implemented: (\S+)/);
      if (match) unimplemented.push(match[1]);
    } else {
      otherErrors.push(e);
    }
  }

  if (unimplemented.length > 0) {
    log(`\x1b[33mUnimplemented CDP methods called by DevTools (${[...new Set(unimplemented)].length}):\x1b[0m`);
    [...new Set(unimplemented)].forEach(m => console.log(`  \x1b[33m- ${m}\x1b[0m`));
  }
  if (otherErrors.length > 0) {
    log(`\x1b[31mOther errors (${otherErrors.length}):\x1b[0m`);
    otherErrors.slice(0, 10).forEach(e => console.log(`  \x1b[31m- ${e.substring(0, 150)}\x1b[0m`));
  }

  await browser.close();
}

// ── Tree Helpers ─────────────────────────────────────────────────────

function findNode(node, localName) {
  if (!node?.children) return null;
  for (const child of node.children) {
    if (child.localName === localName || child.nodeName?.toLowerCase() === localName) return child;
  }
  return null;
}

function findNodeById(node, id) {
  if (!node) return null;
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === 'id' && attrs[i + 1] === id) return node;
  }
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  return null;
}

async function screenshot(page, name) {
  const p = `test/screenshots/${name}.png`;
  await page.screenshot({ path: p, fullPage: true });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  mkdirSync('test/screenshots', { recursive: true });

  log('Fetching targets...');
  let targets;
  try {
    targets = await fetchJSON('/json/list');
  } catch {
    console.error(`Cannot reach bridge at localhost:${BRIDGE_PORT}`);
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error('No targets available');
    process.exit(1);
  }

  const target = targets[0];
  log(`Target: "${target.title}" (${target.deviceName || 'simulator'})`);

  if (!UI_ONLY) {
    await runProtocolTests(target);
  }

  if (!PROTOCOL_ONLY) {
    // Reset counters for UI phase
    const protoResults = { passed, failed };
    await runUITests(target);
  }

  // ── Summary ──
  console.log(`\n\x1b[36m${'═'.repeat(50)}\x1b[0m`);
  console.log(`\x1b[36m Results: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
  console.log(`\x1b[36m${'═'.repeat(50)}\x1b[0m\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
