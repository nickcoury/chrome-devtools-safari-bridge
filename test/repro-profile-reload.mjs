import { WebSocketServer, WebSocket } from 'ws';
import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

mkdirSync('test/screenshots/harden', { recursive: true });

const BRIDGE_PORT = 9221;
const PROXY_PORT = 9222;

const targets = await (await fetch(`http://localhost:${BRIDGE_PORT}/json/list`)).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

// Proxy
const http = await import('http');
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/json')) {
    const proxied = targets.map(t => ({
      ...t,
      webSocketDebuggerUrl: t.webSocketDebuggerUrl?.replace(`:${BRIDGE_PORT}/`, `:${PROXY_PORT}/`),
      devtoolsFrontendUrl: t.devtoolsFrontendUrl?.replace(`:${BRIDGE_PORT}/`, `:${PROXY_PORT}/`),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(proxied));
  } else { res.writeHead(404); res.end(); }
});
const wss = new WebSocketServer({ server });
const pendingRequests = new Map(); // id → {method, ts}

wss.on('connection', (clientWs, req) => {
  const bridgeWs = new WebSocket(`ws://localhost:${BRIDGE_PORT}${req.url}`);
  let ready = false;
  const queue = [];
  bridgeWs.on('open', () => { ready = true; for (const m of queue) bridgeWs.send(m); queue.length = 0; });

  clientWs.on('message', (data) => {
    const str = data.toString();
    const msg = JSON.parse(str);
    // Track all requests
    if (msg.id && msg.method) {
      pendingRequests.set(msg.id, { method: msg.method, ts: Date.now() });
      // Log performance-related messages
      if (msg.method.includes('Tracing') || msg.method.includes('Profiler') ||
          msg.method.includes('Page.') || msg.method.includes('DOM.disable') ||
          msg.method.includes('CSS.disable') || msg.method.includes('Overlay') ||
          msg.method.includes('Network.disable') || msg.method.includes('removeBinding') ||
          msg.method.includes('Runtime.removeBinding')) {
        console.log(`[C→B] id=${msg.id} ${msg.method}`);
      }
    }
    if (ready) bridgeWs.send(str); else queue.push(str);
  });

  bridgeWs.on('message', (data) => {
    const str = data.toString();
    const msg = JSON.parse(str);
    // Log responses to tracked requests
    if (msg.id && pendingRequests.has(msg.id)) {
      const req = pendingRequests.get(msg.id);
      const elapsed = Date.now() - req.ts;
      if (elapsed > 100 || req.method.includes('Tracing') || req.method.includes('Page.') || req.method.includes('disable')) {
        console.log(`[B→C] id=${msg.id} ${req.method} → ${elapsed}ms ${msg.error ? 'ERROR: ' + JSON.stringify(msg.error) : 'ok'}`);
      }
      pendingRequests.delete(msg.id);
    }
    if (msg.method?.includes('Tracing.')) {
      console.log(`[B→C] event: ${msg.method}`);
    }
    clientWs.send(str);
  });

  bridgeWs.on('close', () => { try { clientWs.close(); } catch {} });
  clientWs.on('close', () => { try { bridgeWs.close(); } catch {} });
});

server.listen(PROXY_PORT);
console.log('Proxy on', PROXY_PORT);

// Open DevTools
const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1000 });
const wsUrl = `devtools://devtools/bundled/devtools_app.html?ws=localhost:${PROXY_PORT}/devtools/page/${encodeURIComponent(targets[0].id)}`;
await page.goto(wsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 10000));

// Open Performance panel
async function openPanel(name) {
  await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 300));
  await page.keyboard.down('Meta'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyP');
  await page.keyboard.up('Shift'); await page.keyboard.up('Meta');
  await new Promise(r => setTimeout(r, 500));
  await page.keyboard.type(name, { delay: 30 });
  await new Promise(r => setTimeout(r, 800)); await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 2000));
}

console.log('\n=== Opening Performance, clicking Record ===');
await openPanel('Performance');
await new Promise(r => setTimeout(r, 1000));

// Click Record
const recordBtn = await page.$('[aria-label="Record"]');
if (recordBtn) { await recordBtn.click(); console.log('Clicked Record'); }

console.log('Waiting 2s...');
await new Promise(r => setTimeout(r, 2000));

// Now trigger reload via separate WS while recording
console.log('\n=== Triggering Page.reload via CDP ===');
const reloadWs = new WebSocket(`ws://localhost:${BRIDGE_PORT}/devtools/page/${encodeURIComponent(targets[0].id)}`);
await new Promise(r => reloadWs.on('open', r));
reloadWs.send(JSON.stringify({ id: 1, method: 'Page.reload', params: {} }));
console.log('Reload sent');

// Wait and check for hanging requests
await new Promise(r => setTimeout(r, 10000));

// Check pending requests
console.log('\n=== Pending (unanswered) requests after 10s: ===');
for (const [reqId, req] of pendingRequests) {
  const age = Date.now() - req.ts;
  if (age > 3000) {
    console.log(`  id=${reqId} ${req.method} — hanging for ${Math.round(age/1000)}s`);
  }
}

await page.screenshot({ path: 'test/screenshots/harden/reload-proxy-result.png' });

reloadWs.close();
server.close();
try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
