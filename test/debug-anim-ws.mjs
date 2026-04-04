// Proxy between DevTools and bridge, logging all Animation-related messages
import { WebSocketServer, WebSocket } from 'ws';

const BRIDGE_PORT = 9221;
const PROXY_PORT = 9222;

const targets = await (await fetch(`http://localhost:${BRIDGE_PORT}/json/list`)).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }
console.log('Target:', targets[0].title);

// Serve /json/list on proxy port with rewritten URLs
const http = await import('http');
const server = http.createServer((req, res) => {
  if (req.url === '/json/list' || req.url === '/json') {
    const proxied = targets.map(t => ({
      ...t,
      webSocketDebuggerUrl: t.webSocketDebuggerUrl?.replace(`:${BRIDGE_PORT}/`, `:${PROXY_PORT}/`),
      devtoolsFrontendUrl: t.devtoolsFrontendUrl?.replace(`:${BRIDGE_PORT}/`, `:${PROXY_PORT}/`),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(proxied));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs, req) => {
  const targetPath = req.url;
  const bridgeUrl = `ws://localhost:${BRIDGE_PORT}${targetPath}`;
  console.log(`\n[PROXY] Client connected, forwarding to ${bridgeUrl}`);

  const bridgeWs = new WebSocket(bridgeUrl);
  let ready = false;
  const queue = [];

  bridgeWs.on('open', () => {
    ready = true;
    for (const msg of queue) bridgeWs.send(msg);
    queue.length = 0;
  });

  // Client → Bridge
  clientWs.on('message', (data) => {
    const str = data.toString();
    const msg = JSON.parse(str);
    if (msg.method?.startsWith('Animation') || msg.method?.includes('animation') || msg.method?.includes('pushNodes') || msg.method?.includes('DOM.')) {
      console.log(`[C→B] ${msg.method} id=${msg.id} sessionId=${msg.sessionId || 'NONE'}`, JSON.stringify(msg.params || {}).substring(0, 150));
    }
    if (ready) bridgeWs.send(str);
    else queue.push(str);
  });

  // Bridge → Client
  bridgeWs.on('message', (data) => {
    const str = data.toString();
    try {
      const msg = JSON.parse(str);
      if (msg.method?.startsWith('Animation')) {
        console.log(`[B→C] ${msg.method} sessionId=${msg.sessionId || 'NONE'}`, JSON.stringify(msg.params || {}).substring(0, 200));
      }
      // Log all responses (to see what pushNodesByBackendIds returns)
      if (msg.id && msg.result) {
        const r = JSON.stringify(msg.result);
        if (r.includes('nodeIds') || r.includes('backendNodeId')) {
          console.log(`[B→C] response id=${msg.id}:`, r.substring(0, 200));
        }
      }
      // Log responses to Animation.enable
      if (msg.id && !msg.method) {
        // Check if this was a response to an Animation command
        // We can't easily track this without storing sent IDs, just log all responses briefly
      }
    } catch {}
    clientWs.send(str);
  });

  bridgeWs.on('close', () => { try { clientWs.close(); } catch {} });
  clientWs.on('close', () => { try { bridgeWs.close(); } catch {} });
});

server.listen(PROXY_PORT, () => {
  console.log(`[PROXY] Listening on port ${PROXY_PORT}`);
  console.log(`[PROXY] Open DevTools: devtools://devtools/bundled/devtools_app.html?ws=localhost:${PROXY_PORT}/devtools/page/${encodeURIComponent(targets[0].id)}`);
  console.log('[PROXY] Waiting for connections...\n');
});

// Run Puppeteer to open DevTools and trigger Animation panel
const puppeteer = await import('puppeteer');
const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1000 });

const wsUrl = `devtools://devtools/bundled/devtools_app.html?ws=localhost:${PROXY_PORT}/devtools/page/${encodeURIComponent(targets[0].id)}`;
console.log('[TEST] Opening DevTools...');
await page.goto(wsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 8000));

// Open Animations panel
console.log('[TEST] Opening Animations panel...');
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 300));
await page.keyboard.down('Meta');
await page.keyboard.down('Shift');
await page.keyboard.press('KeyP');
await page.keyboard.up('Shift');
await page.keyboard.up('Meta');
await new Promise(r => setTimeout(r, 500));
await page.keyboard.type('Animations', { delay: 30 });
await new Promise(r => setTimeout(r, 800));
await page.keyboard.press('Enter');
await new Promise(r => setTimeout(r, 5000));

console.log('\n[TEST] Panel should be open now. Checking for Animation messages above...');

const panelText = await page.evaluate(() => document.body.innerText.substring(0, 300));
console.log('[TEST] Panel text:', panelText.substring(0, 200));

// Wait a bit more for any delayed events
await new Promise(r => setTimeout(r, 3000));

console.log('\n[TEST] Done! Closing...');
try { browser.process()?.kill('SIGKILL'); } catch {}
server.close();
process.exit(0);
