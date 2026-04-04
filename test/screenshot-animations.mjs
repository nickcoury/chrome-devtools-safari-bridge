import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';
import WebSocket from 'ws';

mkdirSync('test/screenshots', { recursive: true });

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

// Navigate the phone to the animation fixture page via CDP
const cdpWs = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(targets[0].id)}`);
await new Promise(r => cdpWs.on('open', r));
let msgId = 1;
function sendCDP(method, params = {}) {
  const i = msgId++;
  return new Promise(resolve => {
    const h = data => { const m = JSON.parse(data); if (m.id === i) { cdpWs.off('message', h); resolve(m); } };
    cdpWs.on('message', h);
    cdpWs.send(JSON.stringify({ id: i, method, params }));
  });
}
console.log('Navigating to animation page...');
await sendCDP('Page.navigate', { url: `http://192.168.1.111:9221/__pages/animation.html` });
await new Promise(r => setTimeout(r, 3000));
cdpWs.close();

// Now open DevTools
const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1000 });

// Refresh targets after navigation
const newTargets = await (await fetch('http://localhost:9221/json/list')).json();
const wsUrl = 'devtools://devtools/bundled/devtools_app.html?ws=localhost:9221/devtools/page/' + encodeURIComponent(newTargets[0].id);
await page.goto(wsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 10000));

// Open Animations panel
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
await new Promise(r => setTimeout(r, 3000));

await page.screenshot({ path: 'test/screenshots/animations-panel.png' });
console.log('Saved animations-panel.png');

// Trigger a new animation on the target page via CDP while the panel is open
console.log('Triggering new animation on target...');
const cdpWs2 = (await import('ws')).default;
const ws2 = new cdpWs2(`ws://localhost:9221/devtools/page/${encodeURIComponent(newTargets[0].id)}`);
await new Promise(r => ws2.on('open', r));
let id2 = 100;
function send2(method, params = {}) {
  const i = id2++;
  return new Promise(resolve => {
    const h = data => { const m = JSON.parse(data); if (m.id === i) { ws2.off('message', h); resolve(m); } };
    ws2.on('message', h);
    ws2.send(JSON.stringify({ id: i, method, params }));
  });
}
// Click the "Toggle Transition" button to trigger new CSS transition + web animation
await send2('Runtime.evaluate', { expression: 'runAnimationFixture(); "triggered"' });
await new Promise(r => setTimeout(r, 3000));
await page.screenshot({ path: 'test/screenshots/animations-after-trigger.png' });
console.log('Saved animations-after-trigger.png');

// Trigger another
await send2('Runtime.evaluate', { expression: 'runAnimationFixture(); "triggered2"' });
await new Promise(r => setTimeout(r, 3000));
await page.screenshot({ path: 'test/screenshots/animations-after-trigger2.png' });
console.log('Saved animations-after-trigger2.png');
ws2.close();

// Check what the panel shows
const panelText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
console.log('Panel text:', panelText.substring(0, 300));

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
