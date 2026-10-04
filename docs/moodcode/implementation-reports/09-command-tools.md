# 09 — Command execution, bounded output, cancellation, and crash supervision

2026-10-04, Asia/Seoul. 담당 범위 `packages/engine/src/tools/command/**`.

## 구현과 API

- `index.ts`: `createCommandTool(): ToolDefinition`, `COMMAND_LIMITS`. `run_command` 입력은 `{command, cwd?, timeoutMs?}`. prepare는 입력·canonical workspace cwd를 읽어 검증하며 filesystem/process 효과를 만들지 않는다. `requiresApproval=true`; 정확한 명령, 절대 cwd, 유효 timeout, workspace/run/tool ID, session/root, 플랫폼을 SHA-256 fingerprint에 묶는다. 실행 직전 입력·preview·data·fingerprint와 cwd를 다시 확인한다. 동일 fingerprint의 순차·동시 재실행은 효과 전에 거절한다. 실제 승인 결정은 runner/approval port가 소유한다.
- `process-control.ts`: POSIX shell을 독립 process group으로 실행하며 AbortSignal/timeout에 SIGTERM → 250ms grace → SIGKILL → 2초 확인을 적용한다. shell close와 process-group 부재를 확인해야 cleanupConfirmed가 된다. shell이 종료해도 남은 descendant group을 정리하고 failed 결과를 반환한다. stdout/stderr readables는 sink drain까지 pause하여 supervisor 전달 큐를 제한한다. 중지 시 unread output은 discard/drain하고 관찰 byte만 계수했다는 불확실성을 남긴다.
- `supervisor.ts`: 독립 Node subprocess. execution lock 획득 → READY → 부모 START handshake 이후에만 shell을 시작한다. engine IPC disconnect/SIGTERM/SIGINT 시 cleanup을 수행한다. 엔진 부모 SIGKILL에도 살아남아 원래 command group을 정리한다. client는 supervisor 결과와 close를 기다리며 supervisor 손실 시 알려진 process group에 bounded fallback cleanup을 수행한다. 정리 후 결과 IPC와 output stream finish를 우선 기다리고, paused/disconnected consumer의 종료는 250ms fallback으로 확정한다. 정상 실행은 전체 출력 drain을 유지한다. 컴파일된 `.js` entry와 tsx source 실행을 지원하며, Node/Electron 실행에 `process.execPath`와 `ELECTRON_RUN_AS_NODE=1`을 사용한다. 부모 eval/test/debug argv는 전파하지 않고 module loader option만 보존한다.
- `execution-lock.ts`: `assertExecutionLockAvailable(path): void`, `acquireExecutionLock(path): ExecutionLock` (`recordGroup(pid)`, `release(cleanupConfirmed)`). 별도 SQLite 파일의 `command_execution` singleton marker를 사용한다. active marker를 먼저 commit하고 BEGIN EXCLUSIVE를 실행 동안 보유한다. 확인된 정리만 active=0 commit/release한다. crash·불확실 정리는 active=1을 남겨 후속 실행을 차단한다. `COMMAND_EFFECTS_BUSY`, `COMMAND_CLEANUP_UNCERTAIN`, `COMMAND_EFFECTS_LOCK_FAILED`로 오류를 구별한다.

## 출력·checkpoint 동작

- stdout/stderr 합산 메모리 capture 262,144 bytes, 모델 content 65,536 bytes와 caller maxOutputBytes 중 작은 값, artifact 합산 1,048,576 bytes를 독립 적용한다. UTF-8 완전 문자의 경계를 보존한다. 각 stream에 observed/total, captured, model/source, artifact byte와 각 잘림 byte를 반환한다. 취소 후 미관찰 byte는 정확한 크기를 주장하지 않고 outputAccountingComplete=false/unobservedBytes=null로 구별한다.
- artifact는 absolute canonical 경로의 새 0700 directory/0600 exclusive files에 저장한다. 자기 stdout/stderr artifact가 workspace 안에 있어도 실행별 checkpoint 변경으로 포함하지 않는다. artifactDir 자체는 가능하면 workspace 밖에 두어 수집 예산을 소모하지 않게 하는 것이 좋다.
- command 전에 captureWorkspace를 수행하고, process 정리 뒤 별도 2초 signal로 후 capture를 수행한다. checkpoint preimage는 현재 사용자 파일 내용이므로 기존 Git 수정이 Run의 변경으로 복사되지 않는다. capture가 불완전한 쪽의 missing path를 생성/삭제로 추론하지 않는다. 바이너리·크기·수집 실패 경로는 변경 목록에서 제외하고 incomplete/warnings를 보존한다. 동시 외부 편집의 귀속 불확실성과 arbitrary shell 효과 복원 범위 제한을 항상 명시한다.
- supervisor와 실제 shell environment에서 알려진 provider API key/token 변수 및 Moodcode secret 변수들을 제외한다. Electron supervisor용 `ELECTRON_RUN_AS_NODE`는 shell 환경에 전파하지 않는다. 실제 key 검색이나 외부 provider 호출은 수행하지 않았다.

## 실제 검증

환경: macOS (`darwin`), Node 26.9.0, 로컬 fixtures/임시 디렉터리만 사용.

`./node_modules/.bin/tsx --test packages/engine/src/tools/command/command.test.ts packages/engine/src/tools/command/execution-lock.test.ts packages/engine/src/tools/command/supervisor.test.ts`: **34 tests, 33 pass, 1 Windows-only skip, 0 fail** (3.04초). 독립 검증 담당의 같은 최종 검증도 34개 중 33 pass/1 skip이었다.

검증 내용: prepare 무효과/정확한 승인 binding, 외부·symlink cwd 거부/교체 재검증, 기존 사용자 내용의 전후 checkpoint, nonzero exit, 2.2MB 출력과 개별 한도/0600 permissions, UTF-8 `é` 2/4-byte 경계, tiny/large caller model 한도, 동시 execute 단일 효과, pre-abort 무효과, binary→text/text→binary false checkpoint 방지, workspace 내부 artifact 제외, 실제 child+grandchild 취소, SIGTERM 무시 process-tree timeout SIGKILL, shell natural exit 후 descendant 정리, 실행 중 lock/release, busy lock 무효과, **엔진 부모 SIGKILL 후 command tree 종료와 effects lock 해제**, 별도 **lock owner SIGKILL 후 durable marker의 재실행 차단**.

`supervisor.test.ts`의 추가 실제 검증: 느린 async sink 후 정상 shell 종료 시 false descendant 판정 없음, 영원히 끝나지 않는 output sink의 취소/실제 group 종료, 부모 stdout/stderr를 pause한 **8MiB 출력의 producer backpressure와 재개 후 전 byte 전달**, paused consumer의 stop/disconnect 시 group 종료·lock 해제·bounded supervisor exit, fake provider credential 환경의 shell 전파 차단. cleanup 확인은 supervisor process exit로 먼저 검증하며 부모의 paused readable이 ChildProcess.close를 지연시키는 것과 구별했다.

담당 source/tests 및 transitive imports의 strict/noUncheckedIndexedAccess NodeNext `tsc --ignoreConfig --noEmit ... --types node` 검사 통과. 전체 monorepo build/E2E는 통합 root 소유로 실행하지 않았다.

## 통합 요구와 한계

- root가 추가한 optional `ToolContext.executionLockPath`/`CoordinatorOptions.executionLockPath`를 supervisor에 전달한다. 실제 engine은 영속 경로를 제공하고 createEngine startup에서 `assertExecutionLockAvailable`을 호출해야 한다. field가 없는 standalone fake는 crash 후 supervisor cleanup은 수행하지만 restart gate는 보장하지 않는다. `:memory:` DB와 동등한 비영속 lock은 허용하지 않는다.
- lock `group_pid` update는 held transaction 안에 있으므로 supervisor 자체 crash 때 null로 rollback될 수 있다. committed active marker가 안전하게 재실행을 차단하며 자동 marker 제거·명령 재실행을 수행하지 않는다. 수동 reconciliation UI/명령은 이번 범위가 아니다.
- 확인 범위는 원래 POSIX process group이다. command가 새 process group/session을 만들거나 OS daemon으로 이탈한 프로세스까지 보장하지 않는다. arbitrary shell은 sandbox가 아니며 파일·네트워크·외부 위치의 효과를 모두 rollback할 수 없다.
- Windows는 명확한 `COMMAND_PLATFORM_UNSUPPORTED` 상태다. Linux/Windows 실제 실행, Node 24 런타임, supervisor 자체 SIGKILL 후 manual reconciliation, 최종 Electron bundle/fuse/asar 검증은 이 담당 세션에서 수행하지 않았다. windowless Electron utility의 approved-command smoke는 통합 root가 맡는다.

## 추가 병렬 구현 — 읽기 전용 execution-lock 진단 API

`execution-lock.ts`에 다음 API를 추가했다. doctor 서비스와 root가 직접 import할 수 있으며 ports 변경은 없다.

```ts
inspectExecutionLock(path: string, options?: { signal?: AbortSignal }): ExecutionLockInspection
// { status: 'not_initialized' | 'available' | 'busy' | 'uncertain',
//   marker: { ownerPid, groupPid: number | null, active, updatedAt } | null,
//   schemaVersion: number | null }
```

- 파일 부재는 not_initialized/null/null; 기존 빈 SQLite·table 부재·marker 부재는 not_initialized/null/0이다. inactive marker는 available, active marker는 uncertain이다. 살아 있는 exclusive 소유자는 busy로만 반환하고 marker/schemaVersion을 null로 둔다. PID 값은 저장된 관찰 정보이며 process liveness 확인이나 실행 권한 판정에 사용하지 않는다.
- 기존 absolute regular file만 열고 file symlink·directory·relative/NUL/memory 경로는 거부한다. parents/database/schema 생성·journal 복구·marker 제거·명령 재실행은 없다. SQLite readOnly=true/timeout=0과 짧은 read transaction으로 읽는다. current `user_version=0` schema를 검사하고 기존 assert/acquire도 같은 version check를 수행한다.
- database 1MiB, 반환 timestamp UTF-8 128 bytes, 정확한 5-column schema와 singleton row, integer PID·active·timestamp를 검증한다. `table_xinfo`로 hidden/generated extra column도 거부하고, 대소문자가 다른 선언 column name은 canonical 반환 필드로 읽는다. UTF-16 저장의 timestamp도 최종 UTF-8 반환 byte 한도를 적용한다. 반환 marker와 오류 텍스트는 bounded이며 DB의 oversized 값이나 fragment를 복사하지 않는다. WAL format은 SQLite가 read-only 연결에서도 shm sidecar를 생성할 수 있으므로 header에서 미리 거부한다. opened file descriptor의 현재 identity·size·header와 재조회 path를 검증하므로 stale path stat의 zero-byte 값으로 header 검사를 건너뛰지 않는다.
- 오류: COMMAND_EFFECTS_INSPECT_INVALID_PATH, COMMAND_EFFECTS_INSPECT_PERMISSION_DENIED, COMMAND_EFFECTS_INSPECT_CORRUPT, COMMAND_EFFECTS_LOCK_UNSUPPORTED_VERSION, COMMAND_EFFECTS_INSPECT_RECOVERY_REQUIRED, COMMAND_EFFECTS_INSPECT_FAILED, COMMAND_EFFECTS_INSPECT_ABORTED. busy/locked는 오류 대신 busy 상태다. AbortSignal은 sync operation 경계에서 확인하며 실행 중인 synchronous SQLite/filesystem syscall을 강제로 interrupt한다고 보장하지 않는다. 결과는 순간 관찰이므로 이후 실행 admission에는 원래 acquire/assert gate가 필요하다.

Node SQLite API는 검증한 file descriptor 대신 path를 다시 열기 때문에 마지막 path 검사와 SQLite open 사이의 교체를 원자적으로 막을 수 없다. 안정된 지원 파일에 대한 무변경을 검증했으며, 진단 결과를 실행 권한으로 사용하지 않는다. access time은 읽기로 갱신될 수 있어 파일 불변 검증에서 제외했다.

새 `execution-lock-inspection.test.ts` source **23/23 pass**, 담당 source/tests와 transitive imports의 strict NodeNext/noUncheckedIndexedAccess noEmit 통과. 실제 child exclusive hold→busy, child SIGKILL→uncertain durable marker 및 journal 포함 파일 tree의 bytes/hash/mode/mtime/entries 불변, missing parents 무생성, unsupported version·corruption·hidden/generated schema·대문자 column·UTF-16 timestamp 한도·큰 row·nullable PID·실제 chmod permission·pre-abort·stale zero-byte stat의 WAL header 검사를 검증했다.

최종 source의 command/execution-lock/inspection/supervisor 4파일 재검증: **57 tests, 56 pass, 1 Windows skip, 0 fail** (3.01초). source supervisor의 **stop/disconnect fixes 모두 통과**했다. root가 이미 생성한 compiled artifact로 `node --test packages/engine/dist/tools/command/supervisor.test.js`를 별도 실행했고 **7/7 pass** (2.44초), compiled supervisor의 **paused stop/disconnect cleanup·lock release·bounded exit와 정상 8MiB 전체 출력 모두 통과**했다. 이 세션에서 전체 monorepo build나 root 파일 변경은 수행하지 않았다.
