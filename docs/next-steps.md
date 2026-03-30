# Next Steps

## Mobile Goals and Status

Date: March 29, 2026

This document records the current state of mobile support and lays out concrete strategies for the remaining hard parts after native mobile attach started working.

### Target capabilities

The mobile bridge should provide:

- a Chrome DevTools Protocol adapter for WebKit on iOS
- automatic discovery of physical iOS devices
- automatic discovery of iOS simulators on macOS
- Chrome DevTools and other CDP-compatible tooling support
- simple CLI startup
- built-in target picker UX instead of a manual proxy chain
- USB and Wi-Fi device support
- a protocol mapping layer on top of raw WebKit connectivity, not just raw proxy passthrough

## Current Repo State

### What works today

- desktop Safari has a working CDP bridge in [src/desktop.js](src/desktop.js)
- native iOS target discovery now works for:
  - iOS simulator Safari pages
  - physical iPhone Safari pages
- a native mobile CDP bridge now works for:
  - iOS simulator Safari pages
  - physical iPhone Safari pages
- the iPhone can be launched and navigated from the Mac with `devicectl`
- built-in fixtures can be loaded on a real iPhone using a LAN-reachable URL
- `npm start` starts both bridges and surfaces real simulator and device targets
- `http://localhost:9221/json/list` now returns attachable mobile targets with live `webSocketDebuggerUrl` values
- helper CDP WebSocket smoke tests pass for both simulator and USB iPhone

### What still does not work

- the iOS 18+ WebInspector shim path is not bootstrapped automatically
- the privileged tunnel setup needed by `appium-ios-remotexpc` fails here with `Failed to connect to utun control socket: Operation not permitted`

### What was added (March 29, 2026)

- full mobile instrumentation script (`src/mobile-instrumentation.js`) for console, network, debugger, profiler, animation, and DOM mutation domains
- 500ms event polling loop with per-client broadcasting
- mobile CDP handler coverage expanded: Debugger (breakpoints, pause/resume/step, source maps, script discovery), Profiler (start/stop with source-mapped profile output), Animation (enable/disable, seek, pause, playback rate, resolve), Network (getResponseBody, full request/response lifecycle with POST body capture)
- source map support: discovery via page-side XHR, TraceMap integration, virtual source scripts, mapped breakpoints and pause locations
- CSS matched styles: getMatchedStylesForNode returns real inline + computed styles; getAnimatedStylesForNode returns animation/transition styles
- DOM mutation observation: MutationObserver-based live DOM events (childNodeInserted/Removed, attributeModified, characterDataModified)
- Page.captureScreenshot via simctl io screenshot (simulator) with canvas fallback
- session reliability: auto-reconnect on disconnect, stale client cleanup, polling backoff, per-client domain state
- multi-tab support: per-client domain enablement (debugger, animation, DOM observer) — multiple tabs can be inspected independently
- HTML target picker page served at `http://localhost:9221/` with click-to-open DevTools links
- iOS 18+ shim tunnel diagnostics in doctor script with actionable error messages (utun, tunnel port, SIP, per-device iOS version)
- unified startup: `npm start` starts both bridges and opens the target picker

### Remaining gaps after March 29 additions

1. **iOS 18+ shim bootstrap** — still the hard blocker for modern real devices. Tunnel registry initialization requires root or SIP-disabled entitlements. `npm run doctor` now diagnoses this clearly but can't fix it. Needs either `sudo` helper automation or a documented manual step.

2. **Cross-origin source maps** — page-side XHR can only fetch same-origin source maps. Maps hosted on CDNs won't load. Could add a server-side fetch proxy or use the WIR protocol's built-in resource loading.

3. **CSS rule-level matched styles** — current implementation returns computed styles as a single "computed" rule. True matched CSS rules (by selector from stylesheets) would require CSSOM stylesheet enumeration (`document.styleSheets` + `CSSStyleSheet.cssRules`).

4. **Scope chain on pause** — debugger pause currently returns empty scopeChain. Implementing real scope inspection would require WIR-level scope probing or page-side variable capture.

5. **Conditional breakpoints** — `setBreakpointByUrl` doesn't support `condition` parameter. The callback wrapping pattern could evaluate conditions before pausing.

6. **Wi-Fi device discovery** — only USB devices are discovered. `appium-ios-device` may support network devices via lockdown; needs investigation.

7. **Sleep/wake recovery** — reconnect logic handles disconnects but doesn't handle iOS device sleep/wake gracefully (needs heartbeat + re-enumerate).

8. **Transport provider abstraction** — code still mixes simulator/legacy/shim transports inline. A formal `TransportProvider` interface would improve maintainability.

9. **Page.startScreencast** — currently a no-op stub. Could be implemented by periodic `captureScreenshot` calls at reduced resolution.

10. **Inline style editing** — CSS.setStyleTexts / CSS.setPropertyText are not implemented. Would need `element.style.setProperty()` calls through the session.

11. **View Transition API debugging** — Chrome DevTools supports View Transitions in the Animation tab. Safari supports the View Transition API (`document.startViewTransition()`) but transitions may not surface through `document.getAnimations()` the same way as standard CSS/Web animations. Needs explicit testing: do `::view-transition-*` pseudo-element animations appear in `getAnimations({ subtree: true })`? If not, we need to hook `document.startViewTransition()` and observe the `ViewTransition` object's `.ready`/`.finished` promises and `::view-transition-group(*)` pseudo-element animations separately. Should test on both desktop Safari and iOS simulator, then add instrumentation if gaps exist.

## Technical Gaps

### 1. Attach works, but session reliability needs improvement

We now have attach, but the attach path is not yet production-grade.

Our current mobile path can:

- enumerate device
- enumerate app
- enumerate page
- create a native debugger session
- expose a usable CDP target socket

What still needs work:

- reconnect behavior
- stale-target cleanup
- sleep/wake handling
- tab churn handling
- Wi-Fi and unplug/replug resilience

### 2. No mobile protocol adapter yet

The repo currently has:

- desktop Safari to CDP adapter
- mobile WebKit target discovery

It does not yet have:

- mobile WebKit inspector message transport bound into a CDP-facing target server
- event translation for mobile WebKit inspector domains
- target/page/session lifecycle handling for mobile targets

That protocol-mapping layer is the core remaining build.

### 3. iOS 18+ shim transport bootstrap

For modern iPhones, the likely preferred path is the WebInspector shim accessed through `appium-ios-remotexpc`.

What is missing in this repo:

- a managed tunnel registry lifecycle
- strongbox registration of the tunnel registry port
- health/restart logic for the shim transport
- privilege handling for the tunnel bootstrap

Today, the shim client fails because the tunnel registry is not initialized. Direct tunnel creation then fails at the TUN interface permission boundary.

### 4. Transport abstraction

The mobile code still mixes together:

- simulator transport
- legacy real-device transport
- modern iOS shim transport
- helper HTTP UX

We need a clean internal abstraction:

- `TransportProvider`
- `TargetEnumerator`
- `InspectorSession`
- `CdpTargetAdapter`

Without that separation, every mobile improvement will become brittle.

### 5. Real target socket exposure

The bridge needs to expose endpoints that Chrome DevTools can consume directly.

We still need:

- `json/version`
- `json/list`
- `devtools/page/:id` WebSocket
- target-scoped CDP session routing
- navigation/reload/runtime/debugger bindings for mobile targets

Right now, our `/json/list` is informative but not attachable.

### 6. Session reliability

Capabilities we still need to build:

- persistent reconnect logic when the device sleeps or re-enumerates
- automatic tab refresh and target list invalidation
- stale-session cleanup
- background polling and backoff
- device unplug/replug recovery
- simulator boot/reboot recovery

### 7. Cross-platform story

Even if we only care about macOS right now, the architecture should aim for:

- a platform-neutral public surface
- Apple-specific internals hidden inside transport workers

Our current code still assumes local macOS command-line tooling throughout:

- `simctl`
- `devicectl`
- macOS network assumptions

That is acceptable short-term, but it is still a gap relative to the target architecture.

## Developer Experience Gaps

### 1. One command vs many concepts

The ideal CLI experience is:

- install
- run one command
- click target

Our current flow still requires understanding:

- desktop bridge vs iOS helper
- simulator vs phone
- localhost vs LAN URL for phone fixtures
- discovery endpoints vs attachable targets
- current limitations of the shim tunnel

### 2. Error clarity

Troubleshooting should be explicit and productized.

Our current mobile path still has several expert-only failure modes:

- silent fallback from shim to legacy
- tunnel bootstrap permissions problem
- simulator Web Inspector showing `about:blank`
- page exists in `/json/list` but is not attachable

### 3. No single mobile “ready” state

We need a clear definition:

- helper started
- simulator target present
- device target present
- target attachable in DevTools

Right now we only have partial readiness.

### 4. No productized UI for target selection

We expose JSON and helper endpoints but lack a polished target selection experience.

The goal is:

- a visible device/target list
- click-to-open DevTools behavior

We should achieve that simplicity with either:

- a tiny local HTML control page
- or automatic Chrome opening when a target becomes ready

### 5. Naming and command clarity

Commands have been consolidated to four: `npm start`, `npm run doctor`, `npm run verify`, `npm run kill`.

## The Hard Part

The hard part is not “finding devices” anymore.

The hard part is:

- obtaining a stable mobile WebKit inspector transport
- converting that transport into a stable CDP session model
- packaging it so users do not have to know anything about shim, tunnels, WebKit, or Apple transport differences

That breaks into two sub-problems:

1. Transport bootstrap and permissions
2. Protocol/session translation and reliability

## Strategies To Pursue

### Strategy A: Finish the current Appium-based path

Approach:

- keep `appium-remote-debugger` for page enumeration and low-level WebKit messaging
- add a managed shim tunnel bootstrap with `appium-ios-remotexpc`
- build a mobile `devtools/page/:id` WebSocket that translates between CDP and WebKit

Pros:

- builds directly on what is already working
- fastest path to a working prototype
- least amount of fresh reverse engineering

Cons:

- inherits Appium assumptions and complexity
- tunnel bootstrap may require privilege handling that is awkward for a simple local tool
- may still leave us with transport edge cases we do not control

When to choose it:

- when the goal is fastest progress to a mobile attachable prototype on macOS

### Strategy B: Treat transport and CDP translation as separate subsystems

Approach:

- formalize an internal `TransportProvider` layer
- implement:
  - `SimulatorTransportProvider`
  - `LegacyRealDeviceTransportProvider`
  - `ShimRealDeviceTransportProvider`
- build a single `MobileCdpBridge` above them

Pros:

- cleanest architecture
- easiest to test
- lets us swap transports without rewriting the bridge

Cons:

- more up-front engineering
- slower initial visible progress

When to choose it:

- when we want a serious maintainable mobile subsystem rather than a quick spike

### Strategy C: Build a minimal attachable bridge first, then expand domains

Approach:

- do not aim for full parity initially
- support just enough for attachability:
  - target discovery
  - runtime evaluate
  - page navigation/reload
  - console
  - basic network
  - basic DOM
- expand debugger, source maps, timeline, animation, etc. later

Pros:

- shortest path to “DevTools opens on mobile target”
- forces focus on critical-path functionality

Cons:

- partial DevTools behavior at first
- users may hit unsupported domains quickly

When to choose it:

- immediately, regardless of the transport strategy

### Strategy D: Native shim first for modern iOS, legacy fallback second

Approach:

- treat the iOS 18+ shim path as the primary supported phone path
- keep legacy transport only as fallback for older devices or unsupported scenarios

Pros:

- aligns with modern iOS reality
- avoids investing too much in a path Apple is steadily replacing

Cons:

- forces us to solve tunnel bootstrap and permissions early
- can block short-term progress if the privilege story remains painful

When to choose it:

- once we want a credible path for modern real devices instead of just “something that sometimes works”

### Strategy E: Desktop-style synthetic layer for mobile first

Approach:

- use discovered mobile targets
- proxy only a narrow set of high-value features with synthetic or best-effort implementations
- postpone deep protocol parity

Pros:

- could get a usable first version sooner
- avoids overcommitting to protocol completeness

Cons:

- may diverge from true DevTools expectations quickly
- risks another partial solution that feels fragile

When to choose it:

- for experimental validation only, not as the final architecture

### Strategy F: Replace Appium transport entirely later, but not yet

Approach:

- continue with Appium-based transport for now
- design the bridge so that transport can later be swapped out for:
  - a direct WebKit inspector implementation
  - a native helper
  - a packaged privileged tunnel daemon

Pros:

- pragmatic
- preserves momentum
- avoids a full rewrite now

Cons:

- some technical debt is inevitable

When to choose it:

- now

## Recommended Plan

### Phase 1: Productize native discovery and launch

Done or nearly done:

- simulator discovery
- real-device discovery
- simulator helper routes
- physical-device launch via `devicectl`
- one-command `npm start`

Next polish:

- make simulator navigation more deterministic
- auto-refresh target lists after navigate
- add a tiny local HTML target picker page

### Phase 2: Build a minimal attachable mobile target

Implement:

- `webSocketDebuggerUrl` for one mobile target
- CDP session routing
- basic runtime/page domains

Definition of done:

- Chrome DevTools opens on a simulator or iPhone target from this repo

### Phase 3: Solve modern iPhone shim bootstrap

Implement:

- tunnel registry management
- strongbox registration
- explicit diagnostics for privilege requirements
- fallback/upgrade logic between legacy and shim transport

Definition of done:

- iOS 18+ real-device attach path prefers shim automatically when available

### Phase 4: Reliability and UX

Implement:

- reconnect logic
- stale target cleanup
- health dashboard or simple HTML UI
- clear “ready / degraded / blocked” states

### Phase 5: Feature parity expansion

Expand into:

- debugger
- source maps
- network fidelity
- profiler
- performance
- animation inspection on mobile if WebKit transport allows it

## Concrete Immediate Tasks

### Critical path

1. Add a real mobile `devtools/page/:id` WebSocket target backed by the existing native-discovered pages.
2. Start with simulator only for the first attachable target because it avoids the shim-tunnel permission problem.
3. Reuse the desktop bridge’s CDP dispatcher patterns where possible, but keep transport separate.
4. Add a small HTML landing page on `9221` that lists devices and opens DevTools for attachable targets.

### Parallel track

1. Investigate whether the iOS 18+ tunnel can be launched through a privileged helper or documented `sudo` bootstrap without degrading UX too badly.
2. If privilege is unavoidable, make it explicit and automatic:
   - detect missing tunnel
   - show exact command
   - verify registry port
   - retry shim attach automatically

## Decision

Recommended strategy mix:

- use Strategy B architecturally
- use Strategy C for delivery sequencing
- use Strategy F pragmatically for transport
- keep Strategy D as the modern real-device target state

That means:

- separate transport from protocol translation
- get one attachable simulator target working first
- keep using Appium-based transports while the bridge is being built
- solve the iOS 18+ shim path in parallel instead of blocking all progress on it
