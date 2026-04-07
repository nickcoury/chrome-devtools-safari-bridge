/**
 * Compare Chrome vs Safari bridge traces for Google Images dog query.
 *
 * This script:
 * 1. Connects to the bridge on the iPhone
 * 2. Navigates to Google Images "dog images"
 * 3. Starts a Performance recording
 * 4. Clicks an image to open it (waits 3s)
 * 5. Clicks close (waits 3s)
 * 6. Stops recording and exports the trace
 * 7. Analyzes the trace and compares with Chrome baseline
 */

import WebSocket from 'ws';
import { writeFileSync, readFileSync } from 'fs';
import { gzipSync, gunzipSync } from 'zlib';

// --- Config ---
const BRIDGE_URL = 'http://localhost:9221';
const WAIT_AFTER_NAV = 6000;
const WAIT_AFTER_CLICK = 4000;
const RECORDING_SETTLE = 2000;

// --- Helper ---
function createCDP(ws) {
  let msgId = 1;
  const pending = new Map();
  const eventHandlers = [];

  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method) {
      for (const h of eventHandlers) h(msg.method, msg.params);
    }
  });

  return {
    send(method, params = {}) {
      const id = msgId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout`)); }, 30000);
        pending.set(id, msg => { clearTimeout(timeout); resolve(msg); });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(handler) { eventHandlers.push(handler); },
  };
}

// --- Main ---
console.log('Connecting to bridge...');
const targets = await (await fetch(`${BRIDGE_URL}/json/list`)).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }
console.log('Target:', targets[0].title, '—', targets[0].url?.substring(0, 80));

const ws = new WebSocket(`${BRIDGE_URL}/devtools/page/${encodeURIComponent(targets[0].id)}`);
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
const cdp = createCDP(ws);

// Collect trace events
const traceEvents = [];
cdp.on((method, params) => {
  if (method === 'Tracing.dataCollected') {
    traceEvents.push(...(params.value || []));
  }
});

// 1. Navigate to Google Images (uses Page.navigate which keeps the same target)
console.log('\n1. Navigating to Google Images...');
try {
  // Page.navigate may not return a response on Safari, so race with a timeout
  await Promise.race([
    cdp.send('Page.navigate', { url: 'https://www.google.com/search?q=dog+images&udm=2' }),
    new Promise(r => setTimeout(r, 5000)),
  ]);
} catch (e) {
  console.log('   Page.navigate error (may be normal):', e.message);
}
console.log('   Waiting for page to load...');
await new Promise(r => setTimeout(r, WAIT_AFTER_NAV));

// 2. Start Performance recording
console.log('\n2. Starting Performance recording...');
await cdp.send('Tracing.start', {
  categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler',
  options: '',
});
await new Promise(r => setTimeout(r, RECORDING_SETTLE));
console.log('   Recording started.');

// 3. Click first image (OPEN)
console.log('\n3. Clicking first image (OPEN)...');
const openResult = await cdp.send('Runtime.evaluate', {
  expression: `
    const img = document.querySelector('[data-sve] img');
    if (img) { img.click(); 'opened: ' + (img.alt || img.src?.substring(0, 40)); }
    else { 'no image found'; }
  `,
});
console.log('   Open result:', openResult?.result?.result?.value || openResult?.result?.value || 'unknown');
await new Promise(r => setTimeout(r, WAIT_AFTER_CLICK));

// 4. Click close button (CLOSE)
console.log('\n4. Clicking close button (CLOSE)...');
const closeResult = await cdp.send('Runtime.evaluate', {
  expression: `
    const closeBtn = document.querySelector('[data-svs="true"] [aria-hidden="false"] [aria-label="Close"]');
    if (closeBtn) { closeBtn.click(); 'closed'; }
    else { 'no close button found'; }
  `,
});
console.log('   Close result:', closeResult?.result?.result?.value || closeResult?.result?.value || 'unknown');
await new Promise(r => setTimeout(r, WAIT_AFTER_CLICK));

// 5. Stop recording
console.log('\n5. Stopping recording...');
const endPromise = new Promise(resolve => {
  cdp.on((method) => { if (method === 'Tracing.tracingComplete') resolve(); });
});
// Tracing.end is async — don't wait for response, wait for tracingComplete event
cdp.send('Tracing.end', {}).catch(() => {});
await Promise.race([endPromise, new Promise(r => setTimeout(r, 30000))]);
console.log('   Recording stopped. Got', traceEvents.length, 'trace events.');

// 6. Save trace
const tracePath = 'test/traces/bridge-dogs-latest.json';
const traceGzPath = 'test/traces/bridge-dogs-latest.json.gz';
try {
  const { mkdirSync } = await import('fs');
  mkdirSync('test/traces', { recursive: true });
} catch {}
writeFileSync(tracePath, JSON.stringify({ traceEvents }));
writeFileSync(traceGzPath, gzipSync(JSON.stringify({ traceEvents })));
console.log(`   Saved to ${tracePath} (${traceEvents.length} events)`);

// 7. Analyze
console.log('\n=== BRIDGE TRACE ANALYSIS ===\n');
analyzeTrace(traceEvents, 'Bridge');

// Compare with Chrome if available
try {
  const chromeData = JSON.parse(gunzipSync(readFileSync('Trace-20260407T111552.json.gz')).toString());
  const chromeEvents = chromeData.traceEvents || chromeData;
  console.log('\n=== CHROME TRACE ANALYSIS ===\n');
  analyzeTrace(chromeEvents, 'Chrome');
} catch (e) {
  console.log('Chrome trace not found for comparison:', e.message);
}

ws.close();
process.exit(0);

function analyzeTrace(events, label) {
  const clicks = events.filter(e => e.name === 'EventDispatch' && e.args?.data?.type === 'click');
  const fnCalls = events.filter(e => e.name === 'FunctionCall');
  const profileChunks = events.filter(e => e.name === 'ProfileChunk');
  const runTasks = events.filter(e => e.name === 'RunTask');

  console.log(`[${label}] Total events: ${events.length}`);
  console.log(`[${label}] FunctionCall: ${fnCalls.length}`);
  console.log(`[${label}] ProfileChunk: ${profileChunks.length}`);
  console.log(`[${label}] RunTask: ${runTasks.length}`);
  console.log(`[${label}] Click events: ${clicks.length}`);

  // Profile analysis
  const allNodes = {};
  let allSamples = [];
  let allDeltas = [];
  for (const chunk of profileChunks) {
    const cd = chunk.args?.data || {};
    for (const n of cd.cpuProfile?.nodes || []) allNodes[n.id] = n;
    allSamples.push(...(cd.cpuProfile?.samples || []));
    allDeltas.push(...(cd.timeDeltas || []));
  }
  console.log(`[${label}] Profile nodes: ${Object.keys(allNodes).length}`);
  console.log(`[${label}] Profile samples: ${allSamples.length}`);

  // Max depth
  function getDepth(nodeId) {
    let d = 0, nid = nodeId, seen = new Set();
    while (allNodes[nid] && !seen.has(nid)) { seen.add(nid); d++; nid = allNodes[nid].parent; }
    return d;
  }
  let maxDepth = 0;
  for (const nid of Object.keys(allNodes)) {
    const d = getDepth(Number(nid));
    if (d > maxDepth) maxDepth = d;
  }
  console.log(`[${label}] Max profile depth: ${maxDepth}`);

  // TimeDelta stats
  if (allDeltas.length) {
    const nonZero = allDeltas.filter(d => d > 0);
    if (nonZero.length) {
      console.log(`[${label}] TimeDelta: min=${Math.min(...nonZero)}μs, max=${Math.max(...nonZero)}μs, mean=${Math.round(nonZero.reduce((a,b)=>a+b,0)/nonZero.length)}μs`);
    }
    console.log(`[${label}] Zero deltas: ${allDeltas.length - nonZero.length}/${allDeltas.length}`);
  }

  // Click analysis
  for (let ci = 0; ci < clicks.length; ci++) {
    const click = clicks[ci];
    const ts = click.ts;
    const dur = click.dur || 0;
    console.log(`\n[${label}] Click ${ci} (${ci === 0 ? 'OPEN' : 'CLOSE'}): dur=${(dur/1000).toFixed(1)}ms`);

    const windowFns = fnCalls.filter(e => e.ts >= ts && e.ts <= ts + 1000000).sort((a,b) => a.ts - b.ts);
    console.log(`  FunctionCalls in 1s: ${windowFns.length}`);

    const fnNames = new Set();
    for (const fn of windowFns) {
      const n = fn.args?.data?.functionName;
      if (n) fnNames.add(n);
    }
    console.log(`  Unique fn names: ${fnNames.size}`);
    if (fnNames.size) {
      for (const n of [...fnNames].sort().slice(0, 15)) console.log(`    ${n}`);
    }

    const durations = windowFns.map(e => (e.dur || 0) / 1000);
    if (durations.length) {
      console.log(`  Duration range: ${Math.min(...durations).toFixed(1)}ms - ${Math.max(...durations).toFixed(1)}ms`);
    }
  }
}
