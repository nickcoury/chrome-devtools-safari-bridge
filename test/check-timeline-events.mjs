// Check what event types WebKit's Timeline provides during recording
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
  const i = id++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
    pending.set(i, (msg) => { clearTimeout(timeout); resolve(msg); });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

await new Promise(r => ws.on('open', r));
await send('Runtime.enable');

// Start tracing
events.length = 0;
console.log('Starting trace...');
await send('Tracing.start', {});

// Generate JS work
for (let i = 0; i < 3; i++) {
  await send('Runtime.evaluate', { expression: `function fib(n){return n<=1?n:fib(n-1)+fib(n-2)} fib(22); "done"` });
  await new Promise(r => setTimeout(r, 300));
}
await new Promise(r => setTimeout(r, 1000));

console.log('Stopping trace...');
await send('Tracing.end');
await new Promise(r => setTimeout(r, 5000));

const dataEvent = events.find(e => e.method === 'Tracing.dataCollected');
if (!dataEvent) { console.log('No trace data!'); ws.close(); process.exit(1); }

const traceEvents = dataEvent.params.value;
console.log(`\nTotal trace events: ${traceEvents.length}`);

// Categorize
const categories = {};
for (const evt of traceEvents) {
  const key = `${evt.name}`;
  categories[key] = (categories[key] || 0) + 1;
}
console.log('\nEvent names (from WebKit Timeline + our synthesis):');
for (const [key, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${key}: ${count}`);
}

// Check specifically for FunctionCall events — are they from Timeline or synthesis?
const fnCalls = traceEvents.filter(e => e.name === 'FunctionCall');
console.log(`\nFunctionCall events: ${fnCalls.length}`);
if (fnCalls.length > 0) {
  // Check if any have URL (Timeline-sourced) vs empty URL (synthesis-sourced)
  const withUrl = fnCalls.filter(e => e.args?.data?.url);
  const withoutUrl = fnCalls.filter(e => !e.args?.data?.url);
  console.log(`  With URL (from Timeline): ${withUrl.length}`);
  console.log(`  Without URL (synthesized): ${withoutUrl.length}`);

  // Show a few Timeline-sourced ones
  for (const fc of withUrl.slice(0, 5)) {
    console.log(`    ${fc.args.data.functionName || '?'} @ ${fc.args.data.url?.substring(0, 40)} dur=${(fc.dur/1000).toFixed(1)}ms`);
  }
}

// Check for EvaluateScript events
const evalScript = traceEvents.filter(e => e.name === 'EvaluateScript');
console.log(`\nEvaluateScript events: ${evalScript.length}`);
for (const es of evalScript.slice(0, 3)) {
  console.log(`  dur=${(es.dur/1000).toFixed(1)}ms url=${es.args?.data?.url?.substring(0, 40) || '?'}`);
}

ws.close();
process.exit(0);
