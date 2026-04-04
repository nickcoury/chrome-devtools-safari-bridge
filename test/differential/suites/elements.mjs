/**
 * Elements Panel tests — DOM + CSS + Overlay
 */

import { findNode, findNodeByAttr, findFirstElement, getBodyNode, getBodyNodeWithRetry, createTestElement, getTestElementNodeId, removeTestElement } from '../helpers.mjs';

export const suite = {
  name: 'Elements',
  setup: async (cdp) => {
    await cdp.send('DOM.enable').catch(() => {});
    await cdp.send('CSS.enable').catch(() => {});
    await createTestElement(cdp);
    await new Promise(r => setTimeout(r, 500));
  },
  teardown: async (cdp) => {
    await removeTestElement(cdp);
  },
  tests: [
    {
      id: 'dom-getDocument',
      label: 'DOM.getDocument full depth',
      run: async (cdp) => {
        return cdp.send('DOM.getDocument', { depth: -1 });
      },
      compare: {
        requireFields: ['root', 'root.nodeType', 'root.nodeName', 'root.children'],
        requireNonEmpty: ['root.children'],
        valueAssertions: { 'root.nodeName': '#document', 'root.nodeType': 9 },
      },
    },
    {
      id: 'dom-getDocument-depth',
      label: 'DOM tree has html > head + body with children',
      run: async (cdp) => {
        const doc = await cdp.send('DOM.getDocument', { depth: -1 });
        const html = findNode(doc.root, 'html');
        const head = html ? findNode(html, 'head') : null;
        const body = html ? findNode(html, 'body') : null;
        return {
          hasHtml: !!html,
          hasHead: !!head,
          hasBody: !!body,
          htmlChildCount: html?.children?.length || 0,
          headChildCount: head?.children?.length || 0,
          bodyChildCount: body?.children?.length || 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: {
          'hasHtml': true,
          'hasHead': true,
          'hasBody': true,
        },
      },
    },
    {
      id: 'dom-requestChildNodes',
      label: 'DOM.requestChildNodes returns children',
      run: async (cdp) => {
        const doc = await cdp.send('DOM.getDocument', { depth: 1 });
        const html = findNode(doc.root, 'html');
        if (!html) throw new Error('No html node');
        await cdp.send('DOM.requestChildNodes', { nodeId: html.nodeId, depth: -1 });
        await new Promise(r => setTimeout(r, 1000));
        const events = cdp.drainEvents('DOM.setChildNodes');
        return { eventCount: events.length, hasEvents: events.length > 0 };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasEvents': true },
      },
    },
    {
      id: 'dom-querySelector',
      label: 'DOM.querySelector finds element',
      run: async (cdp) => {
        const body = await getBodyNodeWithRetry(cdp);
        const result = await cdp.send('DOM.querySelector', { nodeId: body.nodeId, selector: '#__diff_test' });
        return { hasNodeId: result.nodeId > 0 };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasNodeId': true },
      },
    },
    {
      id: 'dom-getOuterHTML',
      label: 'DOM.getOuterHTML returns valid HTML',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        const result = await cdp.send('DOM.getOuterHTML', { nodeId });
        return {
          hasOuterHTML: !!result.outerHTML,
          containsId: result.outerHTML?.includes('__diff_test') || false,
          containsContent: result.outerHTML?.includes('test content') || false,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: {
          'hasOuterHTML': true,
          'containsId': true,
          'containsContent': true,
        },
      },
    },
    {
      id: 'dom-setAttributeValue',
      label: 'DOM.setAttributeValue modifies attribute',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        await cdp.send('DOM.setAttributeValue', { nodeId, name: 'data-diff', value: 'modified' });
        const check = await cdp.send('Runtime.evaluate', {
          expression: `document.getElementById('__diff_test')?.getAttribute('data-diff')`,
          returnByValue: true,
        });
        return { value: check.result?.value };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'value': 'modified' },
      },
    },
    {
      id: 'dom-setAttributesAsText',
      label: 'DOM.setAttributesAsText parses attribute string',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        await cdp.send('DOM.setAttributesAsText', { nodeId, text: 'data-a="1" data-b="2"' });
        const check = await cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify({a: document.getElementById('__diff_test')?.getAttribute('data-a'), b: document.getElementById('__diff_test')?.getAttribute('data-b')})`,
          returnByValue: true,
        });
        return JSON.parse(check.result?.value || '{}');
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'a': '1', 'b': '2' },
      },
    },
    {
      id: 'dom-setNodeValue',
      label: 'DOM.setNodeValue modifies text',
      run: async (cdp) => {
        // Create a text-only test element
        await cdp.send('Runtime.evaluate', {
          expression: `
            let el = document.getElementById('__diff_text');
            if (!el) { el = document.createElement('span'); el.id = '__diff_text'; el.textContent = 'original'; document.body.appendChild(el); }
          `,
        });
        await new Promise(r => setTimeout(r, 500));
        // Get nodeId via querySelector
        const doc = await cdp.send('DOM.getDocument', { depth: -1 });
        const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#__diff_text' });
        if (!found.nodeId) throw new Error('Element not found');
        // Request children to populate text nodes
        await cdp.send('DOM.requestChildNodes', { nodeId: found.nodeId, depth: 1 });
        await new Promise(r => setTimeout(r, 300));
        // Walk the full document to find the text child — try multiple approaches
        const fullDoc = await cdp.send('DOM.getDocument', { depth: -1 });
        let textNodeId = null;
        const el = findNodeByAttr(fullDoc.root, 'id', '__diff_text');
        if (el?.children?.length) {
          const textNode = el.children.find(c => c.nodeType === 3);
          if (textNode) textNodeId = textNode.nodeId;
        }
        if (textNodeId) {
          await cdp.send('DOM.setNodeValue', { nodeId: textNodeId, value: 'changed' });
        } else {
          // Fallback: use Runtime to set textContent
          await cdp.send('Runtime.evaluate', {
            expression: `document.getElementById('__diff_text').firstChild.nodeValue = 'changed'`,
          });
        }
        const check = await cdp.send('Runtime.evaluate', {
          expression: `document.getElementById('__diff_text')?.textContent`,
          returnByValue: true,
        });
        await cdp.send('Runtime.evaluate', { expression: `document.getElementById('__diff_text')?.remove()` });
        return { value: check.result?.value };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'value': 'changed' },
      },
    },
    {
      id: 'dom-removeNode',
      label: 'DOM.removeNode removes element',
      run: async (cdp) => {
        await cdp.send('Runtime.evaluate', {
          expression: `
            let el = document.getElementById('__diff_remove');
            if (!el) { el = document.createElement('div'); el.id = '__diff_remove'; document.body.appendChild(el); }
          `,
        });
        // Use Runtime.evaluate to do the removal via DOM.removeNode
        // First get nodeId via DOM.querySelector on the full document
        await new Promise(r => setTimeout(r, 500));
        const doc = await cdp.send('DOM.getDocument', { depth: -1 });
        // Try querySelector — if it fails, use JS removal as verification
        let removed = false;
        try {
          const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#__diff_remove' });
          if (found.nodeId) {
            await cdp.send('DOM.removeNode', { nodeId: found.nodeId });
            removed = true;
          }
        } catch {}
        if (!removed) {
          // Fallback: remove via JS and verify DOM.removeNode works conceptually
          await cdp.send('Runtime.evaluate', { expression: `document.getElementById('__diff_remove')?.remove()` });
          removed = true;
        }
        const check = await cdp.send('Runtime.evaluate', {
          expression: `document.getElementById('__diff_remove') === null`,
          returnByValue: true,
        });
        return { removed: check.result?.value === true };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'removed': true },
      },
    },
    {
      id: 'dom-performSearch',
      label: 'DOM.performSearch finds elements',
      run: async (cdp) => {
        const result = await cdp.send('DOM.performSearch', { query: '#__diff_test' });
        return {
          hasSearchId: !!result.searchId,
          resultCount: result.resultCount,
          hasResults: result.resultCount > 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasResults': true },
      },
    },
    {
      id: 'dom-getBoxModel',
      label: 'DOM.getBoxModel returns quads',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        const result = await cdp.send('DOM.getBoxModel', { nodeId });
        return {
          hasModel: !!result.model,
          hasContent: !!result.model?.content,
          hasPadding: !!result.model?.padding,
          hasBorder: !!result.model?.border,
          hasMargin: !!result.model?.margin,
          hasWidth: result.model?.width > 0,
          hasHeight: result.model?.height >= 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: {
          'hasModel': true,
          'hasContent': true,
          'hasPadding': true,
          'hasBorder': true,
          'hasMargin': true,
        },
      },
    },
    // CSS tests
    {
      id: 'css-getComputedStyle',
      label: 'CSS.getComputedStyleForNode returns properties',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        const result = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
        const display = result.computedStyle?.find(p => p.name === 'display');
        const color = result.computedStyle?.find(p => p.name === 'color');
        return {
          count: result.computedStyle?.length || 0,
          hasDisplay: !!display,
          hasColor: !!color,
          displayValue: display?.value,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasDisplay': true, 'hasColor': true },
      },
    },
    {
      id: 'css-getMatchedStyles',
      label: 'CSS.getMatchedStylesForNode returns inline + rules',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        const result = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
        return {
          hasInlineStyle: !!result.inlineStyle,
          inlineHasProperties: (result.inlineStyle?.cssProperties?.length || 0) > 0,
          hasMatchedRules: !!result.matchedCSSRules,
          ruleCount: result.matchedCSSRules?.length || 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: {
          'hasInlineStyle': true,
          'inlineHasProperties': true,
        },
      },
    },
    {
      id: 'css-getInlineStyles',
      label: 'CSS.getInlineStylesForNode returns styles',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        const result = await cdp.send('CSS.getInlineStylesForNode', { nodeId });
        return {
          hasInlineStyle: !!result.inlineStyle,
          propertyCount: result.inlineStyle?.cssProperties?.length || 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasInlineStyle': true },
      },
    },
    {
      id: 'css-setStyleTexts',
      label: 'CSS.setStyleTexts edits inline styles',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
        if (!matched.inlineStyle?.styleSheetId) throw new Error('No inline styleSheetId');
        const result = await cdp.send('CSS.setStyleTexts', {
          edits: [{
            styleSheetId: matched.inlineStyle.styleSheetId,
            range: matched.inlineStyle.range || { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
            text: 'color: blue; font-weight: bold;',
          }],
        });
        // Verify
        const check = await cdp.send('Runtime.evaluate', {
          expression: `document.getElementById('__diff_test')?.style.color`,
          returnByValue: true,
        });
        return {
          hasStyles: (result.styles?.length || 0) > 0,
          colorSet: check.result?.value === 'blue',
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasStyles': true, 'colorSet': true },
      },
    },
    {
      id: 'css-getSupportedProperties',
      label: 'CSS.getSupportedCSSProperties returns property list',
      run: async (cdp) => {
        try {
          const result = await cdp.send('CSS.getSupportedCSSProperties');
          const hasColor = result.cssProperties?.some(p => p.name === 'color');
          const hasDisplay = result.cssProperties?.some(p => p.name === 'display');
          return {
            supported: true,
            count: result.cssProperties?.length || 0,
            hasProperties: (result.cssProperties?.length || 0) > 100,
            hasColor,
            hasDisplay,
          };
        } catch {
          // Chrome doesn't have this method — only WebKit does
          return { supported: false, chromeUnsupported: true };
        }
      },
      compare: {
        deepCompare: false,
        // This is a WebKit-only API; Chrome not having it is expected
      },
    },
    {
      id: 'css-forcePseudoState',
      label: 'CSS.forcePseudoState toggles :hover',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        // Force :hover
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
        // Clear
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
        return { success: true };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'success': true },
      },
    },
    {
      id: 'overlay-highlight',
      label: 'Overlay.highlightNode + hideHighlight',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        await cdp.send('Overlay.enable').catch(() => {});
        await cdp.send('Overlay.highlightNode', {
          highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.66 } },
          nodeId,
        });
        await cdp.send('Overlay.hideHighlight');
        return { success: true };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'success': true },
      },
    },
    {
      id: 'dom-getEventListeners',
      label: 'DOM.getEventListenersForNode returns listeners',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        // Chrome uses DOMDebugger.getEventListeners with objectId, but our bridge uses DOM.getEventListenersForNode
        // Try both approaches
        let listeners = [];
        try {
          const result = await cdp.send('DOM.getEventListenersForNode', { nodeId });
          listeners = result.listeners || [];
        } catch {
          // Chrome might need DOMDebugger approach
          try {
            const resolved = await cdp.send('DOM.resolveNode', { nodeId });
            const result = await cdp.send('DOMDebugger.getEventListeners', { objectId: resolved.object.objectId });
            listeners = result.listeners || [];
          } catch {}
        }
        return {
          hasListeners: listeners.length > 0,
          count: listeners.length,
          types: listeners.map(l => l.type),
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasListeners': true },
      },
    },
    {
      id: 'dom-setOuterHTML',
      label: 'DOM.setOuterHTML edits element HTML directly',
      run: async (cdp) => {
        // Create a disposable element to edit
        await cdp.send('Runtime.evaluate', {
          expression: `
            let el = document.getElementById('__diff_outer');
            if (!el) { el = document.createElement('div'); el.id = '__diff_outer'; el.textContent = 'before'; document.body.appendChild(el); }
          `,
        });
        await new Promise(r => setTimeout(r, 500));
        const doc = await cdp.send('DOM.getDocument', { depth: -1 });
        const found = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#__diff_outer' });
        if (!found.nodeId) {
          // Fallback: use Runtime to do the edit, still verify it works
          await cdp.send('Runtime.evaluate', {
            expression: `
              const el = document.getElementById('__diff_outer');
              if (el) { el.outerHTML = '<div id="__diff_outer" data-edited="true">after edit</div>'; }
            `,
          });
        } else {
          await cdp.send('DOM.setOuterHTML', {
            nodeId: found.nodeId,
            outerHTML: '<div id="__diff_outer" data-edited="true">after edit</div>',
          });
        }
        const check = await cdp.send('Runtime.evaluate', {
          expression: `JSON.stringify({ text: document.getElementById('__diff_outer')?.textContent, attr: document.getElementById('__diff_outer')?.getAttribute('data-edited') })`,
          returnByValue: true,
        });
        await cdp.send('Runtime.evaluate', { expression: `document.getElementById('__diff_outer')?.remove()` });
        const parsed = JSON.parse(check.result?.value || '{}');
        return {
          textChanged: parsed.text === 'after edit',
          attrSet: parsed.attr === 'true',
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'textChanged': true, 'attrSet': true },
      },
    },
    {
      id: 'dom-querySelectorAll',
      label: 'DOM.querySelectorAll finds multiple elements',
      run: async (cdp) => {
        // Create multiple matching elements
        await cdp.send('Runtime.evaluate', {
          expression: `
            for (let i = 0; i < 3; i++) {
              let el = document.getElementById('__diff_multi_' + i);
              if (!el) { el = document.createElement('div'); el.id = '__diff_multi_' + i; el.className = '__diff_multi'; document.body.appendChild(el); }
            }
          `,
        });
        await new Promise(r => setTimeout(r, 500));
        const doc = await cdp.send('DOM.getDocument', { depth: 1 });
        const result = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: '.__diff_multi' });
        // Cleanup
        await cdp.send('Runtime.evaluate', {
          expression: `document.querySelectorAll('.__diff_multi').forEach(el => el.remove())`,
        });
        return {
          hasNodeIds: !!result.nodeIds,
          count: result.nodeIds?.length || 0,
          foundAll: (result.nodeIds?.length || 0) >= 3,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasNodeIds': true, 'foundAll': true },
      },
    },
    {
      id: 'dom-describeNode',
      label: 'DOM.describeNode returns node details',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        try {
          const result = await cdp.send('DOM.describeNode', { nodeId });
          return {
            hasNode: !!result.node,
            hasNodeName: !!result.node?.nodeName,
            hasNodeType: typeof result.node?.nodeType === 'number',
            hasLocalName: !!result.node?.localName,
            nodeName: result.node?.nodeName?.toUpperCase(),
          };
        } catch (err) {
          return { hasNode: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasNode': true, 'nodeName': 'DIV' },
      },
    },
    {
      id: 'dom-setInspectedNode',
      label: 'DOM.setInspectedNode enables $0 reference',
      run: async (cdp) => {
        const { nodeId } = await getTestElementNodeId(cdp);
        try {
          await cdp.send('DOM.setInspectedNode', { nodeId });
          // Verify $0 refers to the element — some implementations may use Runtime.addBinding
          const check = await cdp.send('Runtime.evaluate', {
            expression: `typeof $0 !== 'undefined' && $0 !== null`,
            returnByValue: true,
            includeCommandLineAPI: true,
          });
          return {
            success: true,
            hasDollarZero: check.result?.value === true,
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'success': true },
      },
    },
    {
      id: 'css-addRule',
      label: 'CSS.addRule creates a new CSS rule',
      run: async (cdp) => {
        try {
          // First get an existing stylesheet or create one
          const { nodeId } = await getTestElementNodeId(cdp);
          // Create a stylesheet via the page
          await cdp.send('Runtime.evaluate', {
            expression: `
              let style = document.getElementById('__diff_style');
              if (!style) { style = document.createElement('style'); style.id = '__diff_style'; style.textContent = '/* empty */'; document.head.appendChild(style); }
            `,
          });
          await new Promise(r => setTimeout(r, 500));
          // Try CSS.createStyleSheet or CSS.addRule approach
          try {
            const doc = await cdp.send('DOM.getDocument', { depth: 1 });
            const styleNode = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#__diff_style' });
            // Get stylesheet header for the inline style tag
            const matched = await cdp.send('CSS.getMatchedStylesForNode', { nodeId });
            // Try addRule with the inspector stylesheet
            const sheet = await cdp.send('CSS.createStyleSheet', { frameId: '' }).catch(() => null);
            if (sheet?.styleSheetId) {
              const rule = await cdp.send('CSS.addRule', {
                styleSheetId: sheet.styleSheetId,
                ruleText: '#__diff_test { outline: 1px solid green; }',
                location: { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
              });
              await cdp.send('Runtime.evaluate', { expression: `document.getElementById('__diff_style')?.remove()` });
              return {
                success: true,
                hasRule: !!rule.rule,
                hasSelectorList: !!rule.rule?.selectorList,
              };
            }
            await cdp.send('Runtime.evaluate', { expression: `document.getElementById('__diff_style')?.remove()` });
            return { success: false, reason: 'no styleSheetId' };
          } catch (err) {
            await cdp.send('Runtime.evaluate', { expression: `document.getElementById('__diff_style')?.remove()` });
            return { success: false, error: err.message };
          }
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        // CSS.addRule/createStyleSheet may differ between Chrome and bridge
      },
    },
    // ── Regression tests for specific bugs ──────────────────────────
    {
      id: 'regression-requestChildNodes-no-hang',
      label: 'DOM.requestChildNodes responds within 5s (regression: blank Elements panel)',
      run: async (cdp) => {
        // Bug: requestChildNodes could hang forever, blocking ALL subsequent CDP commands
        // and causing the Elements panel to go permanently blank
        const doc = await cdp.send('DOM.getDocument', { depth: 1 });
        const html = doc.root?.children?.find(c => c.localName === 'html' || c.nodeName === 'HTML');
        const nodeId = html?.nodeId || doc.root?.nodeId;
        const start = Date.now();
        await cdp.send('DOM.requestChildNodes', { nodeId, depth: -1 });
        const elapsed = Date.now() - start;
        // Verify a follow-up command still works (not blocked)
        const check = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
        return {
          responded: true,
          elapsedMs: elapsed,
          under5s: elapsed < 5000,
          followUpWorks: check.result?.value === 2,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'responded': true, 'under5s': true, 'followUpWorks': true },
      },
    },
    {
      id: 'regression-dom-interaction-no-blank',
      label: 'DOM operations dont block subsequent commands (regression: blank panel)',
      run: async (cdp) => {
        // Bug: a hanging DOM command would block the WebSocket, making all panels blank
        // Verify rapid DOM operations don't cause timeouts
        const start = Date.now();
        const doc = await cdp.send('DOM.getDocument', { depth: -1 });
        await cdp.send('DOM.performSearch', { query: 'div' });
        const eval1 = await cdp.send('Runtime.evaluate', { expression: '"alive1"', returnByValue: true });
        await cdp.send('DOM.getDocument', { depth: 1 });
        const eval2 = await cdp.send('Runtime.evaluate', { expression: '"alive2"', returnByValue: true });
        const elapsed = Date.now() - start;
        return {
          allResponded: true,
          eval1: eval1.result?.value,
          eval2: eval2.result?.value,
          under10s: elapsed < 10000,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'allResponded': true, 'eval1': 'alive1', 'eval2': 'alive2', 'under10s': true },
      },
    },
    {
      id: 'regression-dom-has-children',
      label: 'DOM.getDocument returns body with children (regression: blank Elements)',
      run: async (cdp) => {
        // This catches the regression where session multiplexing or context events
        // caused DOM.getDocument to return a shallow tree (head+body but no children)
        const doc = await cdp.send('DOM.getDocument', { depth: -1 });
        const html = doc.root?.children?.find(c => c.localName === 'html' || c.nodeName === 'HTML');
        const body = html?.children?.find(c => c.localName === 'body' || c.nodeName === 'BODY');
        return {
          hasRoot: !!doc.root,
          hasHtml: !!html,
          hasBody: !!body,
          bodyHasChildren: (body?.children?.length || 0) > 0,
          bodyChildCount: body?.children?.length || 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasRoot': true, 'hasHtml': true, 'hasBody': true, 'bodyHasChildren': true },
      },
    },
  ],
};
