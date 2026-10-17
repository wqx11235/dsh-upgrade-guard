# dsh-upgrade-guard · upgrade safety net for DeepSeek Harness

> **升级前**盘点插件兼容性 → **升级后**扫描已知破坏性契约 → **切换端口前**先启动冒烟，不通过就别切。
> 中文文档：[README.zh.md](README.zh.md)

Stop "upgrading DeepSeek Harness" from turning into "one upgrade, one broken plugin".

[DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) ships fast, and every release can change a contract that plugins depend on. The same class of failure keeps recurring:

| Upgrade | Root cause | Symptom |
| --- | --- | --- |
| 0.1.1 → 0.1.2 | `client-modules` module table got strict | page shows `Failed to load plugins` |
| 0.1.2 → 0.1.5 | service access contract got strict (missing `inject` throws) | 31 plugins pending in a chain |
| 0.1.6 → 0.1.7 | service `settingsScope` removed/renamed | 26 plugins pending |
| 0.1.7-alpha.1 | `ui-primitives` icon renamed (`IconXxx14` → `IconXxxRegular`, no alias) | `Minified React error #130` |
| 0.1.7 | session message v4 `source` contract | a run fails after finishing: `format v4 message requires a producer-owned source kind` |

This plugin turns the diagnosis of each such incident into a reusable check.

## Three actions

| Action | When | What it does |
| --- | --- | --- |
| **Contract scan** (offline, seconds) | anytime / after upgrading | scans installed plugins against a catalogue of known-breaking contracts: removed service names, old session-message `source` shape, references to `ui-primitives` exports that do not exist |
| **Preflight** (online, 10–40 s) | **before** upgrading | for each plugin: declared compatibility range, newest version on npm, whether it supports the target → "can we upgrade + what must move with it + what to disable" |
| **Boot smoke** (30–90 s) | **before** switching ports | boots a throwaway host on a test port, reads its boot summary (`SKIPPED` / `DEGRADED` / `PENDING` / real culprit), probes each client bundle for reachability, kills the test host afterwards |

## Compatibility (why it works on both web and desktop)

Designed to keep working across 0.1.x and 0.2.x, and on both the web profile and the official desktop app:

- **Zero `@deepseek-ai/*` imports.** The host half imports only Node builtins plus the `webServer` service. The largest historical failure class is "host changed a package/service contract while the plugin still imported the old thing", so this plugin imports none.
- **No hardcoded machine paths.** The profile is found by walking up from the plugin's own location; the host binary/install root is derived from `process.argv[1]`; `ui-primitives` is searched through several candidates. The same files run unchanged in `profiles/web` and `profiles/desktop`.
- **`peerDependencies` declared as `*`, all `optional`.** dsh 0.1.7+ ships a peer-compatibility gate that silently skips bundles declaring a narrow range (e.g. `browser-skill-dsh-plugin@0.3.1` requires `@deepseek-ai/dsh-tools: ^0.1.5-rc.3` and gets skipped on 0.2.0-rc.2). A `*` + optional declaration is the declaration shape that survives that gate.
- **Client half follows the 0.1.2+ client contract.** `exports.inject = ['slots']` is declared, and slots are reached via `ctx.slots` with a `ctx.get('slots')` fallback, so both the older proxy and the newer restricted proxy work. It only `require`s `react` (a platform seed word), so the tightened module table cannot hit it.
- **Electron aware.** On the desktop app `process.execPath` is the app binary; smoke spawns with `ELECTRON_RUN_AS_NODE=1` so no second app window appears. Inside a packaged `app.asar` runtime smoke reports `UNSUPPORTED` (with alternatives) instead of failing mysteriously.
- **Honest about the export table.** When the `ui-primitives` copy found on disk differs from the running host version, the UI says so, because "export does not exist" conclusions are only as good as that copy.

## Install

```powershell
# ① from GitHub (installed into the profile)
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add github:wqx11235/dsh-upgrade-guard
# then add "dsh-upgrade-guard" to dsh.profile.bundles in that profile's package.json

# ② manual placement (no network)
#   copy this repo to %USERPROFILE%\.dsh\profiles\web\node_modules\dsh-upgrade-guard
#   and add "dsh-upgrade-guard" to dsh.profile.bundles

# ③ desktop app: same, but use %USERPROFILE%\.dsh\profiles\desktop
```

Restart the host, hard-refresh the page, then open **设置 → 通用 → 升级守卫**.

## Usage

### In the UI

**Settings → General → Upgrade guard** — three buttons plus a footer that tells you which host/runtime/primitives the result came from:

- **Contract scan** → `⚠ critical N / warn N (scanned M plugins)` + findings
- **Preflight** → `📋 target x.y.z: N plugins, K have updates` + the list
- **Boot smoke** → `✅ PASS` / `❌ FAIL` + key output lines (`ROOT?` / `PENDING` / `SKIPPED` / `DEGRADED` / `BADBUNDLE`)

### Command line (same engine)

```powershell
node lib/guard.mjs scan      --json --report scan.md [--profile <dir>] [--primitives <dir>]
node lib/guard.mjs preflight --json --report preflight.md --target 0.1.8-rc.1 [--no-network]
node lib/guard.mjs smoke     --bin <.../dsh/lib/bin.js> --cwd <dir> --port 3099 --timeout 120 [--keep]
```

Environment fallbacks: `DSH_HOME` (default `~/.dsh`), `DSH_PROFILE`, `DSH_PRIMITIVES`, `DSH_SMOKE_BIN`, `DSH_SMOKE_PORT`, `DSH_SMOKE_CWD`, `DSH_SMOKE_TIMEOUT`, `DSH_SMOKE_KEEP=1`.

Console output is deliberately English/ASCII (Windows `cmd` at code page 936 garbles UTF-8 Chinese); the Chinese report goes to the `--report` file (default `$DSH_HOME/upgrade-guard/`).

## Where the judgement comes from

`KNOWN_RULES` in `lib/guard.mjs` is the catalogue of known-breaking contracts:

1. **`removed-service`** — services the host removed or renamed (`settingsScope`, `conversationEvents`, …). Hard references are `critical`; optional `inject([...])` uses are `warn` (the plugin degrades gracefully), and matches inside comments are skipped to avoid false positives.
2. **`session-source-v4`** — the old session-message `source: { kind: 'plugin', plugin: 'x' }` shape (rejected since 0.1.7).
3. **`missing-host-export`** — client code referencing a member absent from the host's `ui-primitives` export table (e.g. the `IconXxx14/16` rename). It only throws `React #130` at render time, so this is a static early warning.
4. **`pinned-exact`** — a plugin pinned to an exact version in the profile (`"x": "1.2.3"`), so it can never follow the host (real case: a plugin pinned and stuck 19 versions behind).

**Every new incident adds one rule** — that is the only way this plugin grows, and the reason it gets sharper over time.

## Limits (read these)

- **Smoke only covers boot time**: plugin tree loading, service dependencies, client bundle reachability. **Render-time** errors (e.g. the primitives rename causing `React #130`) will not show up; the contract scan is what covers those.
- **Contract scan only covers the known catalogue.** A brand-new kind of breakage it has never seen stays invisible.
- **Preflight needs npm registry access.** Plugins installed from git/url sources cannot be checked for a newer version and are flagged for manual review.
- **A plugin skipped by the host's peer gate is not a crash** — the host is protecting you. Smoke lists it as `SKIPPED`; reinstalling requires an explicit `dsh plugin allow-version` exemption.
- **Smoke is unavailable in a packaged desktop runtime** (the entry lives inside `app.asar`).

## Host route

`POST /api/dsh-upgrade-guard`

```jsonc
{ "action": "status" }                      // → { ok, paths: {...}, host: { version, runtime, primitivesSource, ... } }
{ "action": "scan" }                        // → { ok, result: { criticalCount, warnCount, scanned, topFindings, reportPath } }
{ "action": "preflight", "target": "latest"} // → { ok, result: { target, rows, stale, reportPath } }
{ "action": "smoke", "port": 3099 }         // → { ok, result: { verdict, summary, tail, reportPath } }
```

## Layout

```
package.json          dsh.bundle.patch + dsh.client declarations
dsh.plugin.json       plugin manifest (name / entry / client)
cordis.patch.yml      the `insert` line that mounts the plugin
lib/index.js          host half: profile+host probing, webServer route, spawns the engine
lib/client.js         client half: the Settings → General row
lib/guard.mjs         the engine: scan / preflight / smoke (also usable as a plain CLI)
```

## License

MIT © 2026 wqx11235
