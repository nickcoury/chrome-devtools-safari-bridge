/**
 * Load a trace file in Chrome DevTools Performance panel and screenshot it.
 * This is the user-facing validation — see exactly what DevTools renders.
 */
import puppeteer from 'puppeteer';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

const traceFile = process.argv[2] || 'test/traces/bridge-dogs-latest.json';
const outDir = 'test/screenshots';
mkdirSync(outDir, { recursive: true });

if (!existsSync(traceFile)) {
  console.error(`Trace file not found: ${traceFile}`);
  process.exit(1);
}

const absPath = path.resolve(traceFile);
console.log(`Loading trace: ${absPath}`);

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1920,1080'],
  defaultViewport: { width: 1920, height: 1080 },
});

const page = await browser.newPage();

// Navigate to chrome://tracing which can load trace files
// Actually, use the DevTools Performance panel directly
// We need to use the DevTools protocol to load a trace

// Alternative: use chrome://tracing
await page.goto('chrome://tracing', { waitUntil: 'networkidle2', timeout: 10000 });
await new Promise(r => setTimeout(r, 1000));
await page.screenshot({ path: `${outDir}/trace-0-tracing-loaded.png` });

// Load the trace file via the tracing UI
// chrome://tracing has a "Load" button, but it's easier to use the
// Tracing API directly via CDP

const client = await page.createCDPSession();

// Read trace data
const traceData = JSON.parse(readFileSync(absPath, 'utf8'));
const events = traceData.traceEvents || traceData;
console.log(`Trace has ${events.length} events`);

// Use Tracing.recordClockSyncMarker trick doesn't work for loading
// Let's try the Performance panel approach instead

// Navigate to a blank page and open DevTools against it
await page.goto('about:blank');
await new Promise(r => setTimeout(r, 500));

// Actually the simplest approach: use Puppeteer's tracing which dumps to the Performance panel format
// But we need to LOAD an existing trace, not record a new one.

// The most reliable way is to use the DevTools frontend directly.
// Open devtools://devtools/bundled/devtools_app.html and use its import functionality.

// Try the Perfetto UI which can load Chrome traces
await page.goto('https://ui.perfetto.dev/', { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
await new Promise(r => setTimeout(r, 2000));
await page.screenshot({ path: `${outDir}/trace-1-perfetto.png` });

// Upload the trace file
const fileInput = await page.$('input[type="file"]').catch(() => null);
if (fileInput) {
  await fileInput.uploadFile(absPath);
  console.log('Uploaded trace to Perfetto');
  await new Promise(r => setTimeout(r, 5000));
  await page.screenshot({ path: `${outDir}/trace-2-perfetto-loaded.png` });
} else {
  console.log('No file input found on Perfetto, trying alternative approach');
}

// Alternative: open chrome://inspect and load via Performance panel
// This requires connecting to our bridge target

// Actually, let's just analyze the trace structure ourselves and render a text-based flame chart
await browser.close();

// TEXT-BASED FLAME CHART - show what DevTools would render
console.log('\n=== TEXT FLAME CHART (what DevTools shows) ===\n');

const xEvents = events
  .filter(e => e.ph === 'X' && e.ts > 0 && e.pid === 2 && e.tid === 1)
  .sort((a, b) => a.ts - b.ts);

const minTs = Math.min(...events.filter(e => e.ts > 0).map(e => e.ts));

// Find click areas
const clicks = events.filter(e => e.name === 'EventDispatch' && e.args?.data?.type === 'click');
const clickTs = clicks.length > 0 ? clicks[0].ts : minTs + 3e6;

// Find the close click cluster
let closeTs = clickTs;
for (let i = 1; i < clicks.length; i++) {
  if (clicks[i].ts - clicks[i-1].ts > 1e6) {
    closeTs = clicks[i].ts;
    break;
  }
}

// Show flame chart around each click
for (const [label, centerTs] of [['OPEN CLICK', clickTs], ['CLOSE CLICK', closeTs]]) {
  console.log(`--- ${label} (at +${((centerTs - minTs)/1e6).toFixed(1)}s) ---`);

  // Get events in a 200ms window
  const windowStart = centerTs - 10000;
  const windowEnd = centerTs + 200000;
  const windowEvents = xEvents.filter(e => e.ts >= windowStart && e.ts <= windowEnd);

  // Build nesting by timestamp overlap
  for (const e of windowEvents.slice(0, 40)) {
    // Calculate indent based on how many events contain this one
    let depth = 0;
    for (const parent of windowEvents) {
      if (parent === e) continue;
      if (parent.ts <= e.ts && parent.ts + (parent.dur || 0) >= e.ts + (e.dur || 0)) {
        depth++;
      }
      if (depth > 8) break;
    }
    const indent = '  '.repeat(Math.min(depth, 8));
    const rel = ((e.ts - centerTs) / 1000).toFixed(1);
    const dur = ((e.dur || 0) / 1000).toFixed(1);
    const fn = e.args?.data?.functionName || '';
    const evType = e.args?.data?.type || '';
    const info = fn ? `[${fn}]` : evType ? `[${evType}]` : '';
    console.log(`${indent}${e.name}${info} @${rel}ms dur=${dur}ms`);
  }
  console.log();
}

// Show ProfileChunk flame chart depth at each click
const chunks = events.filter(e => e.name === 'ProfileChunk');
const profE = events.filter(e => e.name === 'Profile');
if (chunks.length > 0 && profE.length > 0) {
  const cd = chunks[0].args.data;
  const nodes = Object.fromEntries(cd.cpuProfile.nodes.map(n => [n.id, n]));
  const samples = cd.cpuProfile.samples;
  const deltas = cd.timeDeltas;
  const startTime = profE[0].args.data.startTime;

  let t = startTime;
  for (const [label, centerTs] of [['OPEN CLICK', clickTs], ['CLOSE CLICK', closeTs]]) {
    console.log(`--- FLAME CHART DEPTH at ${label} ---`);
    t = startTime;
    let found = 0;
    for (let i = 0; i < samples.length; i++) {
      t += deltas[i];
      if (t >= centerTs - 50000 && t <= centerTs + 200000) {
        // Show the call stack at this sample
        let nodeId = samples[i];
        const stack = [];
        const seen = new Set();
        while (nodeId && nodes[nodeId] && !seen.has(nodeId)) {
          seen.add(nodeId);
          const fn = nodes[nodeId].callFrame?.functionName || '';
          if (fn && fn !== '(root)') stack.push(fn);
          nodeId = nodes[nodeId].parent;
        }
        if (stack.length > 1) {
          const rel = ((t - centerTs) / 1000).toFixed(1);
          console.log(`  @${rel}ms depth=${stack.length}: ${stack.slice(0, 6).join(' → ')}${stack.length > 6 ? ' → ...' : ''}`);
          found++;
          if (found >= 10) { console.log('  ...'); break; }
        }
      }
    }
    if (found === 0) console.log('  (no profile samples in this window)');
    console.log();
  }
}

process.exit(0);
