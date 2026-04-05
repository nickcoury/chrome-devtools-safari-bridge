// Reproduce: profile Google Images → crash due to 25MB WIR frame
import WebSocket from 'ws';

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }
console.log('Target:', targets[0].title, '—', targets[0].url?.substring(0, 60));

const ws = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(targets[0].id)}`);
let id = 1;
const pending = new Map();
const events = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method) events.push(msg);
});
ws.on('error', (e) => { console.log('WS error:', e.message); });
ws.on('close', (code, reason) => { console.log('WS closed:', code, reason?.toString()); });

function send(method, params = {}) {
  const i = id++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(i); reject(new Error(`${method} timeout`)); }, 30000);
    pending.set(i, (msg) => { clearTimeout(timeout); resolve(msg); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

await new Promise(r => ws.on('open', r));

// Navigate to Google Images if not already there
const currentUrl = targets[0].url;
if (!currentUrl.includes('udm=2')) {
  console.log('Navigating to Google Images...');
  try {
    await send('Page.navigate', { url: 'https://www.google.com/search?q=dogs&udm=2' });
    await new Promise(r => setTimeout(r, 5000));
  } catch (e) {
    console.log('Navigate error:', e.message);
  }
}

// Start tracing (this is what the Performance panel does)
console.log('\nStarting trace...');
events.length = 0;
try {
  await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler' });
  console.log('Tracing started successfully');
} catch (e) {
  console.log('Tracing.start failed:', e.message);
}

// Wait 5 seconds to accumulate profiler data on the complex Google page
console.log('Recording for 5 seconds on Google Images...');
await new Promise(r => setTimeout(r, 5000));

// Stop tracing — this triggers ScriptProfiler.trackingComplete which is the big response
console.log('Stopping trace (this may crash the bridge if response > 20MB)...');
try {
  await send('Tracing.end');
  console.log('Tracing.end succeeded!');
} catch (e) {
  console.log('Tracing.end failed:', e.message);
}

// Wait for dataCollected
console.log('Waiting for trace data...');
await new Promise(r => setTimeout(r, 8000));

const dataEvent = events.find(e => e.method === 'Tracing.dataCollected');
if (dataEvent) {
  console.log('Got trace data!', dataEvent.params.value.length, 'events');
} else {
  console.log('No trace data received — bridge may have crashed');
}

// Check if bridge is still alive
try {
  const h = await fetch('http://localhost:9221/json/list');
  const t = await h.json();
  console.log('Bridge alive:', t.length, 'targets');
} catch {
  console.log('Bridge is DEAD — crashed!');
}

ws.close();
process.exit(0);
