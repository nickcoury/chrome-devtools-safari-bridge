import puppeteer from 'puppeteer';
import { mkdirSync } from 'fs';

mkdirSync('test/screenshots/harden', { recursive: true });

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

console.log('Opening Performance panel...');
await openPanel('Performance');
await new Promise(r => setTimeout(r, 1000));

// List all buttons with aria-labels
const buttons = await page.evaluate(() => {
  const btns = document.querySelectorAll('button, [role="button"], devtools-button');
  return Array.from(btns).map(b => ({
    ariaLabel: b.ariaLabel || b.getAttribute('aria-label') || '',
    title: b.title || '',
    text: b.textContent?.substring(0, 40) || '',
    class: b.className?.substring?.(0, 40) || '',
  })).filter(b => b.ariaLabel || b.title);
});
console.log('Buttons found:');
for (const b of buttons) {
  console.log(`  "${b.ariaLabel}" title="${b.title}" text="${b.text?.trim()}" class="${b.class}"`);
}

// Look specifically for reload/profile button
const reloadBtn = await page.$('[aria-label*="reload"], [aria-label*="Reload"], [title*="reload"], [title*="Reload"]');
console.log('\nReload button found:', !!reloadBtn);

// Try clicking the record button then checking what happens
console.log('\nStarting normal record...');
const recordBtn = await page.$('[aria-label="Record"]');
if (recordBtn) {
  await recordBtn.click();
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: 'test/screenshots/harden/reload-recording.png' });

  // Now check what Page.reload does while recording
  console.log('Triggering Page.reload via CDP while recording...');
  // Send Page.reload through a separate WS
  const ws = (await import('ws')).default;
  const newTargets = await (await fetch('http://localhost:9221/json/list')).json();
  const reloadWs = new ws(`ws://localhost:9221/devtools/page/${encodeURIComponent(newTargets[0].id)}`);
  await new Promise(r => reloadWs.on('open', r));
  reloadWs.send(JSON.stringify({ id: 1, method: 'Page.reload', params: {} }));

  await new Promise(r => setTimeout(r, 5000));
  await page.screenshot({ path: 'test/screenshots/harden/reload-after-reload.png' });

  // Check page status
  const status = await page.evaluate(() => document.body.innerText.substring(0, 200)).catch(() => 'DEAD');
  console.log('After reload:', status.substring(0, 100));

  // Try to stop
  console.log('Stopping...');
  const stopBtn = await page.$('[aria-label="Stop"]');
  if (stopBtn) await stopBtn.click();

  await new Promise(r => setTimeout(r, 10000));
  await page.screenshot({ path: 'test/screenshots/harden/reload-final.png' });

  const final = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => 'DEAD');
  console.log('Final:', final.substring(0, 150));

  reloadWs.close();
}

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
