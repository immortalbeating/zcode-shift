# Z·SHIFT

A ZCode account-switching and quota companion maintained by [immortalbeating](https://github.com/immortalbeating/zcode-shift), available under the [MIT license](LICENSE).

The compact UI has its own name and vector mark, a single icon toolbar with hover/focus hints, and a graphite / warm-gold palette. Account avatars, primary actions, quota colors, and spacing take cues from the maintainer's AGY·SWITCH. Chinese and English are supported. Screenshots use synthetic accounts only.

This version also repairs event-claim verification, discovers explicit claim actions in both billing previews and marketing deliveries, and correlates asynchronous results with the requested account and plan.

Claimed grants scheduled for later show their amount, start time, and expiry. Spendable balances remain based on the server's balance buckets; future grants are not counted as available tokens.

Settings are grouped into General, Offer claims, Account switching, Sign-in & network, Account data, Advanced, and About. Low-frequency options and detailed explanations can be expanded when needed.

Offer checks run every 2, 5, or 10 minutes (default: 5). Discovery overlaps for up to two accounts, while claims and official verification remain serial. Empty accounts add no fixed wait. A credential- and device-bound preview cache lasts 10 seconds and is invalidated on submission. Failures use categorized backoff and respect server cooldowns.

The main window shows the current claim stage and next check. Settings keep the last 30 local results with discovery and submission timings, without credentials. Actual claim time still depends on network and official services.

Executable paths support auto-detection, validation, and restoring automatic lookup. Path and proxy drafts survive other settings changes. Proxy testing checks port reachability only. Update checks query this repository's stable GitHub releases without downloading or installing anything; an unpublished release is reported explicitly.

Sign-in proxy and ZCode service proxy have separate switches and share the saved address. The service switch is off by default and accepts an HTTP proxy for offer discovery, activation, claims, verification configuration, and ZCode balances. This keeps those requests on one route when an account's offers differ by network exit. Proxy failures are reported without silently falling back to a direct connection. BigModel monitoring and GitHub updates are unchanged.

![Z·SHIFT — synthetic demonstration data](docs/screenshot.png)

## Development

Use Node.js 20.19+ / 22.12+, Rust stable, and the platform's Tauri 2 prerequisites.

```sh
npm ci
npm run tauri dev
npm run check:syntax
npm run check:i18n
npm run test:claim
npm run build
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

Windows is locally verified. Other platform status is reported by CI. Account data stays in `~/.zcode-switch/` for compatibility. Do not run multiple tools against the same account operation concurrently.

`npm run test:ui` checks synthetic IPC fixtures in isolated GPU-rendered browser viewports. It uses system Edge on Windows and Playwright Chromium elsewhere. It does not read account files or inject desktop input. Install Chromium with `npx playwright install chromium` when needed.

`zcode-shift.exe --claim-once --id <account-id> --plan-id <plan-id>` performs a real, explicitly targeted claim using the official passive captcha flow and returns JSON. Interactive challenges are left to the user. It does not enable the global auto-claim toggle.

See the [Chinese README](README.md) for CLI and operating details, and [NOTICE.md](NOTICE.md) for provenance. This project is not affiliated with ZCode. Upstream copyright notices and Git history are preserved.
