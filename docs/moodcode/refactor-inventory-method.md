# Refactor inventory measurement method (RF-01)

`scripts/inspect-refactor-scope.mjs` produces an inspection aid from captured source. It does not approve a refactor, prove a defect, prove unused code, or complete RF-01/RF-02. Responsibility, actual callers and consumers, resource ownership, DB transactions, persisted records and public compatibility still require manual evidence. Engine, test and application performance require their own execution evidence.

## Run and preserve evidence

```sh
node --test --test-concurrency=2 scripts/inspect-refactor-scope.test.mjs
node scripts/inspect-refactor-scope.mjs --help
node scripts/inspect-refactor-scope.mjs --stable --top 20 > /tmp/moodcode-refactor-inventory.json
node scripts/inspect-refactor-scope.mjs --stable --detail full --max-report-bytes 134217728 > /tmp/moodcode-refactor-inventory-full.json
```

Run from the repository root or supply `--root`. New files enter the inventory after they enter the Git index; untracked files are never read. During parallel feature work, every capture is transitional. Freeze the intended final source, stage the tool and all intended source changes, stop source mutations, then measure again. Do not reuse old line counts after source changes.

Full reports are local evidence artifacts. Do not commit multi-megabyte graphs as routine documentation. A concise recorded baseline should retain the HEAD, index hash, source fingerprint, tool hashes, runtime versions, bounds, coverage counts and selected candidate ranges/hashes. Retain a hash and usable location for the full artifact when it supports a decision.

The default `summary` detail keeps every source record and all import/export sites, but omits each file's function/call arrays. It retains aggregate counts, distributions, top function evidence and matched caller line samples. `full` retains every measured executable function and syntactic call site. Candidate lists are capped by `--top`; duplication records state both total and reported groups.

`--stable` omits varying elapsed-time and memory observations. With unchanged captured source, index, options, tool and runtime, JSON has a deterministic field/array order and no timestamp or absolute repository path. A normal run includes inventory capture/analysis observations sampled before report formatting. These are not engine latency, regression suite duration or product memory baselines. Worker RSS excludes the native compiler process's peak memory, so it must not be presented as total scanner memory. Full pretty-printed JSON may exceed the default 64 MiB output bound; the full-report example explicitly uses the 128 MiB hard maximum.

## Scope and source qualification

The Git index supplies paths, mode, stage and object IDs. The measured bytes come from the working tree. This distinction permits dirty or newly staged source while preserving its provenance. An index without a commit has `head: null`; content hashes still qualify the capture.

Owned roots are `packages/engine/`, `packages/contracts/`, `packages/windows-job/`, `apps/engine-harness/`, `apps/desktop/`, `scripts/` and `.github/`. Recognized JS/TS and other code extensions are selected. The native Windows package's C/C++ sources are physically measured with explicit unsupported AST coverage; its maintained JS/type entries are public-entry candidates. Tracked Python analysis under `docs/coding-agent-engine-review/` is physically measured in a separate ancillary bucket and never added to owned product/test totals. Other roots are excluded without content reads.

Paths under clones, dependencies, `node_modules`, `vendor`, generated directories, `dist`, release, coverage, `.git`, `.moodcode` and `.next` are excluded. `*.generated.*`/`*.gen.*` names are excluded. `.env` and its variants are excluded before reads. JSON, Markdown and other non-source extensions are excluded; existing package/TypeScript/account configuration is not read as measurement input. Executable `.mjs`/`.cjs` build configuration remains owned code and is parsed without executing it.

Classification uses path evidence: `*.test.*`/`*.spec.*` are tests; fixture directories, `fixture(s).*` and `*.fixture.*` are fixtures; remaining scripts/CI are tooling; other owned source is product. Test naming takes precedence inside a fixture directory. Classification is a reproducible initial partition, not proof of semantic responsibility or coverage. Review exceptional helpers manually before using role totals as acceptance evidence.

Each source is read as bounded, valid UTF-8 from a regular file. Source symlinks and symlink ancestors are rejected. Captured SHA-256 hashes pin exact bytes; index object IDs pin the staged identities. Sources are hashed again after AST inspection, then HEAD and index are checked again. Any observed mutation, missing source or validation failure prevents a stable capture. This is a finite consistency window, not a file lock or protection against a transient change that is reverted between observations.

Tool modules have their own SHA-256 pins. Runtime records Node, platform/architecture and the loaded TypeScript version. The installed TypeScript 7 unstable API is deliberately version-qualified; an upgrade requires repeating the independent fixture tests. The compiler sees a synthetic `noLib`/`noResolve` project containing captured source only. Virtual filesystem callbacks return explicit absence instead of falling back to real account/configuration files. No engine/provider module is imported or executed. No network, account session or live provider is used.

## Metric definitions

| Metric              | Definition and limits                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Physical lines      | Includes blank lines, comments and literals. CRLF counts as one separator; CR, LF, U+2028 and U+2029 also separate lines. Empty text is zero. A final separator does not create a phantom additional line.                                                                                          |
| Function            | Executable function declaration/expression, arrow, method, constructor, getter or setter with a body. Bodyless overloads, signatures and ambient declarations are not executable functions.                                                                                                         |
| Function length     | Inclusive line span from the first declaration token through the final token. Leading comments are excluded. Multiline parameter/type declarations and nested functions contribute to the enclosing span. Body span is also reported.                                                               |
| Syntax decisions    | One per `if`, `for`, `for-in`, `for-of`, `while`, `do`, non-default `case`, `catch`, conditional expression, `&&`, `\|\|`, `??`, `&&=`, `\|\|=`, or `??=` AST occurrence. Strings/comments never count as branches.                                                                                 |
| Function complexity | `1 + syntax decisions` owned by that executable function, including parameter initializers and excluding nested functions. This is a defined syntax proxy, not a semantic path count or proof of risk. `else`, `default`, `finally`, optional chaining and `switch` itself add no decision.         |
| File decisions      | All counted AST decisions, with top-level decisions separate from functions. Nested function decisions are counted once at file level.                                                                                                                                                              |
| Distribution        | Counts, total, nearest-rank p50/p95 and maximum. Inclusive function spans overlap when functions are nested; their total is not distinct source lines.                                                                                                                                              |
| Duplicate candidate | SHA-256 of complete executable body AST structure and exact leaf spelling. Trivia is omitted; identifiers, operators and literal contents are retained. Default minimum is six body lines and 40 AST nodes. Empty/trivial functions are filtered. Occurrence ranges and source hashes are recorded. |

Duplicate matching is intentionally conservative: renamed identifiers are not normalized, and partial blocks are not searched. Matching bodies can still depend on different imports, closures, proof types, DB/native ownership, lifetimes or invariants. Groups spanning production and fixtures are not counted as removable production lines. Shared extracted helpers require an explicit semantic/ownership review and preserved regression scenarios.

## Imports, exports, calls and unused-code limits

The graph records static imports, import types/equalities, literal or computed dynamic imports/`require`, and re-export sites. Relative `.js`/`.mjs`/`.cjs` imports are matched to captured source extensions. Known `@moodcode/engine` and `@moodcode/contracts` entries are mapped without reading package configuration. Ambiguous, missing, computed and external/alias targets retain explicit resolution states. This is not the complete compiler/bundler module resolver.

Exports record declarations, destructured exported bindings, named/default assignments, type exports, re-exports and common dot-style CommonJS assignments. Calls/new expressions record exact source positions and the nearest executable caller. Identifier/property/literal-element spellings are reported; computed callees remain explicit. Bracket-style CommonJS exports, callback escape analysis, class/interface consumers, wildcard expansion and dynamic registration need manual review.

Matched calls are spelling evidence, not symbol resolution: shadowing may overcount; aliases, callbacks, inheritance, JSX components, constructors, private/computed methods and registrations may be missed. Named-import consumers are direct syntactic matches; barrels and namespace consumers are not recursively resolved. `knownPublicEntry` marks a small known entry list and does not certify that other files are private. A `noMatchedCall` row means inspection is needed and cannot justify deletion.

Before any fix/extraction/removal decision, attach actual caller and consumer evidence, exported/registered entry evidence, compatibility with existing DB/archive/event records, owner/transaction/cleanup boundaries, a proposed scope, validation and completion criteria. Keep confirmed defects distinct from inspection candidates. Length and branch counts rank investigation; neither establishes a defect by itself.

## Coverage, bounds and exits

Every selected source has a physical and syntax status. Missing files, non-regular entries, invalid UTF-8, parse diagnostics and measurement failures are retained and counted. Failed parsing does not return apparently reliable partial function data. Recognized code with an unsupported parser remains physically measured with `syntax.status: unsupported`; CSS/HTML/YAML and ancillary Python are current examples. Unsupported source must not silently become full AST coverage.

`executionStatus: completed` with `state: measured-with-unsupported-syntax` means the tool ran successfully and reported a known coverage gap. `completed-with-measurement-failures` means source reading/parsing, source stability or bounds failed. `measurement-failed`/`executionStatus: failed` is a CLI/metadata/worker/output failure that prevented the normal report. `complete` describes owned physical plus syntax coverage only; `refactorAcceptance` is always false. Ancillary coverage is reported separately.

The whole inspection deadline defaults to 60 seconds. Selected source reads default to 5,000 files, 2 MiB per file and 64 MiB of captured source; worker/final JSON defaults to 64 MiB. CLI hard maxima are shown by `--help`. Initial and validation source reads are bounded independently; validation rereads the captured files, so actual read bytes can be about twice captured bytes. Git metadata output has an 8 MiB bound. An exceeded bound produces a visible failure and never a complete result. Worker deadlines also cover synchronous compiler requests; on POSIX a timed-out worker process group, including the native compiler, is killed. Windows uses direct worker termination and must independently confirm native compiler cleanup before treating Windows execution as lifecycle evidence.

Exit `0` means all owned physical/AST source measurement completed; manual work is still outstanding. Exit `1` means unsupported syntax, partial/failed measurements, changed source, a bound failure or execution failure. Inspect `executionStatus`, source stability and coverage counters to distinguish these outcomes. Exit `2` means invalid arguments. `--help` and rejected arguments perform no inspection or compiler loading.

The focused test suite uses independently hand-counted temporary repositories and never builds the product. It checks line and function boundaries, exclusive decisions, path/role exclusions, untouched configurations/untracked source, unsupported/read/parse failures, symlink escape rejection, finite bounds, literal/identifier duplicate false positives, import/export/call evidence, deterministic snapshots and independent source/tool hashes.

## Work still required for RF-01/RF-02

Complete the unsupported language review; map semantic responsibilities and real dependency/consumer edges; record DB transactions, resource lifetimes and compatibility obligations; confirm each duplication/unused-code candidate; measure product/test/engine execution time and memory with existing deterministic benchmarks; then write evidence-backed problem/fix/delete/add/retain items. The final refactor comparison must use the same definitions, selected scope, options and supported runtimes on frozen before/after source. Tooling-only preparation is not completion credit for those work items.
