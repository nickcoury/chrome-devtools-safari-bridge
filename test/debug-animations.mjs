// Debug: connect to bridge via CDP and check Animation events directly
import WebSocket from 'ws';

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

// Navigate to animation page first
const ws = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(targets[0].id)}`);
let id = 1;
const pending = new Map();
const animEvents = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method?.startsWith('Animation.')) {
    animEvents.push(msg);
    console.log(`[EVENT] ${msg.method}:`, JSON.stringify(msg.params).substring(0, 200));
  }
});

function send(method, params = {}) {
  const reqId = id++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
}

await new Promise(r => ws.on('open', r));
console.log('Connected to:', targets[0].title);

// Navigate
await send('Page.navigate', { url: `http://192.168.1.111:9221/__pages/animation.html` });
await new Promise(r => setTimeout(r, 3000));

// Enable DOM first (needed for backendNodeId resolution)
await send('DOM.enable');
await send('DOM.getDocument');

// Enable Animation and wait for events
console.log('\nEnabling Animation domain...');
const enableResult = await send('Animation.enable');
console.log('Animation.enable result:', JSON.stringify(enableResult.result));

// Wait for delayed animation events
console.log('Waiting for animation events...');
await new Promise(r => setTimeout(r, 3000));

console.log(`\nReceived ${animEvents.length} animation events`);

// Print full event details for the first animationStarted
const started = animEvents.find(e => e.method === 'Animation.animationStarted');
if (started) {
  console.log('\nFull animationStarted event:');
  console.log(JSON.stringify(started.params, null, 2));
}

ws.close();
process.exit(0);
