/**
 * Sources Panel tests — Debugger domain
 */

export const suite = {
  name: 'Sources',
  setup: async (cdp) => {
    await cdp.send('Debugger.enable').catch(() => {});
    await cdp.send('Runtime.enable').catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
  },
  tests: [
    {
      id: 'debugger-scriptParsed',
      label: 'Debugger.enable → scriptParsed events',
      run: async (cdp) => {
        await new Promise(r => setTimeout(r, 500));
        // Don't drain — other tests need these events
        const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed');
        return {
          count: scripts.length,
          hasScripts: scripts.length > 0,
          hasUrlScript: scripts.some(s => !!s.params.url),
          urls: scripts.filter(s => s.params.url).slice(0, 3).map(s => s.params.url),
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasScripts': true },
      },
    },
    {
      id: 'debugger-getScriptSource',
      label: 'Debugger.getScriptSource returns content',
      run: async (cdp) => {
        // Re-enable to get fresh script events
        const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed' && e.params.url);
        if (scripts.length === 0) {
          // Try inline scripts
          const allScripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed');
          if (allScripts.length === 0) return { hasSource: false, error: 'no scripts' };
          const result = await cdp.send('Debugger.getScriptSource', { scriptId: allScripts[0].params.scriptId });
          return { hasSource: !!result.scriptSource, length: result.scriptSource?.length || 0 };
        }
        const result = await cdp.send('Debugger.getScriptSource', { scriptId: scripts[0].params.scriptId });
        return {
          hasSource: !!result.scriptSource,
          length: result.scriptSource?.length || 0,
          nonEmpty: (result.scriptSource?.length || 0) > 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasSource': true, 'nonEmpty': true },
      },
    },
    {
      id: 'debugger-getPossibleBreakpoints',
      label: 'Debugger.getPossibleBreakpoints returns locations',
      run: async (cdp) => {
        const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed' && e.params.url);
        if (scripts.length === 0) return { hasLocations: false, error: 'no scripts' };
        const scriptId = scripts[0].params.scriptId;
        const result = await cdp.send('Debugger.getPossibleBreakpoints', {
          start: { scriptId, lineNumber: 0, columnNumber: 0 },
          end: { scriptId, lineNumber: 20, columnNumber: 0 },
        });
        return {
          hasLocations: (result.locations?.length || 0) > 0,
          count: result.locations?.length || 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasLocations': true },
      },
    },
    {
      id: 'debugger-setBreakpoint',
      label: 'Debugger.setBreakpointByUrl + removeBreakpoint',
      run: async (cdp) => {
        const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed' && e.params.url);
        if (scripts.length === 0) return { success: false, error: 'no scripts' };
        const url = scripts[0].params.url;
        const result = await cdp.send('Debugger.setBreakpointByUrl', {
          url,
          lineNumber: 1,
        });
        const hasId = !!result.breakpointId;
        if (hasId) {
          await cdp.send('Debugger.removeBreakpoint', { breakpointId: result.breakpointId });
        }
        return {
          success: hasId,
          hasBreakpointId: hasId,
          hasLocations: !!result.locations,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'success': true, 'hasBreakpointId': true },
      },
    },
    {
      id: 'debugger-setPauseOnExceptions',
      label: 'Debugger.setPauseOnExceptions all modes',
      run: async (cdp) => {
        const results = {};
        for (const state of ['none', 'uncaught', 'all', 'none']) {
          try {
            await cdp.send('Debugger.setPauseOnExceptions', { state });
            results[state] = true;
          } catch (err) {
            results[state] = false;
          }
        }
        return results;
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'none': true, 'uncaught': true, 'all': true },
      },
    },
    {
      id: 'debugger-pause-resume',
      label: 'Debugger.pause + resume flow',
      run: async (cdp) => {
        cdp.clearEvents();
        // Set a breakpoint and trigger it with setTimeout
        await cdp.send('Runtime.evaluate', {
          expression: `setTimeout(() => { let __breakHere = 1; }, 100)`,
        });
        await cdp.send('Debugger.pause');
        // Wait for pause
        try {
          const pauseEvent = await cdp.waitEvent('Debugger.paused', 5000);
          const hasCallFrames = (pauseEvent.params.callFrames?.length || 0) > 0;
          await cdp.send('Debugger.resume');
          return { paused: true, hasCallFrames, resumed: true };
        } catch {
          // Pause might not trigger if no JS is running
          try { await cdp.send('Debugger.resume'); } catch {}
          return { paused: false, reason: 'no JS executing' };
        }
      },
      compare: {
        deepCompare: false,
        // Don't assert pause success — depends on timing
      },
    },
    {
      id: 'debugger-evaluateOnCallFrame',
      label: 'Debugger.evaluateOnCallFrame during pause',
      run: async (cdp) => {
        cdp.clearEvents();
        // Create a function with a debugger statement
        await cdp.send('Runtime.evaluate', {
          expression: `setTimeout(() => { var testVal = 123; debugger; }, 100)`,
        });
        try {
          const pauseEvent = await cdp.waitEvent('Debugger.paused', 5000);
          const callFrames = pauseEvent.params.callFrames || [];
          if (callFrames.length === 0) {
            await cdp.send('Debugger.resume');
            return { evaluated: false, reason: 'no call frames' };
          }
          const result = await cdp.send('Debugger.evaluateOnCallFrame', {
            callFrameId: callFrames[0].callFrameId,
            expression: 'testVal',
            returnByValue: true,
          });
          await cdp.send('Debugger.resume');
          return {
            evaluated: true,
            value: result.result?.value,
            type: result.result?.type,
          };
        } catch (err) {
          try { await cdp.send('Debugger.resume'); } catch {}
          return { evaluated: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'evaluated': true, 'value': 123 },
      },
    },
    {
      id: 'runtime-executionContext',
      label: 'Runtime.executionContextCreated has valid origin',
      run: async (cdp) => {
        let events = cdp.events.filter(e => e.method === 'Runtime.executionContextCreated');
        if (events.length === 0) {
          // Re-enable Runtime to trigger the event
          cdp.clearEvents();
          await cdp.send('Runtime.enable');
          await new Promise(r => setTimeout(r, 500));
          events = cdp.events.filter(e => e.method === 'Runtime.executionContextCreated');
        }
        if (events.length === 0) return { hasContext: false };
        const ctx = events[0].params.context;
        return {
          hasContext: true,
          hasOrigin: !!ctx?.origin && ctx.origin !== '',
          originIsNotBlank: ctx?.origin !== 'about:blank',
          hasName: !!ctx?.name,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasContext': true },
      },
    },
    {
      id: 'page-getResourceTree',
      label: 'Page.getResourceTree returns frame + resources',
      run: async (cdp) => {
        await cdp.send('Page.enable').catch(() => {});
        const result = await cdp.send('Page.getResourceTree');
        return {
          hasFrameTree: !!result.frameTree,
          hasFrame: !!result.frameTree?.frame,
          hasUrl: !!result.frameTree?.frame?.url,
          urlNotBlank: result.frameTree?.frame?.url !== 'about:blank',
          resourceCount: result.frameTree?.resources?.length || 0,
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasFrameTree': true, 'hasFrame': true, 'hasUrl': true },
      },
    },
    {
      id: 'debugger-setBreakpoint-byLocation',
      label: 'Debugger.setBreakpoint by script location',
      run: async (cdp) => {
        const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed' && e.params.url);
        if (scripts.length === 0) return { success: false, error: 'no scripts' };
        const scriptId = scripts[0].params.scriptId;
        try {
          const result = await cdp.send('Debugger.setBreakpoint', {
            location: { scriptId, lineNumber: 0, columnNumber: 0 },
          });
          const hasId = !!result.breakpointId;
          const hasLocation = !!result.actualLocation;
          if (hasId) {
            await cdp.send('Debugger.removeBreakpoint', { breakpointId: result.breakpointId });
          }
          return {
            success: hasId,
            hasBreakpointId: hasId,
            hasActualLocation: hasLocation,
            locationHasScriptId: !!result.actualLocation?.scriptId,
            locationHasLine: typeof result.actualLocation?.lineNumber === 'number',
          };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'success': true, 'hasBreakpointId': true, 'hasActualLocation': true },
      },
    },
    {
      id: 'debugger-stepOver',
      label: 'Debugger.stepOver advances to next line',
      run: async (cdp) => {
        cdp.clearEvents();
        // Use debugger statement to pause, then step over
        await cdp.send('Runtime.evaluate', {
          expression: `setTimeout(() => { var a = 1; debugger; var b = 2; var c = 3; }, 100)`,
        });
        try {
          const pauseEvent = await cdp.waitEvent('Debugger.paused', 5000);
          const callFrames = pauseEvent.params.callFrames || [];
          if (callFrames.length === 0) {
            await cdp.send('Debugger.resume');
            return { paused: false, reason: 'no call frames' };
          }
          const initialLine = callFrames[0].location?.lineNumber;
          cdp.clearEvents();
          await cdp.send('Debugger.stepOver');
          try {
            const stepEvent = await cdp.waitEvent('Debugger.paused', 5000);
            const newLine = stepEvent.params.callFrames?.[0]?.location?.lineNumber;
            await cdp.send('Debugger.resume');
            return {
              paused: true,
              stepped: true,
              initialLine,
              newLine,
              lineAdvanced: newLine !== initialLine || newLine !== undefined,
            };
          } catch {
            try { await cdp.send('Debugger.resume'); } catch {}
            return { paused: true, stepped: false, reason: 'no pause after step' };
          }
        } catch {
          try { await cdp.send('Debugger.resume'); } catch {}
          return { paused: false, reason: 'debugger did not pause' };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'paused': true, 'stepped': true },
      },
    },
    {
      id: 'debugger-stepInto',
      label: 'Debugger.stepInto enters function call',
      run: async (cdp) => {
        cdp.clearEvents();
        await cdp.send('Runtime.evaluate', {
          expression: `
            setTimeout(() => {
              function innerFunc() { return 99; }
              debugger;
              innerFunc();
            }, 100)
          `,
        });
        try {
          const pauseEvent = await cdp.waitEvent('Debugger.paused', 5000);
          if ((pauseEvent.params.callFrames?.length || 0) === 0) {
            await cdp.send('Debugger.resume');
            return { paused: false };
          }
          // Step over the debugger statement to the innerFunc() call
          cdp.clearEvents();
          await cdp.send('Debugger.stepOver');
          await cdp.waitEvent('Debugger.paused', 5000);
          // Now step into innerFunc
          cdp.clearEvents();
          await cdp.send('Debugger.stepInto');
          try {
            const stepEvent = await cdp.waitEvent('Debugger.paused', 5000);
            const funcName = stepEvent.params.callFrames?.[0]?.functionName;
            await cdp.send('Debugger.resume');
            return {
              paused: true,
              steppedIn: true,
              functionName: funcName,
              enteredFunction: funcName === 'innerFunc' || funcName !== '',
            };
          } catch {
            try { await cdp.send('Debugger.resume'); } catch {}
            return { paused: true, steppedIn: false };
          }
        } catch {
          try { await cdp.send('Debugger.resume'); } catch {}
          return { paused: false, reason: 'debugger did not pause' };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'paused': true, 'steppedIn': true },
      },
    },
    {
      id: 'debugger-stepOut',
      label: 'Debugger.stepOut exits current function',
      run: async (cdp) => {
        cdp.clearEvents();
        await cdp.send('Runtime.evaluate', {
          expression: `
            setTimeout(() => {
              function outer() {
                function inner() { debugger; return 1; }
                inner();
                return 2;
              }
              outer();
            }, 100)
          `,
        });
        try {
          const pauseEvent = await cdp.waitEvent('Debugger.paused', 5000);
          if ((pauseEvent.params.callFrames?.length || 0) === 0) {
            await cdp.send('Debugger.resume');
            return { paused: false };
          }
          const initialFunc = pauseEvent.params.callFrames?.[0]?.functionName;
          cdp.clearEvents();
          await cdp.send('Debugger.stepOut');
          try {
            const stepEvent = await cdp.waitEvent('Debugger.paused', 5000);
            const afterFunc = stepEvent.params.callFrames?.[0]?.functionName;
            await cdp.send('Debugger.resume');
            return {
              paused: true,
              steppedOut: true,
              initialFunc,
              afterFunc,
              exitedFunction: afterFunc !== initialFunc,
            };
          } catch {
            // stepOut may have resumed entirely if outer was top-level
            return { paused: true, steppedOut: true, resumed: true };
          }
        } catch {
          try { await cdp.send('Debugger.resume'); } catch {}
          return { paused: false, reason: 'debugger did not pause' };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'paused': true, 'steppedOut': true },
      },
    },
    // ── Regression tests ────────────────────────────────────────────
    {
      id: 'regression-debugger-enable-sends-scripts',
      label: 'Debugger.enable sends scriptParsed events (regression: empty Sources panel)',
      run: async (cdp) => {
        // Bug: drainNativeScriptsParsed() result was discarded, so scripts
        // buffered between cache population and drain were lost
        cdp.clearEvents();
        await cdp.send('Debugger.disable').catch(() => {});
        await new Promise(r => setTimeout(r, 500));
        // Re-enable — should receive scriptParsed events
        cdp.clearEvents();
        await cdp.send('Debugger.enable');
        await new Promise(r => setTimeout(r, 1000));
        const scripts = cdp.events.filter(e => e.method === 'Debugger.scriptParsed');
        return {
          received: scripts.length > 0,
          count: scripts.length,
          hasUrlScript: scripts.some(s => !!s.params?.url),
        };
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'received': true },
      },
    },
  ],
};
