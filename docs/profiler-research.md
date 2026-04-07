# iOS Safari Profiler — Research & Design Document

## Goal

Produce Performance panel traces from iOS Safari that match Chrome DevTools quality as closely as possible: accurate timing, deep flame charts with function names, correct source linking, and all supporting timeline tracks (Network, Interactions, Screenshots, etc.).

---

## Raw Data Sources from WebKit

### 1. Timeline Domain

**API:** `Timeline.enable` → `Timeline.start` → receives `Timeline.eventRecorded` events → `Timeline.stop`

**What it provides:** Instrumented events with exact start/end timestamps for page activity.

**Record types observed:**
- **JS execution:** FunctionCall, EvaluateScript, TimerFire, TimerInstall, TimerRemove, FireAnimationFrame, RequestAnimationFrame, CancelAnimationFrame, EventDispatch, ObserverCallback
- **Rendering:** Layout, RecalculateStyles, InvalidateLayout, ScheduleStyleRecalculation, RenderingFrame
- **Painting:** Paint, CompositeLayers (mapped from "Composite")
- **Loading:** ParseHTML, XHRReadyStateChange, XHRLoad
- **Metrics:** FirstContentfulPaint, LargestContentfulPaint, TimeStamp, ConsoleProfile

**Record structure:**
```
{
  type: "FunctionCall",
  startTime: 12.899,       // seconds since first Timeline.enable
  endTime: 12.900,         // seconds since first Timeline.enable
  data: { scriptName: "https://...", scriptLine: 611, scriptColumn: 125 },
  children: [ { type: "Layout", ... }, ... ]
}
```

**Timestamp epoch:** Seconds since the **first `Timeline.enable` call** in the session — NOT since page load, NOT since `Timeline.start`, NOT since recording start. Determined empirically.

**Conversion to absolute μs:** `(calibratedOriginMs + record.startTime * 1000) * 1000` where `calibratedOriginMs = Date.now() - firstRecord.startTime * 1000` (computed from the first received event).

**Strengths:**
- Exact start/end timestamps for every event (instrumented, not sampled)
- Covers rendering, layout, paint, timers, event dispatch — not just JS
- Nested children provide some call depth within a single event
- Reliable event delivery when Timeline.enable/start are awaited

**Weaknesses:**
- FunctionCall events are **top-level containers** — they say "a script ran" but not which functions were called inside
- No function names — only script URL + line number
- No call stack depth beyond the children nesting (which is by event type, not function call depth)
- `children` nesting is event-type-based (FunctionCall → Layout → Paint), not function-call-based

**Critical discovery:** Timeline.enable + Timeline.start must be **awaited** (not fire-and-forget) or events silently don't flow on reconnections.

### 2. ScriptProfiler Domain

**API:** `ScriptProfiler.startTracking({includeSamples: true})` → receives `ScriptProfiler.trackingComplete` event on stop → `ScriptProfiler.stopTracking()`

**What it provides:** Sampled call stacks — snapshots of the JS call stack taken periodically.

**Data structure (from trackingComplete):**
```
{
  samples: {
    stackTraces: [
      {
        timestamp: 12.456,  // seconds since FIRST startTracking ever (accumulates!)
        stackFrames: [
          { name: "fibonacci", sourceID: 293, url: "...", line: 42, column: 10 },
          { name: "processData", sourceID: 293, url: "...", line: 38, column: 5 },
          ...
        ]
      },
      ...
    ]
  }
}
```

**Timestamp epoch:** Seconds since the **first `ScriptProfiler.startTracking` call** across the entire session. **Timestamps accumulate across multiple startTracking/stopTracking cycles** — they are NOT reset per recording. This means a second recording's traces include stale data from the first recording.

**Sampling rate:** Not controllable and not reported. `ScriptProfiler.startTracking` accepts only `{includeSamples: true}` — there is no interval parameter (unlike Chrome's `Profiler.setSamplingInterval`). WebKit provides no metadata about the intended or actual sampling frequency. We can only infer the rate from deltas between consecutive sample timestamps, which shows ~1-2Hz on real iOS devices vs Chrome V8's 100-1000Hz.

**Batching behavior:** Within a burst of JS execution, WebKit collects many stack snapshots but stamps them all with the **same timestamp** (zero delta between them). The first sample of the next burst has a large delta. This means 100+ samples can share one timestamp. Critically, **we cannot determine the real duration of a batched burst from the profiler data alone** — 40 zero-delta samples could represent 1ms or 100ms of actual execution. Only the corresponding Timeline FunctionCall event knows the real duration, which is why the anchoring approach is necessary.

**Observed rate patterns:**
- During sustained CPU work (e.g., fibonacci loop): non-zero samples show ~1-1.5ms intervals — surprisingly high resolution when JS is actively running
- During light/idle page activity: ~500-1000ms between samples
- Short JS bursts (<100ms): often 0 samples captured (missed entirely)
- The rate appears adaptive — WebKit samples more aggressively during CPU-bound execution

**Strengths:**
- Full call stack depth (observed up to 51 levels deep)
- Function names, source IDs, line/column numbers
- Captures internal call tree structure (who called whom)

**Weaknesses:**
- ~1-2Hz sampling misses most short JS bursts (10-100ms) entirely
- Timestamps accumulate across recordings (must filter to current window)
- Zero-delta batching requires redistribution for Chrome's renderer
- `sourceID` uses a different numbering than `Debugger.scriptParsed` scriptId
- 5 clicks × 50ms each over 5 seconds typically produces only 5-20 samples total

### 3. Profiler Domain (CDP)

**Status: NOT AVAILABLE on real iOS devices.** WebKit returns `"'Profiler' domain was not found"` when `Profiler.enable` is sent directly via WIR.

The bridge's CDP handler maps `Profiler.start`/`Profiler.stop` to ScriptProfiler internally. When we tested `Profiler.start` via the bridge (not direct WIR), it appeared to work with higher resolution — but this was because it went through the bridge's own handler which uses ScriptProfiler underneath.

### 4. Network Domain Events (during recording)

**Events:** `requestWillBeSent`, `responseReceived`, `dataReceived`, `loadingFinished`, `loadingFailed`

**Timestamp epoch:** `timestamp` field is seconds since **page load** (aligns with `performance.timeOrigin`). Conversion: `(pageTimeOrigin + timestamp * 1000) * 1000` → absolute μs.

### 5. Heap Domain (GC events)

**Events:** `Heap.garbageCollected` with `collection.type`, `collection.startTime`, `collection.endTime`

**Timestamp epoch:** Likely seconds since `Heap.enable` was called. Needs further investigation — GC events sometimes appear outside the recording window.

### 6. Page APIs (via Runtime.evaluate)

- `performance.timeOrigin` — absolute ms timestamp of page creation
- `performance.now()` — ms since page load
- `performance.getEntriesByType("mark"/"measure"/"paint"/"largest-contentful-paint")` — user timing + web vitals
- `Page.captureScreenshot` / `Page.snapshotRect` — screenshots (snapshotRect has 3s timeout, may not work on all devices)

---

## Chrome's Expected Trace Format

Chrome DevTools Performance panel expects trace events in the [Trace Event Format](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/):

### Core events that drive the UI:

| Event | What it drives | Phase | Required fields |
|-------|---------------|-------|----------------|
| `TracingStartedInBrowser` | Trace anchor | `I` | `ts`, `args.data.frames[]` |
| `Profile` | Flame chart header | `P` | `ts`, `id`, `args.data.startTime` |
| `ProfileChunk` | Flame chart body | `P` | `ts`, `id`, `args.data.{cpuProfile, timeDeltas}` |
| `FunctionCall` | Summary pie (Scripting) | `X` | `ts`, `dur`, `args.data.{url, frame}` |
| `Layout`/`RecalculateStyles` | Summary pie (Rendering) | `X` | `ts`, `dur` |
| `Paint`/`CompositeLayers` | Summary pie (Painting) | `X` | `ts`, `dur` |
| `RunTask` | Task grouping, Long Task detection | `X` | `ts`, `dur` |
| `EventTiming` | Interactions track | `X` | `ts`, `dur`, `args.data.type` |
| `ResourceSendRequest` | Network track (start) | `I` | `ts`, `args.data.{requestId, url}` |
| `ResourceFinish` | Network track (end) | `I` | `ts`, `args.data.{requestId}` |
| `Screenshot` | Filmstrip | `O` | `ts`, `args.snapshot` (base64) |
| `GCEvent` | GC markers | `X` | `ts`, `dur` |

### ProfileChunk structure:
```json
{
  "cat": "disabled-by-default-v8.cpu_profiler",
  "name": "ProfileChunk",
  "ph": "P",
  "pid": 2, "tid": 1,
  "ts": <absolute μs>,
  "id": "<unique per recording>",
  "args": {
    "data": {
      "cpuProfile": {
        "nodes": [
          { "id": 1, "callFrame": { "functionName": "(root)", "scriptId": "0", "url": "", "lineNumber": -1, "columnNumber": -1 } },
          { "id": 2, "callFrame": { "functionName": "fibonacci", "scriptId": "293", "url": "https://...", "lineNumber": 42, "columnNumber": 10 }, "parent": 1 },
          ...
        ],
        "samples": [2, 2, 3, 2, ...],   // leaf node id at each sample point
      },
      "timeDeltas": [0, 1000, 1000, ...]  // μs between consecutive samples
    }
  }
}
```

Chrome's flame chart renderer uses `Profile.args.data.startTime` as the anchor. Each sample is placed at `startTime + sum(timeDeltas[0..i])`. Consecutive samples with the same leaf node are merged into one visual block. Zero-delta samples at the same position are rendered as a single instant with the deepest stack shown.

---

## What We've Tried and Results

### Timestamp Approaches

| Approach | Result | Why |
|----------|--------|-----|
| `traceStartTime` as Timeline base | Events seconds/minutes off | Timeline uses its own epoch |
| `performance.timeOrigin` as Timeline base | Same — off by page age | Timeline epoch ≠ page load |
| `traceStartTime` assuming seconds-since-start | Worked for fresh pages, broke for aged pages | Timeline.start doesn't reset the clock |
| **Empirical calibration** from first event | ✅ CORRECT | `originMs = Date.now() - firstRecord.startTime * 1000` |

### ProfileChunk Approaches

| Approach | Result | Why |
|----------|--------|-----|
| Raw zero-deltas (no smoothing) | All samples at t=0, one giant block | Chrome renders zero-delta samples at same position |
| Assign 1ms to each zero-delta | All samples compressed to first 200ms | Loses real inter-burst gaps |
| Assign 100μs per zero-delta sample | Still concentrated | Same problem at smaller scale |
| Skip ProfileChunk when sparse | Correct timing but no function names | Lost flame chart entirely |
| **Anchor batches to Timeline events** | ✅ BEST SO FAR | Distributes samples evenly across Timeline FunctionCall timestamps |

### FunctionCall Synthesis

| Approach | Result | Why |
|----------|--------|-----|
| Synthesize from profiler samples | Multi-second ghost calls | Sparse sampling + gap accumulation |
| Skip synthesis | No function names in summary | Timeline FunctionCalls lack names |
| **Disabled** (current) | Correct — rely on Timeline + ProfileChunk | Synthesis added wrong data |

### ScriptProfiler Data Handling

| Issue | Fix |
|-------|-----|
| Timestamps accumulate across recordings | Window filter: keep only traces within `(rawLast - recordingDur - 0.1)` to `rawLast` |
| First delta starts at 0 (misplaces first batch) | Compute offset from window start |
| Recording end inflated by async waits | Capture `recordingEndTs` at start of Tracing.end |

---

## Current Architecture

```
Tracing.start
  ├── Timeline.enable + Timeline.start (await)
  ├── ScriptProfiler.startTracking
  ├── Heap.enable (for GC events)
  ├── Screenshot timer (1s interval)
  ├── BufferUsage timer (500ms interval)
  └── Capture performance.timeOrigin + traceStartTime

During recording:
  ├── Timeline.eventRecorded → #flattenTimelineRecord → client.traceEvents[]
  │     (calibrate epoch on first event)
  ├── Network events → client._traceNetworkEvents[]
  ├── Heap.garbageCollected → client._traceGCEvents[]
  └── Screenshots → client._traceScreenshots[]

Tracing.end
  ├── Capture recordingEndTs (before any async waits)
  ├── Timeline.stop + drain remaining events
  ├── Collect User Timing + Web Vitals (Runtime.evaluate)
  ├── Convert network events to Resource* trace events
  ├── ScriptProfiler.stopTracking → wait for trackingComplete (15s timeout)
  ├── #buildChromeProfile:
  │     ├── Filter traces to recording window
  │     ├── Build node tree (dedup by parentId:sourceID:line:col:name)
  │     ├── Resolve sourceID → Debugger scriptId via URL lookup
  │     ├── Distribute zero-delta batches (100μs per sample within gaps)
  │     └── Return { nodes, samples, timeDeltas, startTime }
  ├── Anchor ProfileChunk samples to Timeline FunctionCall timestamps
  ├── Build cleanEvents:
  │     ├── Metadata events
  │     ├── TracingStartedInBrowser
  │     ├── Window-filtered Timeline events (with RunTask bursts)
  │     ├── EventTiming from EventDispatch
  │     ├── Profile + ProfileChunk
  │     ├── GC events
  │     └── Screenshots
  └── Send Tracing.dataCollected + Tracing.tracingComplete
```

---

## Comparison: Chrome vs Bridge on Google Images

Recorded the same user journey (click image, wait, close) on both Chrome (mobile emulation) and our bridge (real iPhone):

| Metric | Chrome Desktop (mobile emu) | Bridge (real iPhone) |
|--------|---------------------------|---------------------|
| Total events | 29,694 | 1,100 |
| FunctionCall | 628 | 230 |
| ProfileChunk samples | 161 (across 371 chunks) | 424 (1 chunk) |
| ProfileChunk nodes | 75 | 2,347 |
| Max call depth | 15 | 51 |
| EventDispatch | 22 | 196 |
| EventTiming | 234 | 28 |
| Screenshots | 68 | 5 |
| RunTask | 12,410 | 13 |
| Timeline span | 10.6s | 6.8s |
| Longest FunctionCall | 1,762ms | 112ms |

**Key observations:**
- Bridge actually captures MORE profile depth (51 vs 15) and more nodes (2,347 vs 75)
- Bridge captures many more EventDispatch events (196 vs 22)
- Chrome has vastly more infrastructure events (RunTask, GPU, Raster, etc.) that we can't replicate
- Chrome's profiler distributes data across 371 ProfileChunks; we use 1 large chunk
- Our FunctionCalls have correct sub-second durations (max 112ms) — no more multi-second fakes

---

## Known Remaining Issues

### Flame Chart Depth
- **Open click shows 2-3 levels deep;** close click shows more depth
- Root cause: Timeline FunctionCall events are top-level containers. Depth comes only from ProfileChunk samples that happened during that event.
- Short bursts (~50ms) may get 0 profiler samples, so the flame chart shows just the Timeline FunctionCall shell
- Longer bursts get more samples, showing deeper stacks

### ScriptProfiler Sampling Rate
- Cannot be controlled from the inspector protocol
- ~1-2Hz means most sub-100ms JS executions are completely missed
- This is a fundamental WebKit limitation on iOS

### Source Linking
- Timeline FunctionCall events now include scriptId resolved via URL
- ProfileChunk nodes resolve sourceID → Debugger scriptId via URL
- Scripts without URLs (eval'd code, WebKit internals) still go to Application tab
- After recording, Debugger re-enables and sends fresh scriptParsed events — scriptIds may shift

### Reconnection
- WIR session doesn't always release cleanly on disconnect
- 500ms delay added after disconnect; still unreliable
- Chrome://inspect sometimes shows stale targets

---

## Theoretical Best Possible Solution

Given WebKit's constraints, the optimal approach combines both data sources at their strengths:

### Timeline provides the **skeleton:**
- Exact timing for every JS execution burst, rendering pass, layout, paint
- Correct duration for each activity
- Event type categorization (Scripting/Rendering/Painting)

### ProfileChunk provides the **flesh:**
- Function names and call trees sampled during each burst
- Call stack depth showing which functions were on the stack
- Source locations for each function

### The merge strategy:
1. Each Timeline FunctionCall/TimerFire/EventDispatch event defines a time window
2. ProfileChunk samples within that window show what was happening on the stack
3. Chrome's renderer combines them: Timeline events appear in the "devtools.timeline" track, ProfileChunk samples appear in the "Main" flame chart
4. The flame chart shows depth only where profiler samples exist

### What we CAN'T do:
- Show every function call with exact entry/exit time (would need V8-style instrumentation)
- Guarantee profiler samples during short (<100ms) JS bursts
- Match Chrome's volume of infrastructure events (RunTask, GPU, Raster)
- Show consistent flame chart depth for all bursts (depends on sampling luck)

### What we CAN improve:
- **Multiple ProfileChunks:** Chrome sends 371 chunks. We send 1. Splitting into multiple smaller chunks might improve Chrome's rendering. Worth investigating.
- **Better sample-to-event matching:** Instead of distributing samples evenly, match each profiler sample's timestamp to the nearest Timeline event. This would place samples more accurately.
- **Timeline children exploitation:** WebKit Timeline records have `children[]` arrays. A FunctionCall may contain child FunctionCall, Layout, etc. We flatten these but could use them to add nesting depth.
- **Longer recording stability:** Ensure Timeline calibration and ScriptProfiler window filtering remain correct for recordings >30s.
- **Network track rendering:** Events exist but Chrome may need specific formatting to show the waterfall. Needs investigation of exact format Chrome expects.

---

## Open Questions

1. **Can we increase ScriptProfiler sampling rate?** Is there a WebKit preference, environment variable, or entitlement that controls this?
2. **What exactly do Timeline children contain?** Are there nested FunctionCall children that would give us call depth without the profiler?
3. **Would sending multiple ProfileChunks help?** Chrome's 371-chunk approach might have rendering benefits.
4. **Is there a way to get V8-style function instrumentation on JSC?** Perhaps through the Debugger domain's pause-on-function-entry?
5. **Could we use the Debugger domain's call stack info?** When paused at a breakpoint, we get full call frames. Could we briefly pause at function entries to capture stacks? (Extremely expensive, probably not viable.)

---

*Last updated: 2026-04-07*
*Based on testing with iPhone 12 mini, iOS 26.3.1, Safari 26.4, Chrome 146*
