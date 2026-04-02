# Native WebKit Debugger Protocol for iOS

Date: April 2, 2026

## Problem Statement

The current iOS breakpoint implementation uses a **cooperative JavaScript injection approach** rather than WebKit's native debugger protocol. This limits breakpoints to async callback boundaries (setTimeout, Promise.then, etc.) and prevents true line-level debugging.

## Current Architecture (Problematic)

### Breakpoint Flow Today

```
Debugger.setBreakpointByUrl
  → stores breakpoint locally in ios-webinspector.js
  → calls syncDebuggerConfig()
  → Runtime.evaluate injects breakpoint config into __mobileCdtBridge
  → __mobileCdtBridge.wrapCallback() checks breakpoints before async callbacks
  → if match: emits synthetic "paused" event
```

This approach:
- Only works at async callback boundaries
- Cannot stop at arbitrary line numbers mid-synchronous-execution
- Is architecturally similar to what desktop Safari bridge does via WebDriver

### What Should Happen

```
Debugger.setBreakpointByUrl
  → send native WebKit "Debugger.setBreakpointByUrl" command directly
  → WebKit engine pauses natively at the breakpoint
  → WebKit emits native "Debugger.paused" event
  → translate to CDP format and forward to DevTools frontend
```

## Required Changes

### 1. MobileInspectorSession needs direct WebKit command support

The `sendCommand()` method already exists and can send arbitrary WebKit commands:

```javascript
// Current usage (only via Runtime.evaluate):
const response = await this.rawWir.sendCommand("Runtime.evaluate", { expression, returnByValue: true });

// Needed: direct WebKit debugger commands:
await this.rawWir.sendCommand("Debugger.setBreakpointByUrl", {
  lineNumber: params.lineNumber,
  url: params.url,
  urlRegex: params.urlRegex,
  columnNumber: params.columnNumber,
  options: { condition: params.condition }
});
```

### 2. Implement missing WebKit debugger methods

The following CDP methods need to send native WebKit commands instead of using cooperative injection:

| CDP Method | WebKit Method to Send |
|------------|----------------------|
| `Debugger.setBreakpointByUrl` | `Debugger.setBreakpointByUrl` |
| `Debugger.setBreakpoint` | `Debugger.setBreakpoint` |
| `Debugger.resume` | `Debugger.resume` |
| `Debugger.stepInto` | `Debugger.stepInto` |
| `Debugger.stepOver` | `Debugger.stepOver` |
| `Debugger.stepOut` | `Debugger.stepOut` |
| `Debugger.pause` | `Debugger.pause` |
| `Debugger.setBreakpointsActive` | `Debugger.setBreakpointsActive` |
| `Debugger.setPauseOnExceptions` | `Debugger.setPauseOnDebuggerStatements` |
| `Debugger.setAsyncCallStackDepth` | `Debugger.setAsyncStackTraceDepth` (rename) |

### 3. Handle native pause events

Add handlers for native WebKit events:

```javascript
// In RawWirConnection or MobileInspectorSession
on('_rpc_targetSentData:', (data) => {
  // data contains WebKit protocol messages
  const msg = JSON.parse(data.WIRSocketDataKey.toString());
  if (msg.method === 'Debugger.paused') {
    // Transform WebKit pause to CDP format
    // Forward to DevTools frontend
  }
})
```

### 4. CDP Event Translations Needed

When receiving from WebKit:

| WebKit Event | CDP Event | Transformations |
|--------------|-----------|-----------------|
| `Debugger.paused` | `Debugger.paused` | Map scope types (WebKit uses `functionName`, `globalLexicalEnvironment`, etc. CDP uses `local`, `script`, `block`) |
| `Debugger.resumed` | `Debugger.resumed` | Direct pass |
| `Debugger.breakpointResolved` | `Debugger.breakpointResolved` | Direct pass |
| `Debugger.scriptParsed` | `Debugger.scriptParsed` | Add `executionContextId`, rename `module` → `isModule` |
| `Debugger.scriptFailedToParse` | `Debugger.scriptFailedToParse` | Direct pass |

### 5. Result Translations Needed

When receiving from WebKit:

| WebKit Result | CDP Result | Notes |
|---------------|------------|-------|
| `wasThrown: true` | `exceptionDetails` | Transform error format |
| `wasThrown: true` + no result | `type: 'object', subtype: 'error'` | Minimal error |
| `preview` | `preview` | Ensure `description` and `type` present |

## Implementation Plan

### Phase 1: Direct Command Passthrough

1. Add a `sendDebuggerCommand()` helper in `MobileInspectorSession`
2. Modify `setBreakpointByUrl()` to send native WebKit command first, fall back to cooperative if needed
3. Add logging to distinguish which path is being used

### Phase 2: Native Pause Handling

1. Add event handler for `Debugger.paused` from WebKit
2. Transform call frames, scope chain, and `this` binding to CDP format
3. Forward to DevTools frontend via existing transport

### Phase 3: Stepping Commands

1. Implement `stepInto`, `stepOver`, `stepOut`, `resume` to use native commands
2. Remove cooperative stepping logic

### Phase 4: Debugger Enable

On `Debugger.enable`, send:
```javascript
await sendCommand("Debugger.enable", {})
await sendCommand("Debugger.setBreakpointsActive", { active: true })
await sendCommand("Debugger.setPauseOnDebuggerStatements", { enabled: true })
```

## Key Reference: WebKit Inspector Protocol

WebKit's debugger protocol is documented in the WebKit source:
- `Source/JavaScriptCore/inspector/protocol/Debugger.json`

CDP reference:
- https://chromedevtools.github.io/devtools-protocol/1-3/Debugger/

## Testing Approach

1. Use iOS Simulator for fastest iteration
2. Test breakpoints at:
   - Synchronous code lines
   - Async callback boundaries (setTimeout, Promise)
   - Source-mapped locations
3. Test stepping: stepInto, stepOver, stepOut, resume
4. Verify scope chain and variable values in pause state

## Known WebKit-Specific Details

- WebKit uses `functionName` scope type, CDP uses `local`
- WebKit uses `globalLexicalEnvironment`, CDP uses `script`
- WebKit uses `nestedLexical`, CDP uses `block`
- WebKit `module` field → CDP `isModule`
- WebKit doesn't provide `executionContextId` - generate and track
- WebKit doesn't provide script `hash` - CDP expects this, can be empty string

## Relationship to Other Code

The `mobile-instrumentation.js` cooperative debugger can remain as a fallback for cases where native protocol fails, but the primary path for iOS should be native WebKit debugger commands since the transport supports it.

The `desktop.js` bridge uses cooperative injection because it drives Safari via WebDriver which cannot access native debugger protocol. iOS transport CAN access native protocol, so it should use it.
