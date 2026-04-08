/**
 * Open actual Chrome DevTools against the bridge target, record a Performance
 * profile with real clicks, export the trace, and analyze it from the
 * user-facing perspective.
 */
import puppeteer from 'puppeteer';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('test/traces', { recursive: true });
mkdirSync('test/screenshots', { recursive: true });

// Get the bridge target
const targets = await (await fetch('http://localhost:9221/json/list')).json();
const target = targets.find(t => t.url?.includes('google.com')) || targets[0];
console.log('Target:', target.title, '—', target.url?.substring(0, 60));

// Launch Chrome with DevTools open against the bridge target
const devtoolsUrl = `devtools://devtools/bundled/inspector.html?ws=localhost:9221/devtools/page/${encodeURIComponent(target.id)}`;
console.log('DevTools URL:', devtoolsUrl);

const browser = await puppeteer.launch({
  headless: false, // Need real browser to render DevTools
  args: [
    '--no-sandbox',
    '--window-size=1400,900',
    `--app=${devtoolsUrl}`,
  ],
  defaultViewport: null,
});

const pages = await browser.pages();
const devtools = pages[0];
await new Promise(r => setTimeout(r, 5000)); // Wait for DevTools to load

// Screenshot DevTools
await devtools.screenshot({ path: 'test/screenshots/devtools-initial.png' });
console.log('DevTools loaded, screenshot saved');

// Navigate to Performance tab
try {
  // Click on "Performance" tab
  await devtools.evaluate(() => {
    // Find the Performance tab in DevTools
    const tabs = document.querySelectorAll('[role="tab"]');
    for (const tab of tabs) {
      if (tab.textContent?.includes('Performance')) {
        tab.click();
        return 'clicked Performance tab';
      }
    }
    return 'Performance tab not found';
  });
  await new Promise(r => setTimeout(r, 2000));
  await devtools.screenshot({ path: 'test/screenshots/devtools-perf-tab.png' });
  console.log('Switched to Performance tab');
} catch (e) {
  console.log('Could not switch to Performance tab:', e.message);
}

// Use CDP to start a trace recording through DevTools
// Instead of clicking buttons, use the Tracing domain directly
const client = await devtools.createCDPSession();

// Actually, let's use the bridge's CDP directly for the recording
// Open a separate connection to the bridge target
const WebSocket = (await import('ws')).default;
const ws = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(target.id)}`);
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

let msgId = 1;
const pending = new Map();
const traceEvents = [];
ws.on('message', d => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Tracing.dataCollected') traceEvents.push(...(m.params?.value || []));
});
function send(method, params = {}) {
  const id = msgId++;
  return new Promise(resolve => {
    const t = setTimeout(() => { pending.delete(id); resolve(null); }, 30000);
    pending.set(id, msg => { clearTimeout(t); resolve(msg); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

// Start recording
console.log('\nStarting trace recording...');
await send('Tracing.start', {
  categories: '-*,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler',
});
await new Promise(r => setTimeout(r, 2000));

// Click image (OPEN)
console.log('Clicking image (OPEN)...');
const openR = await send('Runtime.evaluate', {
  expression: `document.querySelector('[data-sve] img')?.click(); 'clicked'`
});
console.log('Open:', openR?.result?.result?.value || openR?.result?.value);
await new Promise(r => setTimeout(r, 4000));

// Screenshot DevTools during recording
await devtools.screenshot({ path: 'test/screenshots/devtools-recording.png' });

// Click close
console.log('Clicking close (CLOSE)...');
const closeR = await send('Runtime.evaluate', {
  expression: `document.querySelector('[data-svs="true"] [aria-hidden="false"] [aria-label="Close"]')?.click(); 'closed'`
});
console.log('Close:', closeR?.result?.result?.value || closeR?.result?.value);
await new Promise(r => setTimeout(r, 4000));

// Stop recording
console.log('Stopping recording...');
const completePromise = new Promise(resolve => {
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.method === 'Tracing.tracingComplete') resolve();
  });
});
send('Tracing.end', {}).catch(() => {});
await Promise.race([completePromise, new Promise(r => setTimeout(r, 30000))]);

console.log(`Got ${traceEvents.length} trace events`);

// Save trace
const tracePath = 'test/traces/actual-devtools-profile.json';
writeFileSync(tracePath, JSON.stringify({ traceEvents }));
console.log(`Saved to ${tracePath}`);

// Wait for DevTools to process and show the trace
await new Promise(r => setTimeout(r, 3000));
await devtools.screenshot({ path: 'test/screenshots/devtools-trace-loaded.png' });
console.log('Screenshot of loaded trace saved');

// Now analyze
console.log('\n=== TRACE ANALYSIS ===');
const clicks = traceEvents.filter(e => e.name === 'EventDispatch' && e.args?.data?.type === 'click');
const fnCalls = traceEvents.filter(e => e.name === 'FunctionCall');
const chunks = traceEvents.filter(e => e.name === 'ProfileChunk');
const profEvts = traceEvents.filter(e => e.name === 'Profile');

console.log(`Events: ${traceEvents.length}, FunctionCalls: ${fnCalls.length}, Clicks: ${clicks.length}`);
console.log(`ProfileChunks: ${chunks.length}`);

if (chunks.length > 0 && profEvts.length > 0) {
  const cd = chunks[0].args.data;
  const nodes = cd.cpuProfile?.nodes || [];
  const samples = cd.cpuProfile?.samples || [];
  const deltas = cd.timeDeltas || [];
  const start = profEvts[0].args.data.startTime;
  const minTs = Math.min(...traceEvents.filter(e => e.ts > 0).map(e => e.ts));

  console.log(`Profile: ${nodes.length} nodes, ${samples.length} samples`);
  console.log(`Profile start: +${((start - minTs) / 1e6).toFixed(1)}s`);

  // Sample distribution
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
  let t = start;
  const buckets = {};
  for (let i = 0; i < deltas.length; i++) {
    t += deltas[i];
    const fn = nodeMap[samples[i]]?.callFrame?.functionName || '';
    if (fn && !['(root)', '(program)', '(idle)'].includes(fn)) {
      const b = Math.floor((t - minTs) / 1e6);
      buckets[b] = (buckets[b] || 0) + 1;
    }
  }
  console.log('\nSample distribution (non-idle):');
  for (const b of Object.keys(buckets).sort((a, b) => a - b)) {
    const bar = '#'.repeat(Math.min(buckets[b], 40));
    console.log(`  +${b}s: ${String(buckets[b]).padStart(3)} ${bar}`);
  }

  // Check depth at clicks
  if (clicks.length > 0) {
    for (let ci = 0; ci < Math.min(clicks.length, 3); ci++) {
      const click = clicks[ci];
      t = start;
      let found = 0;
      for (let i = 0; i < samples.length; i++) {
        t += deltas[i];
        if (Math.abs(t - click.ts) < 200000) {
          let nid = samples[i];
          let depth = 0;
          const seen = new Set();
          while (nid && nodeMap[nid] && !seen.has(nid)) {
            seen.add(nid);
            depth++;
            nid = nodeMap[nid].parent;
          }
          if (depth > 2) found++;
        }
      }
      console.log(`\nClick ${ci} at +${((click.ts - minTs) / 1e6).toFixed(1)}s: ${found} deep samples within 200ms`);
    }
  }
}

// Check CompositeLayers
const bigComposites = traceEvents.filter(e => e.name === 'CompositeLayers' && e.dur > 10000);
console.log(`\nCompositeLayers >10ms: ${bigComposites.length}`);

// Named FunctionCalls
const named = fnCalls.filter(e => e.args?.data?.functionName);
console.log(`FunctionCalls named: ${named.length}/${fnCalls.length} (${Math.round(100 * named.length / fnCalls.length)}%)`);

ws.close();
await browser.close();
process.exit(0);
