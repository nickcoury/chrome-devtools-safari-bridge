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
- Root cause: `Timeline.start({})` uses default `maxCallStackDepth: 5` — we never pass a higher value!
- `maxCallStackDepth` controls a **separate `stackTrace` field** on each timeline record (NOT the `children[]` nesting)
- Every FunctionCall record has `record.stackTrace` with function names, URLs, scriptIds, line/column — **we completely ignore this field!**
- The `children[]` nesting is event-type based (FunctionCall → Layout → Paint), NOT call-stack based
- Short bursts (<100ms) may get 0 profiler samples, so the flame chart shows just the Timeline FunctionCall shell
- **FIX 1:** Pass `Timeline.start({maxCallStackDepth: 100})` to get deeper stack traces on each record
- **FIX 2:** Read `record.stackTrace` in `#flattenTimelineRecord` and use it to add function names and synthesize flame chart depth

### ScriptProfiler Sampling Rate
- Cannot be controlled from the inspector protocol (InspectorScriptProfilerAgent never calls `setTimingInterval`)
- JSC's SamplingProfiler actually runs at **1ms intervals (1000Hz)** internally — the `sampleInterval` JSC option defaults to 1000μs
- The ~1-2Hz we observe is a **delivery/batching artifact**, not the actual sampling rate
- During CPU bursts, many samples ARE captured at 1ms resolution (explaining zero-delta batches)
- During idle periods, there's nothing to sample (JS isn't running), creating the large inter-sample gaps
- The `setTimingInterval(Seconds)` method exists on SamplingProfiler but is never called by the inspector agent
- No protocol parameter to control it; would require a jailbroken device or debug WebKit build to change `--sampleInterval`

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
- **🔴 Read `record.stackTrace` from Timeline events** — EVERY FunctionCall record has a `stackTrace` field with function names, URLs, scriptIds that we completely ignore. This is the single biggest improvement available.
- **🔴 `maxCallStackDepth: 100` on Timeline.start** — Currently defaults to 5. Controls depth of the `stackTrace` array on each record.
- **🔴 Synthesize flame chart from stackTrace** — Convert the per-record call stack into nested trace events, giving function-level depth without relying on sampling.
- **🟡 `Timeline.setInstruments` before recording** — Confirmed from source: auto-starts ScriptProfiler + CPUProfiler + Memory tracking via single call.
- **🟡 CPUProfiler.trackingUpdate** — Per-thread CPU usage every ~500ms. Free data if ENABLE_RESOURCE_USAGE is active on iOS.
- **🟡 Inject PerformanceObserver** — Event Timing API (Safari 26.2+) gives microsecond-precision event handler durations.
- **🟡 Better zero-delta redistribution** — Distribute at 1ms intervals (true JSC rate) instead of evenly across FunctionCall duration.
- **🟡 Multiple ProfileChunks:** Chrome sends 371 chunks. We send 1. Splitting might improve Chrome's rendering.
- **🟢 Longer recording stability:** Ensure Timeline calibration and ScriptProfiler window filtering remain correct for recordings >30s.

---

## Deep Research Findings (2026-04-07)

### Discovery 1: `maxCallStackDepth` + `stackTrace` field — THE GAME CHANGER

**Status: 🔴 CRITICAL PRIORITY — easy fix, massive impact. VERIFIED IN WEBKIT SOURCE.**

`Timeline.start` accepts `{maxCallStackDepth: N}` (defaults to 5). We call `Timeline.start({})`.

**What we discovered in WebKit source (`TimelineRecordFactory.cpp`, `InspectorTimelineAgent.cpp`):**

`maxCallStackDepth` does NOT control `children[]` nesting. It controls a **separate `stackTrace` field** that WebKit attaches to every timeline record where `captureCallStack = true`. The code is:

```cpp
// TimelineRecordFactory.cpp:createGenericRecord()
if (maxCallStackDepth) {
    Ref<ScriptCallStack> stackTrace = createScriptCallStack(JSExecState::currentState(), maxCallStackDepth);
    if (stackTrace->size())
        record->setValue("stackTrace", stackTrace->buildInspectorObject());
}
```

```cpp
// InspectorTimelineAgent.cpp:willCallFunction()
pushCurrentRecord(TimelineRecordFactory::createFunctionCallData(scriptName, scriptLine, scriptColumn),
    TimelineRecordType::FunctionCall, /*captureCallStack=*/true);  // <-- true!
```

This means every `FunctionCall` record we receive has a `stackTrace` array containing:
- **Function names** (`functionName`)
- **URLs** (`url`)
- **Script IDs** (`scriptId`)
- **Line/column numbers** (`lineNumber`, `columnNumber`)
- Up to `maxCallStackDepth` frames deep

**We are completely ignoring this field in `#flattenTimelineRecord`.** We only read `record.type`, `record.data`, `record.startTime/endTime`, and `record.children`. The `stackTrace` field has been silently discarded.

**Which record types have `captureCallStack = true`:**
- ✅ `FunctionCall` (line 270) — the most important one
- ❌ `EventDispatch` (line 280) — `false`
- Other types vary

**Current code (line ~2259 in simulator.js):**
```javascript
await session.rawWir.sendCommand("Timeline.start", {});
```

**Fix:**
```javascript
await session.rawWir.sendCommand("Timeline.start", { maxCallStackDepth: 100 });
```

**And in `#flattenTimelineRecord`, read `record.stackTrace`:**
```javascript
// record.stackTrace is an array of {functionName, url, scriptId, lineNumber, columnNumber}
const stackTrace = record.stackTrace || [];
if (stackTrace.length > 0) {
    // Use stackTrace[0] to get the function name for THIS FunctionCall
    // Use the full array to synthesize flame chart depth
}
```

**Impact:** With this fix, we get function names on every FunctionCall event WITHOUT needing ScriptProfiler samples. We also get the full call stack depth, which we can use to synthesize nested flame chart entries. This could eliminate the "2-3 levels deep" problem entirely for events where the profiler has zero samples.

### Discovery 2: JSC's actual sampling rate is 1000Hz

**Status: ANSWERED — changes our mental model**

WebKit source (`OptionsList.h`) defines: `sampleInterval = 1000` (microseconds = 1ms = 1000Hz). The `SamplingProfiler` runs a background thread that:
1. Sleeps for `m_timingInterval` (~1ms ± 20% random fluctuation)
2. Pauses the JSC execution thread
3. Reads machine PC + frame pointer + interpreter PC
4. Constructs a stack trace from pre-allocated buffers (avoids malloc deadlocks)
5. Resumes execution

This means during CPU-bound JS, WebKit IS capturing ~1000 samples/second. The "1-2Hz" observation is because:
- Between CPU bursts, JS isn't running → nothing to sample → large timestamp gaps
- All samples within a burst get batched with the **same timestamp** (zero-delta) because `InspectorScriptProfilerAgent` only delivers data on `trackingComplete`, not in real-time
- The timestamp on each sample comes from a `Stopwatch`, not the system clock — so all samples taken during a single call to the sampling thread's "process stack traces" loop get the same time

**Implication:** The zero-delta batches of 40+ samples actually represent ~40ms of real execution at 1ms resolution. We CAN reconstruct timing by distributing them evenly across the corresponding Timeline FunctionCall duration — which is what our anchoring approach already does. The key insight is that this approach is **more correct than we thought**, not a hack.

### Discovery 3: `Timeline.setInstruments` — CONFIRMED in source, auto-starts domains

**Status: MEDIUM-HIGH PRIORITY — verified in WebKit source**

Safari Web Inspector calls `Timeline.setInstruments(instruments)` before starting a recording. When instruments are set, `Timeline.start` automatically toggles them on/off.

**Verified from `InspectorTimelineAgent.cpp`:**

```cpp
void InspectorTimelineAgent::toggleInstruments(InstrumentState state) {
    for (auto instrumentType : m_instruments) {
        switch (instrumentType) {
        case ScriptProfiler: toggleScriptProfilerInstrument(state); break;
        case Heap:           toggleHeapInstrument(state); break;
        case CPU:            toggleCPUInstrument(state); break;       // <-- FREE CPU data!
        case Memory:         toggleMemoryInstrument(state); break;    // <-- FREE memory data!
        case Timeline:       toggleTimelineInstrument(state); break;
        case Animation:      toggleAnimationInstrument(state); break;
        case Screenshot:     break; // No-op in backend (frontend handles)
        }
    }
}
```

**What each instrument starts:**
- `ScriptProfiler` → calls `scriptProfilerAgent->startTracking(true)` — same as our manual call
- `CPU` → calls `cpuProfilerAgent->startTracking()` — provides per-thread CPU usage via `CPUProfiler.trackingUpdate` events (every ~500ms)
- `Memory` → calls `memoryAgent->startTracking()` — provides memory category breakdown via `Memory.trackingUpdate` events
- `Heap` → calls `heapAgent->startTracking()` — provides allocation snapshots
- `Animation` → calls animation tracking
- `Screenshot` → **no-op in backend** — screenshots are handled by the frontend, so our manual capture is correct

**Recommended instruments:**
```javascript
await session.rawWir.sendCommand("Timeline.setInstruments", { 
  instruments: ["ScriptProfiler", "Timeline", "CPU", "Memory"] 
});
await session.rawWir.sendCommand("Timeline.start", { maxCallStackDepth: 100 });
```

This would auto-start ScriptProfiler + get CPU/Memory data for free. We should listen for `CPUProfiler.trackingUpdate` and `Memory.trackingUpdate` events during recording.

### Discovery 4: Injected PerformanceObserver — untapped precision data

**Status: MEDIUM PRIORITY — supplementary data source**

Safari 26.2+ supports `PerformanceEventTiming` via the Event Timing API. This gives:
- `processingStart` / `processingEnd` — exact microsecond-precision timing for event handlers
- `duration` — total event duration including rendering
- `interactionId` — groups related events (pointerdown → click)

**Injection approach (via `Runtime.evaluate` at recording start):**
```javascript
window.__bridgePerfEntries = [];
new PerformanceObserver((list) => {
  window.__bridgePerfEntries.push(...list.getEntries().map(e => ({
    name: e.name, type: e.entryType,
    startTime: e.startTime, duration: e.duration,
    processingStart: e.processingStart, processingEnd: e.processingEnd,
    interactionId: e.interactionId
  })));
}).observe({ type: "event", buffered: true });
```

**Collect at recording end:**
```javascript
const entries = await Runtime.evaluate({ expression: "JSON.stringify(window.__bridgePerfEntries)" });
```

This gives us exact handler durations even when ScriptProfiler gets zero samples during the event. We can use this to:
- Improve EventTiming trace events with real `processingStart`/`processingEnd`
- Fill in gaps where profiler missed short event handlers
- Build more accurate Interactions track data

**Additional PerformanceObserver entry types available in Safari:**
| Entry Type | Safari Support | Usefulness |
|------------|---------------|------------|
| `event` | 26.2+ | HIGH — event handler timing |
| `layout-shift` | 17+ | MEDIUM — CLS data for trace |
| `resource` | 11+ | Already have from Network domain |
| `paint` / `largest-contentful-paint` | 26.2+ | MEDIUM — web vitals markers |
| `mark` / `measure` | 11+ | HIGH if we inject instrumentation |
| `longtask` | NOT SUPPORTED | N/A — Chrome-only |

### Discovery 5: Entry-point wrapping for DIY profiling

**Status: LOW-MEDIUM PRIORITY — invasive but effective**

Wrap common JS entry points with `performance.mark/measure` to get precise timing:

```javascript
const origSetTimeout = window.setTimeout;
window.setTimeout = function(fn, delay, ...args) {
  const id = __nextId++;
  const wrapped = typeof fn === 'function' ? function() {
    performance.mark('timer-start-' + id);
    try { return fn.apply(this, args); }
    finally { performance.measure('timer-' + id, 'timer-start-' + id); }
  } : fn;
  return origSetTimeout.call(this, wrapped, delay);
};
// Similar for: requestAnimationFrame, addEventListener callbacks, Promise.then
```

**Risks:** Modifies page behavior, could break sites that check function identity. Should be opt-in.
**Benefit:** Microsecond-precision timing for every timer/rAF/event callback, even short ones.

### Discovery 6: Dead ends confirmed

| Approach | Status | Why |
|----------|--------|-----|
| JS Self-Profiling API (`new Profiler()`) | NOT SUPPORTED | WebKit has negative position on this spec |
| Profiler domain (CDP) | NOT AVAILABLE on iOS | Returns "domain not found" — already confirmed |
| `console.profile()` | Same as ScriptProfiler | Calls `startFromConsole` → same Timeline + ScriptProfiler path |
| Long Tasks API | NOT SUPPORTED | Chrome-only as of 2026 |
| DTX/Instruments profiling | No JS-level data | Only provides per-process CPU percentage |
| JSC tracing profiler | Removed | Replaced by sampling profiler; was 30x slower |
| `performance.memory` | NOT SUPPORTED | Chrome-only non-standard API |
| Proxy-based function wrapping | 50-700x overhead | Benchmarks show Proxy is far too slow |
| `os_signpost` / XPC | No JS data exposed | WebKit doesn't expose JS execution through these |

### Discovery 7: `Debugger.addSymbolicBreakpoint` with auto-continue

**Status: LOW-MEDIUM PRIORITY — viable for targeted profiling**

WebKit's Debugger domain has `addSymbolicBreakpoint` which matches function names (including regex) and can run actions without pausing:

```javascript
await session.rawWir.sendCommand("Debugger.addSymbolicBreakpoint", {
  symbol: "handleClick|processData|render",  // regex pattern
  isRegex: true,
  options: {
    actions: [{ type: "evaluate", data: "window.__fnTrace.push(performance.now())" }],
    autoContinue: true
  }
});
```

This would capture function entry timestamps for specific functions without pausing execution. Overhead is per-hit (not global), so it's viable for targeting specific hot functions. Not practical for all functions.

### Discovery 8: `CPUProfiler` domain — per-thread CPU usage

**Status: MEDIUM PRIORITY — free supplementary data**

WebKit has a separate `CPUProfiler` domain (conditional on `ENABLE_RESOURCE_USAGE`) that provides:

```json
// CPUProfiler.trackingUpdate event (fires every ~500ms during recording):
{
  "event": {
    "timestamp": 12.456,
    "usage": 85.2,           // total CPU % (can exceed 100% on multi-core)
    "threads": [
      { "name": "WebKit: Garbage Collection", "usage": 5.1, "type": "webkit" },
      { "name": "Worker (blob:...)", "usage": 12.0, "targetId": "worker-123" }
    ]
  }
}
```

The main thread is NOT in the `threads` array (it's the "remainder" — total minus thread sum). This could power a CPU usage track in the Chrome trace.

### Discovery 9: `Memory` domain — categorized memory tracking

**Status: LOW PRIORITY — nice to have**

The Memory domain provides periodic breakdowns during recording:

```json
// Memory.trackingUpdate event:
{
  "event": {
    "timestamp": 12.456,
    "categories": [
      { "type": "javascript", "size": 15728640 },
      { "type": "jit",        "size": 2097152 },
      { "type": "images",     "size": 8388608 },
      { "type": "layers",     "size": 1048576 },
      { "type": "page",       "size": 4194304 },
      { "type": "other",      "size": 524288 }
    ]
  }
}
```

Could be used to add a memory track to Chrome traces. Both CPU and Memory domains are conditional on `ENABLE_RESOURCE_USAGE` — need to verify they work on real iOS devices.

### Discovery 10: Screenshot instrument is a no-op in backend

**Status: CONFIRMED — our approach is correct**

The `Screenshot` instrument case in `toggleInstruments` does `break;` with no action. Screenshots are handled by the Web Inspector frontend, not the backend. Our manual `Page.captureScreenshot` approach is the correct one.

### Discovery 11: Complete WebKit Inspector Protocol domain inventory

**27 domains available** (from `Source/JavaScriptCore/inspector/protocol/`):

| Domain | Profiling relevance |
|--------|-------------------|
| **CPUProfiler** | Per-thread CPU usage — NEW, untapped |
| **Memory** | Memory category breakdown — NEW, untapped |
| **ScriptProfiler** | Sampling profiler — already using |
| **Timeline** | Instrumented events — already using, need `maxCallStackDepth` + `stackTrace` |
| **Heap** | GC events + allocation snapshots — partially using (GC only) |
| **Animation** | Animation state tracking — already using for Animations panel |
| **Debugger** | Symbolic breakpoints — NEW capability for targeted profiling |
| Canvas | Canvas operations — not relevant for JS profiling |
| DOM/CSS/Network/Page | Already using for other features |
| Others (Audit, Browser, etc.) | Not relevant |

---

## Updated Open Questions

1. ~~Can we increase ScriptProfiler sampling rate?~~ **ANSWERED:** JSC samples at 1ms internally. The rate is fine; the delivery is batched. Can't change it via protocol.
2. ~~What exactly do Timeline children contain?~~ **ANSWERED:** `children[]` is event-type nesting (FunctionCall → Layout → Paint). `maxCallStackDepth` controls a SEPARATE `record.stackTrace` field with function names + call frames. **We've been ignoring this field.**
3. ~~Does `Timeline.setInstruments` change data delivery?~~ **ANSWERED:** It auto-starts/stops the specified domains. ScriptProfiler starts with `includeSamples: true`. CPU/Memory provide periodic tracking updates. No change to Timeline event structure.
4. ~~What does `maxCallStackDepth: 100` actually produce?~~ **ANSWERED from source:** Each FunctionCall record gets `record.stackTrace` = array of `{functionName, url, scriptId, lineNumber, columnNumber}` up to 100 frames deep. This is the JS call stack at the moment of the function call.
5. **Can injected PerformanceObserver coexist with profiling?** Does `Runtime.evaluate` injection at recording start interfere with Timeline recording?
6. ~~Is there a way to get V8-style function instrumentation on JSC?~~ **ANSWERED: No.** The tracing profiler was removed. No bytecode instrumentation available.
7. ~~Would the `CPU` instrument provide useful per-thread usage data?~~ **ANSWERED from protocol:** `CPUProfiler.trackingUpdate` provides total CPU%, per-thread breakdown with name/type/targetId, at ~500ms intervals. Need to verify `ENABLE_RESOURCE_USAGE` is active on iOS.
8. **Does `ENABLE_RESOURCE_USAGE` compile flag apply to iOS Safari?** CPUProfiler and Memory domains are conditional on this. If it's disabled on iOS, these domains won't work.
9. **How should we synthesize flame chart entries from `record.stackTrace`?** Should we create synthetic nested FunctionCall events? Or feed the stack frames into ProfileChunk nodes?

---

## Recommended Action Plan

### Phase 1: The stackTrace breakthrough (HIGHEST IMPACT)
1. **Pass `maxCallStackDepth: 100` to `Timeline.start`** — Single line change, gives us full call stacks on every FunctionCall record
2. **Read `record.stackTrace` in `#flattenTimelineRecord`** — Extract function names, URLs, scriptIds from the call stack we've been ignoring
3. **Add function names to FunctionCall trace events** — Use `stackTrace[0].functionName` to label each FunctionCall
4. **Synthesize flame chart depth from stack traces** — Convert the call stack into nested trace events, giving us function-level depth WITHOUT relying on ScriptProfiler samples

### Phase 2: Instrument orchestration
5. **Call `Timeline.setInstruments(["ScriptProfiler", "Timeline", "CPU", "Memory"])` before `Timeline.start`** — Verified from source: this auto-starts ScriptProfiler + CPU/Memory tracking
6. **Listen for `CPUProfiler.trackingUpdate` events** — Per-thread CPU usage data every ~500ms (if `ENABLE_RESOURCE_USAGE` is active on iOS)
7. **Listen for `Memory.trackingUpdate` events** — Memory category breakdown during recording

### Phase 3: Supplementary data sources
8. **Inject PerformanceObserver for Event Timing API** — Get precise event handler durations (Safari 26.2+)
9. **Inject `performance.mark/measure` around entry points** — DIY Long Tasks for short bursts
10. **Split into multiple ProfileChunks** — Chrome sends 371 chunks; we send 1. May improve rendering.

### Phase 4: Advanced techniques
11. **Better zero-delta redistribution** — Distribute at 1ms intervals (matching true JSC sampling rate) instead of evenly across FunctionCall duration
12. **`Debugger.addSymbolicBreakpoint` with auto-continue** — Targeted function entry timing for specific hot paths
13. **Combine stackTrace + ProfileChunk data** — Use Timeline stackTrace for structure, ProfileChunk for timing within bursts

---

*Last updated: 2026-04-07*
*Based on testing with iPhone 12 mini, iOS 26.3.1, Safari 26.4, Chrome 146*
*Research sources: WebKit source (TimelineRecordFactory.cpp, InspectorTimelineAgent.cpp, SamplingProfiler.cpp, OptionsList.h, InspectorScriptProfilerAgent.cpp, Timeline.json, ScriptProfiler.json, CPUProfiler.json, Memory.json, Debugger.json), WebKit blog posts, MDN, CanIUse, Bun inspector protocol*
