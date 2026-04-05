# Chrome DevTools Safari Bridge — Feature Matrix

Comprehensive breakdown of Chrome DevTools features and their support status
when connected to iOS Safari via this bridge.

**Legend:** ✅ Working | ⚠️ Partial | ❌ Not supported | N/A Not applicable

---

## Elements Panel

### DOM Tree & Inspection
| Feature | Status | Notes |
|---------|--------|-------|
| Display DOM tree with depth traversal | ✅ | Full tree with child expansion |
| Inspect element picker (select on page) | ✅ | Injects click handler on device |
| Edit element HTML (outerHTML) | ✅ | Via DOM.setOuterHTML |
| Edit attributes | ✅ | Via DOM.setAttributeValue |
| Delete elements | ✅ | Via DOM.removeNode |
| Search DOM with CSS selectors | ✅ | Via DOM.performSearch |
| Element highlighting on hover | ✅ | Via Overlay.highlightNode with DOM overlay |
| Drag to reorder elements | ❌ | Not implemented |

### Styles Panel
| Feature | Status | Notes |
|---------|--------|-------|
| View matched CSS rules | ✅ | Via CSS.getMatchedStylesForNode |
| View computed styles | ✅ | Via CSS.getComputedStyleForNode |
| Edit inline styles | ✅ | Via CSS.setStyleTexts |
| View box model | ⚠️ | Data available, visual overlay limited |
| Force pseudo-classes (:hover, :active, :focus) | ✅ | Via CSS.forcePseudoState |
| CSS autocomplete | ✅ | Handled by DevTools frontend |
| View event listeners | ✅ | Via DOMDebugger.getEventListeners |
| Accessibility properties | ⚠️ | Basic tree, not full Chrome a11y |

### Layout Panel
| Feature | Status | Notes |
|---------|--------|-------|
| Flexbox overlay | ❌ | WebKit doesn't expose flex debugging |
| Grid overlay | ❌ | WebKit doesn't expose grid debugging |

---

## Console Panel

| Feature | Status | Notes |
|---------|--------|-------|
| Display console.log/warn/error/info | ✅ | Native Console.messageAdded events |
| Filter by level | ✅ | Handled by DevTools frontend |
| Evaluate JavaScript expressions | ✅ | Via Runtime.evaluate |
| Object inspection/expansion | ✅ | Via Runtime.getProperties |
| Preserve log on navigation | ✅ | Frontend feature |
| Clear console | ✅ | Via Console.clearMessages |
| $0 reference to inspected element | ✅ | Handled by DevTools |
| console.table output | ✅ | Via message formatting |
| console.group/groupEnd | ✅ | Via message type |
| console.time/timeEnd | ✅ | Via message type |
| Multi-line input | ✅ | Frontend feature |
| Autocomplete | ✅ | Via Runtime.getProperties |

---

## Sources Panel

### Script Viewing
| Feature | Status | Notes |
|---------|--------|-------|
| List loaded scripts | ✅ | Via Debugger.scriptParsed |
| View script source | ✅ | Via Debugger.getScriptSource |
| Syntax highlighting | ✅ | Frontend feature |
| Pretty-print minified code | ✅ | Frontend feature |
| Source map resolution | ✅ | Via session.mapToUiLocation |
| View stylesheet source text | ✅ | Via CSS.getStyleSheetText |
| Search across sources | ⚠️ | Single-file search works, cross-file limited |

### Debugging
| Feature | Status | Notes |
|---------|--------|-------|
| Set line breakpoints | ✅ | Via Debugger.setBreakpoint |
| Conditional breakpoints | ✅ | Via Debugger.setBreakpoint with condition |
| Pause on exceptions | ✅ | Via Debugger.setPauseOnExceptions |
| Step over/into/out | ✅ | Via Debugger.stepOver/Into/Out |
| Resume execution | ✅ | Via Debugger.resume |
| View call stack | ✅ | Via Debugger.paused event |
| View scope variables | ✅ | Via Runtime.getProperties on scope |
| Watch expressions | ✅ | Via Runtime.evaluate in frame |
| Hover variable preview | ✅ | Via Runtime.evaluate |
| DOM breakpoints | ⚠️ | Subtree/attribute via DOMDebugger |
| Event listener breakpoints | ⚠️ | Basic support |
| XHR/Fetch breakpoints | ❌ | Not mapped to WebKit |

---

## Network Panel

| Feature | Status | Notes |
|---------|--------|-------|
| Show HTTP requests | ✅ | Native Network events |
| Request URL, method, status | ✅ | Full request metadata |
| Response headers | ✅ | Via Network.responseReceived |
| Request headers | ✅ | Via Network.requestWillBeSent |
| Response body preview | ✅ | Via Network.getResponseBody |
| Request timing/waterfall | ⚠️ | Basic timing, no detailed phases |
| Filter by type (XHR, Doc, JS, CSS) | ✅ | Frontend filter on type field |
| Filter by URL | ✅ | Frontend feature |
| Preserve log | ✅ | Frontend feature |
| Disable cache | ⚠️ | Sent but WebKit support varies |
| Copy as cURL | ✅ | Frontend feature from headers |
| WebSocket frames | ✅ | WebKit sends webSocket* events, forwarded as-is |
| Network throttling | ❌ | WebKit doesn't support emulation |
| Block requests | ❌ | Not implemented |
| Cookie details tab | ⚠️ | Headers available, dedicated tab limited |
| Detailed timing breakdown (DNS, TLS, etc.) | ⚠️ | Partial — response.timing when available |

---

## Performance Panel

### Recording
| Feature | Status | Notes |
|---------|--------|-------|
| Start/stop recording | ✅ | Via Tracing.start/end |
| Buffer usage indicator | ✅ | Periodic Tracing.bufferUsage events |
| Record on page load | ⚠️ | Manual start, no auto-on-navigate |

### Timeline & Flame Chart
| Feature | Status | Notes |
|---------|--------|-------|
| JS flame chart with function names | ✅ | ProfileChunk with call tree |
| Source map resolution in flame chart | ✅ | mapToUiLocation on profile nodes |
| FunctionCall events (exact timestamps) | ✅ | From WebKit Timeline domain |
| EvaluateScript events | ✅ | From Timeline |
| TimerFire/Install/Remove events | ✅ | From Timeline |
| EventDispatch events | ✅ | From Timeline |
| Layout events | ✅ | From Timeline |
| RecalculateStyles events | ✅ | From Timeline |
| Paint events | ✅ | From Timeline |
| CompositeLayers events | ✅ | From Timeline |
| ParseHTML events | ✅ | From Timeline |
| FireAnimationFrame events | ✅ | From Timeline |
| XHR events | ✅ | From Timeline |
| ObserverCallback events | ✅ | From Timeline |
| Long Task markers (>50ms) | ✅ | Wrapped in RunTask spans |

### Network in Timeline
| Feature | Status | Notes |
|---------|--------|-------|
| ResourceSendRequest | ✅ | From buffered Network events |
| ResourceReceiveResponse | ✅ | From buffered Network events |
| ResourceReceivedData | ✅ | From buffered Network events |
| ResourceFinish | ✅ | From buffered Network events |

### Screenshots & Metrics
| Feature | Status | Notes |
|---------|--------|-------|
| Screenshot filmstrip | ✅ | JPEG captures every 1s |
| GC events | ✅ | From Heap.garbageCollected |
| User Timing (marks/measures) | ✅ | From performance.mark/measure API |
| FCP marker | ✅ | From Performance paint entries |
| LCP marker | ⚠️ | When available from Performance API |
| FPS meter | ❌ | No real-time FPS from WebKit |
| Memory timeline | ❌ | Would need continuous Heap polling |
| CPU usage timeline | ❌ | Not available from WebKit |

### Summary & Analysis
| Feature | Status | Notes |
|---------|--------|-------|
| Summary pie chart (Scripting/Rendering/Painting) | ✅ | All events have correct categories |
| Bottom-up view | ✅ | Frontend feature from trace data |
| Call tree view | ✅ | Frontend feature from trace data |
| Event log view | ✅ | Frontend feature from trace data |

---

## Memory Panel

| Feature | Status | Notes |
|---------|--------|-------|
| Take heap snapshot | ⚠️ | Heap.snapshot available, format partially compatible |
| Heap snapshot comparison | ❌ | Format incompatible |
| Allocation timeline | ❌ | Not available from WebKit |
| Allocation sampling | ❌ | Not available from WebKit |
| Collect garbage button | ✅ | Via Heap.gc |

---

## Application Panel

### Storage
| Feature | Status | Notes |
|---------|--------|-------|
| Local Storage view/edit | ✅ | Via DOMStorage.getDOMStorageItems/set/remove |
| Session Storage view/edit | ✅ | Via DOMStorage.getDOMStorageItems/set/remove |
| Cookies view/edit | ✅ | Via Page.getCookies/setCookie/deleteCookie |
| IndexedDB inspection | ✅ | Via IndexedDB.requestDatabaseNames/requestData/clearObjectStore |
| Cache Storage | ❌ | Not implemented |

### Service Workers
| Feature | Status | Notes |
|---------|--------|-------|
| List service workers | ❌ | WebKit ServiceWorker domain not mapped |
| SW lifecycle management | ❌ | Not implemented |

### Manifest
| Feature | Status | Notes |
|---------|--------|-------|
| View web app manifest | ❌ | Not implemented |

---

## Security Panel

| Feature | Status | Notes |
|---------|--------|-------|
| Page security overview | ❌ | Security domain not mapped |
| Certificate details | ❌ | Not available from WebKit |
| Mixed content warnings | ❌ | Not implemented |

---

## Lighthouse Panel

| Feature | Status | Notes |
|---------|--------|-------|
| Run audits | ❌ | Requires Chrome's Lighthouse engine |
| Performance scoring | ❌ | N/A for remote targets |

---

## Animations Panel

| Feature | Status | Notes |
|---------|--------|-------|
| Capture CSS animations | ✅ | Via document.getAnimations() polling |
| Animation timeline display | ✅ | Events with backendNodeId linking |
| Playback controls (play/pause) | ✅ | Via Animation.setPaused |
| Playback speed (0.25x-4x) | ✅ | Via Animation.setPlaybackRate |
| Seek through timeline | ✅ | Via Animation.seekAnimations |
| Element highlighting | ✅ | Via backendNodeId → DOM node |

---

## Recorder Panel

| Feature | Status | Notes |
|---------|--------|-------|
| Record user flows | ❌ | Chrome-specific feature |
| Replay recordings | ❌ | Chrome-specific feature |

---

## Cross-Cutting Features

| Feature | Status | Notes |
|---------|--------|-------|
| Tab navigation (Elements/Console/Sources/etc.) | ✅ | All major panels accessible |
| URL bar showing page URL | ✅ | From page's location.href |
| Navigation detection (URL changes on device) | ✅ | Poll-based detection |
| Page reload | ✅ | Via Page.reload |
| Multiple targets (tabs) | ✅ | Via /json/list endpoint |
| Device name display | ✅ | From USB device info |
| Dark theme | ✅ | DevTools frontend default |
| Command palette (Ctrl+Shift+P) | ✅ | Frontend feature |
| Keyboard shortcuts | ✅ | Frontend feature |

---

## Known Limitations

1. **No network throttling** — WebKit doesn't expose network emulation
2. **No GPU/Raster profiling** — WebKit doesn't expose GPU thread data
3. **No CSS Grid/Flexbox debugging** — WebKit's CSS domain doesn't include layout debugging
4. **Heap snapshots** — WebKit's format partially differs from V8
5. **Service Workers** — WebKit's ServiceWorker domain not fully mapped
6. **Security panel** — No certificate/security info forwarding
7. **Lighthouse** — Requires Chrome's built-in engine, not applicable to remote Safari
8. **Recorder** — Chrome-specific feature, not applicable
9. **Cache Storage** — Not implemented
10. **Device emulation** — No viewport/touch emulation from WebKit

---

*Last updated: 2026-04-05*
*Bridge version: iOS native WebKit Inspector Protocol*
