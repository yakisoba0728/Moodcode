# STORE-01 signed revision/receipt preparation

`prepareSignedBackendRevision` now owns the repeated signed record/receipt assembly used by live `append` and `appendAdministrative`. It accepts typed captured values and performs the original sequence: record signing, body validation, state transition assertion, transition validation, then receipt signing with request/after hashes. It has no database, transaction, Original-port, UUID, time or cache access.

The callers retain body/state/request selection, quota checks, UUID/time capture, SQL projection, both row inserts and head CAS. All 36 quoted SQL statements are byte-identical to the baseline. Live connection projection still uses `eid`; administrative projection still uses `after.connectionId`. Recovery retains `uncertain`/`BACKEND_OWNER_LOST`, and import retains disabled or `paused-import`/`BACKEND_IMPORTED` state. Public APIs, schemas, migration versions and events are unchanged.

Manual caller review confirmed the single configured `backendRecords` instance, existing synchronous transaction ownership, Original producer ports and independent archive validation. The existing named functions changed only in the two appenders; every other named-function AST fingerprint remains unchanged, including the body, transition, SQL-owner and database validators. No validator consumes the new writer helper.

The dedicated receipt contract test was added and passed against the unchanged baseline before implementation: 2 tests, 2 passes, no skips. It independently reads SQL through separate read-only connections and computes canonical JSON SHA with `node:crypto`, using fixed UUID/time captures. It checks live registration/disable links, complete headers and serialized pairs, nested request immutability and historical dedupe with one total target read. Its administrative case backs up a genuine held request, closes the actual Engine through its Original owner, then validates copied-evidence recovery and pause-import links, owner columns, unknown outcomes, archive SHA binding, unchanged history, exactly ten required added rows, and no replay. Both cases independently validate exported archives.

The authored harness's first run used the wrong Node mock restore API. It was corrected to `mock.mock.restore()` before rerunning unchanged production; no assertion was weakened. After implementation, the contract test plus existing store, native graph, completed/cancelled archive, crash recovery, admission rollback and producer-boundary suites passed: **20 tests, 20 passes, no skips**. These reuse the existing real SQLite CAS rollback, getter/proxy zero-trap and Run/Attempt/native-tool ownership coverage.

| Measurement                               |   Before |    After |
| ----------------------------------------- | -------: | -------: |
| Store physical lines                      |    4,088 |    4,118 |
| Store functions                           |      144 |      145 |
| Sum of function syntax complexity         |    1,375 |    1,376 |
| Store decision nodes                      |    1,231 |    1,231 |
| `append` lines / complexity               | 161 / 32 | 140 / 28 |
| `appendAdministrative` lines / complexity | 141 / 25 | 125 / 25 |
| New helper lines / complexity             |        — |   50 / 5 |

The gain is one assembly responsibility and one definition for each signed pair field. Typed named inputs add 30 total lines. Decisions moved from `append` into the helper; the extra function contributes one base complexity point. This is **not** a total line or complexity reduction. Measurements use the existing TypeScript 7 AST worker's closed virtual filesystem and syntax proxy, not a semantic/runtime measure.

Source pins, caller references, preserved contracts, exact tests, log hashes and metric artifacts are recorded in [the JSON review](next-store-refactor-review.json). Current store SHA-256 is `1a47ea5d3caf772dc96ef9053d7e36b5929b79c0f2aa75ddce5ef4576d473ff9`; the authored test SHA-256 is `8d00a4e6889043e39445c76023435c9235cfadf902869ab4f9618caac0912e7b`.

The delegated parent completed its own all-project typecheck and compiled native gate: 20/20 tests, no failures or skips. Root retains combined full regression on integrated main. The STORE agent made no dependency/build/dist writes or live provider/key requests; the parent performed setup and serial builds only in this isolated worktree.
