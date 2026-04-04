// Save trace data to a file that can be loaded in chrome://tracing
import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

const ws = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(targets[0].id)}`);
let id = 1;
const pending = new Map();
const events = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method) events.push(msg);
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

await send('Runtime.enable');

// Generate JS work
console.log('Generating JS work...');
for (let i = 0; i < 3; i++) {
  await send('Runtime.evaluate', { expression: `
    function fibonacci(n) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }
    function heavyWork() { for (let i = 0; i < 3; i++) fibonacci(22); }
    heavyWork(); "done ${i}"
  ` });
}

// Start tracing
events.length = 0;
console.log('Starting trace...');
await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler' });

// Generate work during trace
for (let i = 0; i < 5; i++) {
  await send('Runtime.evaluate', { expression: `
    function fibonacci(n) { return n <= 1 ? n : fibonacci(n-1) + fibonacci(n-2); }
    function processData() { let s = 0; for (let i = 0; i < 50000; i++) s += Math.sin(i); return s; }
    function renderUI() { fibonacci(24); processData(); }
    renderUI(); "trace work ${i}"
  ` });
  await new Promise(r => setTimeout(r, 200));
}

await new Promise(r => setTimeout(r, 2000));
console.log('Stopping trace...');
await send('Tracing.end');
await new Promise(r => setTimeout(r, 5000));

const dataEvent = events.find(e => e.method === 'Tracing.dataCollected');
if (!dataEvent) { console.error('No trace data!'); process.exit(1); }

const traceData = { traceEvents: dataEvent.params.value };
writeFileSync('test/trace-output.json', JSON.stringify(traceData, null, 2));
console.log(`Saved trace to test/trace-output.json (${traceData.traceEvents.length} events)`);

// Print summary of JS-related events
const jsEvents = traceData.traceEvents.filter(e => e.name === 'FunctionCall' || e.name === 'ProfileChunk' || e.name === 'Profile');
console.log(`\nJS-related events: ${jsEvents.length}`);
const fnCalls = traceData.traceEvents.filter(e => e.name === 'FunctionCall');
console.log(`FunctionCall events: ${fnCalls.length}`);
const uniqueFns = new Set(fnCalls.map(e => e.args?.data?.functionName));
console.log(`Unique function names: ${[...uniqueFns].join(', ')}`);

const chunk = traceData.traceEvents.find(e => e.name === 'ProfileChunk');
if (chunk) {
  const nodes = chunk.args?.data?.cpuProfile?.nodes || [];
  const jsNodes = nodes.filter(n => n.callFrame?.codeType === 'JS');
  const uniqueProfileFns = new Set(jsNodes.map(n => n.callFrame.functionName));
  console.log(`\nProfile nodes: ${nodes.length} (${jsNodes.length} JS)`);
  console.log(`Unique profile functions: ${[...uniqueProfileFns].join(', ')}`);
}

ws.close();
process.exit(0);
