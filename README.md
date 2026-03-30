# Chrome DevTools Safari Bridge

Use Chrome DevTools to debug Safari — desktop, iOS simulator, and real iPhone.

## Quick Start

```bash
npm install
npm start
```

This starts both bridges, discovers all available Safari targets, and opens a target picker at `http://localhost:9221/`. Click **Inspect** on any target to open Chrome DevTools.

## What It Does

- **Desktop Safari** — bridge via Selenium WebDriver on port 9333
- **iOS Simulator** — bridge via native Web Inspector protocol on port 9221
- **Real iPhone** — bridge via USB Web Inspector on port 9221 (requires Web Inspector enabled in Settings → Safari → Advanced)

All three appear in a single target picker page. Each target gets a full CDP translation layer supporting Elements, Console, Network, Debugger, Profiler, and Animation panels.

## Requirements

- macOS with Safari
- Chrome (for DevTools frontend)
- Xcode (for simulator and device tools)
- Safari: Enable `Allow Remote Automation` in Safari → Settings → Advanced (for desktop bridge)
- iPhone: Enable `Web Inspector` in Settings → Safari → Advanced (for real device)

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start everything — kills stale processes, starts both bridges, opens target picker |
| `npm run doctor` | Run environment diagnostics (desktop + iOS) |
| `npm run verify` | Run desktop regression tests |
| `npm run kill` | Kill stale bridge processes on ports 9221 and 9333 |

## Architecture

```
Target Picker (http://localhost:9221/)
├── Desktop Safari (port 9333)
│   └── Selenium WebDriver → CDP translation
├── iOS Simulator (port 9221)
│   └── Web Inspector unix socket → WIR protocol → CDP translation
└── Real iPhone (port 9221)
    └── USB lockdown → Web Inspector → WIR protocol → CDP translation
```

### Source Layout

| File | Purpose |
|------|---------|
| `src/desktop.js` | Desktop Safari bridge (WebDriver-based) |
| `src/simulator.js` | iOS control server, CDP handler, polling loop, target picker |
| `src/ios-webinspector.js` | Web Inspector protocol, MobileInspectorSession, WIR transport |
| `src/mobile-instrumentation.js` | Page-side JS injected for console/network/debugger/profiler/animation |
| `src/tunnel-registry.js` | Bridges Apple's CoreDevice tunnel for appium compatibility |
| `scripts/launch.mjs` | Single-command launcher for both bridges |

### CDP Domain Coverage

**Desktop (via WebDriver instrumentation):**
Elements, Console, Network, Debugger (cooperative async breakpoints with source maps), Profiler, Animation, Performance/Tracing

**Mobile (via Web Inspector protocol):**
Elements, Console, Network, Debugger (breakpoints, pause/resume/step, source maps), Profiler, Animation, DOM mutations, CSS matched styles, Screenshots

## Fixtures

Test pages are served at `/__fixtures/` on both bridges:

- `animation.html` — CSS animations, Web Animations API, periodic console/network activity, theme toggle, DOM mutation buttons
- `view-transition.html` — View Transition API test
- `debugger.html` — Async breakpoint verification
- `mapped-async.html` — Source map breakpoint test
- `network.html` — Fetch/XHR capture test

## Known Limitations

- **Desktop Safari automation lock** — WebDriver-controlled Safari windows block user interaction. A native Mach service bridge is planned to replace this.
- **iPhone screen must be unlocked** — iOS disables Web Inspector when the screen locks or Safari is backgrounded.
- **Mobile round-trip latency** — Each CDP operation goes through USB Web Inspector, adding 1-3s per call. DOM snapshots are cached to reduce this.
- **Single inspector per page** — Only one DevTools client can inspect a given page at a time (same as Safari's native inspector).

## Documentation

- [docs/next-steps.md](docs/next-steps.md) — Goals, technical gaps, and strategy
- [docs/mobile-maintainer-context.md](docs/mobile-maintainer-context.md) — iOS implementation guide
- [docs/mobile-investigation-log.md](docs/mobile-investigation-log.md) — Dead ends and environment findings
