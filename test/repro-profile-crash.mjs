import puppeteer from 'puppeteer';
import WebSocket from 'ws';
import { mkdirSync } from 'fs';

mkdirSync('test/screenshots/harden', { recursive: true });

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }
console.log('Target:', targets[0].title, '—', targets[0].url?.substring(0, 60));

// First navigate to Google Images via CDP
console.log('\n1. Navigating to Google Images...');
const cdpWs = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(targets[0].id)}`);
await new Promise(r => cdpWs.on('open', r));
let msgId = 1;
const cdpErrors = [];
function sendCDP(method, params = {}) {
  const i = msgId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${method} timeout`)), 15000);
    const h = data => {
      const m = JSON.parse(data);
      if (m.id === i) { clearTimeout(timeout); cdpWs.off('message', h); resolve(m); }
      if (m.method === 'Inspector.detached' || m.method === 'Inspector.targetCrashed') {
        cdpErrors.push(m);
        console.log('  ⚠ CDP event:', m.method, JSON.stringify(m.params));
      }
    };
    cdpWs.on('message', h);
    cdpWs.send(JSON.stringify({ id: i, method, params }));
  });
}

// Ensure we're on Google Images
try {
  await sendCDP('Page.navigate', { url: 'https://www.google.com/search?q=dogs&udm=2' });
  await new Promise(r => setTimeout(r, 5000));
  console.log('  Navigated to Google Images');
} catch (e) {
  console.log('  Navigate failed:', e.message);
}
cdpWs.close();

// Wait for page to settle
await new Promise(r => setTimeout(r, 3000));

// Now open DevTools and do the profile flow
console.log('\n2. Opening DevTools...');
const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 1800, height: 1000 });

const newTargets = await (await fetch('http://localhost:9221/json/list')).json();
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
  await new Promise(r => setTimeout(r, 2000));
}

console.log('\n3. Opening Performance panel...');
await openPanel('Performance');
await new Promise(r => setTimeout(r, 1000));
await page.screenshot({ path: 'test/screenshots/harden/crash-1-perf-panel.png' });

console.log('\n4. Starting recording...');
const recordButton = await page.$('[aria-label="Record"]');
if (recordButton) await recordButton.click();
else { await page.keyboard.down('Control'); await page.keyboard.press('KeyE'); await page.keyboard.up('Control'); }
await new Promise(r => setTimeout(r, 2000));
await page.screenshot({ path: 'test/screenshots/harden/crash-2-recording.png' });

// Now simulate the user clicking an image on Google Images by triggering navigation via CDP
// This simulates the DOM complexity change that happens when clicking a Google image
console.log('\n5. Simulating image click (triggering JS + DOM changes)...');
const ws2 = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(newTargets[0].id)}`);
let ws2Open = false;
ws2.on('open', () => { ws2Open = true; });
ws2.on('error', (e) => { console.log('  WS2 error:', e.message); });
ws2.on('close', (code, reason) => { console.log('  WS2 closed:', code, reason?.toString()); });

await new Promise(r => setTimeout(r, 2000));

if (ws2Open) {
  // Click the first image thumbnail
  try {
    const clickId = 999;
    ws2.send(JSON.stringify({
      id: clickId,
      method: 'Runtime.evaluate',
      params: { expression: `
        // Click the first big image thumbnail
        const img = document.querySelector('img[data-src]') || document.querySelector('img[alt]');
        if (img) { img.click(); 'clicked ' + img.alt; }
        else { 'no image found'; }
      ` }
    }));
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) {
    console.log('  Click eval failed:', e.message);
  }
} else {
  console.log('  WS2 not open — bridge may be busy');
}

console.log('\n6. Waiting 3s for DOM changes...');
await new Promise(r => setTimeout(r, 3000));
await page.screenshot({ path: 'test/screenshots/harden/crash-3-after-click.png' });

// Check if DevTools is still alive
const isAlive = await page.evaluate(() => document.body.innerText.substring(0, 100)).catch(() => 'DEAD');
console.log('  DevTools status:', isAlive === 'DEAD' ? 'CRASHED' : 'alive');

console.log('\n7. Stopping recording...');
try {
  const stopButton = await page.$('[aria-label="Stop"]');
  if (stopButton) await stopButton.click();
  else { await page.keyboard.down('Control'); await page.keyboard.press('KeyE'); await page.keyboard.up('Control'); }
} catch (e) {
  console.log('  Stop failed:', e.message);
}

console.log('\n8. Waiting for trace to load...');
await new Promise(r => setTimeout(r, 10000));
await page.screenshot({ path: 'test/screenshots/harden/crash-4-result.png' });

const finalText = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => 'DEAD');
console.log('  Final status:', typeof finalText === 'string' ? finalText.substring(0, 150) : finalText);

// Check bridge health
try {
  const health = await fetch('http://localhost:9221/json/list');
  const t = await health.json();
  console.log('\n  Bridge health:', t.length, 'targets');
} catch {
  console.log('\n  Bridge health: UNREACHABLE');
}

ws2.close();
try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
