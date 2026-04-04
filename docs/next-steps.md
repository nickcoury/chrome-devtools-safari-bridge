# Next Steps

## Current Status (April 3, 2026)

### What works
- **Elements**: full DOM tree, styles, computed, box model, attribute editing, outerHTML editing
- **Console**: message streaming (log/warn/error), evaluation, object expansion, deep nesting
- **Network**: request/response capture, headers, timing, response body, error tracking
- **Sources**: scriptParsed events sent correctly, getScriptSource works — but file tree empty (see below)
- **Performance**: panel loads with Live Metrics, recording reworked to match Chrome 146 protocol
- **Application**: localStorage, sessionStorage, IndexedDB, cookies
- **Debugger**: breakpoints, pause/resume, step into/over/out, evaluateOnCallFrame, scope inspection
- **Animation**: CSS animation + Web Animation API events flow with correct format
- **Screenshots**: Page.captureScreenshot works on real devices

### What doesn't work
1. **Sources file tree empty** — DevTools receives scriptParsed events but doesn't populate the navigator tree without `Target.attachedToTarget` session multiplexing
2. **Performance recording stuck at "Initializing"** — Tracing.start responds correctly, bufferUsage events sent, but DevTools doesn't transition to "Recording" state
3. **Animation drawer** — events flow correctly but the Animations drawer panel may not display them

### Architecture
- 11 domain-specific CDP handler methods in simulator.js
- Native WebKit Inspector Protocol for Debugger/Console/Network
- 200ms poll loop for event forwarding (80% idle)
- 86 differential parity tests comparing Chrome vs bridge
- Built-in performance profiling (BRIDGE_PERF=1)
- Panel verification script (test/verify-panels.mjs)

## Next priorities

### 1. Sources panel file tree (HIGH)
The file tree requires `Target.attachedToTarget` which creates a child CDP session. Previous attempts broke Elements panel because the bridge doesn't implement session multiplexing (incoming messages with `sessionId` need to be stripped, outgoing messages need `sessionId` added). A careful implementation that:
- Stores `sessionId` on the client when `Target.setAutoAttach({flatten:true})`
- Strips `sessionId` from incoming messages before routing to handlers
- Adds `sessionId` to outgoing responses and events via `#send()`
...should work but needs VISUAL VERIFICATION (verify-panels.mjs) after every change.

### 2. Performance recording (MEDIUM)
The tracing protocol now matches Chrome exactly (bufferUsage during recording, dataCollected at end). The "Initializing" state may be caused by:
- Chrome 146 expecting `Tracing.start` to be scoped to a session
- The TracingStartedInBrowser metadata needing specific fields
- DevTools internally calling additional methods before considering recording started

### 3. Desktop extension improvements (MEDIUM)
- Console/Network hooks now inject into main world via `<script>` tag
- DOM blanking fixed (suppressed DOM.documentUpdated on mutations)
- Needs manual testing after extension rebuild

### 4. Test coverage (LOW)
- Sources panel needs a test that verifies file tree population
- Performance recording needs a test that clicks Record and verifies timer starts
- Animation panel needs a test that verifies animations display
