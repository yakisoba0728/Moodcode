# 08 — 승인 관리 구현 보고서

2026-10-04, Asia/Seoul. 승인 모듈 구현과 fake store·실제 SQLite 검증을 완료했다. 공유 contracts·ports·package 설정·engine facade 및 다른 담당자의 소스는 수정하지 않았다. 아래 추가 단계에는 root의 terminal 승인 만료 불변식 변경을 반영한 최종 검증 결과를 기록했다.

## 구현 파일과 API

- `packages/engine/src/permission/index.ts`: `ApprovalManager implements ApprovalPort`, `constructor(store: EngineStore)`.
- `packages/engine/src/permission/approval.test.ts`: 복사되는 durable rows와 동기 postcommit notification을 구현하는 독립 fake `EngineStore` 기반 테스트.

`request(input, signal)`은 `ApprovalRecord(status=pending)`와 `approval.requested` event를 같은 `store.commit()`으로 저장한 뒤 정확히 해당 승인에 대한 결정만 기다린다. 이미 중지된 signal은 row/event를 만들지 않는다. 요청의 session과 Run을 대조하며 `running`·`awaiting_approval` 상태에서만 새 요청을 만든다. 모든 승인 commit에서 Run 상태는 변경하지 않는다.

메모리 map은 현재 등록된 waiters와 원래 요청의 binding만 보유한다. 저장된 승인 상태가 결정의 기준이다. waiter와 abort listener를 requested commit 전에 등록하여 event 알림 내부의 즉시 결정·취소·중복 요청도 놓치지 않는다. 종료 시 listener와 map entry를 정리한다.

동일 `runId/toolCallId`의 아직 pending인 동일 fingerprint·toolName·preview 요청은 row/event 하나를 공유하되 서로 다른 promise를 받는다. preview object key 순서는 무시하고 배열 순서는 보존한다. 중복 waiter 하나가 abort되면 승인 전체를 만료한다. 이미 allowed/denied인 승인에 새 `request()`를 붙여 실행 권한을 다시 사용하지 않는다. 새 tool call ID가 필요하다.

`decide(id, decision, fingerprint)`는 저장된 fingerprint를 먼저 엄격히 대조한다. allow는 allowed, deny는 denied로 기록하고 `approval.resolved` event를 commit한 뒤 waiter를 resolve한다. 동일 결정의 재전송은 같은 저장 기록을 반환하며 timestamp/event를 추가하지 않는다. 종료된 Run에 대한 같은 결정 재전송도 조회만 수행한다. 다른 결정·다른 fingerprint·expired 승인은 거절한다. pending Run이 cancelling/terminal로 바뀌었거나 원래 memory binding과 저장 기록이 다르면 만료한 뒤 거절한다.

memory waiter가 없는 저장된 pending 승인은 복구된 실행 권한으로 인정하지 않는다. `request()`·`decide()`가 발견하면 `approval.expired(reason=recovery)`를 저장하고 거절한다. `cancelRun(runId)`은 memory waiters뿐 아니라 해당 Run snapshot의 모든 durable pending 승인을 만료한다. 다른 Run이나 이미 결정된 승인은 보존한다. abort/cancel/recovery는 `resolvedAt`과 `approval.expired`를 같은 commit으로 남긴다.

결정과 취소가 경합하면 먼저 commit된 결과를 유지한다. allowed가 먼저 저장된 뒤 signal이 abort되면 approval 결과는 allowed를 유지하며 실제 실행 전 취소 검사는 runner/tool 책임이다. 취소 만료 event 알림에서 늦은 decide가 재진입해도 원래 waiter의 취소 오류를 보존한다.

pending commit 실패는 waiter를 정리하고 저장 오류를 반환한다. decision commit 실패는 pending waiter를 유지하여 재전송을 허용한다. expiration commit 실패는 waiter를 저장 오류로 reject하고 실행 권한을 제거하며 실패를 숨기지 않는다. DB의 pending record가 남은 경우 다음 접근은 recovery expiration을 수행하며 allow하지 않는다. cancelRun에서 하나의 commit이 실패해도 나머지 승인은 계속 만료한 후 첫 실패를 throw한다.

## 오류와 event 계약

- Permission이 commit하는 event: `approval.requested`, `approval.resolved`, `approval.expired`. payload에는 `approvalId`, `toolCallId`, `toolName`, `fingerprint`, `status`, `preview`가 있으며 resolved에는 `decision`, expired에는 `reason`이 추가된다. storage가 terminal/recovery transaction에서 발행하는 expiry payload는 해당 모듈의 계약을 따른다.
- Error code: `APPROVAL_CANCELLED`, `APPROVAL_EXPIRED`, `APPROVAL_FINGERPRINT_MISMATCH`, `APPROVAL_CONFLICT`, `APPROVAL_REQUEST_CONFLICT`, `APPROVAL_STALE`, `APPROVAL_RUN_INACTIVE`, `INVALID_APPROVAL_DECISION`. 저장소의 not-found·저장 오류는 전달한다.
- 입력·저장 변경·반환값은 복사하며, 구조적으로 추가된 `id/status/createdAt/resolvedAt` input 필드가 manager의 생성 ID·상태·timestamp를 덮어쓰지 못하게 고정 request 필드만 사용한다. caller의 abort reason은 오류 메시지에 복사하지 않는다.

## 실제 검증

Node `v26.9.0`에서 다음 검증을 직접 실행했다. 외부 공급자 호출·API key·파일/명령 실행 효과를 사용하지 않았다.

```sh
npx --no-install tsx --test packages/engine/src/permission/approval.test.ts
```

**55 tests passed, 0 failed, 0 skipped.** 테스트 수는 `node:test`의 하위 case를 포함한다. 승인 요청의 pending/event 동시 기록, allow/deny·decision 재전송, fingerprint/conflict/stale 거절, request dedup, abort·cancelRun·orphan recovery, requested/resolved/expired 알림 중 재진입 경합, 저장 실패·재시도, Run 상태 변경, 입력·반환값 mutation을 검증했다. permission이 `CommitChange.run`을 쓰지 않는 것도 확인했다.

```sh
npx --no-install tsc --ignoreConfig --noEmit --module NodeNext --moduleResolution NodeNext --target ES2023 --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/engine/src/permission/index.ts packages/engine/src/permission/approval.test.ts
```

**소스와 테스트의 strict 타입 검사 통과.** 설치된 TypeScript는 개별 source 인자를 지정할 때 `--ignoreConfig`가 필요하다. monorepo build는 통합 담당자 범위이므로 실행하지 않았다.

## 제약과 통합 확인사항

초기 fake 단계에서는 실제 SQLite commit/restart를 검증하지 않았으며, 아래 추가 단계에서 file-backed DB와 SIGKILL 재개방까지 검증했다. engine facade·runner의 전체 승인·취소 흐름 및 Electron runtime의 전체 연결 검증은 통합 담당 범위다.

전체 startup pending 만료와 미완료 Run 복구는 `store.recoverInterrupted()`가 담당한다. ApprovalManager는 orphan pending을 발견할 때 안전하게 만료하며 constructor에서 전체 저장소를 재구성하거나 자동 승인하지 않는다. 하나의 engine/store owner와 synchronous `EngineStore.commit` 계약을 전제로 하며, 다중 manager/다중 프로세스 CAS와 독립 승인 TTL은 현재 port 범위에 없다.

승인이 fingerprint에 bound되어도 실제 filesystem/hash/cwd 재검증과 AbortSignal 확인, 효과의 단일 실행은 runner·tool이 담당한다. permission은 prepared tool을 실행하거나 effect rollback을 수행하지 않는다. 계약 변경 제안은 없으며 기존 `ApprovalPort`·`EngineStore`만 사용했다.

## 추가 단계 — 실제 SQLite 승인 lifecycle 검증

2026-10-04. 추가 병렬 작업 요청에 따라 fake 단위 테스트와 분리한 `packages/engine/src/permission/approval-integration.test.ts` 및 `packages/engine/src/permission/fixtures/approval-child.ts`를 추가했다. 앞선 단계에서 미검증이었던 실제 SQLite 영속 기록·재개방·process kill 경계를 이번 단계에서 검증했다. 다른 담당자의 storage·runner·facade 및 공유 설정은 수정하지 않았다.

공개 `ApprovalManager`·`ApprovalPort` API는 유지했다. permission의 승인 조회 경계에서 `APPROVAL_NOT_FOUND`만 동일 code의 고정 메시지로 정규화하여 caller가 보낸 없는 approval ID를 오류에 불필요하게 echo하지 않게 했다. 유효한 approval preview·journal payload와 실행용 출력은 변경하지 않았다. 나머지 저장 오류는 기존처럼 전달한다.

### 실제 검증과 결과

모든 새 통합 테스트는 임시 **file-backed SqliteStore**를 사용한다. 실제 workspace·session을 등록하고 `admit()`의 created Run을 running으로 전이하며, 실제 ToolCallRecord와 awaiting_approval 상태를 저장한다. raw SQLite connection이나 DB 우회 수정, 승인 재구성·자동 재승인은 사용하지 않았다.

```sh
npx --no-install tsx --test packages/engine/src/permission/approval-integration.test.ts
```

**16 tests passed, 0 failed, 0 cancelled, 0 skipped.** 다음 경계를 검증했다.

- 실제 `subscribe()`를 request 이전 cursor에 등록하고 requested event 소비 직후 handler에서 즉시 decide한다. handler는 pending row와 event가 이미 commit되었음을 snapshot에서 확인하며, resolved event와 afterSeq replay가 일치하는지 검증한다. SqliteStore의 구독 API는 AsyncIterable이므로 consumer 자체는 commit 이후 microtask에서 이어지며, 실제 API에 동기 callback을 새로 붙이지 않았다.
- allow·deny 상태와 resolvedAt이 DB 재개방 후 그대로 남는다. 새 manager의 동일 결정 재전송은 seq를 증가시키지 않으며, 반대 결정·다른 fingerprint·이미 결정된 tool 요청 재사용을 거절한다.
- abort→allow는 expired를 유지하고 allow→abort는 이미 commit된 allowed를 유지한다. 두 순서 모두 signal 확인을 하는 consumer의 효과 횟수는 0이고 DB 재개방에서도 먼저 저장된 결과를 유지한다.
- 다른 workspace/session/Run의 tool ID, 잘못된 tool 이름, 없는 tool ID는 approval commit 전체를 거절한다. event seq·approval rows가 증가하지 않으며, 같은 manager가 이후 올바른 요청을 접수할 수 있다. 다른 workspace/Run/tool의 실제 준비 fingerprint를 사용한 결정도 모두 거절한다.
- 합성 secret·newline·ESC·NUL 값이 들어 있는 preview를 그대로 저장·replay하되 fingerprint mismatch·request conflict·unknown approval ID·abort reason·expired 오류에는 그 값을 echo하지 않는다. 저장된 사용자 preview를 무작정 치환하거나 product stdout을 수정하지 않았다.
- terminal commit은 pending approval을 먼저 expired로 저장하고 `approval.expired`를 terminal event 바로 앞에 기록한다. 재개방 전 이미 만료가 durable이며, 잘못된 fingerprint의 늦은 결정도 memory waiter를 종료하고 API에는 mismatch 오류를 유지한다. 정확한 fingerprint의 allow·deny는 `APPROVAL_EXPIRED`로 거절한다. terminal 이후 일반 commit의 `RUN_TERMINAL` 거절 정책은 유지한다.
- 승인 actor가 먼저 commit하면 allowed 결정과 그 event가 보존되고, terminal actor가 먼저 commit하면 expired와 그 event가 보존된다. 종료된 Run을 확인하는 consumer는 효과를 만들지 않는다. terminal expiry 뒤 `cancelRun()`·abort는 기존 memory waiter를 종료하며 event를 추가하지 않는다. `recoverInterrupted()`의 남은 tool cleanup도 expiry나 terminal event를 중복 기록하지 않는다.
- 별도 실제 Node child가 ApprovalManager를 통해 pending을 durable commit하고 ready를 보낸다. SIGKILL 전에는 두 번째 DB owner가 `DB_LOCKED`로 거절된다. SIGKILL 후 실제 재개방→복구에서 Run·tool은 interrupted, approval은 expired이며 `tool.started/completed`·`approval.resolved` event와 효과 marker가 모두 없다. startup recovery를 먼저 수행한 경우와 orphan approval에 먼저 decide한 경우 모두 실행 권한을 얻지 못한다. request ID 재전송도 같은 interrupted Run을 반환하며 효과를 반복하지 않는다.
- crash fixture의 **positive control**은 실제 allow commit을 받은 경우에만 marker를 작성하고 tool·Run을 completed로 기록한다. marker writer가 실제로 동작함을 확인하여 crash 테스트의 marker 부재가 효과 구현 누락으로 통과하지 않게 했다.

source·fixture를 strict 옵션으로 **임시 디렉터리에만 emit**한 뒤 생성된 JavaScript 테스트를 `node --test`로 실행했다. compile은 `--module NodeNext --moduleResolution NodeNext --target ES2024 --strict --noUncheckedIndexedAccess --skipLibCheck --types node --rootDir packages/engine/src`를 사용했고, root의 build output·설정·lockfile은 변경하지 않았다. runtime dependency lookup만 기존 node_modules를 임시 디렉터리에 연결했다. 임시 출력은 `TemporaryDirectory`가 정리했다.

**최종 strict emit 성공, compiled tests 71/71 통과**: 기존 fake 회귀 55개와 최종 SQLite 통합 16개다. 전체 monorepo build/check와 Electron 검증은 root에게 남겼다. 이번 작업에서 실제 명령 도구나 외부 공급자·API key 호출은 하지 않았다.

독립 검토 후 positive control의 `approval.resolved` 개수를 정확히 1개로 확인하도록 보강하여 누락 event의 `findIndex=-1`이 순서 비교를 우연히 통과하지 못하게 했다. DB owner 잠금 검증의 예상 밖 성공 경로에서도 생성된 store를 반드시 닫도록 정리했다. 최종 source 통합 **16/16**, targeted strict 타입 검사, 기존 fake를 포함한 최종 compiled **71/71**이 모두 통과했다.

### 공유 수정 후 확정한 승인 불변식과 남은 범위

이전에 발견한 terminal/pending 공백은 storage 담당자의 수정으로 해소되었다. `SqliteStore.commit()`의 terminal transaction은 Run 상태 변경·해당 Run의 pending approval expiry·`approval.expired` events·terminal event를 원자적으로 commit한다. terminal event는 항상 expiry events 뒤에 기록되며 snapshot의 terminal cursor가 모든 승인 결과를 포함한다. terminal이 확정된 Run에 새 commit을 허용하는 예외는 추가하지 않았다.

새 불변식에 맞춰 permission도 보강했다. `cancelRun()`은 durable pending뿐 아니라 해당 Run의 live waiter가 있는 저장 기록을 함께 처리한다. storage가 먼저 expired로 바꾼 뒤 cleanup이 도착해도 promise·abort listener·registry가 남지 않으며, 선결정된 allowed/denied는 유지한다. `decide()`는 저장된 expired 상태를 발견하면 fingerprint가 틀린 늦은 delivery에서도 waiter를 먼저 정리하고, API의 `APPROVAL_FINGERPRINT_MISMATCH` 정책은 유지한다. 정확한 fingerprint의 늦은 결정은 `APPROVAL_EXPIRED`로 거절한다. permission은 전체 recovery나 DB 우회 수정, Run 상태 전이를 수행하지 않는다.

기존 facade commandId control fallback 제안도 root가 수정했다. 현재 source는 trim·length·byte 한도와 control 문자 거절을 통과한 data descriptor 값만 fallback correlation ID로 복사한다. 이 담당자는 facade를 수정하거나 그 전체 regression suite를 실행하지 않았으며, root의 새 regression·monorepo 검증이 그 범위를 담당한다.

permission은 저장된 approval 변화를 감지하는 독립 background subscriber를 만들지 않는다. terminal 또는 expiry actor가 먼저 commit한 뒤 live waiter 정리는 `decide()`·`cancelRun()`·AbortSignal을 통해 이루어진다. 정상 runner의 cancellation/cleanup이 이 lifecycle을 소유한다. 이 단계의 효과는 임시 marker뿐이며 실제 shell command·patch 및 Electron utility process의 승인 흐름을 대신하지 않는다. 그 전체 연결 검증은 root의 통합 테스트 범위다.
