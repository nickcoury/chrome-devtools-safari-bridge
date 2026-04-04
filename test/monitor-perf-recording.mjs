/**
 * Monitor what CDP commands DevTools sends when starting a Performance recording.
 * Opens DevTools, clicks Record, captures all CDP messages for 15s.
 */
import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const targets = await (await fetch('http://localhost:9221/json/list')).json();
const log = [];

// Connect a WebSocket to spy on CDP traffic
const spy = new WebSocket('ws://localhost:9221/devtools/page/' + encodeURIComponent(targets[0].id));
spy.on('message', d => {
  const msg = JSON.parse(d);
  if (msg.method) log.push(`← EVENT ${msg.method}`);
});
spy.on('open', () => log.push('SPY: connected'));

// Also launch Puppeteer DevTools
const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 2000, height: 1000 });
await page.goto('devtools://devtools/bundled/inspector.html?ws=localhost:9221/devtools/page/' + encodeURIComponent(targets[0].id), { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 10000));

// Switch to Performance panel
await page.keyboard.press('Escape');
await new Promise(r => setTimeout(r, 300));
await page.keyboard.down('Meta');
await page.keyboard.down('Shift');
await page.keyboard.press('KeyP');
await page.keyboard.up('Shift');
await page.keyboard.up('Meta');
await new Promise(r => setTimeout(r, 500));
await page.keyboard.type('Performance', { delay: 30 });
await new Promise(r => setTimeout(r, 500));
await page.keyboard.press('Enter');
await new Promise(r => setTimeout(r, 3000));

log.push('=== CLICKING RECORD ===');

// Click Record button
const clicked = await page.evaluate(() => {
  function deepFind(root, depth = 0) {
    if (depth > 20) return null;
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      const label = (el.getAttribute('aria-label') || el.title || '').toLowerCase();
      if (label.includes('record')) { el.click(); return label; }
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const f = deepFind(el.shadowRoot, depth+1); if (f) return f; }
    }
    return null;
  }
  return deepFind(document);
});
log.push(`Record clicked: ${clicked}`);

// Monitor for 15s
await new Promise(r => setTimeout(r, 15000));

// Save log
writeFileSync('/tmp/perf-monitor.log', log.join('\n'));
console.log('Captured', log.length, 'events');
console.log(log.filter(l => l.includes('Tracing') || l.includes('RECORD') || l.includes('Profiler') || l.includes('Timeline')).join('\n'));

spy.close();
try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
