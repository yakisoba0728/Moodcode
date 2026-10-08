# Engine resilience harness

`scripts/verify-engine-resilience.mjs` repeatedly runs an account-free compound Engine scenario in separate committed temporary Git repositories and SQLite databases. It uses the existing `ScriptedProvider`, native inbox and approval APIs, real owned `run_command` processes, native job evidence, and Engine recovery. It does not create synthetic Run, ToolContext, approval, checkpoint, or cleanup rows.

## Run

After the repository's normal build, the default command runs the quick profile:

```sh
node scripts/verify-engine-resilience.mjs --profile quick --runtime compiled --report /tmp/moodcode-resilience-quick.json
node scripts/verify-engine-resilience.mjs --profile extended --iterations 60 --seed 946 --runtime compiled --report /tmp/moodcode-resilience-extended.json
```

For source development, use the **absolute** repository loader path. The real crash worker uses the matching absolute loader and never rebuilds the shared workspace:

```sh
node --import "$PWD/node_modules/tsx/dist/loader.mjs" scripts/verify-engine-resilience.mjs --profile quick --runtime source
node --import "$PWD/node_modules/tsx/dist/loader.mjs" --test --test-concurrency=1 packages/engine/src/resilience/soak.integration.test.ts scripts/verify-engine-resilience.test.mjs
```

`quick` defaults to three iterations; `extended` defaults to twelve. `--iterations` accepts 3–60; every three iterations include the same three lifecycle scenarios. `--seed` is a uint32 that selects bounded UTF-8 output payloads. It does not insert random delays, vary approval grants, or weaken assertions. `--boundary-timeout-ms` defaults to 10,000 and accepts 1,000–30,000. Git operations, provider/run waits, readiness, process cleanup, lock release, and Engine close use bounded operations. The actual held fixture command also has a 60-second native timeout. No fixed long sleep establishes readiness or cleanup.

## Compound boundaries

Every iteration starts a native source input with the command-only profile. While its genuine Tool awaits native approval, another native input is queued and redelivered under the same request identity. The harness checks one input identity, zero observer dispatch, and no process before approval. It also cancels a third queued input and checks that it never becomes a Run.

After exact approval, the local Node command atomically publishes its PID and holds on an explicit file gate. The harness verifies the native job's Run/Turn/Attempt/Tool/approval identity and rejects copied or released output handles. The three scenarios then diverge:

| Scenario       | Actual consumption and recovery assertions                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `complete`     | Release the real process, require completed Tool and Part, checkpoint binding, sealed stdout hash and cleanup, then require exactly one queued observer Run. Close/reopen with jobs default-off; terminal native history stays unchanged and explicit resume cannot replay either input.                                                                                                                                                        |
| `cancel`       | Cancel the running owned job using its current native revision. Join the real PID and process group. Preserve a known cancelled result only with genuine cleanup; preserve `uncertain` otherwise. Close/reopen; uncertainty requires `CLEANUP_PENDING`, leaves the observer pending, and prevents another command. A known cancellation may resume only the original queued observer.                                                           |
| `root-sigkill` | Fork a real Engine worker, wait for durable native job running plus physical PID/group readiness, then SIGKILL that Root. Require its actual supervisor to remove the process group and release the effect lock without resetting its marker. Reopen: physical disappearance cannot synthesize a completion receipt; the job remains `uncertain`, the queued input remains pending, resume is quarantined, and provider/process replay is zero. |

Assertions also preserve the source config digest, native turn/input identity, one actual command Tool, original turn/tool/output ceilings, no provider retry, and missing token/cost observations as `null`. The complete path verifies the current sealed artifact bytes against their native SHA. The failure regression injects a close error after a genuine Engine close and checks that cleanup does not delete the DB or report success.

## Report and failure behavior

The bounded JSON report has `schemaVersion: 1`, `kind: "engine-resilience-soak"`, top-level `passed`, `supported`, and `noLive`, profile/seed/iterations, actual Node/OS/architecture/runtime, per-iteration results, and summary counts. Native evidence includes record counts and digests, versioned event type counts, source/config/job/completion hashes, measured usage, explicit unknown tokens/cost, queue/cancel state, and the resume outcome. Boundary timings are cumulative monotonic elapsed milliseconds; they are not provider CPU measurements or a performance claim.

`source` pins the loaded harness and Engine entry files and reports Git HEAD when available. It explicitly does **not** claim a full engine source freeze or a clean working tree. A repository/CI source manifest provides that separate qualification.

Successful iterations close their SQLite handles and remove their private fixtures only after physical cleanup. Failed iterations retain their DB/artifacts at `cleanup.retainedEvidencePath`. A close error, missing cleanup proof, or required emergency cleanup makes the iteration fail. Emergency process cleanup never changes native receipts or resets quarantine. The suite stops at its first failure and does not start more effects after cleanup debt. `--report` uses a mode-0600 temporary file and atomic rename. CLI exit codes are 0 for complete pass, 1 for failure/unsupported/report I/O error, and 2 for invalid arguments. Invalid arguments and help do not import the Engine. The CLI contract tests use explicit CLI-only fixtures; they provide no Engine/account validation credit.

## Supported scope and recorded local evidence

The initial source implementation was exercised on macOS arm64 using real POSIX commands: the focused suite passed 7 tests, and extended mode passed 12 isolated iterations with 12 process launches, zero cleanup failures, zero command replay, and eight intentionally unknown cancellation/crash outcomes. These initial v1 logs and source identities are supplied in `/tmp/moodcode-resilience-source-freeze.json`. The bounded cancel-wait correction is pinned separately by `/tmp/moodcode-resilience-source-freeze-v2.json`. Root validated the final compiled implementation over 60 iterations and the actual CI quick report validator; [aggregate verification](engine-hardening-verification.json) records the separate evidence and support limits.

This harness covers owned commands rather than PTYs, parallel workflows, or child task allocation. Windows is unsupported and returns a failing unsupported CLI result, while physical integration tests explicitly skip unsupported hosts. It neither supplies Windows JobObject evidence nor reclassifies Linux Darwin-only skips. Existing dedicated suites retain those scopes.

Extended iterations are isolated scenarios with Engine close/reopen inside each; they are not a single long-lived Engine with accumulating history. A 12- or 60-iteration short run is bounded fault regression, not multi-hour availability or a proof that every intermittent failure is fixed. In particular, the separate R-PTY-01 historical uncertainty remains outside this command harness. No external model, account, credential reader, GUI, network provider, or billed cost verification is performed.
