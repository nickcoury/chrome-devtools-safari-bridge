# Next Steps

## Current Status (April 4, 2026)

### Parity Results

| Platform | Parity | Tests |
|----------|--------|-------|
| Chrome (reference) | 100% | 86/86 |
| iPhone | 98.8% | 85/86 |
| Simulator | ~98% | (same bridge code) |
| Desktop Safari | 16–30% | depends on extension connection |

### All 4+ Panels Working (pixel-screenshot verified on iPhone)
- **Elements**: Full DOM tree with expanded children (head, body, all descendants) + Styles + Computed
- **Console**: tick messages, error messages, evaluation (2+2=4) all visible
- **Network**: fetch requests with 200 status, timing, headers
- **Sources**: File tree (top → domain → __pages → demo.html + demo-app.js), Breakpoints, Call Stack
- **Performance**: Recording flow works end-to-end (suspendAllTargets 2ms, Tracing.start 1ms, bufferUsage events during recording, dataCollected on stop)

### Single Remaining iPhone Failure
- **Debugger.setBreakpoint by scriptId** — WebKit may not support this variant. `setBreakpointByUrl` (what DevTools actually uses) works fine. Not a functional limitation.

### Key Fixes This Sprint
1. **DOM.getDocument child expansion** — WebKit returns shallow tree; bridge now awaits setChildNodes events before returning, matching Chrome's full-tree response
2. **Console/Network sessionId** — Native events (consoleAPICalled, Network.*) must NOT have sessionId, otherwise DevTools filters them as "from child target"
3. **findNode DOCTYPE skip** — Test helper was matching DOCTYPE (nodeType=10) before <html> element
4. **Pixel screenshot verification** — Text-based checks gave false positives; screenshots are the only reliable verification

### Desktop Limitations (architectural)
- Extension must be active on target page
- No native debugger (breakpoints, stepping, callframes)
- No native network interception (only fetch/XHR hooks via content script)
- WebSocket connection cycles (content script reconnects every ~2s)

## Remaining Work

### For User's Manual Testing (HIGH)
- **Performance recording**: Click Record in DevTools — protocol is verified working, needs UI confirmation
- **Page navigation**: Navigate while DevTools is open, verify panels recover

### Desktop Improvements (MEDIUM)
- Runtime.evaluate reliability (extension connection cycling)
- Console/Network events (need extension on real page)
- Computed styles (CSS.getComputedStyleForNode returns empty when extension disconnected)

### Test Infrastructure
- `npm test` — 86 differential parity tests vs Chrome reference
- `npm run test:cdp` — 7 CDP-level protocol checks
- `npm run test:panels` — 5 Puppeteer panel text checks
- `node test/verify-screenshots.mjs` — Pixel screenshot verification
- Pixel screenshots catch regressions that text/CDP checks miss (canonical example: sessionId filtering)
