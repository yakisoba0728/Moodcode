# Command lifetime and ownership

This increment adds explicitly approved command lifetimes to the existing independently owned host-command executor. A foreground command can become a Root-owned background command and later return to foreground waiting without another spawn. The same actual supervisor, process-group PID and private control epoch remain attached throughout. Existing `run_command` keeps its synchronous behavior.

Enable `jobs`, `hostCommands` and `commandLifetimes` explicitly. The default catalogue has no lifetime tools. `commandLifetimeCapability()` reports the supported pipe transport, input limits and lack of live restoration. The implemented transport supports POSIX child pipes on darwin, linux and freebsd; the actual fixtures were run on darwin/arm64. PTY ownership transfer and unsupported platforms are rejected before effects.

## Actual consumer and host APIs

The model catalogue contains `run_command_job`, `command_job_input` and `wait_command_job`. Each uses an exact native approval and the coordinator's original ToolContext/Run/Turn/Attempt/Tool/Part scope. `run_command_job` accepts a command, initial foreground/background mode, output allocation and optional cwd/timeout. Input and wait tools require the same original source Run and session. The current profile, immutable source configuration, original catalogue and physical source are rechecked before use. These tools expose bounded advisory observations; they do not turn output or a serialized owner into an execution grant.

The host-facing Engine APIs are:

- `previewCommandLifetime`, `readCommandLifetimePreview`, `startCommandLifetime` and `releaseCommandLifetimeHandle`.
- `previewCommandLifetimeTransfer`, `readCommandLifetimeTransfer` and `transferCommandLifetime` for an exact approved owner-generation transition.
- `previewCommandLifetimeInput`, `readCommandLifetimeInputPreview` and `writeCommandLifetimeInput` for exact approved stdin/EOF.
- `waitForCommandLifetime`, `cancelCommandLifetime`, `inspectCommandLifetimes` and `commandLifetimeCapability`.

Preview handles are private originals. Copied, released, stale or proxy objects cannot start, transfer or write. A transfer pins the current native record SHA, process tuple, Root epoch and generation before committing its receipt. The process is not restarted or reconstructed from a PID. Host cancellation remains available for physical cleanup even when a profile or policy change prevents new operations.

## Lifetime and limits

An original idle-workspace host owner holds the genuine coordinator lease. Model execution uses a narrowly authenticated lease exception for its own currently executing source Run; other Runs, restoration and conflicting effects remain blocked. The lease lasts through real process completion, artifact sealing, checkpoint and native receipt settlement. Model output allocation is reserved from the current parent budget before admission. Owner transfer cannot reset output, elapsed time or other budgets.

Foreground follows the original execution cancellation signal. An exact transition to background releases the foreground waiter and keeps an independently bounded Root owner. Successful completion of its source Run preserves that explicitly approved background lifetime; parent failure/cancellation joins real cleanup before the parent becomes terminal. Foreground attach/wait uses the same owner and PID. Root close aborts and joins all retained physical owners. Completed parents receive no later command execution events; lifetime history is session scoped.

Each stdin packet is at most 16 KiB, with one pending operation, at most 64 operations and 64 KiB total data. EOF is explicit and final. Input intent commits before the actual write. The same original supervisor acknowledges only after the actual writable callback completes. ACK failure, transfer ambiguity or transport failure creates durable uncertainty and prevents replay. The process can be cleaned up while that debt remains; confirmed physical cleanup does not erase a missing receipt. Output retains the existing bounded ring, truncation metadata, sealed artifacts and exact frozen-page behavior. Existing host result delivery still commits its input, immutable receipt/link and birth anchor atomically, then wakes after COMMIT.

## Native history and recovery

DB23 remains unchanged at 139 named catalogue rows. Signed bounded `command.lifetime.*` session-document heads and complete typed session-event revisions share a primary transaction. History validates source immutability, approval, real Tool/Part and Run evidence, exact generation/transfer transitions, stdin intent/ACK continuity, native host PID and sealed settlement. Caps reserve room for close/recovery/import records.

Restart marks unowned starting/running histories uncertain and never replays the command. Live ownership is not restored from an epoch or PID. Import pauses lifetime history and does not issue a new Original. A prior unknown receipt remains a workspace quarantine. Historical inspection and frozen output DATA are available separately from current physical authority; replacing a sealed artifact inode invalidates fresh source capture even when its bytes match.

## Verification and integration boundaries

The focused suite passed 18 actual Engine/Git/SQLite/process cases: host and model bidirectional same-PID transitions, Unicode stdin/EOF, fixed allocation and total-input caps, exact approvals, profile drift, parent cancellation, successful-parent background lifetime, Root close, admission/ACK/transfer SQL faults, late cancellation, artifact replacement, existing atomic result inbox, paused archive import, and SIGKILL after transfer and input ACK. Crash fixtures observe real guardian cleanup and execution-lock release before reopening; restart retains uncertainty without another spawn or provider call.

Adjacent command, host command, result-inbox and verification tests passed 117 of 119 cases, with two existing platform skips. Whole-project declaration emission passed. Exact source identities and log digests are recorded in [the verification report](engine-phase-two-command-lifetimes-verification.json); the integrating parent owns the aggregate regression gate.

The integrating engine preserves its OS-bound command producer and rejects `osSandbox:true` together with `commandLifetimes:true` using `SANDBOX_COMMAND_LIFETIME_UNSUPPORTED` before storage or process admission. Interactive ownership transfer has no verified sandbox-bound producer yet. Configured Run-only command preflight or role policy unsupported by the genuine host lane is rejected before effects. User-PTY transfer, live PID restoration, explicit checkpoint restore, account-backed model tests and additional operating-system evidence are outside this increment. E5/E6 environment debt remains open.
