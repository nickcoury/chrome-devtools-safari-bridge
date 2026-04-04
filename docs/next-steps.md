# Next Steps

## Current Status (April 4, 2026)

### Parity Results

| Platform | Parity | Tests |
|----------|--------|-------|
| Chrome (reference) | 100% | 86/86 |
| iPhone | 96.5% | 83/86 |
| Simulator | 96.5% | 83/86 |
| Desktop Safari | 23.3% | 20/86 |

### What works (iOS — iPhone + Simulator)
- **Elements**: full DOM tree, styles, computed, box model, attribute editing
- **Console**: message streaming (log/warn/error), evaluation, object expansion, deep nesting, exception details
- **Network**: request/response capture, headers, timing, response body, error tracking, dataReceived
- **Sources**: file tree populated (via session multiplexing), scriptParsed events, getScriptSource, breakpoints, stepping, evaluateOnCallFrame
- **Performance**: recording works (Overlay.disable + Page.stopLoading stubs fixed the hang), tracing matches Chrome 146 protocol
- **Application**: localStorage, sessionStorage, IndexedDB, cookies
- **Debugger**: breakpoints (by URL), pause/resume, step into/over/out, evaluateOnCallFrame, scope inspection
- **Animation**: CSS animation + Web Animation API events flow with correct format
- **Screenshots**: Page.captureScreenshot works on real devices
- **Other**: DOMDebugger (DOM/event/XHR breakpoints), HeapProfiler snapshots, Performance.getMetrics

### Known iPhone failures (3/86)
1. **DOM tree depth** — `DOM.getDocument` returns a shallow tree; children arrive via async `DOM.setChildNodes` events. Chrome returns the full tree inline. This doesn't affect DevTools UX (DevTools processes the events).
2. **DOM.setOuterHTML** — native WebKit `DOM.setOuterHTML` doesn't seem to take effect. Needs investigation.
3. **Debugger.setBreakpoint by scriptId** — WebKit may not support this variant. `setBreakpointByUrl` works fine and is what DevTools uses.

### What works (Desktop Safari)
- **Elements**: DOM tree (when extension active on a page), styles, highlighting
- **Sources**: panel loads (limited without native debugger)
- **Performance**: Tracing.start/end + Profiler stubs
- **Other**: Animation events, screenshots, navigation, Storage.getStorageKey

### Desktop limitations
The desktop bridge relies on a Safari Web Extension content script. This limits:
- No native debugger (breakpoints, stepping, callframes)
- No native network interception (only fetch/XHR hooks)
- DOM operations require round-trips to content script
- Extension must be active on the target page

## Next Priorities

### 1. Desktop DOM/Runtime fidelity (MEDIUM)
- `DOM.querySelector`/`querySelectorAll` now implemented via content script evaluate
- `Runtime.evaluate` returns basic types but needs proper objectId/exception handling
- `Runtime.getProperties` and `callFunctionOn` need implementation

### 2. Manual testing confirmation (HIGH)
- Performance recording: user needs to verify the Record button works in DevTools
- Animation drawer: verify animations display correctly
- Sources file tree: sometimes populates inconsistently (timing-dependent)

### 3. Test infrastructure (LOW)
- verify-panels.mjs passes 5/5 panels
- Differential tests cover 86 scenarios
- Sources panel Puppeteer switching is flaky in headless mode (fixed with &panel=sources)

## Architecture
- 11 domain-specific CDP handler methods in simulator.js (~3200 lines)
- Native WebKit Inspector Protocol for Debugger/Console/Network
- 200ms poll loop for event forwarding
- 86 differential parity tests comparing Chrome vs bridge
- Built-in performance profiling (BRIDGE_PERF=1)
- Panel verification script (test/verify-panels.mjs) — 5/5 passing
- Auto-detect iOS devices in launch script
