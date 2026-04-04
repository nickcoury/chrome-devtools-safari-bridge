# Mobile Maintainer Context

This file is for future agents and maintainers working on the iOS side of this repo.

It is intentionally practical. Read this before changing the mobile path.

## Current truth

The repo has two different states:

- desktop Safari is a real CDP bridge and is the working product
- iOS simulator and physical iPhone now also have a working mobile CDP attach bridge through the helper

That distinction matters. Do not confuse:

- `target discovery works`

with:

- `Chrome DevTools can attach through the local helper`

## Current mobile capability

As of commits:

- `5f534f4` Add native iOS Web Inspector discovery
- `258eeff` Improve native iOS helper workflow

the mobile helper can:

- discover iOS simulators through `simctl`
- discover physical iPhones through `appium-ios-device`
- resolve the simulator Web Inspector socket
- enumerate native Web Inspector pages for simulator and real device
- launch MobileSafari on a physical iPhone with `devicectl`
- open a real-device fixture URL over the Mac's LAN IP
- expose mobile targets through `http://localhost:9221/json/list`
- expose attachable mobile `webSocketDebuggerUrl` targets through the helper
- attach a native Web Inspector session for simulator and physical device
- translate enough CDP for runtime, DOM, CSS, and page basics on mobile

The mobile helper still does not yet:

- automate the modern iOS 18+ shim bootstrap
- guarantee that physical iPhone transport is using the shim path instead of legacy fallback
- match desktop Safari feature coverage or reliability yet

## Critical files

- [src/ios-webinspector.js](src/ios-webinspector.js)
  current mobile transport and probing helpers
- [src/simulator.js](src/simulator.js)
  current iOS helper HTTP server
- [docs/next-steps.md](docs/next-steps.md)
  mobile goals, gap analysis, and recommended strategy
- [docs/mobile-investigation-log.md](docs/mobile-investigation-log.md)
  detailed findings, dead ends, and environment knowledge

## Fastest commands

### Health check

```bash
npm run doctor
```

### Start everything

```bash
npm start
```

Then check the target picker at `http://localhost:9221/`.

## Important invariants

### 1. Real device URLs cannot use `localhost`

For a physical iPhone, fixtures must use the Mac's LAN IP, not `localhost`.

Good:

- `http://192.168.x.x:9221/__pages/demo.html`

Bad:

- `http://localhost:9221/__pages/demo.html`

The helper now detects and logs a LAN-reachable fixture URL for this reason.

### 2. Appium shim and legacy paths are different

For modern iOS, `appium-remote-debugger` first attempts the iOS 18+ WebInspector shim through `appium-ios-remotexpc`.

If the shim transport is not bootstrapped, Appium falls back to the legacy path.

This means:

- seeing a real device page today does not mean the modern shim path is solved
- it may simply mean legacy fallback still works for the current environment

### 3. Discovery does not imply attachability

If `/json/list` shows mobile targets, that only means enumeration works.

A finished bridge still requires:

- `devtools/page/:id` WebSocket
- CDP domain translation
- session lifecycle handling

### 4. The simulator path is easier than the modern phone path

If the immediate goal is first mobile DevTools attachment, prefer solving simulator attach first.

The simulator avoids the iOS 18+ shim tunnel bootstrap problem.

## Recommended design direction

The next major implementation should separate:

- transport acquisition
- target enumeration
- inspector session
- CDP translation

Suggested internal types:

- `TransportProvider`
- `TargetEnumerator`
- `InspectorSession`
- `MobileCdpBridge`

Do not keep growing `src/simulator.js` into the full architecture.

## What not to redo

Do not spend more cycles re-proving these already-known points:

- a real WebKit-to-CDP adapter is the correct architectural approach
- `devicectl` can launch Safari on the phone
- `appium-ios-device` can see the phone's lockdown UDID
- the simulator socket path can be resolved from `launchd_sim` via `lsof`
- `appium-ios-remotexpc` tunnel creation needs `utun` and currently fails here without enough privilege

Those are already established in the investigation log.

## What to focus on next

If you are continuing implementation, the critical path is:

1. expose one attachable mobile `devtools/page/:id` WebSocket
2. improve reliability and feature coverage of the working mobile bridge
3. reuse desktop CDP translation patterns where possible
4. solve iOS 18+ shim bootstrap in parallel, not before everything else

## Documentation rule

If you learn something that would save the next agent more than 15 minutes, add it to:

- [docs/mobile-investigation-log.md](docs/mobile-investigation-log.md)

If it changes project direction, update:

- [docs/next-steps.md](docs/next-steps.md)
