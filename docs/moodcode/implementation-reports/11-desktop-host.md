# Desktop host implementation

Status: main/worker/preload/settings implementation is complete. All source, compiled and native host checks pass.

## Integration entrypoints and API

- Main: `apps/desktop/src/main/index.ts` → `dist/main/index.js`.
- Utility: `apps/desktop/src/worker/index.ts` → `dist/main/engine-worker.js`.
- Preload: `apps/desktop/src/preload/index.ts` → `dist/main/preload.cjs`.
- Command supervisor must be bundled next to the utility at `dist/main/supervisor.js`.
- Renderer loads from `dist/renderer/index.html` using `loadFile`.
- Public renderer API is the exact `DesktopApi` in `src/shared/protocol.ts`, including `openExternal`. Main IPC uses a private `{ok,value}` / `{ok:false,error}` envelope so preload can preserve error codes; consumers only receive the public method result.
- `DesktopHost` in `main/host.ts` owns transport, settings transactions, generation/status, and renderer ownership. It imports engine/contracts types only. `UtilityWorker` in `worker/core.ts` is the sole engine/SQLite owner.
- Internal RPC types are in `worker/protocol.ts`: `start`, `bootstrap`, `command`, `subscribe`, `unsubscribe`, `dropOwner`, `assertIdle`, `close`; `WorkerPush` only emits bounded session invalidations.
- `SettingsStore` in `main/settings.ts` has `load`, `prepare`, `commit`, `getView`. A resolved/prepared value exposes private `engineConfig` as a non-enumerable property; only `view` is public.

## Test launch switches

`MOODCODE_DESKTOP_USER_DATA` always accepts an absolute user-data directory. Test folder selection and fixtures require an unpackaged app and either `MOODCODE_DESKTOP_TEST=1` or `MOODCODE_DESKTOP_TEST_LAUNCH=1`. With that flag, `MOODCODE_DESKTOP_TEST_WORKSPACE` substitutes the folder picker. `MOODCODE_DESKTOP_TEST_SCENARIO=coding|slow` forces scripted provider configuration, removes API-key environment use, and disables Codex auth metadata reads. Ordinary builds ignore fixture/picker switches.

An explicit fixture launch also starts/retries when a saved real provider's credential/auth resolution fails; malformed settings files still fail. Ordinary launches preserve the selected-provider credential error without switching providers.

The coding fixture expects `math.mjs` with an `a - b` expression and a Node `.test.mjs` fixture. It reads the file through the real tool, uses the returned hash for `apply_patch`, waits for explicit patch approval, requests explicit `node --test` approval, and completes only after successful command cleanup and a nonzero reported test count. It never automatically allows an approval. The slow fixture delays output for reload/cancellation testing. No external provider calls are used by tests.

## Codex connection

Engine auth helper has `getCodexAuthStatus(): Promise<{state:'ready'|'missing'|'expired'|'unreadable'|'invalid'|'unsupported',modelId?:string}>`. Main directly imports the exported helper and refreshes its asynchronous metadata before settings load/prepare, mapping `ready` to public `available` and unsupported/invalid states to public `unreadable`. The settings store receives cached sanitized metadata through `codexAuth:()=>DesktopCodexAuth`. No token is passed to settings or renderer. The worker directly selects exported `new CodexProvider()`; the provider resolves current local credentials for each turn and owns the trusted endpoint. Required facade exports are now connected.

An absent settings file selects Codex only when auth and local model metadata are available; otherwise it visibly selects scripted. Codex settings reject API-key input and require an empty configurable base URL. Authenticated state with no model metadata requires a model selection instead of inventing one.

## Verification

- Settings: 39 tests passed.
- Host transport/lifecycle: 33 tests passed.
- Preload/security: 32 tests passed, including file/status/restore/history validation and transport.
- Utility worker/runtime: 28 tests passed.
- Combined source tests: **132/132 passed**, with no skips. The same **132/132 compiled tests passed**.
- Desktop main/preload/worker strict TypeScript check and renderer no-emit check passed.
- Bundled main, worker, preload, supervisor and Vite renderer build passed (`node scripts/build-desktop.mjs`).
- All six newly introduced file/status/restore/history commands use the canonical contracts validator and cross only the command channel; tests confirm payload isolation, IDs/paths/fingerprint bounds and unsupported-field rejection.

Tests cover busy settings refusal, command-admission and shutdown races, old-close/new-start/commit ordering, failed restart recovery, commit plus cleanup failure, bounded pending RPCs/timeouts, owner reload with an active Run, subscription coalescing/leaks, expired approvals, actual command test execution, failed tests and stale hash refusal, child-process termination before DB reopening, and private fields/credentials in messages, JSON keys and error codes.

Native Playwright Electron host smoke passed **29/29 checks** on Electron **44.5.1**, main/utility Node **24.21.0**, macOS arm64. Verified frozen bridge, sandbox/context isolation, renderer `require`/`process`/`Buffer` absence, fixture provider/defaults, credential-free bootstrap, persisted workspace/folder picker, session/Run admission, bounded invalidations, and a reload snapshot with the Run still running. `app.quit()` exited with code 0 after cleanup (229 ms); reopening the same user-data directory restored workspace/session and the cancelled Run with an advanced journal; second quit exited code 0 (106 ms). Both native apps and temporary script/Git workspace/user-data directories were removed. Launch credentials were excluded; no Codex auth or provider request occurred in this fixture run.

Broader renderer E2E, packaged distribution, and actual OS keychain persistence remain integration checks owned by the root desktop task. This report does not claim a real model request.

## Settings storage and IPC limits

`settings.json` is an atomic, bounded ciphertext-only settings file (maximum 32,768 bytes), created with mode 0600 inside a mode-0700 directory when committed. Input keys are limited to 4,096 bytes and safeStorage ciphertext to 16,384 bytes. Symbolic and hard links, unsafe existing file permissions, truncated/invalid UTF-8 JSON, stale/forged candidates, and external changes are rejected. Rename is the commit point; directory fsync is best effort where unsupported. Ancestor directories are host controlled.

Main passes Linux's storage-backend getter only on Linux. Insecure `basic_text` and unavailable credential storage refuse key persistence; environment credentials remain supported. A stored key is bound to its provider and is never implicitly reused for another provider. No raw key appears in renderer settings, bootstrap, error codes, or logs. API-key and Codex modes remain separate.

RPC bodies are capped at 1 MiB, depth 32 and 20,000 nodes. Main pending requests are capped at 128; worker concurrent dispatches at 64. Subscriptions are capped at 128 total and 32 per owner, with a single coalesced invalidation every 25 ms per subscription. Consumers read committed snapshots. Reload, renderer destruction and unmount abort subscriptions only. App quit awaits acknowledged engine cleanup and keeps the app open with a cleanup error if that acknowledgement is unavailable; it does not force-kill the utility.

## Renderer integration notes

`SaveDesktopSettings.baseURL` must be `''` for both scripted and Codex. The settings UI now normalizes those two selections to an empty endpoint. Codex settings must not send an API key left from a previous remote selection.

The shared optional `DesktopSettings.codexModelId` is connected; the settings metadata view provides the sanitized local model identifier, including when scripted is selected.

Source worker tests must remove inherited `NODE_TEST_CONTEXT` around fixture `node --test` execution; otherwise Node skips recursive test runs. The coding verification now checks a real test name and nonzero count, and the shutdown fixture checks a live process before cleanup.
