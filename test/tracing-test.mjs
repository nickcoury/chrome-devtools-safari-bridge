import WebSocket from 'ws';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
const log = (msg) => { writeFileSync('/tmp/tracing-test.log', msg + '\n', { flag: 'a' }); console.log(msg); };
writeFileSync('/tmp/tracing-test.log', '');

const targets = JSON.parse(execSync('curl -s http://localhost:9221/json/list').toString());
const ws = new WebSocket('ws://localhost:9221/devtools/page/' + encodeURIComponent(targets[0].id));

ws.on('open', () => {
  log('Sending Tracing.start...');
  const t0 = Date.now();
  ws.send(JSON.stringify({id:1, method:'Tracing.start', params:{categories:'-*'}}));

  ws.on('message', d => {
    const msg = JSON.parse(d);
    const elapsed = Date.now() - t0;
    if (msg.id === 1) {
      log(`Response in ${elapsed}ms:`, JSON.stringify(msg.result || msg.error).substring(0, 100));
    }
    if (msg.method?.startsWith('Tracing.')) {
      log(`Event ${elapsed}ms: ${msg.method}`);
    }
  });
});

setTimeout(() => { log('TIMEOUT after 8s'); process.exit(1); }, 8000);
