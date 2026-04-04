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

// Dump the ENTIRE drawer DOM tree
const drawerDom = await page.evaluate(() => {
  // Find the animations panel container (should be in drawer)
  const drawer = document.querySelector('[class*="drawer"]') ||
    document.querySelector('.tabbed-pane[aria-label="Drawer"]');

  const walk = (el, depth = 0) => {
    if (depth > 6) return '';
    const r = el.getBoundingClientRect();
    const indent = '  '.repeat(depth);
    let line = `${indent}<${el.tagName.toLowerCase()}`;
    if (el.className) line += ` class="${String(el.className).substring(0, 60)}"`;
    if (el.id) line += ` id="${el.id}"`;
    const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3 ? el.textContent.substring(0, 40) : '';
    line += ` rect="${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}"`;
    if (text) line += ` text="${text}"`;
    line += '>';
    let result = line + '\n';
    for (const child of el.children) {
      result += walk(child, depth + 1);
    }
    return result;
  };

  // Find parent of the animations panel
  const animTimeline = document.querySelector('.animations-timeline');
  if (animTimeline) {
    // Walk up to find container
    let container = animTimeline;
    for (let i = 0; i < 3; i++) { if (container.parentElement) container = container.parentElement; }
    return walk(container, 0);
  }

  return 'No .animations-timeline found';
});

console.log('Drawer DOM:\n' + drawerDom);

await page.screenshot({ path: 'test/screenshots/anim-result.png' });

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
