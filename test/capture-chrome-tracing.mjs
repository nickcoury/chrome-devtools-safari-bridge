/**
 * Capture what Chrome's own tracing mechanism sends when recording Performance.
 * Uses Puppeteer's CDPSession to intercept the actual tracing protocol.
 */
import puppeteer from 'puppeteer';
import { writeFileSync } from 'fs';

const browser = await puppeteer.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage();
await page.goto('data:text/html,<h1>Test</h1><script>setInterval(()=>console.log("tick"),1000)</script>');

const client = await page.createCDPSession();
const log = [];

// Listen for all tracing events
client.on('Tracing.dataCollected', p => {
  log.push({ method: 'Tracing.dataCollected', eventCount: p.value?.length || 0 });
  // Log first few events for format reference
  if (p.value?.length > 0) {
    log.push({ firstEvents: p.value.slice(0, 5) });
  }
});
client.on('Tracing.bufferUsage', p => log.push({ method: 'Tracing.bufferUsage', params: p }));
client.on('Tracing.tracingComplete', p => log.push({ method: 'Tracing.tracingComplete', params: p }));

// Start tracing like DevTools does
console.log('Starting trace...');
await client.send('Tracing.start', {
  categories: '-*,devtools.timeline,v8.execute,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame',
  options: '',
  bufferUsageReportingInterval: 500,
  transferMode: 'ReportEvents',
  streamFormat: 'json',
});
log.push({ started: true, time: Date.now() });

// Wait 3 seconds
await new Promise(r => setTimeout(r, 3000));

// Stop
console.log('Stopping trace...');
await client.send('Tracing.end');

// Wait for tracingComplete
await new Promise(r => setTimeout(r, 2000));

// Save log
writeFileSync('/tmp/chrome-tracing-capture.json', JSON.stringify(log, null, 2));
console.log('Captured', log.length, 'events');
console.log('First 3:', JSON.stringify(log.slice(0, 3), null, 2));

try { browser.process()?.kill('SIGKILL'); } catch {}
process.exit(0);
