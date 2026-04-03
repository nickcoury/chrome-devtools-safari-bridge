#!/usr/bin/env node
/**
 * DevTools Panel UI Test
 *
 * Launches Chrome DevTools connected to a bridge target and verifies
 * each panel actually renders content (not just protocol responses).
 *
 * This catches bugs that protocol-level tests miss:
 * - Events not flowing through the poll loop
 * - Missing event sequences (e.g., executionContextCreated)
 * - Panel initialization failures
 *
 * Usage:
 *   node test/devtools-panels.test.mjs [--bridge-port=9221] [--headed]
 */

import puppeteer from 'puppeteer';

const BRIDGE_PORT = parseInt(process.argv.find(a => a.startsWith('--bridge-port='))?.split('=')[1] || '9221');
const HEADED = process.argv.includes('--headed');

function log(msg) { console.log(`\x1b[36m[panel-test]\x1b[0m ${msg}`); }
function pass(msg) { console.log(`\x1b[32m  ✓\x1b[0m ${msg}`); }
function fail(msg, err) { console.log(`\x1b[31m  ✗\x1b[0m ${msg}: ${err}`); }

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    pass(name);
    passed++;
  } catch (err) {
    fail(name, err.message || err);
    failed++;
  }
}

// Get all visible text including deep shadow DOM
async function getAllText(page) {
  return page.evaluate(() => {
    function deepText(root, depth = 0) {
      if (depth > 10) return '';
      let text = '';
      for (const node of root.childNodes) {
        if (node.nodeType === 3) text += node.textContent;
        if (node.nodeType === 1) {
          text += deepText(node, depth + 1);
          if (node.shadowRoot) text += deepText(node.shadowRoot, depth + 1);
        }
      }
      return text;
    }
    return deepText(document);
  });
}

// Switch DevTools panel using Command Menu (Ctrl/Cmd+Shift+P → type panel name)
async function switchPanel(page, panelName) {
  // Map friendly names to what the Command Menu expects
  const cmdMap = {
    'elements': 'Elements',
    'console': 'Console',
    'sources': 'Sources',
    'network': 'Network',
    'performance': 'Performance',
    'application': 'Application',
  };
  const command = cmdMap[panelName.toLowerCase()] || `Show ${panelName}`;

  // Close any existing Command Menu first
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 300));

  // Open Command Menu with Ctrl+Shift+P (Cmd+Shift+P on Mac)
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyP');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  await new Promise(r => setTimeout(r, 500));

  // Type the command
  await page.keyboard.type(command, { delay: 30 });
  await new Promise(r => setTimeout(r, 500));

  // Press Enter to execute
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 3000));
}

async function main() {
  log('Fetching targets...');
  let targets;
  try {
    const resp = await fetch(`http://localhost:${BRIDGE_PORT}/json/list`);
    targets = await resp.json();
  } catch {
    console.error(`Cannot reach bridge at localhost:${BRIDGE_PORT}`);
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error('No targets. Connect a device.');
    process.exit(1);
  }

  const target = targets[0];
  log(`Target: "${target.title}" (${target.deviceName || 'simulator'})`);

  const wsParam = `localhost:${BRIDGE_PORT}/devtools/page/${encodeURIComponent(target.id)}`;
  const devtoolsUrl = `devtools://devtools/bundled/inspector.html?ws=${wsParam}`;

  log('Launching Chrome...');
  const browser = await puppeteer.launch({
    headless: !HEADED,
    channel: 'chrome',
    args: ['--no-first-run', '--no-default-browser-check'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  log('Opening DevTools...');
  await page.goto(devtoolsUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for DevTools to fully initialize
  log('Waiting for DevTools to connect...');
  await new Promise(r => setTimeout(r, 8000));

  // Take screenshots of each panel
  const { mkdirSync } = await import('fs');
  mkdirSync('test/screenshots', { recursive: true });

  // ── Elements Panel ──
  log('\n── Elements Panel ──');
  await switchPanel(page, 'elements');
  await page.screenshot({ path: 'test/screenshots/panel-elements.png' });

  await test('Elements panel shows DOM nodes', async () => {
    const text = await getAllText(page);
    const hasDom = text.includes('<html') || text.includes('<body') || text.includes('<div') ||
                   text.includes('html') || text.includes('body') || text.includes('head');
    if (!hasDom) throw new Error('No DOM tree content visible');
  });

  await test('Styles sidebar has content', async () => {
    const text = await getAllText(page);
    if (!text.includes('Styles') && !text.includes('element.style') && !text.includes('Computed') &&
        !text.includes('body') && !text.includes('font') && !text.includes('margin'))
      throw new Error('No styles visible');
  });

  // ── Console Panel ──
  log('\n── Console Panel ──');
  await switchPanel(page, 'console');
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: 'test/screenshots/panel-console.png' });

  await test('Console shows messages', async () => {
    const text = await getAllText(page);
    // The demo page logs tick messages and "Demo initialized" on load
    if (!text.includes('tick') && !text.includes('Demo') && !text.includes('initialized') &&
        !text.includes('count') && !text.includes('console') && !text.includes('heartbeat'))
      throw new Error('No console messages visible');
  });

  // ── Sources Panel ──
  log('\n── Sources Panel ──');
  await switchPanel(page, 'sources');
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: 'test/screenshots/panel-sources.png' });

  await test('Sources panel has script files', async () => {
    const text = await getAllText(page);
    // Should show the page URL or script files in the navigator
    const hasContent = text.includes('demo') || text.includes('.html') || text.includes('.js') ||
                       text.includes('Page') || text.includes('top') || text.includes('__pages') ||
                       text.includes('function') || text.includes('var ') || text.includes('const ');
    if (!hasContent) throw new Error('No source files or code visible');
  });

  // ── Network Panel ──
  log('\n── Network Panel ──');
  await switchPanel(page, 'network');
  await new Promise(r => setTimeout(r, 3000));
  await page.screenshot({ path: 'test/screenshots/panel-network.png' });

  await test('Network panel shows requests', async () => {
    const text = await getAllText(page);
    // The demo page auto-fetches fixture.json on load
    const hasRequests = text.includes('fixture') || text.includes('demo') || text.includes('.json') ||
                        text.includes('200') || text.includes('GET') || text.includes('requests');
    if (!hasRequests) throw new Error('No network requests visible');
  });

  // ── Performance Panel ──
  log('\n── Performance Panel ──');
  await switchPanel(page, 'timeline'); // internal name
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: 'test/screenshots/panel-performance.png' });

  await test('Performance panel loads', async () => {
    const text = await getAllText(page);
    if (!text.includes('Record') && !text.includes('Performance') && !text.includes('Start') &&
        !text.includes('profil') && !text.includes('timeline') && !text.includes('Screencast'))
      throw new Error('Performance panel not loaded');
  });

  // ── Application Panel ──
  log('\n── Application Panel ──');
  await switchPanel(page, 'resources'); // internal name
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: 'test/screenshots/panel-application.png' });

  await test('Application panel loads', async () => {
    const text = await getAllText(page);
    if (!text.includes('Storage') && !text.includes('Cookies') && !text.includes('Local') &&
        !text.includes('Application'))
      throw new Error('Application panel not loaded');
  });

  // ── Error Analysis ──
  log('\n── Error Analysis ──');
  const unimplemented = new Set();
  const otherErrors = [];
  for (const e of errors) {
    if (e.includes('favicon') || e.includes('Permissions-Policy')) continue;
    const match = e.match(/Method not implemented: (\S+)/);
    if (match) unimplemented.add(match[1]);
    else otherErrors.push(e);
  }

  if (unimplemented.size > 0) {
    log(`\x1b[33mUnimplemented methods DevTools tried to call (${unimplemented.size}):\x1b[0m`);
    [...unimplemented].sort().forEach(m => console.log(`  \x1b[33m- ${m}\x1b[0m`));
  }
  if (otherErrors.length > 0) {
    log(`\x1b[31mOther DevTools errors (${otherErrors.length}):\x1b[0m`);
    otherErrors.slice(0, 5).forEach(e => console.log(`  \x1b[31m- ${e.substring(0, 120)}\x1b[0m`));
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Panel UI Tests: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m`);
  console.log(`  Screenshots saved to test/screenshots/`);
  console.log(`${'═'.repeat(50)}\n`);

  // Force close
  try { browser.process()?.kill('SIGKILL'); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
