// Check if backendNodeIds can be resolved in the DOM
import WebSocket from 'ws';

const targets = await (await fetch('http://localhost:9221/json/list')).json();
const ws = new WebSocket(`ws://localhost:9221/devtools/page/${encodeURIComponent(targets[0].id)}`);
let id = 1;
const pending = new Map();
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
function send(method, params = {}) {
  const reqId = id++;
  return new Promise(resolve => { pending.set(reqId, resolve); ws.send(JSON.stringify({ id: reqId, method, params })); });
}
await new Promise(r => ws.on('open', r));

// Enable DOM
await send('DOM.enable');
const doc = await send('DOM.getDocument', { depth: -1 });
console.log('Document nodeId:', doc.result?.root?.nodeId);

// Get body nodeId
const body = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'body' });
console.log('Body nodeId:', body.result?.nodeId);

// Enable Animation
const animEvents = [];
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.method?.startsWith('Animation.')) animEvents.push(msg);
});
await send('Animation.enable');
await new Promise(r => setTimeout(r, 2000));

// Get the backendNodeIds from animation events
const backendIds = [];
for (const evt of animEvents) {
  if (evt.method === 'Animation.animationStarted' && evt.params?.animation?.source?.backendNodeId) {
    backendIds.push(evt.params.animation.source.backendNodeId);
    console.log(`Animation ${evt.params.animation.id}: backendNodeId=${evt.params.animation.source.backendNodeId}`);
  }
}

// Try to push these nodes
if (backendIds.length > 0) {
  console.log('\nPushing backendNodeIds:', backendIds);
  const pushResult = await send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: backendIds });
  console.log('Push result:', JSON.stringify(pushResult.result));

  // Try to describe each node
  for (const nodeId of pushResult.result?.nodeIds || []) {
    try {
      const desc = await send('DOM.describeNode', { nodeId });
      console.log(`  Node ${nodeId}:`, desc.result?.node?.nodeName, desc.result?.node?.attributes?.slice(0, 6));
    } catch (e) {
      console.log(`  Node ${nodeId}: FAILED`, e.message);
    }
  }
}

ws.close();
process.exit(0);
