// Quick CDP test: start a trace, generate JS work, stop, and inspect the trace events
import WebSocket from 'ws';

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

const ws = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(targets[0].id)}`);
let id = 1;
const pending = new Map();
const events = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method) {
    events.push(msg);
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
console.log('Connected to target:', targets[0].title);

// Enable Runtime so we can evaluate JS
await send('Runtime.enable');

// Navigate to a JS-heavy page to generate profiler data
console.log('Navigating to a page with JS...');
await send('Page.navigate', { url: 'https://example.com' });
await new Promise(r => setTimeout(r, 3000));

// Generate JS work via evaluation
console.log('Generating JS work on target page...');
await send('Runtime.evaluate', { expression: `
  // Create lots of named function calls for the profiler to capture
  function fibonacci(n) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }
  function heavyWork() { for (let i = 0; i < 5; i++) fibonacci(25); }
  function processData() { const arr = Array.from({length: 10000}, (_, i) => i); return arr.reduce((a, b) => a + b, 0); }
  function renderLoop() { heavyWork(); processData(); }
  // Run it multiple times
  for (let i = 0; i < 3; i++) renderLoop();
  "JS work done"
` });

// Start tracing
console.log('Starting trace...');
events.length = 0;
await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler' });

// Generate more JS work during tracing
console.log('Generating JS work during trace...');
for (let i = 0; i < 5; i++) {
  await send('Runtime.evaluate', { expression: `
    function fibonacci(n) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }
    function busyLoop() { let sum = 0; for (let i = 0; i < 100000; i++) sum += Math.sin(i); return sum; }
    function renderFrame() { fibonacci(28); busyLoop(); }
    renderFrame();
    "iteration ${i}"
  ` });
  await new Promise(r => setTimeout(r, 200));
}

console.log('Waiting 2 more seconds...');
await new Promise(r => setTimeout(r, 2000));

// Stop tracing
console.log('Stopping trace...');
await send('Tracing.end');

// Wait for dataCollected
await new Promise(r => setTimeout(r, 5000));

// Find the Tracing.dataCollected event
const dataEvent = events.find(e => e.method === 'Tracing.dataCollected');
if (!dataEvent) {
  console.error('No Tracing.dataCollected received!');
  console.log('Events received:', events.map(e => e.method));
  process.exit(1);
}

const traceEvents = dataEvent.params.value;
console.log(`\nTotal trace events: ${traceEvents.length}`);

// Categorize events
const categories = {};
for (const evt of traceEvents) {
  const key = `${evt.cat}/${evt.name}`;
  categories[key] = (categories[key] || 0) + 1;
}
console.log('\nEvent categories:');
for (const [key, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key}: ${count}`);
}

// Check for Profile/ProfileChunk events
const profileEvents = traceEvents.filter(e => e.name === 'Profile' || e.name === 'ProfileChunk');
console.log(`\nProfile events: ${profileEvents.length}`);
for (const pe of profileEvents) {
  console.log(`  ${pe.name}: cat=${pe.cat}, pid=${pe.pid}, tid=${pe.tid}, ph=${pe.ph}`);
  if (pe.name === 'ProfileChunk' && pe.args?.data?.cpuProfile) {
    const cp = pe.args.data.cpuProfile;
    console.log(`    nodes: ${cp.nodes?.length}, samples: ${cp.samples?.length}`);
    // Show some node details
    const jsNodes = cp.nodes.filter(n => n.callFrame?.codeType === 'JS');
    console.log(`    JS nodes: ${jsNodes.length}`);
    for (const n of jsNodes.slice(0, 10)) {
      console.log(`      id:${n.id} ${n.callFrame.functionName} @ ${n.callFrame.url}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`);
    }
    if (jsNodes.length > 10) console.log(`      ... and ${jsNodes.length - 10} more`);
    // Check timeDeltas
    const td = pe.args.data.timeDeltas || [];
    console.log(`    timeDeltas: ${td.length}, sample: [${td.slice(0, 20).join(', ')}]`);
    const nonZero = td.filter(d => d > 0);
    console.log(`    non-zero deltas: ${nonZero.length}, avg: ${nonZero.length ? Math.round(nonZero.reduce((a,b)=>a+b,0)/nonZero.length) : 0}μs`);
    console.log(`    lines: ${pe.args.data.lines?.length}`);
  }
}

// Check for FunctionCall events
const fnCalls = traceEvents.filter(e => e.name === 'FunctionCall');
console.log(`\nFunctionCall events: ${fnCalls.length}`);
for (const fc of fnCalls.slice(0, 10)) {
  const d = fc.args?.data || {};
  console.log(`  ${d.functionName || '?'} @ ${d.url || '?'}:${d.lineNumber}:${d.columnNumber} dur=${fc.dur}μs`);
}

ws.close();
process.exit(0);
