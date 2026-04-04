# Chrome DevTools Safari Bridge

Use Chrome DevTools to debug Safari — desktop, iOS simulator, and real iPhone.

## Quick Start

```bash
npm install
npm start
```

This starts both bridges, discovers all available Safari targets, and opens a target picker at `http://localhost:9221/`. Click **Inspect** on any target to open Chrome DevTools.

## What It Does

- **Desktop Safari** — bridge via Safari Web Extension on port 9333
- **iOS Simulator** — bridge via native Web Inspector protocol on port 9221
- **Real iPhone** — bridge via USB Web Inspector on port 9221 (requires Web Inspector enabled in Settings > Safari > Advanced)

All three appear in a single target picker page. Each target gets a full CDP translation layer supporting Elements, Console, Sources, Network, Performance, Application, and Animation panels.

## Feature Parity

See **[test/parity-chart.md](test/parity-chart.md)** for the full compatibility matrix across all platforms, generated from automated differential tests against Chrome.

| Platform | Parity | Tests |
|----------|--------|-------|
| Chrome (reference) | 100% | 86/86 |
| iPhone | 97.7% | 84/86 |
| Simulator | ~97% | (same bridge code) |
| Desktop Safari | 16–30% | (depends on extension connection) |

## Requirements

- macOS with Safari
- Chrome (for DevTools frontend)
- Xcode (for simulator and device tools)
- Safari: Enable `Allow Remote Automation` in Safari > Settings > Advanced (for desktop bridge)
- iPhone: Enable `Web Inspector` in Settings > Safari > Advanced (for real device)

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start everything — both bridges + target picker |
| `npm test` | Run differential parity tests against Chrome |
| `npm run doctor` | Run environment diagnostics |
| `npm run kill` | Kill stale bridge processes on ports 9221 and 9333 |
| `npm run build:ext` | Build the Safari Web Extension for desktop debugging |
| `node test/verify-panels.mjs` | Quick regression check — verifies 5 DevTools panels via text |
| `npm run test:cdp` | CDP-level verification — checks actual protocol responses |
| `node test/verify-screenshots.mjs` | Pixel screenshot verification — saves screenshots for review |

## Architecture

```
Target Picker (http://localhost:9221/)
├── Desktop Safari (port 9333)
│   └── Safari Web Extension → CDP translation
├── iOS Simulator (port 9221)
│   └── Web Inspector unix socket → WIR protocol → CDP translation
└── Real iPhone (port 9221)
    └── USB → Web Inspector → WIR protocol → CDP translation
```

### Source Layout

| Path | Purpose |
|------|---------|
| `src/simulator.js` | iOS control server, CDP handler (11 domain methods), polling loop, target picker |
| `src/ios-webinspector.js` | Web Inspector protocol, MobileInspectorSession, WIR transport |
| `src/desktop.js` | Desktop Safari bridge (extension-based) |
| `src/tunnel-registry.js` | Bridges Apple's CoreDevice tunnel for appium compatibility |
| `desktop-extension/browser/` | Safari Web Extension (manifest, background, content scripts) |
| `desktop-extension/xcode/` | Xcode project wrapping the extension as a macOS app |
| `test/differential/` | 84 differential parity tests comparing Chrome vs bridge |
| `test/pages/demo.html` | Comprehensive demo page exercising all DevTools features |
| `scripts/launch.mjs` | Single-command launcher for both bridges |

### Performance Profiling

Start with `BRIDGE_PERF=1 npm start`, then visit `http://localhost:9221/perf` for per-method timing stats, poll loop metrics, and event throughput.

## Test Pages

Served at `/__pages/` on both bridges:

- **`demo.html`** — Comprehensive page exercising all DevTools panels (Elements, Console, Sources, Network, Animation, Storage, Performance)
- `animation.html` — Focused animation/network activity for load testing
- `view-transition.html` — View Transition API test
- `debugger.html` — Breakpoint verification

## Known Limitations

- **Desktop Safari automation lock** — WebDriver-controlled Safari windows block user interaction
- **iPhone screen must be unlocked** — iOS disables Web Inspector when the screen locks
- **USB transport latency** — Each CDP command round-trips through USB (~10-50ms). Bridge code itself is fast (2ms poll loop, 80% idle)
- **Single inspector per page** — Only one DevTools client can inspect a given page at a time

## License

Apache 2.0 — see [LICENSE](LICENSE)

## Documentation

- [test/parity-chart.md](test/parity-chart.md) — Feature compatibility matrix
- [docs/capability-map.md](docs/capability-map.md) — WebKit Inspector API capabilities
- [docs/native-wk-debugger-protocol.md](docs/native-wk-debugger-protocol.md) — WebKit debugger protocol reference
