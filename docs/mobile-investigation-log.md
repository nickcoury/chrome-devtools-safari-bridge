# Mobile Investigation Log

This file records what has already been investigated on the iOS side so future efforts do not repeat the same loops.

## Snapshot

Current repo checkpoints relevant to mobile work:

- `caeca2b` Replace broken simulator path with working simctl helper
- `5f534f4` Add native iOS Web Inspector discovery
- `258eeff` Improve native iOS helper workflow

Latest major mobile outcome:

- native raw Web Inspector attach now works for both simulator and physical iPhone
- the helper now exposes attachable mobile `webSocketDebuggerUrl` targets
- CDP WebSocket smoke tests now pass for both simulator and USB iPhone through the helper

## Confirmed environment facts

These were observed locally on this machine during investigation:

- Xcode developer dir exists at `/Applications/Xcode.app/Contents/Developer`
- `simctl` works
- iOS simulator runtime available: `iOS 18.6`
- physical iPhone connected over USB and visible to the Mac
- `devicectl` sees the phone
- `appium-ios-device` sees the phone by lockdown UDID

Important distinction:

- `devicectl list devices` reports a CoreDevice identifier
- `appium-ios-device` and usbmux-based tooling use the phone UDID

Do not confuse those IDs.

## Discovery findings

### Simulator

Confirmed:

- the simulator Web Inspector socket can be resolved through `lsof -aUc launchd_sim`
- the resolved socket looks like:
  - `/private/tmp/.../com.apple.webinspectord_sim.socket`
- Appium's simulator RPC client can connect to that socket
- once Safari is running and has a page, `/json/list` can show a real simulator target

Observed behavior:

- when Safari had not fully navigated, the simulator target could show `about:blank`
- after explicit navigation, the simulator target showed `Example Domain`

Conclusion:

- simulator transport works for both discovery and attach
- simulator remains the easiest environment for iterating on mobile bridge behavior

### Physical iPhone

Confirmed:

- `appium-ios-device` reports the lockdown UDID
- `appium-remote-debugger` can enumerate Safari on the phone through the current environment
- `devicectl device process launch --payload-url ... com.apple.mobilesafari` works
- after launching Safari this way, the helper can see a real iPhone Web Inspector page

Important DX finding:

- the phone cannot use `localhost` to reach the Mac's fixtures
- the helper must use the Mac's LAN IP for device fixtures

Conclusion:

- physical-device discovery and launch are working
- physical-device raw attach also works through the helper
- the remaining physical-device transport gap is shim automation and reliability, not basic attachability

## Modern iOS shim findings

### What Appium is doing

From installed package source:

- `appium-remote-debugger` prefers the WebInspector shim on iOS 18+
- it uses `appium-ios-remotexpc` for that path
- `appium-ios-remotexpc` expects a tunnel registry port in strongbox
- it then uses that registry to locate an active tunnel

### What failed

Reading the strongbox item for `tunnelRegistryPort` initially returned `undefined`.

Appium shim path then failed with:

- `Tunnel registry port not found. Please run the tunnel creation script first`

Running the tunnel creation script directly showed the next blocker:

- tunnel setup failed with `Failed to connect to utun control socket: Operation not permitted`

Conclusion:

- the modern iOS 18+ shim path is still not automated here
- however, physical-device attach no longer depends on solving shim bootstrap first because the legacy path can still carry the working bridge in this environment

## Known dead ends and non-solutions

### 1. “If `/json/list` has pages, mobile DevTools is basically done”

False.

Discovery-only targets still lack:

- CDP WebSocket
- session routing
- protocol translation

### 2. “The physical device issue is just the wrong UDID”

Not the main issue.

UDID confusion existed early on, but it is not the hard blocker anymore.

The real blocker is:

- modern transport bootstrap
- then CDP translation

### 3. “The phone should use the same `localhost` fixture URL as the simulator”

False.

The physical device needs a host-reachable LAN URL.

### 4. “We should keep expanding helper endpoints before building attach”

Not the best next move.

Discovery and launch are already good enough to begin building the actual mobile attach path.

### 5. “We must fully solve the iPhone shim path before any mobile attach work”

False.

Simulator attach can and should be pursued first because it avoids the tunnel privilege problem.

## Helpful commands that worked

### Environment check

```bash
npm run doctor
```

### Start everything

```bash
npm start
```

### Manual real-device navigation

```bash
curl "http://localhost:9221/device/navigate?url=http%3A%2F%2F<LAN-IP>%3A9221%2F__fixtures%2Fanimation.html"
```

### Manual target listing

```bash
curl http://localhost:9221/json/list
curl http://localhost:9221/targets
```

### Direct `devicectl` launch that worked

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcrun devicectl device process launch \
  --device <iphone-udid> \
  --terminate-existing \
  --payload-url http://<LAN-IP>:9221/__fixtures/animation.html \
  com.apple.mobilesafari
```

## Helpful source-level knowledge

These packages were useful and should not need to be rediscovered:

- `appium-remote-debugger`
- `appium-ios-device`
- `appium-ios-simulator`
- `appium-ios-remotexpc`

Relevant internal behaviors:

- `appium-remote-debugger` uses simulator socket transport for simulator
- `appium-remote-debugger` uses shim first on iOS 18+ real devices
- `appium-ios-remotexpc` stores tunnel registry port in strongbox container `appium-xcuitest-driver`
- the missing strongbox item is named `tunnelRegistryPort`

## Architectural takeaways

Key conclusions from research:

- discovery alone is not enough; the bridge must support full attach, not just target enumeration
- transport complexity should be hidden behind a productized CLI and adapter
- the privileged/native transport issue must be solved or packaged rather than avoided
- a simple UX does not mean simple internals -- transport complexity still exists under the hood

## Recommended next work

The best next implementation target is:

- a first attachable simulator CDP target

The best parallel investigation is:

- making iOS 18+ shim bootstrap explicit and reliable

See:

- [docs/next-steps.md](docs/next-steps.md)
- [docs/mobile-maintainer-context.md](docs/mobile-maintainer-context.md)
