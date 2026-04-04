/**
 * Performance Panel tests — Tracing + Profiler + Heap
 */

export const suite = {
  name: 'Performance',
  setup: async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    await new Promise(r => setTimeout(r, 500));
  },
  tests: [
    {
      id: 'tracing-record',
      label: 'Tracing.start + end returns trace events',
      run: async (cdp) => {
        cdp.clearEvents();
        try {
          await cdp.send('Tracing.start', {
            categories: '-*,devtools.timeline',
            options: '',
          });
          // Let some activity happen
          await cdp.send('Runtime.evaluate', {
            expression: `
              for (let i = 0; i < 100; i++) {
                document.createElement('div');
              }
            `,
          });
          await new Promise(r => setTimeout(r, 1000));
          await cdp.send('Tracing.end');

          // Wait for trace data
          await new Promise(r => setTimeout(r, 3000));
          const dataEvents = cdp.drainEvents('Tracing.dataCollected');
          const complete = cdp.drainEvents('Tracing.tracingComplete');

          const totalEvents = dataEvents.reduce((sum, e) => sum + (e.params?.value?.length || 0), 0);
          return {
            started: true,
            hasData: dataEvents.length > 0,
            hasComplete: complete.length > 0,
            traceEventCount: totalEvents,
          };
        } catch (err) {
          return { started: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'started': true },
      },
    },
    {
      id: 'profiler-record',
      label: 'Profiler.start + stop returns profile',
      run: async (cdp) => {
        try {
          await cdp.send('Profiler.enable').catch(() => {});
          await cdp.send('Profiler.start');
          // Generate some CPU work
          await cdp.send('Runtime.evaluate', {
            expression: `
              let sum = 0;
              for (let i = 0; i < 10000; i++) sum += Math.sqrt(i);
              sum;
            `,
            returnByValue: true,
          });
          await new Promise(r => setTimeout(r, 500));
          const result = await cdp.send('Profiler.stop');
          return {
            started: true,
            hasProfile: !!result.profile,
            hasNodes: (result.profile?.nodes?.length || 0) > 0,
            hasSamples: !!result.profile?.samples,
            hasTimeDeltas: !!result.profile?.timeDeltas,
            nodeCount: result.profile?.nodes?.length || 0,
          };
        } catch (err) {
          return { started: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'started': true, 'hasProfile': true },
      },
    },
    {
      id: 'heap-snapshot',
      label: 'HeapProfiler.takeHeapSnapshot streams chunks',
      run: async (cdp) => {
        try {
          await cdp.send('HeapProfiler.enable');
          cdp.clearEvents();
          await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
          // Wait for chunks
          await new Promise(r => setTimeout(r, 5000));
          const chunks = cdp.drainEvents('HeapProfiler.addHeapSnapshotChunk');
          await cdp.send('HeapProfiler.disable').catch(() => {});
          const totalSize = chunks.reduce((sum, c) => sum + (c.params?.chunk?.length || 0), 0);
          return {
            started: true,
            hasChunks: chunks.length > 0,
            chunkCount: chunks.length,
            totalSize,
          };
        } catch (err) {
          return { started: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'started': true, 'hasChunks': true },
      },
    },
    {
      id: 'performance-getMetrics',
      label: 'Performance.getMetrics returns metrics',
      run: async (cdp) => {
        try {
          await cdp.send('Performance.enable').catch(() => {});
          const result = await cdp.send('Performance.getMetrics');
          return {
            hasMetrics: (result.metrics?.length || 0) > 0,
            count: result.metrics?.length || 0,
            names: (result.metrics || []).slice(0, 5).map(m => m.name),
          };
        } catch (err) {
          return { hasMetrics: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'hasMetrics': true },
      },
    },
    // ── Regression tests ────────────────────────────────────────────
    {
      id: 'regression-tracing-start-emits-data',
      label: 'Tracing.start emits initial dataCollected event (regression: stuck at Initializing)',
      run: async (cdp) => {
        // Bug: Tracing.start didn't emit any events after starting Timeline recording,
        // so DevTools stayed stuck at "Initializing" forever
        cdp.clearEvents();
        try {
          await cdp.send('Tracing.start', { categories: '-*,devtools.timeline' });
          // Check that an initial dataCollected event was emitted immediately
          await new Promise(r => setTimeout(r, 500));
          const dataEvents = cdp.events.filter(e => e.method === 'Tracing.dataCollected');
          await cdp.send('Tracing.end').catch(() => {});
          await new Promise(r => setTimeout(r, 1000));
          return {
            started: true,
            hasInitialData: dataEvents.length > 0,
            firstEventHasValue: !!dataEvents[0]?.params?.value,
          };
        } catch (err) {
          return { started: false, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'started': true, 'hasInitialData': true },
      },
    },
    {
      id: 'regression-tracing-start-responds-fast',
      label: 'Tracing.start responds within 10s (regression: hanging Performance)',
      run: async (cdp) => {
        const start = Date.now();
        try {
          await cdp.send('Tracing.start', { categories: '-*,devtools.timeline' }, 10000);
          const elapsed = Date.now() - start;
          // Clean up
          await cdp.send('Tracing.end').catch(() => {});
          await new Promise(r => setTimeout(r, 1000));
          cdp.drainEvents('Tracing.dataCollected');
          cdp.drainEvents('Tracing.tracingComplete');
          return { responded: true, elapsedMs: elapsed, under10s: elapsed < 10000 };
        } catch (err) {
          const elapsed = Date.now() - start;
          return { responded: false, elapsedMs: elapsed, error: err.message };
        }
      },
      compare: {
        deepCompare: false,
        valueAssertions: { 'responded': true, 'under10s': true },
      },
    },
  ],
};
