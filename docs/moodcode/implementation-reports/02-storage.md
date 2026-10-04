# 02 — SQLite storage implementation

완료일: 2026-10-04, Asia/Seoul.

## 구현 파일과 API

- `packages/engine/src/storage/index.ts`: `export class SqliteStore implements EngineStore`, constructor `(dbPath: string)`.
- `packages/engine/src/storage/storage.test.ts`: admission, journal/projection, snapshot/replay/subscribe, records, recovery, migration 검증.
- `packages/engine/src/storage/ownership.test.ts`: 다중 owner, 경로 별칭, 실제 process crash 검증.
- `packages/engine/src/storage/fixtures/owner-child.ts`: 기록을 commit한 뒤 SIGKILL을 기다리는 child fixture. filesystem/process 효과는 실행하지 않는다.

고정 `EngineStore`의 모든 메서드를 구현했다. contracts/ports, package 설정, public facade/export는 수정하지 않았다. 계약 변경 제안은 없다.

## 구현된 동작

파일 DB는 canonical path 옆의 `.owner.sqlite`를 DELETE journal 모드로 열고 장기 `BEGIN EXCLUSIVE` transaction을 유지한다. main DB 열기·migration·recovery 전에 소유권을 획득하며, 다른 engine owner는 `DB_LOCKED`로 거절된다. PID나 stale 시간에 의존하지 않는다. close는 main DB를 먼저 닫은 뒤 ownership 연결을 닫으며, lock 파일을 unlink하지 않는다. 생성된 경로와 부모의 symlink를 canonicalize하고, hardlink와 dangling 파일 symlink는 `DB_PATH_UNSUPPORTED`로 거절한다. 초기화 실패도 소유권을 해제한다. 별도 lock DB는 SQLite의 [exclusive transaction](https://sqlite.org/lang_transaction.html)과 [파일 잠금](https://sqlite.org/lockingv3.html)을 사용한다.

main DB는 WAL, foreign keys, `synchronous=FULL`을 적용한다. v0→v1 DDL/index와 `user_version`을 하나의 transaction으로 기록하며, 지원 범위 밖의 버전은 main DB 변경 전에 `DB_VERSION_UNSUPPORTED`로 거절한다. workspace/session/input/run/message/tool/approval/checkpoint와 session별 seq journal을 저장한다. workspace root deduplication, session/run 조회, immutable identity 검증, foreign keys와 active workspace partial unique index를 적용했다.

admit는 정규화 입력의 canonical JSON을 비교한다. object key 순서는 identity에 영향을 주지 않는다. session/request ID의 기존 receipt 조회와 conflict 검사가 busy보다 먼저 실행된다. 새 입력의 input/run/user-message/`input.admitted`/seq는 같은 `BEGIN IMMEDIATE` transaction으로 기록된다. busy/conflict와 실패한 commit은 기록이나 seq를 남기지 않는다.

commit은 Run 전이, message/tool/approval/checkpoint projection, journal, seq를 한 transaction으로 갱신하고 commit 이후에만 구독자를 깨운다. tool input, approval fingerprint/preview와 기존 entity의 소속은 바꿀 수 없다. checkpoint는 immutable이다. terminal state는 matching `run.<state>` event를 요구하며, pending approval을 같은 transaction에서 expired로 마감하고 approval.expired events 뒤에 terminal event를 마지막으로 기록한다. 종료 이후 public commit은 `RUN_TERMINAL`로 거절된다. late 결과와 중복 terminal은 상태·seq를 바꾸지 않는다.

snapshot은 단일 read transaction에서 모든 projection과 `lastSeq`를 읽는다. replay는 ascending seq의 페이지를 반환한다(기본 128개, 명시적 limit 1~1024). subscribe는 wake listener를 등록한 다음 journal을 읽는다. 알림에는 event를 적재하지 않으며 소비자는 cursor부터 다음 DB 페이지를 읽는다. AbortSignal과 store.close는 idle wait를 해제하고 listeners를 정리한다.

recoverInterrupted는 active Run을 `interrupted`, requested/awaiting/running tool을 `interrupted`, pending approval을 `expired`로 기록한다. record 변경과 각 event는 하나의 recovery transaction이다. terminal Run에 남은 unresolved tools와 이전 DB의 orphan pending records도 정리하며 Run terminal event를 추가하지 않는다. 현재 정상 commit API는 terminal Run에 pending approval을 남기지 않는다. checkpoint/history/receipt를 보존하고, 두 번째 recovery는 기록을 더 만들지 않는다. 자동 도구 재실행은 없다.

## 실제 검증

실행 환경은 로컬 macOS, Node `v26.9.0`, 설치된 TypeScript `7.0.2`와 tsx다. 실제 공급자 API와 외부 비용 호출은 사용하지 않았다.

1. `node_modules/.bin/tsx --test packages/engine/src/storage/*.test.ts`: **20/20 통과**.
2. `tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node`에 담당 소스/테스트/fixture를 지정: **통과**.
3. 담당 파일을 임시 output directory에 동일 옵션으로 compile하고, ESM package metadata와 기존 node_modules symlink를 붙여 `node --test <temporary>/storage/*.test.js`: **20/20 통과**. compiled `.js` child fixture도 실제 실행했다. 임시 결과는 Python TemporaryDirectory로 정리했다.
4. 통합 담당자가 이미 만든 `packages/engine/dist/storage/*.test.js`도 실행해 **19/19 통과**했다. 이 출력은 마지막에 추가한 snapshot read transaction 경합 테스트 이전 build였다. 최신 소스와 임시 compiled output에서는 해당 추가 테스트까지 20개를 확인했다.

의미 있는 검증 범위:

- 같은 프로세스의 두 store와 live child owner 배제, close 이후 재획득.
- 기존 파일/부모 symlink alias, hardlink 및 처음부터 dangling symlink인 경로.
- running tool과 pending approval 두 child를 각각 SIGKILL한 뒤 owner 재획득, interrupted/expired recovery, 중복 receipt 유지 및 workspace busy 해제.
- 별도 SQLite 연결의 journal 삽입 실패 trigger로 run/message/seq rollback과 gap 없는 다음 event.
- snapshot의 첫 SELECT 뒤 별도 SQLite writer가 commit해도 projection과 lastSeq가 같은 이전 revision을 유지하고, snapshot cursor에서 새 event를 replay하는 경합.
- snapshot→subscribe 사이 commit, empty replay 직후 await 이전 commit, 느린 consumer의 270 event와 여러 페이지, 두 subscriber, abort/close.
- request conflict와 busy 순서, workspace별 동시 허용, late terminal 거부, records identity와 immutable checkpoint, orphan cleanup, recovery idempotence.
- future schema 거절 전후 main DB bytes 동일 및 초기화 실패 후 lock 재획득.

## 한계와 통합 시 주의점

- constructor는 lock/migration을 수행하며 `recoverInterrupted()`는 자동 실행하지 않는다. facade가 단독 owner 획득 직후 runner 생성 전에 호출해야 한다.
- local filesystem의 SQLite 잠금 동작을 검증했다. 네트워크 filesystem, 외부 프로세스가 DB/lock 파일을 삭제·교체하는 상황, 디스크/전원 손실은 검증하지 않았다. DB backup/restore에는 SQLite main/WAL의 일관성을 고려해야 한다.
- 의도적인 raw SQLite writer는 ownership protocol을 우회할 수 있다. EngineStore를 사용하는 엔진끼리의 소유권을 보장하며, 테스트의 별도 raw 연결은 transaction 경합을 강제로 재현하는 fixture다.
- `:memory:`는 각 store에 독립적인 일시 DB다. crash durability와 process 간 ownership의 대상은 파일 DB다.
- 모든 효과와 DB가 원자적이라는 보장은 없다. uncertain tool은 interrupted이며, checkpoint의 incomplete/warnings를 그대로 보존한다.
- 고정 port에는 session-list pagination/cursor와 artifact metadata 저장 메서드가 없다. listSessions는 전체 배열이며 replay pagination은 readEvents/subscribe에 적용한다.
- Node 24 최소 버전과 Electron utility runtime, 전체 engine integration/build는 이 담당 범위에서 직접 검증하지 않았다. Node SQLite API의 timeout은 [Node 공식 문서](https://nodejs.org/api/sqlite.html)에 Node 24 지원으로 기록되어 있으며, 실제 실행 검증은 Node 26에서 했다.

## 추가 단계 — integrity 검사, native backup, 비동기 close

2026-10-04 추가 병렬 지시에 따라 기존 port/facade의 signature를 변경하지 않고 다음 API를 추가했다.

```ts
SqliteStore.integrityCheck(): IntegrityCheckResult
SqliteStore.backup(destination: string, options?: StoreBackupOptions): Promise<DatabaseBackup>
SqliteStore.closeAsync(): Promise<void>

interface StoreBackupOptions { signal?: AbortSignal }
interface DatabaseBackup { destination: string; bytes: number; schemaVersion: number }
interface IntegrityCheckResult {
  ok: boolean;
  schemaVersion: number;
  errors: string[];
  foreignKeyViolations: {
    table: string; rowId: number | null; parent: string; foreignKeyIndex: number;
  }[];
}
```

추가 파일은 `storage/maintenance.ts`, `storage/maintenance.test.ts`, `storage/backup-paths.test.ts`다. index.ts는 위 세 메서드와 반환 타입을 export한다. EngineStore port, contracts, facade와 root 설정 파일은 수정하지 않았다.

integrityCheck는 하나의 read transaction에서 `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, 지원 DB 버전을 검사하며 journal을 추가하지 않는다. SQLite의 [integrity_check는 FK 검사와 별개](https://sqlite.org/pragma.html#pragma_integrity_check)이므로 두 검사를 모두 사용한다. 실제 raw connection에서 FK를 깨뜨린 경우, CHECK constraint를 무시하고 invalid seq를 저장한 경우, user_version을 변경한 경우를 검출했다.

backup은 [Node 공식 `node:sqlite.backup`](https://nodejs.org/api/sqlite.html#sqlitebackupsource-db-path-options)과 로컬 `@types/node/sqlite.d.ts`를 확인해 사용했다. live main DB 파일을 복사하지 않는다. 파일 DB에는 별도의 readOnly 연결을 열고 BEGIN과 실제 SELECT로 WAL snapshot을 고정한다. native API가 이 committed snapshot을 private staging 파일에 기록하고, staging의 integrity/FK/user_version을 검증한다. 같은 source handle의 writer transaction과 native backup이 경합하면 SQLITE_LOCKED가 될 수 있으므로 live writer와 분리했다. native 결과가 source WAL header를 상속하므로 staging에서 journal_mode=DELETE로 바꾸고 연결을 닫아 단독 main file을 내보낸다. 반환된 backup은 source owner·WAL·SHM·외부 effect sidecar를 복사하지 않는다. 별도 읽기 연결을 열 수 없는 :memory:는 공식 [VACUUM INTO](https://sqlite.org/lang_vacuum.html)를 동기로 실행해 같은 검증·게시 경로를 사용한다.

목적지는 새 파일만 허용한다. 빈 기존 파일, 기존 directory, file/parent symlink(상위 경로 포함), dangling symlink, hardlink, 기존 SQLite sidecar가 있으면 거절한다. lexical `..`로 감춰지는 원래 parent symlink도 resolve 이전에 검사한다. 생성한 parent와 staging directory는 0700, backup file은 0600이며 기존 사용자 directory의 mode는 변경하지 않는다. private staging의 file/parent inode를 확인한 뒤 `linkSync`로 최종 목적지를 atomic no-overwrite 게시하고 임시 hardlink를 제거한다. 경쟁자가 목적지에 새 파일/링크를 생성하면 그 파일을 보존하고 백업은 실패한다. file과 output parent를 fsync한다.

abort는 시작 전, native progress, native 완료 후 및 publish 경계에서 확인한다. Node API에는 AbortSignal 옵션이 없어 progress의 exception으로 native 작업을 finalize한 뒤 reject하도록 한다. 이 동작은 [Node 24 소스](https://github.com/nodejs/node/blob/v24.0.0/src/node_sqlite.cc)와 [Node 26 소스](https://github.com/nodejs/node/blob/v26.9.0/src/node_sqlite.cc)를 확인했고 Node 26에서 실제 취소와 source 정상 유지로 검증했다. 일반 실패/취소는 private staging과 자신의 partial output을 제거하며, cleanup 자체가 실패하면 `BACKUP_CLEANUP_FAILED`와 `partialPath`를 반환한다. 경쟁자가 만든 다른 inode는 지우지 않는다.

기존 close():void는 즉시 새 읽기/쓰기/백업을 거절하고 진행 중 backup을 취소한다. native job·검증·cleanup이 모두 settled될 때까지 SQLite/ownership 연결을 유지한다. closeAsync는 그 정리와 실제 connection release까지 기다린다. 반복 close/closeAsync는 같은 완료 상태를 공유한다. native release가 실패하면 `STORE_CLOSE_FAILED`로 reject하며, 오류를 성공 종료로 감추지 않는다.

추가 검증은 Node 26.9.0에서 실제 SQLite로 수행했다.

- committed terminal/active Run과 checkpoint를 포함한 WAL source를 backup하고, 복원 store의 snapshot·journal·checkpoint와 원본이 일치하는 것을 확인했다. 복원 store를 열기만 하면 active 상태가 보존되며 명시적 recoverInterrupted 호출 후에만 interrupted가 된다. source의 active Run과 외부 effects는 그대로다.
- native backup 중 source terminal commit이 발생해도 restored snapshot·journal이 고정된 이전 시점과 정확히 일치하는 것을 확인했다. readOnly source 연결은 WAL writer commit을 막지 않는다.
- pre-abort, in-flight abort, close, 병렬 backup+abort+closeAsync, double close와 native connection release exception을 검증했다. await closeAsync 후 새 owner가 정상적으로 열렸다.
- FK/버전 검증 실패와 경쟁 목적지 생성 후 staging이 제거되는 것을 확인했다. 목적지/parent symlink, hardlink, 기존 empty/nonempty file, mode 0700/0600, SQLite sidecar를 실제 filesystem으로 검증했다.
- memory store의 파일 backup과 두 병렬 backup도 복원해 확인했다.

추가 단계 최종 실행 결과:

1. `node_modules/.bin/tsx --test packages/engine/src/storage/*.test.ts`: **48/48 통과** (기존 20 + maintenance 10 + backup paths 18).
2. 담당 storage 전체 `.ts`와 fixture를 `tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node`로 검사: **통과**.
3. 동일한 strict 옵션으로 임시 output directory에 담당 파일 전체를 compile하고 `node --test <temporary>/storage/*.test.js`: **48/48 통과**. 최신 source suite와 compiled suite를 독립 process로 병렬 실행해 native 백업/동시 commit 경합도 다시 확인했다. 전체 monorepo build는 실행하지 않았다.

통합 담당자가 추가할 API는 facade의 `integrityCheck`, `backup` 노출과 engine.close()의 finally에서 `await store.closeAsync()` 호출이다. backup 후 복원은 기존 파일을 overwrite하는 기능을 제공하지 않으며, 사용자에게 새 DB 경로를 선택하게 하는 상위 흐름은 통합 범위다.

추가 단계 한계: 파일 backup은 별도 read transaction의 첫 SELECT 시점에 고정되며 reader가 유지되는 동안 WAL checkpoint와 크기에 영향을 줄 수 있다. Signal은 native step/publish 경계 취소이며 마지막 step이 이미 끝났으면 완료가 먼저 확정될 수 있다. memory fallback은 동기 SQLite 실행 중 event loop 취소를 처리하지 못하고 실행 전/완료 경계에서 확인한다. 프로세스 SIGKILL/전원 손실 중에는 private staging이 남을 수 있으며 이를 startup에서 자동 삭제하거나 effects를 재실행하지 않는다. 실패 시 새로 만든 비어 있는 parent directories는 남을 수 있다. SQLite 구조/FK/지원 버전을 검사하고 모든 JSON domain invariant를 추가 감사하는 기능은 아니다. adversarial filesystem rename 교체·disk failure, Windows 및 Electron utility의 이 추가 API는 아직 직접 검증하지 않았다. 상위 루트가 OS symlink인 경로(예: macOS `/tmp`)도 명시적으로 거절하므로 caller는 symlink가 없는 실제 부모 경로를 사용해야 한다.

## 추가 단계 — terminal Run의 pending approval 불변식

2026-10-04 root integration에서 확인한 pending approval 불변식을 보강했다. 정상 `commit()`으로 Run을 completed/cancelled/failed/interrupted로 확정할 때, 같은 runId/sessionId에 속한 모든 pending approval을 expired와 resolvedAt으로 바꾸고 각각 `approval.expired`를 기록한다. 기존 allowed/denied/expired 결정을 바꾸지 않는다. matching Run terminal event는 마지막 seq로 기록하며 commit의 반환 event도 이 마지막 terminal event다. Run projection, approval expiry, 모든 events와 seq는 같은 transaction으로 commit/rollback되고, 통지도 전체 COMMIT 이후에만 발생한다.

기존 terminal 이후 모든 public commit을 거절하는 정책을 유지했다. 중복 terminal과 late approval expiry 요청은 `RUN_TERMINAL`이며 expiry를 추가하지 않는다. terminal CommitChange 안에서 새로 들어온 pending approval도 terminal commit에 포함되어 만료된다. recovery는 같은 내부 expiry helper를 사용하고 이미 terminal transaction에서 만료된 승인을 다시 기록하지 않는다.

기존 storage.test.ts의 정상 API로 terminal+pending orphan을 만들던 기대는 제거했다. 현재 불변식에 맞게 terminal 직후 승인 만료와 event 순서를 확인한 다음, recovery가 남은 unresolved tool만 정리하며 approval expiry/Run terminal을 중복하지 않는 것을 검증한다. 외부 raw DB로 legacy domain 상태를 제조하지 않았다.

`storage/terminal-approval.test.ts`에 새 실제 SQLite 테스트 6개를 추가했다. 네 terminal 상태 각각에서 여러 pending 승인의 만료, terminal CommitChange에 포함된 새 pending의 만료, 기존 allowed/denied/expired 결정 보존, 다른 workspace/Run의 pending 상태·seq 보존을 검증한다. 또 journal의 terminal INSERT와 두 번째 expiry INSERT에만 SQLite trigger로 실패를 주입해, 먼저 바뀐 Run/approval, 삽입된 tool/approval, event와 seq 전체가 rollback되는 것을 확인했다. Domain fixture는 전부 정상 public store API로 생성했다. trigger를 제거한 재시도는 gap 없는 seq와 terminal-last를 유지한다.

backup concurrent writer 회귀 테스트도 pending 승인을 포함하도록 보강했다. source의 terminal commit은 pending→expired를 확정하고, 이미 고정된 backup은 이전 running+pending snapshot과 journal 전체를 정확히 보존한다.

최종 검증은 source `tsx --test storage/*.test.ts` **54/54 통과**, strict NodeNext noEmit **통과**, 담당 전체를 strict compile한 임시 output의 `node --test storage/*.test.js` **54/54 통과**다. 공개 port/facade/root 설정은 변경하지 않았고 새 schema/migration도 필요하지 않다. terminal `commit()` 하나가 여러 approval.expired events를 추가할 수 있으므로 반환 terminal event의 seq를 마지막 cursor로 사용하면 된다.
