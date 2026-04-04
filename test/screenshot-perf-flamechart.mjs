import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

mkdirSync('test/screenshots', { recursive: true });

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1000 });

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
  await new Promise(r => setTimeout(r, 2000));
}

await openPanel('Performance');
await new Promise(r => setTimeout(r, 1000));

// Record
const recordButton = await page.$('[aria-label="Record"]');
if (recordButton) await recordButton.click();
else { await page.keyboard.down('Control'); await page.keyboard.press('KeyE'); await page.keyboard.up('Control'); }
await new Promise(r => setTimeout(r, 5000));
const stopButton = await page.$('[aria-label="Stop"]');
if (stopButton) await stopButton.click();
else { await page.keyboard.down('Control'); await page.keyboard.press('KeyE'); await page.keyboard.up('Control'); }

await new Promise(r => setTimeout(r, 12000));
for (let i = 0; i < 5; i++) { await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 200)); }

// Take full view
await page.screenshot({ path: 'test/screenshots/perf-flamechart-full.png' });
console.log('Full view saved');

// Click on the flame chart area to focus
await page.mouse.click(400, 200);
await new Promise(r => setTimeout(r, 500));

// Zoom in significantly with W key
for (let i = 0; i < 15; i++) {
  await page.keyboard.press('KeyW');
  await new Promise(r => setTimeout(r, 80));
}
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: 'test/screenshots/perf-flamechart-zoomed.png' });
console.log('Zoomed view saved');

// Zoom in more
for (let i = 0; i < 10; i++) {
  await page.keyboard.press('KeyW');
  await new Promise(r => setTimeout(r, 80));
}
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: 'test/screenshots/perf-flamechart-detail.png' });
console.log('Detail view saved');

// Click on a yellow bar if visible and take another screenshot
await page.mouse.click(400, 180);
await new Promise(r => setTimeout(r, 1000));
await page.screenshot({ path: 'test/screenshots/perf-flamechart-selected.png' });
console.log('Selected view saved');

// Print the summary stats
const stats = await page.evaluate(() => document.body.innerText.substring(0, 1000));
console.log('\nPage summary:', stats.substring(0, 500));

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
