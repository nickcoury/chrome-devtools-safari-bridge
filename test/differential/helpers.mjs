/**
 * Shared test helpers for DOM traversal and common operations.
 */

export function findNode(node, localName) {
  if (!node?.children) return null;
  for (const child of node.children) {
    // Skip non-element nodes (DOCTYPE nodeType=10, text nodeType=3, comment nodeType=8)
    if (child.nodeType && child.nodeType !== 1) continue;
    if ((child.localName || child.nodeName?.toLowerCase()) === localName) return child;
  }
  return null;
}

export function findNodeByAttr(node, attrName, attrValue) {
  if (!node) return null;
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === attrName && attrs[i + 1] === attrValue) return node;
  }
  if (node.children) {
    for (const child of node.children) {
      const found = findNodeByAttr(child, attrName, attrValue);
      if (found) return found;
    }
  }
  return null;
}

export function findFirstElement(node) {
  if (!node?.children) return null;
  return node.children.find(c => c.nodeType === 1) || null;
}

export function getBodyNode(docResult) {
  const html = findNode(docResult.root, 'html');
  if (!html) throw new Error('No <html> node');
  const body = findNode(html, 'body');
  if (!body) throw new Error('No <body> node');
  return body;
}

/**
 * Get body node with retries — Chrome sometimes doesn't return full depth on first call.
 */
export async function getBodyNodeWithRetry(cdp) {
  // First try with depth -1
  let doc = await cdp.send('DOM.getDocument', { depth: -1 });
  let html = findNode(doc.root, 'html');
  let body = html ? findNode(html, 'body') : null;

  if (!body && html) {
    // Request children explicitly
    await cdp.send('DOM.requestChildNodes', { nodeId: html.nodeId, depth: -1 });
    await new Promise(r => setTimeout(r, 500));
    doc = await cdp.send('DOM.getDocument', { depth: -1 });
    html = findNode(doc.root, 'html');
    body = html ? findNode(html, 'body') : null;
  }

  if (!body) {
    // Last resort: use querySelector on document node
    const result = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'body' });
    if (result.nodeId) return { nodeId: result.nodeId };
    throw new Error('No <body> node found');
  }
  return body;
}

/**
 * Enable common domains needed by most tests.
 */
export async function enableDomains(cdp, domains = ['DOM', 'CSS', 'Runtime', 'Network', 'Debugger', 'Page']) {
  for (const domain of domains) {
    try {
      await cdp.send(`${domain}.enable`);
    } catch {
      // Some domains may not exist
    }
  }
  // Wait for initial events to arrive
  await new Promise(r => setTimeout(r, 1000));
}

/**
 * Create a test element on the page.
 */
export async function createTestElement(cdp, id = '__diff_test') {
  await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        let el = document.getElementById('${id}');
        if (!el) {
          el = document.createElement('div');
          el.id = '${id}';
          el.className = 'test-element';
          el.style.color = 'red';
          el.style.fontSize = '16px';
          el.textContent = 'test content';
          el.setAttribute('data-test', 'value');
          el.addEventListener('click', function onClick() {});
          document.body.appendChild(el);
        }
        return el.id;
      })()
    `,
    returnByValue: true,
  });
}

/**
 * Remove test element.
 */
export async function removeTestElement(cdp, id = '__diff_test') {
  await cdp.send('Runtime.evaluate', {
    expression: `document.getElementById('${id}')?.remove()`,
  });
}

/**
 * Get the test element's nodeId — uses querySelector for reliability.
 * DOM.getDocument may not include dynamically created elements in WebKit bridge.
 */
export async function getTestElementNodeId(cdp, id = '__diff_test') {
  const doc = await cdp.send('DOM.getDocument', { depth: 1 });
  // Use querySelector which always works for dynamically created elements
  const result = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: `#${id}` });
  if (!result.nodeId) {
    // Fallback: try walking the full tree
    const fullDoc = await cdp.send('DOM.getDocument', { depth: -1 });
    const el = findNodeByAttr(fullDoc.root, 'id', id);
    if (!el) throw new Error(`Test element #${id} not found in DOM`);
    return { nodeId: el.nodeId, doc: fullDoc };
  }
  return { nodeId: result.nodeId, doc };
}
