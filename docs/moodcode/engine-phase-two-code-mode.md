# MC2-15: restricted code mode

This increment supports one tested environment: Darwin with the experimental, deprecated `sandbox-exec` backend and Node.js. It executes a closed `moodcode-json-v1` program in a separate OS-restricted process. Runtime registration performs real file read/write, process-fork and loopback network probes before publishing an available capability. Unsupported environments do not fall back to unrestricted execution.

The language provides bounded values, variables, arithmetic, comparisons, branches, fixed-count loops, native tool calls and a return value. It does not accept JavaScript, TypeScript, imports, `eval`, `vm`, arbitrary expressions or custom tool names. Node explicitly documents that [`vm` is not a security mechanism](https://nodejs.org/api/vm.html); this feature uses the tested kernel restrictions and its closed interpreter instead.

## Public flow

Create the engine with `codeMode: true`. The feature is off by default, and separately owned child engines explicitly start with `codeMode: false`.

1. `registerCodeModeHost()` verifies and pins the actual OS backend, executable, interpreter and trusted supervisor sources. `getCodeModeSupport()` and `getCodeModeCapability()` expose the tested support state.
2. `previewCodeModeGrant({workspaceId, sessionId, config})` returns an Original host preview. `readCodeModeGrant(preview)` exposes its descriptive SHA and exact target.
3. `approveCodeModeGrant({preview, fingerprint: description.sha256, approved: true})` approves that Original preview. A copied object or persisted receipt does not establish a grant.
4. The model calls `execute_code` with `{source, allocation}`. Its actual native Tool approval includes the full source, raw source SHA, runtime, allocation and grant SHA. Effects inside the program obtain separate native approvals.
5. `inspectCodeMode(workspaceId)` and `getCodeMode(workspaceId, id)` read bounded native history. `releaseCodeModeGrant(preview)` releases a retained preview. Closing the engine joins owned execution.

For example, `source` can be the JSON serialization of this program:

```json
{
  "version": 1,
  "statements": [
    {
      "op": "call",
      "id": "seed",
      "tool": "read_file",
      "input": { "op": "literal", "value": { "path": "seed" } },
      "result": "seed"
    },
    { "op": "return", "value": { "op": "var", "name": "seed" } }
  ]
}
```

The allocation requires positive `maxSteps`, `maxNestedCalls`, `maxResultBytes` and `maxDurationMs` within the limits below and the original Run's remaining allowance.

## Native ownership and effects

The restricted worker receives program data, its allocation, generation and bounded broker replies. It receives no engine context, credentials, grant or approval object. Its kernel profile denies workspace/home/database content access, arbitrary writes, network access and process forks, while allowing the exact interpreter and required system bootstrap files. The environment contains only the fixed PATH. Readable system bootstrap files and file metadata remain part of the documented kernel profile.

Each broker request returns to the existing coordinator through the actual Original `execute_code` ToolContext. The coordinator uses its live Run owner, Turn, Attempt, native Tool proposal, policy, prepare, approval, budget, execution lock, output handling and final Part. The worker cannot construct those objects. Supported calls are `read_file`, `list_files`, `search_files`, `apply_patch`, `run_command` and `verify_changes`; custom tools, recursion, MCP, remote callbacks and other names are rejected. Effect calls require their own approval even when configured policy would otherwise allow them.

Worker isolation and broker permission are separate: the worker has the kernel restriction, while a broker command follows the existing approved command contract. An approved command receives OS sandbox restrictions only when the parent engine's OS sandbox grant applies. This feature does not label ordinary approved commands as OS-isolated. Existing command ownership, physical workspace lock, checkpoints and the narrow Original nested verification scope are retained.

Nested calls charge the same cumulative Run and Turn tool budget. Allocation time includes native approval waits. A timed-out or cancelled nested approval cannot dispatch later, and source/grant/profile/config/catalogue/physical workspace drift is checked again before actual effects. A replaced grant is stale even when its policy is identical.

## Persistence and recovery

DB version 23 and its existing catalogue are unchanged. Records use bounded reserved SessionDocuments and independent immutable `code.mode.source_admitted`, `code.mode.process_admitted`, `code.mode.closed_observed` and `code.mode.record` events, plus the native document revision anchor. Validation cross-checks actual Run/Turn/Attempt, allowed approval, each Tool/Part and output digests. Rehashing a mutable document cannot erase an admitted PID, change a result or fabricate a terminal receipt.

The native call intent commits before broker dispatch. Physical process completion is recorded before the outer final ToolPart; the job becomes terminal only after that real Part exists. SQL failure before admission starts no worker. SQL failure after process admission or after the final Part retains uncertainty without creating another result or retrying effects.

Parent cancellation and engine close join the runtime supervisor and existing command group. Actual Root SIGKILL tests also wait for both groups and the physical command lock to disappear. Interrupted restart history becomes `uncertain`; imported history becomes `paused-import`. Neither path registers a runtime, reconstructs a live Original grant or automatically replays a provider/tool call. Unknown effects block further workspace execution through the existing recovery guard. Partial approved command effects remain on disk.

## Limits and evidence

Source: 16 KiB, 512 nodes, depth 12. Fixed loop count: at most 64. Allocation: at most 4,096 steps, 16 nested calls, 32 KiB result and 30 seconds. Native records: at most 128, 64 KiB each and 8 MiB total. Runtime protocol: bounded JSONL frames and finite total output; no unbounded program I/O is exposed. Runtime Node heap is bounded at 64 MiB.

The final focused suite has 26 passing cases in both direct source and emitted JavaScript. It includes genuine approvals, native read/patch/command/verification receipts, file/network/fork kernel denial, source/physical replacement, stale and copied grants, duplicate calls, Run budgets, timeouts, cancellation, SQL faults, fully rehashed native corruption, actual SIGKILL, restart and paused import. The adjacent native/coordinator/output-budget/verification/owned-command suite has 183 passing cases. Whole engine strict checking and whole project declaration build pass. Exact commands and evidence are recorded in [the verification file](engine-phase-two-code-mode.verification.json).

The supported Darwin backend remains experimental. Other OS backends, arbitrary JavaScript/TypeScript/WASI, remote or MCP effects, runtime reconnect, historical grant restoration and automatic uncertain-effect repair are unsupported. GUI, live accounts/providers and broader environment verification items E5-13/E5-08/E6-07/E6-08 are outside this increment.
