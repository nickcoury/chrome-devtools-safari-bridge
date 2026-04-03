/**
 * Parity chart generator.
 * Reads test results and writes a markdown table.
 */

import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function generateChart(results, platforms, outputPath) {
  const lines = [];
  const date = new Date().toISOString().split('T')[0];

  lines.push('# CDP Feature Parity Chart');
  lines.push('');
  lines.push(`Generated: ${date}  `);
  lines.push(`Platforms tested: ${platforms.map(p => p.name).join(', ') || 'none'}  `);
  lines.push('');

  // Summary
  const total = results.length;
  const chromePassed = results.filter(r => r.chromePass).length;

  lines.push('## Summary');
  lines.push('');
  lines.push(`| Platform | Passed | Total | Parity |`);
  lines.push(`|----------|--------|-------|--------|`);
  lines.push(`| Chrome (reference) | ${chromePassed} | ${total} | 100% |`);

  for (const platform of platforms) {
    const passed = results.filter(r => r[platform.name]?.pass).length;
    const pct = total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0';
    lines.push(`| ${platform.name} | ${passed} | ${total} | ${pct}% |`);
  }
  lines.push('');

  // Group by suite
  const suites = new Map();
  for (const r of results) {
    if (!suites.has(r.suite)) suites.set(r.suite, []);
    suites.get(r.suite).push(r);
  }

  // Header with platform columns
  const platformCols = platforms.map(p => p.name);

  for (const [suiteName, suiteResults] of suites) {
    lines.push(`## ${suiteName}`);
    lines.push('');
    const pCols = platformCols.length > 0
      ? `| ${platformCols.join(' | ')} `
      : '';
    const pSep = platformCols.length > 0
      ? platformCols.map(() => '|:------:').join('')
      : '';
    lines.push(`| Feature | Chrome ${pCols}| Notes |`);
    lines.push(`|---------|:------:${pSep}|-------|`);

    for (const r of suiteResults) {
      const chromeStatus = r.chromePass ? 'pass' : (r.chromeError ? 'FAIL' : 'skip');
      const chromeIcon = r.chromePass ? '✅' : '❌';

      const platformStatuses = [];
      const notes = [];

      for (const p of platforms) {
        const pr = r[p.name];
        if (!pr) {
          platformStatuses.push('➖');
        } else if (pr.pass) {
          platformStatuses.push('✅');
        } else {
          platformStatuses.push('❌');
          // Capture first diff or error as note
          if (pr.error) {
            notes.push(`${p.name}: ${truncate(pr.error, 50)}`);
          } else if (pr.diffs?.length) {
            notes.push(`${p.name}: ${truncate(pr.diffs[0], 50)}`);
          }
        }
      }

      const noteStr = notes.join('; ');
      const pStatuses = platformStatuses.length > 0
        ? `| ${platformStatuses.join(' | ')} `
        : '';
      lines.push(`| ${r.label} | ${chromeIcon} ${pStatuses}| ${noteStr} |`);
    }

    lines.push('');
  }

  // Legend
  lines.push('## Legend');
  lines.push('');
  lines.push('- ✅ Pass — response matches Chrome reference structurally');
  lines.push('- ❌ Fail — response differs from Chrome or threw an error');
  lines.push('- ➖ N/A — platform not available during test run');
  lines.push('');

  const content = lines.join('\n');
  writeFileSync(outputPath, content);
  return content;
}

function truncate(str, max) {
  if (!str) return '';
  str = String(str);
  return str.length > max ? str.substring(0, max) + '...' : str;
}
