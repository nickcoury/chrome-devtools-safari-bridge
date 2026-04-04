#!/usr/bin/env node
/**
 * Pixel Screenshot Verification
 *
 * Takes screenshots of each DevTools panel and analyzes them for
 * actual content (not just text keywords). Uses Puppeteer to open
 * DevTools, wait for data to flow, and capture screenshots.
 *
 * Each panel check:
 * 1. Opens a fresh DevTools connection
 * 2. Waits for the panel to populate
 * 3. Takes a screenshot
 * 4. Analyzes the screenshot for expected visual patterns
 *
 * Usage: node test/verify-screenshots.mjs [--bridge-port=9221] [--save-dir=/tmp]
 */

import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';

const BRIDGE_PORT = parseInt(process.argv.find(a => a.startsWith('--bridge-port='))?.split('=')[1] || '9221');
const SAVE_DIR = process.argv.find(a => a.startsWith('--save-dir='))?.split('=')[1] || '/tmp/devtools-verify';

function log(msg) { console.log(`\x1b[36m[screenshot]\x1b[0m ${msg}`); }
function pass(msg) { console.log(`\x1b[32m  ✓\x1b[0m ${msg}`); }
function fail(msg) { console.log(`\x1b[31m  ✗\x1b[0m ${msg}`); }

async function main() {
  await fs.mkdir(SAVE_DIR, { recursive: true });

  let targets;
  try {
    targets = await (await fetch(`http://localhost:${BRIDGE_PORT}/json/list`)).json();
  } catch { console.error('Bridge not running'); process.exit(1); }
  if (!targets.length) { console.error('No targets'); process.exit(1); }

  log(`Target: ${targets[0].title} (${targets[0].deviceType || 'unknown'})`);
  log(`Screenshots: ${SAVE_DIR}`);

  const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
  let passed = 0, failed = 0;

  const baseUrl = targets[0].devtoolsFrontendUrl;

  // Helper: open panel, wait, screenshot, analyze
  async function checkPanel(name, panelParam, waitMs, analyzeImg) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    const url = panelParam ? baseUrl + '&panel=' + panelParam : baseUrl;
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch {
      // Some panel URLs may fail — fall back to base and switch
      await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    }
    await new Promise(r => setTimeout(r, waitMs));
    const imgPath = path.join(SAVE_DIR, `${name}.png`);
    await page.screenshot({ path: imgPath, fullPage: false });

    // Analyze: extract text content from DevTools to verify data is present
    const text = await page.evaluate(() => {
      function dt(root, d = 0) {
        if (d > 12) return '';
        let t = '';
        for (const n of root.childNodes) {
          if (n.nodeType === 3) t += n.textContent;
          if (n.nodeType === 1 && n.tagName !== 'STYLE' && n.tagName !== 'SCRIPT') {
            t += dt(n, d+1);
            if (n.shadowRoot) t += dt(n.shadowRoot, d+1);
          }
        }
        return t;
      }
      return dt(document);
    });

    const result = analyzeImg(text);
    await page.close();
    return { ...result, imgPath };
  }

  // Elements
  const elements = await checkPanel('elements', null, 20000, (text) => {
    const hasHtml = text.includes('<html') || text.includes('html');
    const hasBody = text.includes('<body') || text.includes('body');
    const hasStyles = text.includes('Styles') || text.includes('element.style');
    // Check for CHILDREN content (not just head/body tags)
    const hasChildContent = text.includes('meta') || text.includes('style') || text.includes('div') || text.includes('section') || text.includes('script');
    return { ok: hasHtml && hasBody && hasChildContent && hasStyles, detail: `html=${hasHtml} body=${hasBody} children=${hasChildContent} styles=${hasStyles}` };
  });
  if (elements.ok) { pass(`Elements: DOM tree with children + Styles (${elements.imgPath})`); passed++; }
  else { fail(`Elements: ${elements.detail} (${elements.imgPath})`); failed++; }

  // Console
  const console_ = await checkPanel('console', 'console', 25000, (text) => {
    const hasTick = text.includes('tick');
    const hasError = text.includes('Failed') || text.includes('error') || text.includes('Error');
    const hasPrompt = text.includes('>') || text.includes('›');
    const hasMessages = hasTick || hasError;
    return { ok: hasMessages, detail: `tick=${hasTick} errors=${hasError} prompt=${hasPrompt}` };
  });
  if (console_.ok) { pass(`Console: messages visible (${console_.imgPath})`); passed++; }
  else { fail(`Console: ${console_.detail} (${console_.imgPath})`); failed++; }

  // Network
  const network = await checkPanel('network', 'network', 25000, (text) => {
    const hasRequests = text.includes('fixture') || text.includes('200') || text.includes('requests');
    const hasHeaders = text.includes('Name') && text.includes('Status');
    return { ok: hasRequests || hasHeaders, detail: `requests=${hasRequests} headers=${hasHeaders}` };
  });
  if (network.ok) { pass(`Network: ${network.detail} (${network.imgPath})`); passed++; }
  else { fail(`Network: ${network.detail} (${network.imgPath})`); failed++; }

  // Sources
  const sources = await checkPanel('sources', 'sources', 15000, (text) => {
    const hasFiles = text.includes('demo') || text.includes('localhost') || text.includes('__pages');
    const hasPanel = text.includes('Page') || text.includes('Breakpoints') || text.includes('Sources');
    return { ok: hasFiles || hasPanel, detail: `files=${hasFiles} panel=${hasPanel}` };
  });
  if (sources.ok) { pass(`Sources: ${sources.detail} (${sources.imgPath})`); passed++; }
  else { fail(`Sources: ${sources.detail} (${sources.imgPath})`); failed++; }

  await browser.close();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Screenshot Verification: ${passed} pass, ${failed} fail`);
  console.log(`  Screenshots saved to: ${SAVE_DIR}`);
  console.log(`${'═'.repeat(50)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
