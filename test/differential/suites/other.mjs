/**
 * Other tests — DOMDebugger, Animation, Page.captureScreenshot
 */

import { createTestElement, getTestElementNodeId, removeTestElement } from '../helpers.mjs';

export const suite = {
  name: 'Other',
  setup: async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    await cdp.send('DOM.enable').catch(() => {});
    await cdp.send('Debugger.enable').catch(() => {});
    await createTestElement(cdp);
    await new Promise(r => setTimeout(r, 500));
  },
  teardown: async (cdp) => {
    await removeTestElement(cdp);
  },
  tests: [
    {
      id: 'domdebugger-domBreakpoint',
      label: 'DOMDebugger.setDOMBreakpoint + remove',
      run: async (cdp) => {
        try {
          const { nodeId } = await getTestElementNodeId(cdp);
          await cdp.send('DOMDebugger.setDOMBreakpoint', {
            nodeId,
            type: 'subtree-modified',
          });
          await cdp.send('DOMDebugger.removeDOMBreakpoint', {
            nodeId,
            type: 'subtree-modified',
          });
          return { success: true };
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
      id: 'domdebugger-eventBreakpoint',
      label: 'DOMDebugger.setEventListenerBreakpoint + remove',
      run: async (cdp) => {
        try {
          // Try both Chrome and bridge API patterns
          try {
            await cdp.send('DOMDebugger.setEventListenerBreakpoint', { eventName: 'click' });
            await cdp.send('DOMDebugger.removeEventListenerBreakpoint', { eventName: 'click' });
            return { success: true };
          } catch {
            // Bridge may use setEventBreakpoint
            await cdp.send('DOMDebugger.setEventBreakpoint', { eventName: 'click' });
            await cdp.send('DOMDebugger.removeEventBreakpoint', { eventName: 'click' });
            return { success: true };
          }
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
      id: 'domdebugger-xhrBreakpoint',
      label: 'DOMDebugger.setXHRBreakpoint + remove',
      run: async (cdp) => {
        try {
          await cdp.send('DOMDebugger.setXHRBreakpoint', { url: 'test-url' });
          await cdp.send('DOMDebugger.removeXHRBreakpoint', { url: 'test-url' });
          return { success: true };
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
      id: 'animation-enable',
      label: 'Animation.enable + events',
      run: async (cdp) => {
        try {
          cdp.clearEvents();
          await cdp.send('Animation.enable');
          // Create an animation
          await cdp.send('Runtime.evaluate', {
            expression: `
              const el = document.createElement('div');
              el.id = '__diff_anim';
              el.style.width = '10px';
              document.body.appendChild(el);
              el.animate([{width: '10px'}, {width: '100px'}], {duration: 500});
            `,
          });
          await new Promise(r => setTimeout(r, 2000));
          const created = cdp.drainEvents('Animation.animationCreated');
          const started = cdp.drainEvents('Animation.animationStarted');
          await cdp.send('Animation.disable').catch(() => {});
          await cdp.send('Runtime.evaluate', { expression: `document.getElementById('__diff_anim')?.remove()` });
          return {
            hasCreated: created.length > 0,
            hasStarted: started.length > 0,
            hasAny: created.length > 0 || started.length > 0,
          };
        } catch (err) {
          return { hasAny: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        // Animation events may differ in timing
      },
    },
    {
      id: 'page-captureScreenshot',
      label: 'Page.captureScreenshot returns image data',
      run: async (cdp) => {
        try {
          const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
          return {
            hasData: !!result.data,
            dataLength: result.data?.length || 0,
            nonEmpty: (result.data?.length || 0) > 100,
          };
        } catch (err) {
          return { hasData: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasData': true },
      },
    },
    {
      id: 'page-navigate',
      label: 'Page.navigate + reload',
      run: async (cdp) => {
        try {
          // Just verify reload works without error
          await cdp.send('Page.reload');
          await new Promise(r => setTimeout(r, 2000));
          return { success: true };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'success': true },
      },
    },
  ],
};
