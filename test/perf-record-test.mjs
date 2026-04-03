import puppeteer from 'puppeteer';

const targets = await (await fetch('http://localhost:9221/json/list')).json();
const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.setViewport({ width: 2000, height: 1000 });
await page.goto('devtools://devtools/bundled/inspector.html?ws=localhost:9221/devtools/page/' + encodeURIComponent(targets[0].id), { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise(r => setTimeout(r, 10000));

// Switch to Performance — use Ctrl+Shift+E which is the Record shortcut
// This automatically opens the Performance panel and starts recording
await page.keyboard.down('Meta'); await page.keyboard.press('KeyE'); await page.keyboard.up('Meta');
await new Promise(r => setTimeout(r, 5000));

// Click Record button by finding it in shadow DOM
const recordClicked = await page.evaluate(() => {
  function deepFind(root, depth = 0) {
    if (depth > 20) return null;
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      const label = (el.getAttribute('aria-label') || el.title || '').toLowerCase();
      if (label.includes('record')) { el.click(); return label; }
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const f = deepFind(el.shadowRoot, depth+1); if (f) return f; }
    }
    return null;
  }
  return deepFind(document);
});
console.log('Record button:', recordClicked);

// Wait to see if it starts
await new Promise(r => setTimeout(r, 5000));
await page.screenshot({ path: 'test/screenshots/perf-recording.png' });

// Try to stop
const stopClicked = await page.evaluate(() => {
  function deepFind(root, depth = 0) {
    if (depth > 20) return null;
    for (const el of root.querySelectorAll('button, [role="button"]')) {
      const label = (el.getAttribute('aria-label') || el.title || '').toLowerCase();
      if (label.includes('stop')) { el.click(); return label; }
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) { const f = deepFind(el.shadowRoot, depth+1); if (f) return f; }
    }
    return null;
  }
  return deepFind(document);
});
console.log('Stop button:', stopClicked);
await new Promise(r => setTimeout(r, 5000));
await page.screenshot({ path: 'test/screenshots/perf-stopped.png' });

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
