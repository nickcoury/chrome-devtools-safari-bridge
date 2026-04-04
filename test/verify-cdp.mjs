#!/usr/bin/env node
/**
 * CDP-Level Panel Verification
 *
 * Connects directly to the bridge via CDP WebSocket and verifies that
 * each panel's underlying protocol works correctly. This catches real
 * regressions that the Puppeteer text-check (verify-panels.mjs) misses.
 *
 * Usage: node test/verify-cdp.mjs [--bridge-port=9221]
 */

import WebSocket from 'ws';

const BRIDGE_PORT = parseInt(process.argv.find(a => a.startsWith('--bridge-port='))?.split('=')[1] || '9221');

function pass(msg) { console.log(`\x1b[32m  ✓\x1b[0m ${msg}`); }
function fail(msg) { console.log(`\x1b[31m  ✗\x1b[0m ${msg}`); }

class CDPVerifier {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 1;
    this.pending = new Map();
    this.events = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject, timer } = this.pending.get(msg.id);
          clearTimeout(timer);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.method || ''}: ${JSON.stringify(msg.error)}`));
          else resolve(msg.result);
        }
        if (msg.method) this.events.push(msg);
      });
    });
  }

  send(method, params = {}, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.ws?.close(); }
}

async function main() {
  let targets;
  try {
    targets = await (await fetch(`http://localhost:${BRIDGE_PORT}/json/list`)).json();
  } catch { console.error('Bridge not running on port ' + BRIDGE_PORT); process.exit(1); }
  if (!targets.length) { console.error('No targets'); process.exit(1); }

  console.log(`\x1b[36m[verify-cdp]\x1b[0m Target: ${targets[0].title} (${targets[0].deviceType || 'unknown'})`);
  console.log(`\x1b[36m[verify-cdp]\x1b[0m Connecting to ${targets[0].webSocketDebuggerUrl}...`);

  const cdp = new CDPVerifier(targets[0].webSocketDebuggerUrl);
  await cdp.connect();

  let passed = 0, failed = 0;

  // ── Elements ──
  try {
    await cdp.send('DOM.enable');
    const doc = await cdp.send('DOM.getDocument', {});
    const html = doc.root?.children?.find(c => c.localName === 'html' || c.nodeName === 'HTML');
    const body = html?.children?.find(c => c.localName === 'body');
    if (html && body && (body.childNodeCount > 0 || body.children?.length > 0)) {
      pass(`Elements: DOM tree (${body.childNodeCount || body.children?.length} body children)`);
      passed++;
    } else {
      fail(`Elements: shallow DOM (html=${!!html} body=${!!body} children=${body?.childNodeCount || body?.children?.length || 0})`);
      failed++;
    }
  } catch (e) { fail(`Elements: ${e.message}`); failed++; }

  // CSS
  try {
    const doc = await cdp.send('DOM.getDocument', {});
    const html = doc.root?.children?.find(c => c.localName === 'html');
    const body = html?.children?.find(c => c.localName === 'body');
    if (body) {
      const computed = await cdp.send('CSS.getComputedStyleForNode', { nodeId: body.nodeId });
      if (computed.computedStyle?.length > 10) {
        pass(`Elements: Styles (${computed.computedStyle.length} computed properties)`);
        passed++;
      } else {
        fail(`Elements: no computed styles (${computed.computedStyle?.length || 0})`);
        failed++;
      }
    } else { fail('Elements: no body for CSS check'); failed++; }
  } catch (e) { fail(`Elements CSS: ${e.message}`); failed++; }

  // ── Console ──
  try {
    await cdp.send('Runtime.enable');
    const evalResult = await cdp.send('Runtime.evaluate', { expression: '2 + 2', returnByValue: true });
    if (evalResult.result?.type === 'number' && evalResult.result?.value === 4) {
      pass('Console: evaluate works (2+2=4)');
      passed++;
    } else {
      fail(`Console: evaluate returned ${JSON.stringify(evalResult.result)}`);
      failed++;
    }
  } catch (e) { fail(`Console: ${e.message}`); failed++; }

  // Console events
  try {
    cdp.events.length = 0;
    await cdp.send('Runtime.evaluate', { expression: 'console.log("__cdp_verify_test__")' });
    await new Promise(r => setTimeout(r, 1500));
    const consoleMsgs = cdp.events.filter(e => e.method === 'Runtime.consoleAPICalled');
    if (consoleMsgs.length > 0) {
      pass(`Console: events received (${consoleMsgs.length})`);
      passed++;
    } else {
      fail('Console: no consoleAPICalled events received');
      failed++;
    }
  } catch (e) { fail(`Console events: ${e.message}`); failed++; }

  // ── Network ──
  try {
    await cdp.send('Network.enable');
    cdp.events.length = 0;
    await cdp.send('Runtime.evaluate', { expression: 'fetch("/json/list").catch(() => {})' });
    await new Promise(r => setTimeout(r, 3000));
    const netRequests = cdp.events.filter(e => e.method === 'Network.requestWillBeSent');
    const netResponses = cdp.events.filter(e => e.method === 'Network.responseReceived');
    if (netRequests.length > 0 && netResponses.length > 0) {
      pass(`Network: request+response captured (${netRequests.length} req, ${netResponses.length} resp)`);
      passed++;
    } else {
      fail(`Network: missing events (requests=${netRequests.length} responses=${netResponses.length})`);
      failed++;
    }
  } catch (e) { fail(`Network: ${e.message}`); failed++; }

  // ── Sources ──
  try {
    await cdp.send('Debugger.enable');
    await new Promise(r => setTimeout(r, 1500));
    const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed' && e.params.url);
    if (scripts.length > 0) {
      pass(`Sources: ${scripts.length} scripts parsed`);
      passed++;
    } else {
      fail('Sources: no scriptParsed events');
      failed++;
    }
  } catch (e) { fail(`Sources: ${e.message}`); failed++; }

  // ── Performance ──
  try {
    // Test the full DevTools recording flow: suspendAllTargets + Tracing.start
    await cdp.send('Runtime.removeBinding', { name: '_devtools' }).catch(() => {});
    await Promise.all([
      cdp.send('DOM.disable'),
      cdp.send('CSS.disable'),
      cdp.send('Overlay.disable'),
      cdp.send('Network.disable'),
      cdp.send('Page.stopLoading'),
    ]);
    const t0 = Date.now();
    await cdp.send('Tracing.start', { categories: '-*,devtools.timeline' });
    const elapsed = Date.now() - t0;
    await new Promise(r => setTimeout(r, 1200));
    const bufferEvents = cdp.events.filter(e => e.method === 'Tracing.bufferUsage');
    await cdp.send('Tracing.end');
    await new Promise(r => setTimeout(r, 1000));
    const dataEvents = cdp.events.filter(e => e.method === 'Tracing.dataCollected');
    const completeEvents = cdp.events.filter(e => e.method === 'Tracing.tracingComplete');

    if (elapsed < 10000 && bufferEvents.length > 0 && completeEvents.length > 0) {
      pass(`Performance: tracing works (${elapsed}ms start, ${bufferEvents.length} bufferUsage, ${dataEvents.length} data)`);
      passed++;
    } else {
      fail(`Performance: tracing issues (start=${elapsed}ms, bufferUsage=${bufferEvents.length}, complete=${completeEvents.length})`);
      failed++;
    }
  } catch (e) { fail(`Performance: ${e.message}`); failed++; }

  cdp.close();

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`  CDP Checks: ${passed} pass, ${failed} fail`);
  console.log(`${'═'.repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
