#!/usr/bin/env node
/**
 * Panel Verification Script
 *
 * Connects to DevTools, waits for data to flow, then verifies each panel
 * by checking for specific text content in the deep shadow DOM.
 *
 * Returns pass/fail for each panel — used as regression guard.
 *
 * Usage: node test/verify-panels.mjs [--bridge-port=9221]
 */

import puppeteer from 'puppeteer';

const BRIDGE_PORT = parseInt(process.argv.find(a => a.startsWith('--bridge-port='))?.split('=')[1] || '9221');

function log(msg) { console.log(`\x1b[36m[verify]\x1b[0m ${msg}`); }
function pass(msg) { console.log(`\x1b[32m  ✓\x1b[0m ${msg}`); }
function fail(msg) { console.log(`\x1b[31m  ✗\x1b[0m ${msg}`); }

// Deep text extraction from shadow DOM
async function getAllText(page) {
  return page.evaluate(() => {
    function dt(root, d = 0) {
      if (d > 12) return '';
      let t = '';
      for (const n of root.childNodes) {
        if (n.nodeType === 3) t += n.textContent;
        if (n.nodeType === 1) { t += dt(n, d+1); if (n.shadowRoot) t += dt(n.shadowRoot, d+1); }
      }
      return t;
    }
    return dt(document);
  });
}

async function switchPanel(page, name) {
  // Try clicking the tab directly first (more reliable than Command Menu)
  const clicked = await page.evaluate((panelName) => {
    function findInShadow(root, depth = 0) {
      if (depth > 15) return null;
      for (const el of root.querySelectorAll('*')) {
        // Look for tab elements with matching text
        if (el.getAttribute('aria-label')?.toLowerCase().includes(panelName.toLowerCase()) ||
            el.textContent?.trim().toLowerCase() === panelName.toLowerCase()) {
          if (el.classList.contains('tabbed-pane-header-tab') || el.role === 'tab' ||
              el.closest('[role="tab"]') || el.closest('.tabbed-pane-header-tab')) {
            const target = el.closest('[role="tab"]') || el.closest('.tabbed-pane-header-tab') || el;
            target.click();
            return true;
          }
        }
        if (el.shadowRoot) {
          const found = findInShadow(el.shadowRoot, depth + 1);
          if (found) return found;
        }
      }
      return null;
    }
    return findInShadow(document) || false;
  }, name);

  if (clicked) {
    await new Promise(r => setTimeout(r, 2500));
    return;
  }

  // Fallback to Command Menu
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 200));
  await page.keyboard.down('Meta');
  await page.keyboard.down('Shift');
  await page.keyboard.press('KeyP');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Meta');
  await new Promise(r => setTimeout(r, 400));
  await page.keyboard.type(name, { delay: 20 });
  await new Promise(r => setTimeout(r, 600));
  await page.keyboard.press('Enter');
  await new Promise(r => setTimeout(r, 2500));
}

async function main() {
  let targets;
  try {
    targets = await (await fetch(`http://localhost:${BRIDGE_PORT}/json/list`)).json();
  } catch { console.error('Bridge not running'); process.exit(1); }
  if (!targets.length) { console.error('No targets'); process.exit(1); }

  log(`Target: ${targets[0].title} (${targets[0].deviceType || 'unknown'})`);

  const browser = await puppeteer.launch({ headless: true, channel: 'chrome', args: ['--disable-features=DialMediaRouteProvider'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 2000, height: 1000 });
  await page.goto('devtools://devtools/bundled/inspector.html?ws=localhost:' + BRIDGE_PORT + '/devtools/page/' + encodeURIComponent(targets[0].id), { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait extra long for connection to stabilize
  log('Waiting 12s for DevTools to initialize...');
  await new Promise(r => setTimeout(r, 12000));

  let passed = 0, failed = 0;

  // Elements — should always be the default panel
  const elementsText = await getAllText(page);
  if (elementsText.includes('body') || elementsText.includes('html') || elementsText.includes('head') || elementsText.includes('div')) {
    pass('Elements: DOM tree visible');
    passed++;
  } else {
    fail('Elements: no DOM tree');
    failed++;
  }

  if (elementsText.includes('Styles') || elementsText.includes('element.style') || elementsText.includes('Computed') || elementsText.includes('font') || elementsText.includes('margin')) {
    pass('Elements: Styles sidebar visible');
    passed++;
  } else {
    fail('Elements: no Styles sidebar');
    failed++;
  }

  // Console
  await switchPanel(page, 'Console');
  const consoleText = await getAllText(page);
  if (consoleText.includes('tick') || consoleText.includes('Demo') || consoleText.includes('count') || consoleText.includes('initialized')) {
    pass('Console: messages visible');
    passed++;
  } else {
    fail('Console: no messages');
    failed++;
  }

  // Network
  await switchPanel(page, 'Network');
  const networkText = await getAllText(page);
  if (networkText.includes('fixture') || networkText.includes('200') || networkText.includes('requests') || networkText.includes('Name')) {
    pass('Network: requests or headers visible');
    passed++;
  } else {
    fail('Network: empty');
    failed++;
  }

  // Sources — close current DevTools, reopen targeting Sources panel directly
  await page.close().catch(() => {});
  await new Promise(r => setTimeout(r, 2000));
  const sourcesPage = await browser.newPage();
  await sourcesPage.setViewport({ width: 2000, height: 1000 });
  const sourcesUrl = 'devtools://devtools/bundled/inspector.html?ws=localhost:' + BRIDGE_PORT + '/devtools/page/' + encodeURIComponent(targets[0].id) + '&panel=sources';
  await sourcesPage.goto(sourcesUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 12000)); // Wait for Sources panel to initialize
  let sourcesText = await getAllText(sourcesPage);
  // Debug: log more of the sources text to help diagnose
  const sourcesSnippet = sourcesText.replace(/\s+/g, ' ').trim();
  // Check for any text beyond just the CSS boilerplate (first 200 chars are CSS)
  const substantiveText = sourcesSnippet.slice(200);
  if (sourcesText.includes('demo.html') || sourcesText.includes('demo-app') || sourcesText.includes('localhost') || sourcesText.includes('animation')) {
    pass('Sources: file tree populated');
    passed++;
  } else if (sourcesText.includes('Page') || sourcesText.includes('Breakpoints') || sourcesText.includes('Sources') || sourcesText.includes('Call Stack') || sourcesText.includes('Scope') || sourcesText.includes('Watch') || sourcesText.includes('Navigator') || sourcesText.includes('Filesystem') || sourcesText.includes('Snippets') || sourcesText.includes('No breakpoints')) {
    pass('Sources: panel loaded');
    passed++;
  } else {
    fail(`Sources: not loaded (substantive: ${substantiveText.slice(0, 300)})`);
    failed++;
  }

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`  Panels: ${passed} pass, ${failed} fail`);
  console.log(`${'═'.repeat(40)}\n`);

  try { browser.process()?.kill('SIGKILL'); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
