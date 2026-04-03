#!/usr/bin/env node
/**
 * Differential CDP Parity Test Runner
 *
 * Compares Chrome (reference) CDP responses against the bridge on available platforms.
 * Generates test/parity-chart.md with results.
 *
 * Usage:
 *   node test/differential/runner.mjs [--platform=iphone|simulator|desktop] [--suite=elements|console|...]
 */

import path from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { ChromeReference } from './chrome-ref.mjs';
import { BridgeClients } from './bridge-client.mjs';
import { compareResponses } from './comparator.mjs';
import { generateChart } from './chart.mjs';
import { enableDomains } from './helpers.mjs';

// Import all suites
import { suite as elementsSuite } from './suites/elements.mjs';
import { suite as consoleSuite } from './suites/console.mjs';
import { suite as sourcesSuite } from './suites/sources.mjs';
import { suite as networkSuite } from './suites/network.mjs';
import { suite as performanceSuite } from './suites/performance.mjs';
import { suite as applicationSuite } from './suites/application.mjs';
import { suite as otherSuite } from './suites/other.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.resolve(__dirname, 'results');
const CHART_PATH = path.resolve(__dirname, '../parity-chart.md');

const ALL_SUITES = [
  elementsSuite,
  consoleSuite,
  sourcesSuite,
  networkSuite,
  performanceSuite,
  applicationSuite,
  otherSuite,
];

// CLI args
const platformFilter = process.argv.find(a => a.startsWith('--platform='))?.split('=')[1];
const suiteFilter = process.argv.find(a => a.startsWith('--suite='))?.split('=')[1];

// ── Logging ──────────────────────────────────────────────────────────

function log(msg) { console.log(`\x1b[36m[runner]\x1b[0m ${msg}`); }
function pass(msg) { console.log(`\x1b[32m  ✓\x1b[0m ${msg}`); }
function fail(msg) { console.log(`\x1b[31m  ✗\x1b[0m ${msg}`); }
function warn(msg) { console.log(`\x1b[33m  ⚠\x1b[0m ${msg}`); }
function section(msg) { console.log(`\n\x1b[36m── ${msg} ──\x1b[0m`); }

// ── Run a single test against a CDP target ───────────────────────────

async function runTest(test, cdp) {
  if (test.run) {
    return await test.run(cdp);
  }
  throw new Error(`Test ${test.id} has no run function`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(RESULTS_DIR, { recursive: true });

  const suites = suiteFilter
    ? ALL_SUITES.filter(s => s.name.toLowerCase() === suiteFilter.toLowerCase())
    : ALL_SUITES;

  if (suites.length === 0) {
    console.error(`No suite matching "${suiteFilter}". Available: ${ALL_SUITES.map(s => s.name).join(', ')}`);
    process.exit(1);
  }

  // ── Phase 1: Chrome Reference ──────────────────────────────────
  section('Phase 1: Chrome Reference');
  log('Launching Chrome with fixture page...');

  const chrome = new ChromeReference();
  let chromeCdp;
  try {
    chromeCdp = await chrome.start();
  } catch (err) {
    console.error('Failed to launch Chrome:', err.message);
    console.error('Ensure Google Chrome is installed.');
    process.exit(1);
  }
  log(`Chrome fixture: ${chrome.fixtureUrl}`);

  // Enable all domains
  await enableDomains(chromeCdp);

  // Run all tests against Chrome
  const results = [];
  let totalTests = 0;
  let chromePass = 0;
  let chromeFail = 0;

  for (const suite of suites) {
    section(`Chrome: ${suite.name}`);

    // Suite setup
    if (suite.setup) {
      try {
        await suite.setup(chromeCdp);
      } catch (err) {
        warn(`Suite setup failed: ${err.message}`);
      }
    }

    for (const test of suite.tests) {
      totalTests++;
      const result = {
        id: test.id,
        label: test.label,
        suite: suite.name,
        compare: test.compare || {},
      };

      try {
        result.chromeResult = await runTest(test, chromeCdp);
        result.chromePass = true;
        chromePass++;
        pass(`${test.label}`);
      } catch (err) {
        result.chromePass = false;
        result.chromeError = err.message;
        chromeFail++;
        fail(`${test.label}: ${err.message}`);
      }

      results.push(result);
    }

    // Suite teardown
    if (suite.teardown) {
      try {
        await suite.teardown(chromeCdp);
      } catch {}
    }
  }

  log(`Chrome: ${chromePass}/${totalTests} passed`);
  await chrome.close();
  log('Chrome closed.');

  // ── Phase 2: Discover Bridge Platforms ──────────────────────────
  section('Phase 2: Bridge Platforms');

  const bridges = new BridgeClients();
  const allPlatforms = await bridges.discover();
  log(`Discovered platforms: ${allPlatforms.map(p => `${p.name} (${p.target.title})`).join(', ') || 'none'}`);

  const platforms = platformFilter
    ? allPlatforms.filter(p => p.name.toLowerCase() === platformFilter.toLowerCase())
    : allPlatforms;

  if (platforms.length === 0) {
    warn('No bridge platforms available. Chart will show N/A for all platforms.');
  }

  // ── Phase 3: Run tests against each platform ──────────────────
  for (const platform of platforms) {
    section(`Platform: ${platform.name}`);
    log(`Connecting to ${platform.target.webSocketDebuggerUrl}...`);

    let cdp;
    try {
      cdp = await bridges.connect(platform);
    } catch (err) {
      warn(`Failed to connect to ${platform.name}: ${err.message}`);
      continue;
    }

    // Enable domains
    await enableDomains(cdp);

    let platformPass = 0;
    let platformFail = 0;

    for (const suite of suites) {
      section(`${platform.name}: ${suite.name}`);

      // Suite setup
      if (suite.setup) {
        try {
          await suite.setup(cdp);
        } catch (err) {
          warn(`Suite setup failed: ${err.message}`);
        }
      }

      for (const test of suite.tests) {
        const result = results.find(r => r.id === test.id);
        if (!result) continue;

        try {
          const bridgeResult = await runTest(test, cdp);

          // Compare against Chrome reference
          if (result.chromePass && result.chromeResult) {
            const comparison = compareResponses(result.chromeResult, bridgeResult, test.compare || {});
            result[platform.name] = { pass: comparison.pass, diffs: comparison.diffs };
            if (comparison.pass) {
              platformPass++;
              pass(`${test.label}`);
            } else {
              platformFail++;
              fail(`${test.label}: ${comparison.diffs[0]}`);
            }
          } else {
            // Chrome failed too — bridge passed without error, count as pass
            result[platform.name] = { pass: true, note: 'Chrome also failed' };
            platformPass++;
            pass(`${test.label} (Chrome N/A, bridge OK)`);
          }
        } catch (err) {
          result[platform.name] = { pass: false, error: err.message };
          platformFail++;
          fail(`${test.label}: ${err.message}`);
        }
      }

      // Suite teardown
      if (suite.teardown) {
        try {
          await suite.teardown(cdp);
        } catch {}
      }
    }

    log(`${platform.name}: ${platformPass}/${totalTests} passed`);
    cdp.close();
  }

  await bridges.closeAll();

  // ── Phase 4: Generate chart ────────────────────────────────────
  section('Generating Parity Chart');

  // Save raw results
  writeFileSync(
    path.join(RESULTS_DIR, 'raw-results.json'),
    JSON.stringify(results, null, 2)
  );
  log(`Raw results saved to ${path.join(RESULTS_DIR, 'raw-results.json')}`);

  // Generate markdown chart
  const chart = generateChart(results, platforms, CHART_PATH);
  log(`Parity chart saved to ${CHART_PATH}`);

  // Print summary
  console.log('\n' + '═'.repeat(60));
  console.log('  PARITY SUMMARY');
  console.log('═'.repeat(60));
  console.log(`  Chrome (reference): ${chromePass}/${totalTests}`);
  for (const platform of platforms) {
    const passed = results.filter(r => r[platform.name]?.pass).length;
    const pct = totalTests > 0 ? ((passed / totalTests) * 100).toFixed(1) : '0.0';
    const color = passed === totalTests ? '\x1b[32m' : passed > totalTests / 2 ? '\x1b[33m' : '\x1b[31m';
    console.log(`  ${platform.name}: ${color}${passed}/${totalTests} (${pct}%)\x1b[0m`);
  }
  console.log('═'.repeat(60) + '\n');

  // Exit with failure if any platform has < 50% parity
  const anyBad = platforms.some(p => {
    const passed = results.filter(r => r[p.name]?.pass).length;
    return passed < totalTests / 2;
  });

  process.exit(anyBad ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
