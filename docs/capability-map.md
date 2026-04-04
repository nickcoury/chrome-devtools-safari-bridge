# Chrome DevTools ↔ WebKit Inspector Capability Map

**Date**: April 4, 2026  
**Device**: iPhone 12 mini, iOS 26.3.1  
**WebKit Inspector Protocol**: probed via native WIR transport

## Legend

- ✅ **Working** — implemented and validated
- 🔧 **Needs work** — WebKit supports it, we haven't wired it up
- 🟡 **Partial** — works but missing features
- ⛔ **Not available** — WebKit doesn't expose this

---

## Elements Panel

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| DOM tree display | ✅ | DOM.getDocument | Full tree, unlimited depth |
| Node selection + highlight | ✅ | Runtime.evaluate (overlay div) | Margin/padding/border/content boxes |
| Edit HTML (outerHTML) | ✅ | Runtime.evaluate | Bidirectional |
| Edit attributes | ✅ | Runtime.evaluate | setAttribute/setAttributesAsText |
| Delete node | ✅ | Runtime.evaluate | removeNode |
| Edit text nodes | ✅ | Runtime.evaluate | setNodeValue |
| $0 console reference | ✅ | Runtime.evaluate | setInspectedNode → window.$0 |
| Box model display | ✅ | Runtime.evaluate | Real margin/padding/border quads |
| Computed styles | ✅ | Runtime.evaluate (getComputedStyle) | 434+ properties |
| Matched CSS rules | 🟡 | CSS.getMatchedStylesForNode (native!) | **Currently using JS fallback.** Native WebKit CSS domain has `getMatchedStylesForNode` — switch to it for real rule origins, selectors, media queries |
| Inline style editing | ✅ | Runtime.evaluate | Bidirectional via element.style |
| CSS property autocomplete | ✅ | CSS.getSupportedCSSProperties | Full property list with longhands/shorthands |
| Font information | 🔧 | CSS.getSupportedSystemFontFamilyNames | **WebKit returns all system fonts.** Not wired up |
| Force element state (:hover etc) | ✅ | CSS.forcePseudoState | Toggle :hover/:active/:focus |
| DOM search (Ctrl+F in Elements) | ✅ | DOM.performSearch + DOM.getSearchResults | Native WebKit search |
| Event listeners panel | ✅ | DOM.getEventListenersForNode | Native WebKit event listeners |
| Accessibility properties | 🔧 | DOM.getAccessibilityPropertiesForNode | **WebKit supports it.** AX tree for a11y panel |
| DOM undo/redo | 🔧 | DOM.undo, DOM.redo, DOM.markUndoableState | **WebKit supports it.** Would let Ctrl+Z revert DOM edits |
| querySelector | ✅ | DOM.querySelector | Native WebKit querySelector |
| Inspect mode (pick element) | 🔧 | DOM.setInspectModeEnabled | **WebKit supports it!** Would enable the "select element" tool that highlights on device as you move |
| Layout panel (grid/flex) | 🔧 | CSS.setLayoutContextTypeChangedMode | Partially supported in WebKit |

## Console Panel

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| console.log/warn/error | ✅ | Console.messageAdded (native) | With stack traces |
| Console evaluation | ✅ | Runtime.evaluate | |
| Object preview/expansion | ✅ | Runtime.getProperties (native) | Deep expansion working |
| Clear console | ✅ | Console.clearMessages | Native WebKit clear |
| Log channels (network, storage) | 🔧 | Console.getLoggingChannels + setLoggingChannelLevel | **WebKit has network/storage/access logging channels.** Could enable verbose network logging |

## Sources / Debugger Panel

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| Script listing | ✅ | Debugger.scriptParsed (native) | Filtered to page scripts |
| Script source | ✅ | Debugger.getScriptSource (native) | |
| Line breakpoints | ✅ | Debugger.setBreakpointByUrl (native) | |
| Conditional breakpoints | ✅ | Debugger.setBreakpointByUrl options.condition | |
| Remove breakpoints | ✅ | Debugger.removeBreakpoint (native) | |
| Pause/Resume | ✅ | Debugger.pause/resume (native) | |
| Step into/over/out | ✅ | Debugger.stepInto/stepOver/stepOut (native) | |
| Call stack | ✅ | Debugger.paused event callFrames | |
| Scope variables | ✅ | Runtime.getProperties on scope objectIds | Deep expansion |
| Watch expressions | ✅ | Debugger.evaluateOnCallFrame | With correct frame mapping |
| Hover to inspect | ✅ | Debugger.evaluateOnCallFrame | |
| Pause on exceptions | ✅ | Debugger.setPauseOnExceptions (native) | all/uncaught/none |
| Possible breakpoints | ✅ | Debugger.getPossibleBreakpoints (native) | |
| Pause on assertions | 🔧 | Debugger.setPauseOnAssertions | **WebKit supports it.** |
| Pause on microtasks | 🔧 | Debugger.setPauseOnMicrotasks | **WebKit supports it.** |
| Continue to next run loop | 🔧 | Debugger.continueUntilNextRunLoop | **WebKit supports it.** "Continue to here" equivalent |
| Blackbox scripts | 🔧 | Debugger.setPauseForInternalScripts, setBlackboxBreakpointEvaluations | |
| Source maps | 🟡 | Debugger.scriptParsed sourceMapURL | Need to download + apply mapping |
| Search across sources | 🔧 | Page.searchInResources, Page.searchInResource | **WebKit supports it.** Would enable Ctrl+Shift+F |
| Resource content | 🔧 | Page.getResourceContent | **WebKit supports it.** View HTML/CSS/images |
| Bootstrap script | 🔧 | Page.setBootstrapScript | **Inject JS before page load.** |

## Network Panel

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| Request list | ✅ | Network.requestWillBeSent (native) | |
| Response headers | ✅ | Network.responseReceived (native) | |
| Loading timing | ✅ | Network.loadingFinished (native) | |
| Loading failures | ✅ | Network.loadingFailed (native) | |
| Response body | ✅ | Network.getResponseBody (native) | |
| Data received events | ✅ | Network.dataReceived (native) | |
| WebSocket inspection | 🔧 | Network.resolveWebSocket, webSocketWillSendHandshakeRequest events | **WebKit supports WebSocket inspection.** |
| Disable cache | 🔧 | Network.setResourceCachingDisabled | **WebKit supports it.** |
| Extra request headers | 🔧 | Network.setExtraHTTPHeaders | **WebKit supports it.** |
| Load resource | 🔧 | Network.loadResource | Fetch any URL through the page context |
| Certificate info | 🔧 | Network.getSerializedCertificate | **WebKit supports it.** |

## Performance / Timeline

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| Timeline recording | 🔧 | Timeline.enable/start/stop | **WebKit has full Timeline domain!** Records rendering, scripting, painting events |
| Timeline instruments | 🔧 | Timeline.setInstruments | Can select: ScriptProfiler, Timeline, Memory, Heap, CPU, Screenshot |
| CPU profiling | 🔧 | CPUProfiler.startTracking/stopTracking | **Native CPU profiler available.** |
| Script profiling | 🔧 | ScriptProfiler.startTracking/stopTracking | **Native script profiler.** Provides per-function timing |
| Memory tracking | 🔧 | Memory.enable/startTracking/stopTracking | **Native memory tracking.** |
| Heap snapshots | 🔧 | Heap.snapshot | **Full V8-format heap snapshot.** Could power Memory panel |
| Heap GC | 🔧 | Heap.gc | **Trigger garbage collection.** |

## Animation Panel

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| Animation tracking | 🔧 | Animation.enable/startTracking/stopTracking | **Native animation tracking with animationCreated events.** Currently using cooperative JS polling |
| Animation effect target | 🔧 | Animation.requestEffectTarget | Get DOM node for an animation |
| Resolve animation | 🔧 | Animation.resolveAnimation | Get Runtime object for animation |

## Application Panel / Storage

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| Cookies | 🔧 | Page.getCookies, Page.setCookie, Page.deleteCookie | **WebKit supports full cookie CRUD.** |
| localStorage/sessionStorage | 🔧 | DOMStorage.enable/getDOMStorageItems/setDOMStorageItem/removeDOMStorageItem | **Full DOMStorage API available.** |
| IndexedDB | 🔧 | IndexedDB.enable/requestDatabaseNames/requestDatabase/requestData/clearObjectStore | **Full IndexedDB inspection available.** |
| Service Workers | ⛔ | ServiceWorker domain not found | Not available on this iOS version |

## Rendering / Layers

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| Layer tree | 🔧 | LayerTree.enable/layersForNode/reasonsForCompositingLayer | **Full compositing layer inspection.** Events: layerTreeDidChange |
| Paint rects | 🔧 | Page.setShowPaintRects | **WebKit supports it.** |
| Emulated media | 🔧 | Page.setEmulatedMedia | **WebKit supports it.** (prefers-color-scheme, print, etc.) |
| Override user agent | ✅ | Page.overrideUserAgent | Already confirmed working |
| Override user preferences | 🔧 | Page.overrideUserPreference | |
| Canvas inspection | 🔧 | Canvas.enable/disable | |

## DOMDebugger (Event/DOM/XHR Breakpoints)

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| DOM mutation breakpoints | 🔧 | DOMDebugger.setDOMBreakpoint/removeDOMBreakpoint | **Break when DOM node modified.** |
| Event listener breakpoints | 🔧 | DOMDebugger.setEventBreakpoint/removeEventBreakpoint | **Break on click, keydown, etc.** |
| XHR/Fetch breakpoints | 🔧 | DOMDebugger.setURLBreakpoint/removeURLBreakpoint | **Break when URL matches.** |

## Audit

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| Audit framework | 🔧 | Audit.setup/run/teardown | **WebKit has built-in audit runner.** |

## Worker

| Feature | Status | WebKit API | Notes |
|---------|--------|-----------|-------|
| Worker inspection | 🔧 | Worker.enable | **Available.** |

---

## Summary: What's NOT available in WebKit

- `ApplicationCache` domain (deprecated anyway)
- `Database` domain (WebSQL — deprecated)
- `ServiceWorker` domain  
- `Screen` domain
- `Target` domain (we handle target routing ourselves)
- `Network.setEmulatedConditions` (throttling)
- `Page.setShowRulers`, `Page.setForcedAppearance`, `Page.setTimeZone`

## Priority Implementation Order

### Tier 1 — High impact, straightforward (native API ready)

1. **Native CSS.getMatchedStylesForNode** — Real CSS rules with selectors, origins, media queries
2. **DOM.performSearch** — Ctrl+F in Elements panel
3. **DOM.getEventListenersForNode** — Event Listeners tab
4. **DOMStorage** — localStorage/sessionStorage in Application panel
5. **Page.getCookies/setCookie/deleteCookie** — Cookies in Application panel
6. **DOM.setInspectModeEnabled** — "Select element" picker tool
7. **Network.setResourceCachingDisabled** — "Disable cache" checkbox

### Tier 2 — Performance and profiling

8. **Timeline start/stop** — Performance recording
9. **CPUProfiler/ScriptProfiler** — CPU flame charts
10. **Heap.snapshot** — Memory panel heap snapshots
11. **Memory tracking** — Memory timeline

### Tier 3 — Enhanced debugging

12. **DOMDebugger** — DOM/event/XHR breakpoints
13. **CSS.forcePseudoState** — Toggle :hover/:active/:focus
14. **Page.searchInResources** — Search across all sources
15. **Native Animation tracking** — Replace cooperative polling
16. **Console.clearMessages** — Clear console button
17. **IndexedDB** — Database inspection

### Tier 4 — Polish

18. **LayerTree** — Compositing layer visualization
19. **Canvas** — Canvas inspection
20. **DOM.undo/redo** — Ctrl+Z for DOM edits
21. **Page.setEmulatedMedia** — Emulate prefers-color-scheme, print
22. **CSS.getSupportedCSSProperties** — Autocomplete
23. **Network.resolveWebSocket** — WebSocket inspection
24. **Page.setBootstrapScript** — Inject JS before page load
