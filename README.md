# safari-cdt-codex

Goal: connect a Safari page from an iPhone, Safari desktop, or iPhone Simulator to Chrome DevTools with the Elements panel working.

## Current status

- The original simulator bridge still exists in [src/index.js](/Users/nick/Repos/safari-cdt-codex/src/index.js), but simulator target discovery is still blocked by Apple returning no page inventory from `webinspectord_sim` in this environment.
- A working desktop Safari bridge now exists in [src/desktop.js](/Users/nick/Repos/safari-cdt-codex/src/desktop.js).
- Chrome DevTools can connect to the desktop bridge and the Elements flow is working.
- The bridge currently translates a subset of CDP onto Safari WebDriver and page-side DOM/CSS inspection.
- The next major work areas are `Network`, `Console`, `Page lifecycle`, `Sources/Debugger`, and `Performance`.

## Running

Install dependencies:

```bash
npm install
```

Start the desktop Safari bridge:

```bash
npm run start:desktop
```

Start it with CDP method logging:

```bash
npm run start:desktop:debug
```

Current Chrome DevTools target URL:

```text
devtools://devtools/bundled/inspector.html?ws=localhost:9333/devtools/page/desktop-safari
```

Discovery endpoints:

- `http://localhost:9333/json/list`
- `http://localhost:9333/json/version`

## What exists today

- `DOM.getDocument`
- `DOM.requestChildNodes`
- `DOM.describeNode`
- `DOM.resolveNode`
- `DOM.getOuterHTML`
- `DOM.getBoxModel`
- `CSS.getComputedStyleForNode`
- `CSS.getMatchedStylesForNode`
- `CSS.getInlineStylesForNode`
- `Runtime.evaluate`
- `Page.navigate`
- enough `Target` / `Overlay` / `Debugger` / `Network` / `Storage` stubs for the current DevTools Elements path to connect

## Repo layout

- Desktop bridge: [src/desktop.js](/Users/nick/Repos/safari-cdt-codex/src/desktop.js)
- Simulator bridge experiment: [src/index.js](/Users/nick/Repos/safari-cdt-codex/src/index.js)
- Shared logger: [src/logger.js](/Users/nick/Repos/safari-cdt-codex/src/logger.js)
- Project manifest: [package.json](/Users/nick/Repos/safari-cdt-codex/package.json)

## Reproduced findings

### 1. Simulator transport connects but does not enumerate pages

Running `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer npm start` in this repo starts the bridge and logs a successful simulator connection.

Observed:

- Device list server came up on port `9221`.
- Debug server came up on port `9222`.
- The adaptor negotiated target-based WebInspector protocol.
- The adaptor connected to simulator socket `/private/tmp/.../com.apple.webinspectord_sim.socket`.

### 2. Simulator device discovery works but target discovery does not

`http://localhost:9221/json` returns the simulator device.

`http://localhost:9222/json` remains `[]` even while MobileSafari is open on the simulator.

Direct adaptor inspection also reports:

```json
{
  "type": "simulator",
  "name": "Simulator (iPhone 14 Pro)",
  "apps": []
}
```

### 3. Raw simulator WebInspector request path is silent

Direct `_rpc_reportIdentifier:` and `_rpc_getConnectedApplications:` messages were sent against the simulator socket via `appium-ios-device`.

Observed:

- Writes succeeded.
- No `_rpc_reportConnectedApplicationList:` or related application/page messages were received back.

### 4. Desktop Safari WebDriver now works once GUI remote automation is enabled

After manually enabling Safari's GUI `Allow Remote Automation` setting, `selenium-webdriver` can:

- open `https://example.com`
- read `document.title`
- read DOM text content

## Best next steps

1. Implement `Network` as the first real CDP expansion area.
2. Add `Console` and page lifecycle events.
3. Expand into `Sources` / `Debugger` and `Performance` based on what Safari/WebDriver can expose or what can be translated.
4. Revisit the physical iPhone path once the desktop bridge is stronger.
