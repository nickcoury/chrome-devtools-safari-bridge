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

await send('DOM.enable');
const doc = await send('DOM.getDocument', { depth: 3 });

// Check if nodes have backendNodeId
function checkNode(node, depth = 0) {
  const indent = '  '.repeat(depth);
  const hasBackendNodeId = 'backendNodeId' in node;
  console.log(`${indent}${node.nodeName} nodeId=${node.nodeId} backendNodeId=${node.backendNodeId ?? 'MISSING'} ${hasBackendNodeId ? '✓' : '✗ MISSING'}`);
  for (const child of (node.children || []).slice(0, 5)) {
    checkNode(child, depth + 1);
  }
}

console.log('DOM tree backendNodeId check:');
checkNode(doc.result.root);

ws.close();
process.exit(0);
