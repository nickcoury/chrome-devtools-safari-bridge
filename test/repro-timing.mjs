// Reproduce: profiler timing is wrong — JS calls appear to span 4-7 seconds
// Record a trace with known idle + burst pattern and check the output
import WebSocket from 'ws';

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
  const i = id++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
    pending.set(i, (msg) => { clearTimeout(timeout); resolve(msg); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

await new Promise(r => ws.on('open', r));
await send('Runtime.enable');

// Start trace
events.length = 0;
console.log('Starting trace...');
await send('Tracing.start', {});

// Pattern: 200ms burst, 2s idle, 200ms burst, 2s idle
console.log('Burst 1 (fib)...');
await send('Runtime.evaluate', { expression: 'function fib(n){return n<=1?n:fib(n-1)+fib(n-2)} fib(25); "done"' });
console.log('Idle 2s...');
await new Promise(r => setTimeout(r, 2000));
console.log('Burst 2 (fib)...');
await send('Runtime.evaluate', { expression: 'function fib(n){return n<=1?n:fib(n-1)+fib(n-2)} fib(25); "done"' });
console.log('Idle 2s...');
await new Promise(r => setTimeout(r, 2000));

console.log('Stopping trace...');
await send('Tracing.end');
await new Promise(r => setTimeout(r, 5000));

const dataEvent = events.find(e => e.method === 'Tracing.dataCollected');
if (!dataEvent) { console.log('No trace data!'); ws.close(); process.exit(1); }

const traceEvents = dataEvent.params.value;
const chunk = traceEvents.find(e => e.name === 'ProfileChunk');
if (!chunk) { console.log('No ProfileChunk!'); ws.close(); process.exit(1); }

const cp = chunk.args.data.cpuProfile;
const td = chunk.args.data.timeDeltas;
const nodeMap = new Map(cp.nodes.map(n => [n.id, n]));

console.log(`\nSamples: ${cp.samples.length}, TimeDeltas: ${td.length}`);
const totalUs = td.reduce((a, b) => a + b, 0);
console.log(`Total time from deltas: ${(totalUs/1e6).toFixed(2)}s`);

// Analyze the raw timeDelta distribution
const zeros = td.filter(d => d === 0).length;
const nonZero = td.filter(d => d > 0);
console.log(`Zeros: ${zeros}, Non-zero: ${nonZero.length}`);
if (nonZero.length > 0) {
  console.log(`Non-zero range: ${Math.min(...nonZero)}μs — ${Math.max(...nonZero)}μs`);
  console.log(`Non-zero avg: ${Math.round(nonZero.reduce((a,b)=>a+b,0)/nonZero.length)}μs`);
}

// Show timeline: when does each sample occur relative to start?
console.log(`\nSample timeline (relative to start):`);
let runningUs = 0;
let lastBurstEnd = 0;
let inBurst = false;
for (let i = 0; i < cp.samples.length; i++) {
  const node = nodeMap.get(cp.samples[i]);
  const fn = node?.callFrame?.functionName || '?';
  const delta = td[i];
  runningUs += delta;

  const isJS = fn !== '(root)' && fn !== '(program)' && fn !== '(idle)';
  if (isJS && !inBurst) {
    console.log(`  BURST START at ${(runningUs/1e6).toFixed(3)}s: ${fn}`);
    inBurst = true;
  } else if (!isJS && inBurst) {
    console.log(`  BURST END at ${(runningUs/1e6).toFixed(3)}s (gap from last: ${((runningUs - lastBurstEnd)/1e6).toFixed(3)}s)`);
    lastBurstEnd = runningUs;
    inBurst = false;
  }
}
if (inBurst) console.log(`  BURST END at ${(runningUs/1e6).toFixed(3)}s`);

// Show FunctionCall events
const fnCalls = traceEvents.filter(e => e.name === 'FunctionCall');
const profile = traceEvents.find(e => e.name === 'Profile');
console.log(`\nFunctionCall events: ${fnCalls.length}`);
for (const fc of fnCalls) {
  const relMs = (fc.ts - profile.args.data.startTime) / 1000;
  console.log(`  ${fc.args.data.functionName} at ${relMs.toFixed(0)}ms dur=${(fc.dur/1000).toFixed(1)}ms`);
}

ws.close();
process.exit(0);
