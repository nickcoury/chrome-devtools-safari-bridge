# CDP Feature Parity Chart

Generated: 2026-04-03  
Platforms tested: iPhone  

## Summary

| Platform | Passed | Total | Parity |
|----------|--------|-------|--------|
| Chrome (reference) | 78 | 80 | 100% |
| iPhone | 69 | 80 | 86.3% |

## Elements

| Feature | Chrome | iPhone | Notes |
|---------|:------:|:------:|-------|
| DOM.getDocument full depth | ✅ | ❌ | iPhone: missing field: root.compatibilityMode |
| DOM tree has html > head + body with children | ✅ | ❌ | iPhone: value mismatch: hasHead = false, expected true |
| DOM.requestChildNodes returns children | ✅ | ✅ |  |
| DOM.querySelector finds element | ✅ | ✅ |  |
| DOM.getOuterHTML returns valid HTML | ✅ | ✅ |  |
| DOM.setAttributeValue modifies attribute | ✅ | ✅ |  |
| DOM.setAttributesAsText parses attribute string | ✅ | ✅ |  |
| DOM.setNodeValue modifies text | ✅ | ❌ | iPhone: No text child |
| DOM.removeNode removes element | ❌ | ❌ | iPhone: Element not found |
| DOM.performSearch finds elements | ✅ | ✅ |  |
| DOM.getBoxModel returns quads | ✅ | ✅ |  |
| CSS.getComputedStyleForNode returns properties | ✅ | ✅ |  |
| CSS.getMatchedStylesForNode returns inline + rules | ✅ | ✅ |  |
| CSS.getInlineStylesForNode returns styles | ✅ | ✅ |  |
| CSS.setStyleTexts edits inline styles | ✅ | ✅ |  |
| CSS.getSupportedCSSProperties returns property list | ✅ | ✅ |  |
| CSS.forcePseudoState toggles :hover | ✅ | ✅ |  |
| Overlay.highlightNode + hideHighlight | ✅ | ✅ |  |
| DOM.getEventListenersForNode returns listeners | ✅ | ✅ |  |
| DOM.setOuterHTML edits element HTML directly | ❌ | ❌ | iPhone: Element not found |
| DOM.querySelectorAll finds multiple elements | ✅ | ✅ |  |
| DOM.describeNode returns node details | ✅ | ✅ |  |
| DOM.setInspectedNode enables $0 reference | ✅ | ✅ |  |
| CSS.addRule creates a new CSS rule | ✅ | ✅ |  |

## Console

| Feature | Chrome | iPhone | Notes |
|---------|:------:|:------:|-------|
| Runtime.evaluate returns primitive | ✅ | ✅ |  |
| Runtime.evaluate returns string | ✅ | ✅ |  |
| Runtime.evaluate returns object with objectId | ✅ | ✅ |  |
| Runtime.evaluate returns exception details | ✅ | ✅ |  |
| Runtime.getProperties returns own properties | ✅ | ✅ |  |
| Runtime.getProperties deep nesting | ✅ | ✅ |  |
| Runtime.callFunctionOn works | ✅ | ✅ |  |
| console.log → Runtime.consoleAPICalled | ✅ | ✅ |  |
| console.warn type correctness | ✅ | ✅ |  |
| console.error type correctness | ✅ | ✅ |  |
| Runtime.evaluate with awaitPromise resolves async | ✅ | ✅ |  |
| Runtime.evaluate returns array with objectId | ✅ | ✅ |  |
| Runtime.getProperties returns array index properties | ✅ | ✅ |  |
| Runtime.evaluate returnByValue with nested objects | ✅ | ✅ |  |

## Sources

| Feature | Chrome | iPhone | Notes |
|---------|:------:|:------:|-------|
| Debugger.enable → scriptParsed events | ✅ | ✅ |  |
| Debugger.getScriptSource returns content | ✅ | ✅ |  |
| Debugger.getPossibleBreakpoints returns locations | ✅ | ✅ |  |
| Debugger.setBreakpointByUrl + removeBreakpoint | ✅ | ✅ |  |
| Debugger.setPauseOnExceptions all modes | ✅ | ✅ |  |
| Debugger.pause + resume flow | ✅ | ✅ |  |
| Debugger.evaluateOnCallFrame during pause | ✅ | ❌ | iPhone: value mismatch: evaluated = false, expected true |
| Runtime.executionContextCreated has valid origin | ✅ | ❌ | iPhone: value mismatch: hasContext = false, expected true |
| Page.getResourceTree returns frame + resources | ✅ | ✅ |  |
| Debugger.setBreakpoint by script location | ✅ | ❌ | iPhone: value mismatch: success = false, expected true |
| Debugger.stepOver advances to next line | ✅ | ❌ | iPhone: value mismatch: paused = false, expected true |
| Debugger.stepInto enters function call | ✅ | ❌ | iPhone: value mismatch: paused = false, expected true |
| Debugger.stepOut exits current function | ✅ | ❌ | iPhone: value mismatch: paused = false, expected true |

## Network

| Feature | Chrome | iPhone | Notes |
|---------|:------:|:------:|-------|
| Network.requestWillBeSent event on fetch | ✅ | ✅ |  |
| Network.responseReceived event | ✅ | ✅ |  |
| Network.loadingFinished event | ✅ | ✅ |  |
| Network.getResponseBody returns content | ✅ | ✅ |  |
| Network.loadingFailed on 404 | ✅ | ✅ |  |
| Page.getResourceContent returns page HTML | ✅ | ✅ |  |
| Network response has non-empty headers | ✅ | ✅ |  |
| Network request has non-empty headers | ✅ | ✅ |  |
| Network response has timing data | ✅ | ✅ |  |
| Network.dataReceived event has dataLength | ✅ | ✅ |  |

## Performance

| Feature | Chrome | iPhone | Notes |
|---------|:------:|:------:|-------|
| Tracing.start + end returns trace events | ✅ | ✅ |  |
| Profiler.start + stop returns profile | ✅ | ✅ |  |
| HeapProfiler.takeHeapSnapshot streams chunks | ✅ | ✅ |  |
| Performance.getMetrics returns metrics | ✅ | ✅ |  |

## Application

| Feature | Chrome | iPhone | Notes |
|---------|:------:|:------:|-------|
| DOMStorage.getDOMStorageItems (localStorage) | ✅ | ✅ |  |
| DOMStorage.setDOMStorageItem | ✅ | ✅ |  |
| DOMStorage.removeDOMStorageItem | ✅ | ✅ |  |
| IndexedDB.requestDatabaseNames | ✅ | ✅ |  |
| Page.getCookies | ✅ | ✅ |  |
| Storage.getStorageKey | ✅ | ✅ |  |
| DOMStorage.getDOMStorageItems (sessionStorage) | ✅ | ✅ |  |
| DOMStorage.setDOMStorageItem (sessionStorage) | ✅ | ✅ |  |
| Page.deleteCookie removes a cookie | ✅ | ✅ |  |

## Other

| Feature | Chrome | iPhone | Notes |
|---------|:------:|:------:|-------|
| DOMDebugger.setDOMBreakpoint + remove | ✅ | ✅ |  |
| DOMDebugger.setEventListenerBreakpoint + remove | ✅ | ✅ |  |
| DOMDebugger.setXHRBreakpoint + remove | ✅ | ✅ |  |
| Animation.enable + events | ✅ | ✅ |  |
| Page.captureScreenshot returns image data | ✅ | ✅ |  |
| Page.navigate + reload | ✅ | ✅ |  |

## Legend

- ✅ Pass — response matches Chrome reference structurally
- ❌ Fail — response differs from Chrome or threw an error
- ➖ N/A — platform not available during test run
