# CDP Feature Parity Chart

Generated: 2026-04-04  
Platforms tested: iPhone  

## Summary

| Platform | Passed | Total | Parity |
|----------|--------|-------|--------|
| Chrome (reference) | 86 | 86 | 100% |
| iPhone | 9 | 86 | 10.5% |
| Simulator | — | 86 | N/A |
| Desktop | — | 86 | N/A |

## Elements

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| DOM.getDocument full depth | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM tree has html > head + body with children | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.requestChildNodes returns children | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.querySelector finds element | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.getOuterHTML returns valid HTML | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.setAttributeValue modifies attribute | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.setAttributesAsText parses attribute string | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.setNodeValue modifies text | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| DOM.removeNode removes element | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| DOM.performSearch finds elements | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.performSearch |
| DOM.getBoxModel returns quads | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| CSS.getComputedStyleForNode returns properties | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| CSS.getMatchedStylesForNode returns inline + rules | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| CSS.getInlineStylesForNode returns styles | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| CSS.setStyleTexts edits inline styles | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| CSS.getSupportedCSSProperties returns property list | ✅ | ✅ | ➖ | ➖ |  |
| CSS.forcePseudoState toggles :hover | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| Overlay.highlightNode + hideHighlight | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.getEventListenersForNode returns listeners | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.setOuterHTML edits element HTML directly | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| DOM.querySelectorAll finds multiple elements | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| DOM.describeNode returns node details | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.setInspectedNode enables $0 reference | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| CSS.addRule creates a new CSS rule | ✅ | ✅ | ➖ | ➖ |  |
| DOM.requestChildNodes responds within 5s (regression: blank Elements panel) | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM operations dont block subsequent commands (regression: blank panel) | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |
| DOM.getDocument returns html with head+body (regression: blank Elements) | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: DOM.getDocument |

## Console

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| Runtime.evaluate returns primitive | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.evaluate returns string | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.evaluate returns object with objectId | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.evaluate returns exception details | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.getProperties returns own properties | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.getProperties deep nesting | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.callFunctionOn works | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| console.log → Runtime.consoleAPICalled | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| console.warn type correctness | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| console.error type correctness | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.evaluate with awaitPromise resolves async | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.evaluate returns array with objectId | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.getProperties returns array index properties | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.evaluate returnByValue with nested objects | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |

## Sources

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| Debugger.enable → scriptParsed events | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasScripts = false, expected true |
| Debugger.getScriptSource returns content | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasSource = false, expected true |
| Debugger.getPossibleBreakpoints returns locations | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasLocations = false, expected tru... |
| Debugger.setBreakpointByUrl + removeBreakpoint | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: success = false, expected true |
| Debugger.setPauseOnExceptions all modes | ✅ | ✅ | ➖ | ➖ |  |
| Debugger.pause + resume flow | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Debugger.evaluateOnCallFrame during pause | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Runtime.executionContextCreated has valid origin | ✅ | ✅ | ➖ | ➖ |  |
| Page.getResourceTree returns frame + resources | ✅ | ✅ | ➖ | ➖ |  |
| Debugger.setBreakpoint by script location | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: success = false, expected true |
| Debugger.stepOver advances to next line | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Debugger.stepInto enters function call | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Debugger.stepOut exits current function | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Debugger.enable sends scriptParsed events (regression: empty Sources panel) | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Debugger.enable |

## Network

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| Network.requestWillBeSent event on fetch | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Network.responseReceived event | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Network.loadingFinished event | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Network.getResponseBody returns content | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Network.loadingFailed on 404 | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Page.getResourceContent returns page HTML | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasContent = false, expected true |
| Network response has non-empty headers | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Network request has non-empty headers | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Network response has timing data | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |
| Network.dataReceived event has dataLength | ✅ | ❌ | ➖ | ➖ | iPhone: Timeout: Runtime.evaluate |

## Performance

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| Tracing.start + end returns trace events | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: started = false, expected true |
| Profiler.start + stop returns profile | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: started = false, expected true |
| HeapProfiler.takeHeapSnapshot streams chunks | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: started = false, expected true |
| Performance.getMetrics returns metrics | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasMetrics = false, expected true |
| Tracing.start emits initial dataCollected event (regression: stuck at Initializing) | ✅ | ✅ | ➖ | ➖ |  |
| Tracing.start responds within 10s (regression: hanging Performance) | ✅ | ✅ | ➖ | ➖ |  |

## Application

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| DOMStorage.getDOMStorageItems (localStorage) | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasTestItem = undefined, expected ... |
| DOMStorage.setDOMStorageItem | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: set = false, expected true |
| DOMStorage.removeDOMStorageItem | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: removed = false, expected true |
| IndexedDB.requestDatabaseNames | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasTestDb = undefined, expected tr... |
| Page.getCookies | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasTestCookie = undefined, expecte... |
| Storage.getStorageKey | ✅ | ✅ | ➖ | ➖ |  |
| DOMStorage.getDOMStorageItems (sessionStorage) | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasTestItem = undefined, expected ... |
| DOMStorage.setDOMStorageItem (sessionStorage) | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: set = false, expected true |
| Page.deleteCookie removes a cookie | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: success = false, expected true |

## Other

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| DOMDebugger.setDOMBreakpoint + remove | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: success = false, expected true |
| DOMDebugger.setEventListenerBreakpoint + remove | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: success = false, expected true |
| DOMDebugger.setXHRBreakpoint + remove | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: success = false, expected true |
| Animation.enable + events | ✅ | ✅ | ➖ | ➖ |  |
| Page.captureScreenshot returns image data | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: hasData = false, expected true |
| Page.navigate + reload | ✅ | ❌ | ➖ | ➖ | iPhone: value mismatch: success = false, expected true |

## Legend

- ✅ Pass — response matches Chrome reference structurally
- ❌ Fail — response differs from Chrome or threw an error
- ➖ N/A — platform not available during test run
