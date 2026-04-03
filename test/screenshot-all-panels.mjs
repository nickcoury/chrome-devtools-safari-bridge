import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

mkdirSync('test/screenshots', { recursive: true });

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 2000, height: 1000 });
await page.goto('devtools://devtools/bundled/inspector.html?ws=localhost:9221/devtools/page/' + encodeURIComponent(targets[0].id), { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 10000));

async function switchAndScreenshot(name) {
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
  const fname = name.toLowerCase().replace(/\s+/g, '-');
  await page.screenshot({ path: `test/screenshots/panel-${fname}.png` });
  console.log(`  ${name} → panel-${fname}.png`);
}

const panels = [
  'Elements', 'Console', 'Sources', 'Network',
  'Performance', 'Application',
  'Animations',   // Note: not "Animation" — DevTools uses "Animations"
];

console.log('Screenshotting panels...');
for (const panel of panels) {
  await switchAndScreenshot(panel);
}

try { browser.process()?.kill('SIGKILL'); } catch {}
console.log('Done!');
process.exit(0);
