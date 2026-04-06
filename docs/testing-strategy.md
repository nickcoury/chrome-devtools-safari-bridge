# Testing & Documentation Strategy

## Documentation: Single Source of Truth

### `docs/feature-matrix.md` — Primary Feature Tracking
The **feature matrix** is the single source of truth for what works and what doesn't.
It is organized by DevTools panel/sub-section from a **user-centric** perspective.

- Covers all platforms (iOS device, iOS simulator, desktop Safari)
- Status: ✅ Working | ⚠️ Partial | ❌ Not supported | N/A Not applicable
- Updated whenever features are added or bugs are fixed
- Includes notes on implementation details and limitations

### `docs/capability-map.md` — Deprecated
Previously tracked WebKit API ↔ Chrome CDP mappings at a protocol level.
Superseded by `feature-matrix.md` which is more comprehensive and user-centric.
Keep as historical reference but do not update.

### `docs/next-steps.md` — Deprecated  
Previously tracked sprint priorities. Superseded by backlog memory files
and task tracking in Claude conversations. Keep as historical reference.

---

## Testing Tiers

### Tier 1: Smoke Tests (Fast, Automated, CI-friendly)
**File:** `test/verify-cdp.mjs`  
**What:** Sends key CDP commands and checks for valid responses.  
**Speed:** ~5 seconds  
**Catches:** Protocol-level regressions (methods returning errors, missing handlers)  
**Run:** `node test/verify-cdp.mjs`

### Tier 2: Differential Tests (Automated, Comprehensive)
**Directory:** `test/differential/`  
**What:** Compares bridge CDP responses against expected Chrome behavior.  
Per-panel suites: elements, console, sources, network, performance, application, other.  
**Speed:** ~30 seconds  
**Catches:** Response format mismatches, missing fields, wrong data types  
**Run:** `node test/differential/runner.mjs`

### Tier 3: Pixel Snapshot Tests (Automated, Visual)
**File:** `test/regression-screenshots.mjs`  
**What:** Opens DevTools via Puppeteer, screenshots each panel, verifies visually.  
**Speed:** ~60 seconds  
**Catches:** Visual regressions, panels not rendering, UI breakage  
**Run:** `node test/regression-screenshots.mjs`  
**Note:** Requires Chrome + bridge running. Best for pre-release validation.

### Tier 4: Manual Testing (Human, Exploratory)
**What:** User exercises specific workflows that automated tests can't cover.  
**Catches:** Interaction bugs, edge cases on complex pages, subjective quality issues  
**Focus areas for manual testing:**
- Performance profiling on complex pages (Google Images, news sites)
- Source linking from flame chart → Sources panel
- Navigation on device → DevTools sync
- Animation capture and playback controls
- Breakpoint debugging flow (set, hit, inspect, resume)
- Network waterfall on pages with many requests

---

## Test File Organization

### Keep (active tests)
- `test/verify-cdp.mjs` — Tier 1 smoke test
- `test/differential/` — Tier 2 differential suite
- `test/regression-screenshots.mjs` — Tier 3 visual regression
- `test/check-timeline-events.mjs` — Timeline event type validation

### Archive (useful for debugging but not regular testing)
- `test/repro-*.mjs` — Bug reproduction scripts
- `test/debug-*.mjs` — Debug/investigation scripts
- `test/harden-*.mjs` — Hardening scripts for specific pages
- `test/screenshot-*.mjs` — One-off screenshot scripts
- `test/check-*.mjs` — One-off validation scripts

### Remove (superseded)
- `test/trace-output.json` — Generated artifact, not a test

---

## When to Run What

| Situation | Run |
|-----------|-----|
| After any code change | Tier 1 (verify-cdp) |
| After Performance/Tracing changes | Tier 1 + Tier 2 performance suite |
| Before committing feature work | Tier 1 + Tier 2 full |
| Before release / major milestone | All tiers including manual |
| Investigating a bug | Relevant repro-*.mjs or debug-*.mjs |

---

*Last updated: 2026-04-06*
