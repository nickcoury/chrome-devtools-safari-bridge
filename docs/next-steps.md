# Next Steps

## Current Status (April 4, 2026 — Sprint End)

### iPhone: 100% Parity (86/86)
All 86 differential CDP tests pass, matching Chrome exactly.

### All Panels Working (pixel-screenshot verified)
- **Elements**: Full DOM tree with expanded children + Styles + Computed ✅
- **Console**: tick messages + errors visible, evaluation works ✅
- **Network**: fetch requests with 200 status, headers, timing ✅
- **Sources**: File tree, breakpoints, stepping, scope inspection ✅
- **Performance**: Recording starts with timer ("Tracing... 14.7s") ✅ — but trace loading hangs after stop ⚠️

### Performance Recording Details
- **Starting**: Works perfectly — suspendAllTargets (2ms), Tracing.start (1ms), timer counting
- **During**: bufferUsage events flow, ScriptProfiler captures JS stack samples
- **Stopping**: Trace data sent (metadata + ProfileChunk with real CPU profile nodes)
- **Loading**: DevTools hangs at "Loading trace..." — trace parser can't process our data format
- **Root cause**: Unknown. The `sdk.js` error is at startup (not trace-related). The trace data has correct structure (Profile/ProfileChunk with parent references, nodes, samples, timeDeltas). Needs investigation of Chrome DevTools trace parser expectations.

### JS Profiling Data (Implemented but blocked by trace loading)
- ScriptProfiler.trackingComplete returns real stack traces with function names, line numbers
- buildChromeProfile() converts WebKit stack traces to Chrome's tree-based profile format
- 30+ profile nodes with function names like `fib`, `evaluateWithScopeExtension`
- 50+ stack samples with microsecond time deltas
- Profile data included as ProfileChunk trace events matching Chrome's format

### Animation Panel
- Events are sent (animationCreated, animationStarted) with name, type, duration
- Panel shows "No animations" — likely needs valid backendNodeId linking to DOM
- Fixed: iterations (-1 → 10000), currentTime normalization, keyframe values

### Key Architecture Decisions
- **Safe default responses**: Unhandled CDP methods return `{}` instead of errors — prevents DevTools features from blocking
- **Skip sessionId on native events**: Console/Network events must NOT have sessionId
- **DOM child expansion**: Await setChildNodes events before returning getDocument
- **Pixel screenshots for verification**: Text-based checks give false positives

## Remaining Backlog

### HIGH Priority
1. **Performance trace loading** — fix "Loading trace..." hang so flame chart renders
2. **Animation panel** — events sent but not displayed, needs backendNodeId

### MEDIUM Priority  
3. **Desktop bridge parity** — improve from ~25% toward 80%
4. **Source map support** — link profiler frames to original source positions
5. **Network in Performance timeline** — add request trace events

### LOW Priority
6. **Screenshots in Performance** — periodic screenshots during recording
7. **Input events** — EventDispatch trace events
8. **Desktop evaluate reliability** — extension WebSocket reconnection
