import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

mkdirSync('test/screenshots/harden', { recursive: true });

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }
console.log('Target:', targets[0].title);

const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1000 });

// Use devtools_app for full-width Performance panel
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

console.log('Opening Performance panel...');
await openPanel('Performance');
await new Promise(r => setTimeout(r, 1000));

// Record for 3 seconds
console.log('Starting recording...');
const recordButton = await page.$('[aria-label="Record"]');
if (recordButton) await recordButton.click();
else { await page.keyboard.down('Control'); await page.keyboard.press('KeyE'); await page.keyboard.up('Control'); }
await new Promise(r => setTimeout(r, 3000));

console.log('Stopping...');
const stopButton = await page.$('[aria-label="Stop"]');
if (stopButton) await stopButton.click();
else { await page.keyboard.down('Control'); await page.keyboard.press('KeyE'); await page.keyboard.up('Control'); }

console.log('Waiting for trace...');
await new Promise(r => setTimeout(r, 12000));

// Dismiss dialogs
for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await new Promise(r => setTimeout(r, 200)); }

// Get summary stats
const stats = await page.evaluate(() => document.body.innerText.substring(0, 500));
console.log('\nPerformance summary:', stats.substring(0, 300));

await page.screenshot({ path: 'test/screenshots/harden/perf-recording.png' });
console.log('Saved perf-recording.png');

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
