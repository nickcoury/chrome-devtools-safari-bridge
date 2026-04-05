import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

mkdirSync('test/screenshots', { recursive: true });

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1200 });

const wsUrl = 'devtools://devtools/bundled/devtools_app.html?ws=localhost:9221/devtools/page/' + encodeURIComponent(targets[0].id);
await page.goto(wsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 10000));

async function openPanel(name) {
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyP');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  await new Promise(r => setTimeout(r, 500));
  await page.keyboard.type(name, { delay: 30 });
  await new Promise(r => setTimeout(r, 800));
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 3000));
}

console.log('Opening Animations panel...');
await openPanel('Animations');
await new Promise(r => setTimeout(r, 8000));

// Check shadow DOM for previews and try to click one
const previewInfo = await page.evaluate(() => {
  const timeline = document.querySelector('.animations-timeline');
  if (!timeline?.shadowRoot) return { error: 'no shadow root' };
  const shadow = timeline.shadowRoot;

  const buffer = shadow.querySelector('.animation-timeline-buffer');
  const previews = shadow.querySelectorAll('.preview-ui-container');
  const rows = shadow.querySelector('.animation-timeline-rows');

  return {
    bufferChildren: buffer?.children.length,
    previewCount: previews.length,
    rowsChildren: rows?.children.length,
    rowsRect: rows ? (() => { const r = rows.getBoundingClientRect(); return `${r.x},${r.y} ${r.width}x${r.height}`; })() : 'none',
  };
});
console.log('Before click:', JSON.stringify(previewInfo));

// Click on the preview button inside shadow DOM
const clicked = await page.evaluate(() => {
  const timeline = document.querySelector('.animations-timeline');
  if (!timeline?.shadowRoot) return false;
  const btn = timeline.shadowRoot.querySelector('.animation-buffer-preview');
  if (btn) { btn.click(); return true; }
  return false;
});
console.log('Clicked preview:', clicked);

await new Promise(r => setTimeout(r, 3000));

// Check after clicking
const afterClick = await page.evaluate(() => {
  const timeline = document.querySelector('.animations-timeline');
  if (!timeline?.shadowRoot) return { error: 'no shadow root' };
  const shadow = timeline.shadowRoot;

  const rows = shadow.querySelector('.animation-timeline-rows');
  const nodeRows = shadow.querySelectorAll('.animation-node-row');
  const scrubber = shadow.querySelector('.animation-scrubber');
  const header = shadow.querySelector('.animation-timeline-header');

  return {
    rowsChildren: rows?.children.length,
    rowsHTML: rows?.innerHTML?.substring(0, 300),
    nodeRowCount: nodeRows.length,
    scrubberVisible: scrubber ? !scrubber.classList.contains('hidden') : false,
    headerRect: header ? (() => { const r = header.getBoundingClientRect(); return `${r.x},${r.y} ${r.width}x${r.height}`; })() : 'none',
  };
});
console.log('After click:', JSON.stringify(afterClick));

await page.screenshot({ path: 'test/screenshots/anim-result.png' });
console.log('Done!');

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
