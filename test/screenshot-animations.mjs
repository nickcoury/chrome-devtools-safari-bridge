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
// Wait for poll to re-emit animations with correct body nodeId
await new Promise(r => setTimeout(r, 8000));

// Check panel state
const panelInfo = await page.evaluate(() => {
  const panel = document.querySelector('.animations-timeline');
  if (!panel) return { error: 'no panel' };
  const children = [];
  for (const el of panel.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 5 && r.height > 5 && el.className) {
      children.push({ class: el.className.substring(0, 60), rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` });
    }
  }
  return { childCount: panel.children.length, innerText: panel.innerText.substring(0, 200), elements: children.slice(0, 20) };
});
console.log('Panel info:', JSON.stringify(panelInfo, null, 2));

await page.screenshot({ path: 'test/screenshots/anim-result.png' });
console.log('Saved anim-result.png');

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
