// Debug: compare raw WebKit profiler timestamps vs smoothed output
import WebSocket from 'ws';

const targets = await (await fetch('http://localhost:9221/json/list')).json();
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
  return new Promise(resolve => { pending.set(reqId, resolve); ws.send(JSON.stringify({ id: reqId, method, params })); });
}

await new Promise(r => ws.on('open', r));
await send('Runtime.enable');

// Generate JS work
for (let i = 0; i < 3; i++) {
  await send('Runtime.evaluate', { expression: `
    function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }
    fib(22); "done"
  ` });
}

// Start trace
events.length = 0;
await send('Tracing.start', { categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler' });

// Generate work during trace with delays between bursts
for (let i = 0; i < 3; i++) {
  await send('Runtime.evaluate', { expression: `
    function fib(n) { return n <= 1 ? n : fib(n-1) + fib(n-2); }
    function heavy() { fib(24); }
    heavy(); "burst ${i}"
  ` });
  await new Promise(r => setTimeout(r, 500)); // 500ms gap between bursts
}

await new Promise(r => setTimeout(r, 1000));
await send('Tracing.end');
await new Promise(r => setTimeout(r, 5000));

const dataEvent = events.find(e => e.method === 'Tracing.dataCollected');
if (!dataEvent) { console.error('No trace data!'); process.exit(1); }

const traceEvents = dataEvent.params.value;
const chunk = traceEvents.find(e => e.name === 'ProfileChunk');
const profile = traceEvents.find(e => e.name === 'Profile');

if (!chunk) { console.error('No ProfileChunk!'); process.exit(1); }

const cp = chunk.args.data.cpuProfile;
const td = chunk.args.data.timeDeltas;

console.log(`Profile startTime: ${profile.args.data.startTime}μs`);
console.log(`Samples: ${cp.samples.length}, TimeDeltas: ${td.length}`);
console.log(`Total duration: ${td.reduce((a, b) => a + b, 0)}μs = ${(td.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}ms`);

// Show the timeDelta distribution
const nonZero = td.filter(d => d > 0);
const zeros = td.filter(d => d === 0);
console.log(`\nTimeDelta distribution:`);
console.log(`  Non-zero: ${nonZero.length}, avg: ${nonZero.length ? Math.round(nonZero.reduce((a,b)=>a+b,0)/nonZero.length) : 0}μs`);
console.log(`  Zeros: ${zeros.length}`);
console.log(`  Min non-zero: ${Math.min(...nonZero)}μs, Max: ${Math.max(...nonZero)}μs`);

// Show first 30 timeDeltas with sample function names
const nodeMap = new Map(cp.nodes.map(n => [n.id, n]));
console.log(`\nFirst 30 samples with deltas:`);
let runningTime = 0;
for (let i = 0; i < Math.min(30, cp.samples.length); i++) {
  const node = nodeMap.get(cp.samples[i]);
  const fn = node?.callFrame?.functionName || '?';
  const delta = td[i];
  runningTime += delta;
  console.log(`  [${i}] +${delta}μs (${(runningTime/1000).toFixed(1)}ms) → ${fn}`);
}

// Check FunctionCall events timing
const fnCalls = traceEvents.filter(e => e.name === 'FunctionCall');
console.log(`\nFunctionCall events: ${fnCalls.length}`);
const heavyCalls = fnCalls.filter(e => e.args?.data?.functionName === 'heavy');
console.log(`heavy() calls: ${heavyCalls.length}`);
for (const fc of heavyCalls) {
  const relTs = (fc.ts - profile.args.data.startTime) / 1000;
  console.log(`  at ${relTs.toFixed(0)}ms, dur=${(fc.dur/1000).toFixed(1)}ms`);
}

// Total recording duration
const runTask = traceEvents.find(e => e.name === 'RunTask');
if (runTask) {
  console.log(`\nRunTask duration: ${(runTask.dur/1000).toFixed(0)}ms`);
}

ws.close();
process.exit(0);
