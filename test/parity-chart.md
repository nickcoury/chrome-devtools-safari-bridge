# CDP Feature Parity Chart

Generated: 2026-04-04  
Platforms tested: iPhone, Desktop  

## Summary

| Platform | Passed | Total | Parity |
|----------|--------|-------|--------|
| Chrome (reference) | 86 | 86 | 100% |
| iPhone | 86 | 86 | 100.0% |
| Simulator | — | 86 | N/A |
| Desktop | 14 | 86 | 16.3% |

## Elements

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| DOM.getDocument full depth | ✅ | ✅ | ➖ | ❌ | Desktop: empty array: root.children (Chrome has 2 items) |
| DOM tree has html > head + body with children | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasHtml = false, expected true |
| DOM.requestChildNodes returns children | ✅ | ✅ | ➖ | ❌ | Desktop: No html node |
| DOM.querySelector finds element | ✅ | ✅ | ➖ | ❌ | Desktop: No <body> node found |
| DOM.getOuterHTML returns valid HTML | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| DOM.setAttributeValue modifies attribute | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| DOM.setAttributesAsText parses attribute string | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| DOM.setNodeValue modifies text | ✅ | ✅ | ➖ | ❌ | Desktop: Timeout: DOM.getDocument |
| DOM.removeNode removes element | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: removed = false, expected true |
| DOM.performSearch finds elements | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasResults = false, expected true |
| DOM.getBoxModel returns quads | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| CSS.getComputedStyleForNode returns properties | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| CSS.getMatchedStylesForNode returns inline + rules | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| CSS.getInlineStylesForNode returns styles | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| CSS.setStyleTexts edits inline styles | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| CSS.getSupportedCSSProperties returns property list | ✅ | ✅ | ➖ | ✅ |  |
| CSS.forcePseudoState toggles :hover | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| Overlay.highlightNode + hideHighlight | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| DOM.getEventListenersForNode returns listeners | ✅ | ✅ | ➖ | ❌ | Desktop: Test element #__diff_test not found in DOM |
| DOM.setOuterHTML edits element HTML directly | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: textChanged = false, expected true |
| DOM.querySelectorAll finds multiple elements | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: foundAll = false, expected true |
| DOM.describeNode returns node details | ✅ | ✅ | ➖ | ❌ | Desktop: Timeout: DOM.getDocument |
| DOM.setInspectedNode enables $0 reference | ✅ | ✅ | ➖ | ❌ | Desktop: Timeout: DOM.getDocument |
| CSS.addRule creates a new CSS rule | ✅ | ✅ | ➖ | ✅ |  |
| DOM.requestChildNodes responds within 5s (regression: blank Elements panel) | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: followUpWorks = false, expected tr... |
| DOM operations dont block subsequent commands (regression: blank panel) | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: eval1 = undefined, expected "alive... |
| DOM.getDocument returns html with head+body (regression: blank Elements) | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasHtml = false, expected true |

## Console

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| Runtime.evaluate returns primitive | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: type = "undefined", expected "numb... |
| Runtime.evaluate returns string | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: type = "undefined", expected "stri... |
| Runtime.evaluate returns object with objectId | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: type = "undefined", expected "obje... |
| Runtime.evaluate returns exception details | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasException = false, expected tru... |
| Runtime.getProperties returns own properties | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: aType = undefined, expected "numbe... |
| Runtime.getProperties deep nesting | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: canExpand = false, expected true |
| Runtime.callFunctionOn works | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: type = "undefined", expected "numb... |
| console.log → Runtime.consoleAPICalled | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |
| console.warn type correctness | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |
| console.error type correctness | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |
| Runtime.evaluate with awaitPromise resolves async | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: type = "object", expected "number" |
| Runtime.evaluate returns array with objectId | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: subtype = "error", expected "array... |
| Runtime.getProperties returns array index properties | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasIndexProps = false, expected tr... |
| Runtime.evaluate returnByValue with nested objects | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: type = "undefined", expected "obje... |

## Sources

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| Debugger.enable → scriptParsed events | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasScripts = false, expected true |
| Debugger.getScriptSource returns content | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasSource = false, expected true |
| Debugger.getPossibleBreakpoints returns locations | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasLocations = false, expected tru... |
| Debugger.setBreakpointByUrl + removeBreakpoint | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: success = false, expected true |
| Debugger.setPauseOnExceptions all modes | ✅ | ✅ | ➖ | ✅ |  |
| Debugger.pause + resume flow | ✅ | ✅ | ➖ | ✅ |  |
| Debugger.evaluateOnCallFrame during pause | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: evaluated = false, expected true |
| Runtime.executionContextCreated has valid origin | ✅ | ✅ | ➖ | ✅ |  |
| Page.getResourceTree returns frame + resources | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasUrl = false, expected true |
| Debugger.setBreakpoint by script location | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: success = false, expected true |
| Debugger.stepOver advances to next line | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: paused = false, expected true |
| Debugger.stepInto enters function call | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: paused = false, expected true |
| Debugger.stepOut exits current function | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: paused = false, expected true |
| Debugger.enable sends scriptParsed events (regression: empty Sources panel) | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |

## Network

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| Network.requestWillBeSent event on fetch | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |
| Network.responseReceived event | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |
| Network.loadingFinished event | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |
| Network.getResponseBody returns content | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasBody = false, expected true |
| Network.loadingFailed on 404 | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasEither = false, expected true |
| Page.getResourceContent returns page HTML | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasContent = false, expected true |
| Network response has non-empty headers | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |
| Network request has non-empty headers | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |
| Network response has timing data | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |
| Network.dataReceived event has dataLength | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: received = false, expected true |

## Performance

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| Tracing.start + end returns trace events | ✅ | ✅ | ➖ | ✅ |  |
| Profiler.start + stop returns profile | ✅ | ✅ | ➖ | ✅ |  |
| HeapProfiler.takeHeapSnapshot streams chunks | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasChunks = false, expected true |
| Performance.getMetrics returns metrics | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasMetrics = false, expected true |
| Tracing.start sends bufferUsage events during recording | ✅ | ✅ | ➖ | ✅ |  |
| Tracing.start responds within 10s (regression: hanging Performance) | ✅ | ✅ | ➖ | ✅ |  |

## Application

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| DOMStorage.getDOMStorageItems (localStorage) | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasTestItem = false, expected true |
| DOMStorage.setDOMStorageItem | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: set = false, expected true |
| DOMStorage.removeDOMStorageItem | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: removed = false, expected true |
| IndexedDB.requestDatabaseNames | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasTestDb = false, expected true |
| Page.getCookies | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasTestCookie = false, expected tr... |
| Storage.getStorageKey | ✅ | ✅ | ➖ | ✅ |  |
| DOMStorage.getDOMStorageItems (sessionStorage) | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasTestItem = false, expected true |
| DOMStorage.setDOMStorageItem (sessionStorage) | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: set = false, expected true |
| Page.deleteCookie removes a cookie | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: success = false, expected true |

## Other

| Feature | Chrome | iPhone | Simulator | Desktop | Notes |
|---------|:------:|:------:|:------:|:------:|-------|
| DOMDebugger.setDOMBreakpoint + remove | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: success = false, expected true |
| DOMDebugger.setEventListenerBreakpoint + remove | ✅ | ✅ | ➖ | ✅ |  |
| DOMDebugger.setXHRBreakpoint + remove | ✅ | ✅ | ➖ | ✅ |  |
| Animation.enable + events | ✅ | ✅ | ➖ | ✅ |  |
| Page.captureScreenshot returns image data | ✅ | ✅ | ➖ | ❌ | Desktop: value mismatch: hasData = false, expected true |
| Page.navigate + reload | ✅ | ✅ | ➖ | ✅ |  |

## Legend

- ✅ Pass — response matches Chrome reference structurally
- ❌ Fail — response differs from Chrome or threw an error
- ➖ N/A — platform not available during test run
