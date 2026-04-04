// Test Animation panel with the animation fixture page
import WebSocket from 'ws';

const targets = await (await fetch('http://localhost:9221/json/list')).json();
if (!targets.length) { console.error('No targets'); process.exit(1); }

const ws = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(targets[0].id)}`);
let id = 1;
const pending = new Map();
const events = [];

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method) events.push(msg);
});

function send(method, params = {}) {
  const reqId = id++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    ws.send(JSON.stringify({ id: reqId, method, params }));
  });
}

await new Promise(r => ws.on('open', r));
console.log('Connected to:', targets[0].title);

// Navigate to animation page
console.log('Navigating to animation page...');
await send('Page.navigate', { url: `http://192.168.1.111:9221/__pages/animation.html` });
await new Promise(r => setTimeout(r, 3000));

// Enable domains
await send('DOM.enable');
await send('CSS.enable');
await send('Runtime.enable');

// Clear events
events.length = 0;

// Enable Animation domain
console.log('Enabling Animation domain...');
await send('Animation.enable');
await new Promise(r => setTimeout(r, 2000));

// Check for animation events
const animCreated = events.filter(e => e.method === 'Animation.animationCreated');
const animStarted = events.filter(e => e.method === 'Animation.animationStarted');

console.log(`\nAnimation events received:`);
console.log(`  animationCreated: ${animCreated.length}`);
console.log(`  animationStarted: ${animStarted.length}`);

for (const evt of animStarted) {
  const anim = evt.params?.animation;
  if (anim) {
    console.log(`\n  Animation: ${anim.id}`);
    console.log(`    name: ${anim.name}`);
    console.log(`    type: ${anim.type}`);
    console.log(`    playState: ${anim.playState}`);
    console.log(`    source.backendNodeId: ${anim.source?.backendNodeId}`);
    console.log(`    source.duration: ${anim.source?.duration}ms`);
    console.log(`    source.iterations: ${anim.source?.iterations}`);
    console.log(`    source.keyframes: ${anim.source?.keyframesRule?.keyframes?.length}`);
    if (anim.source?.keyframesRule?.keyframes?.length) {
      for (const kf of anim.source.keyframesRule.keyframes.slice(0, 3)) {
        console.log(`      ${kf.offset}: ${kf.value?.substring(0, 80)}`);
      }
    }
  }
}

// Test pushNodesByBackendIdsToFrontend
if (animStarted.length > 0) {
  const backendIds = animStarted.map(e => e.params?.animation?.source?.backendNodeId).filter(Boolean);
  if (backendIds.length > 0) {
    console.log(`\nResolving backendNodeIds: [${backendIds.join(', ')}]`);
    const pushResult = await send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: backendIds });
    console.log('pushNodesByBackendIds result:', JSON.stringify(pushResult.result));
  }
}

ws.close();
process.exit(0);
