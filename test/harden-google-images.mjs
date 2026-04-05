import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { mkdirSync } from 'fs';

mkdirSync('test/screenshots/harden', { recursive: true });

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

// Navigate phone to Google Images via CDP
console.log('Navigating to Google Images...');
const cdpWs = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(targets[0].id)}`);
await new Promise(r => cdpWs.on('open', r));
let msgId = 1;
function sendCDP(method, params = {}) {
  const i = msgId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
    const h = data => { const m = JSON.parse(data); if (m.id === i) { clearTimeout(timeout); cdpWs.off('message', h); resolve(m); } };
    cdpWs.on('message', h);
    cdpWs.send(JSON.stringify({ id: i, method, params }));
  });
}

await sendCDP('Page.navigate', { url: 'https://www.google.com/search?q=dogs&udm=2' });
console.log('Waiting for page load...');
await new Promise(r => setTimeout(r, 8000));
cdpWs.close();

// Refresh targets after navigation
await new Promise(r => setTimeout(r, 2000));
const newTargets = await (await fetch('http://localhost:9221/json/list')).json();
console.log('Target:', newTargets[0]?.title, newTargets[0]?.url?.substring(0, 60));

// Open DevTools
const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1000 });

const wsUrl = 'devtools://devtools/bundled/devtools_app.html?ws=localhost:9221/devtools/page/' + encodeURIComponent(newTargets[0].id);
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

async function screenshotPanel(name) {
  await openPanel(name);
  await new Promise(r => setTimeout(r, 2000));
  const fname = name.toLowerCase().replace(/\s+/g, '-');
  await page.screenshot({ path: `test/screenshots/harden/${fname}.png` });

  // Get panel text for verification
  const text = await page.evaluate(() => document.body.innerText.substring(0, 300));
  console.log(`[${name}] ${text.substring(0, 100).replace(/\n/g, ' | ')}`);
  return fname;
}

// Test each panel
console.log('\n=== Testing all panels on Google Images ===\n');

await screenshotPanel('Elements');
await screenshotPanel('Console');
await screenshotPanel('Network');
await screenshotPanel('Sources');
await screenshotPanel('Performance');
await screenshotPanel('Application');

console.log('\n=== Done! Screenshots in test/screenshots/harden/ ===');

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
