// Full regression test: screenshot all DevTools panels
import puppeteer from 'puppeteer-core';

const TABS = ['Elements', 'Console', 'Sources', 'Network', 'Performance'];
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const targets = await (await fetch('http://localhost:9221/json/list')).json();
  if (!targets.length) { console.error('No targets'); process.exit(1); }

  const wsUrl = targets[0].webSocketDebuggerUrl;
  const inspectUrl = 'devtools://devtools/bundled/devtools_app.html?ws=' + encodeURIComponent(wsUrl.replace('ws://', ''));

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: null,
    args: ['--window-size=1400,900'],
  });
  const page = (await browser.pages())[0];
  await page.goto(inspectUrl);
  await new Promise(r => setTimeout(r, 5000));

  const cdp = await page.createCDPSession();

  // Helper: click a tab by name using accessibility tree
  async function clickTab(name) {
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const tab = tree.nodes.find(n =>
      n.role?.value === 'tab' && n.name?.value?.includes(name)
    );
    if (tab) {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: tab.backendDOMNodeId });
      await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { this.click(); }' });
      return true;
    }
    return false;
  }

  // Helper: click a button by name
  async function clickButton(name) {
    const tree = await cdp.send('Accessibility.getFullAXTree');
    const btn = tree.nodes.find(n =>
      n.role?.value === 'button' && n.name?.value?.includes(name)
    );
    if (btn) {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: btn.backendDOMNodeId });
      await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { this.click(); }' });
      return true;
    }
    return false;
  }

  const results = [];

  // 1. Elements panel
  console.log('Testing Elements panel...');
  await clickTab('Elements');
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/tmp/regression-elements.png' });
  results.push('Elements');

  // 2. Console panel
  console.log('Testing Console panel...');
  await clickTab('Console');
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/tmp/regression-console.png' });
  results.push('Console');

  // 3. Sources panel
  console.log('Testing Sources panel...');
  await clickTab('Sources');
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/tmp/regression-sources.png' });
  results.push('Sources');

  // 4. Network panel
  console.log('Testing Network panel...');
  await clickTab('Network');
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/tmp/regression-network.png' });
  results.push('Network');

  // 5. Performance panel - record and stop
  console.log('Testing Performance panel...');
  await clickTab('Performance');
  await new Promise(r => setTimeout(r, 2000));
  await page.screenshot({ path: '/tmp/regression-perf-idle.png' });
  results.push('Performance-idle');

  // Start recording
  // Click the record icon in toolbar (first icon)
  await page.mouse.click(15, 39);
  await new Promise(r => setTimeout(r, 4000));

  // Stop recording via accessibility
  if (await clickButton('Stop')) {
    console.log('  Stopped recording');
  }
  await new Promise(r => setTimeout(r, 12000));
  await page.screenshot({ path: '/tmp/regression-perf-trace.png' });
  results.push('Performance-trace');

  console.log('\nScreenshots saved:');
  for (const r of results) {
    console.log(`  /tmp/regression-${r.toLowerCase()}.png`);
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
