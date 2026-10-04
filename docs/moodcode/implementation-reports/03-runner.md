# 03 — Run coordinator 구현 보고서

작성일: 2026-10-04, Asia/Seoul.

## 구현 파일과 API

- `packages/engine/src/runner/index.ts`: `RunCoordinator implements CoordinatorPort`, `constructor(CoordinatorOptions)`, `submit`, `cancel`, `waitForRun`, `close`.
- `packages/engine/src/runner/coordinator.test.ts`: 계약 기반 fake store/provider/approval/tool로 실행 경계와 부작용 순서를 검증한다.
- `packages/engine/src/runner/lifecycle-integration.test.ts`: 실제 SQLite·context·승인·파일·command supervisor 연결과 재열기를 검증한다.

## 실제 동작

`store.admit`의 duplicate receipt를 그대로 반환하며 중복 요청에는 실행 owner와 provider 호출을 만들지 않는다. 새 durable 접수에는 owner 하나를 등록한 후 microtask에서 실행을 시작한다. Run 상태와 공개 event는 store commit으로만 변경한다. provider delta는 assistant projection과 `message.delta`를 함께 commit한다. provider throw/length/finish 누락 뒤에도 이미 commit한 부분 텍스트를 유지한다.

context builder는 첫 turn과 후속 tool turn 전에 저장된 snapshot으로 호출한다. `reservedBytes`에는 JSON wrapper와 tool catalog 크기를 전달해 이전 history가 메시지 외 비용까지 고려해 잘리게 한다. 후속 turn도 commit된 assistant/tool exchange에서 context를 다시 만들어 old history를 줄일 수 있게 한다. request의 model ID와 schema를 전달한다. 완성된 call만 처리하며 중복 call ID, finish와 call의 불일치, 잘못된 usage를 거절한다. storage tool ID는 UUID이고 provider call ID는 assistant/tool message에 유지하므로 서로 다른 Run의 동일 provider ID가 domain row를 덮어쓰지 않는다.

tool은 prepare → policy → approval → execute 순서로 실행한다. PreparedTool 객체 identity를 유지해 도구의 WeakMap bound request를 지원하며 승인 대기 중 공개 metadata가 변경되면 execute를 차단한다. plan mode는 `requiresApproval` 도구와 `apply_patch`/`run_command`를 차단한다. 승인 요청 전에 `run.awaiting_approval`를 commit하고 결정 후 abort되지 않았을 때 running으로 돌아간다. permission 모듈이 approval records를 소유한다. runner는 durable approval과 반환 decision의 session/run/tool/fingerprint/status를 다시 확인한다. 거절·입력 오류·일반 도구 실패는 구조화 tool 결과로 다음 turn에 전달한다. 같은 execute를 재시도하지 않는다.

turn/tool-count/duration/tool-timeout/context-byte/output-byte budget을 적용한다. 도구가 `data.timedOut=true`로 자신의 더 짧은 timeout을 보고해도 결과를 기록한 뒤 `TOOL_TIMEOUT`으로 Run을 마감하며 다음 provider turn을 실행하지 않는다. context 한도는 JSON message와 tool schemas를 합친 UTF-8 크기이고 output 한도는 Run 전체 assistant text와 저장된 tool content의 합이다. 초과 출력은 UTF-8 문자 경계에서 잘라 저장한 뒤 `OUTPUT_LIMIT`로 실패시킨다. 큰 원본 tool data를 journal로 복사하지 않고 content, 제한된 artifacts metadata와 cleanup 상태를 기록한다. usage는 turn별 event로 보존하며 미제공 값은 0으로 바꾸지 않는다.

cancel과 close는 provider/tool/approval에 abort를 전달한다. 중지된 작업의 promise가 정리된 뒤 terminal을 저장하며 늦은 provider/tool output은 저장하지 않는다. 비협조적인 비동기 작업은 일반적으로 1초 정리 grace 후 `CLEANUP_UNCERTAIN`, `run_command` execute는 process-group 정리와 checkpoint 수집을 위해 5초 grace를 적용한다. provider iterator `return()`도 1초 제한을 둔다. cleanupConfirmed=false/cleanupUncertain=true이면 취소·완료로 기록하지 않는다. fatal tool은 interrupted record로 마감하며 정리 불확실성은 현재 coordinator에서 해당 workspace를 격리해 새 Run을 `CLEANUP_PENDING`으로 거절한다. 이때 원래 request ID의 중복/충돌은 기존 store 계약을 유지한다.

`ToolContext.recordCheckpoint`는 tool execute와 그 abort cleanup이 살아 있는 동안 checkpoint row와 `workspace.changed`를 한 commit으로 기록한다. prepare·execute settlement 후·terminal 후의 checkpoint와 잘못된 identity를 거절한다. optional `executionLockPath`를 ToolContext에 전달해 command supervisor의 효과 lease를 지원한다. terminal state는 한 번만 기록하며 waitForRun은 durable terminal Run을 반환한다. close는 모든 owner를 취소하고 각각의 정리 완료를 기다린다.

## 실제 검증

2026-10-04 실행:

```sh
node_modules/.bin/tsx --test packages/engine/src/runner/coordinator.test.ts
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --target ES2023 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node packages/engine/src/runner/index.ts packages/engine/src/runner/coordinator.test.ts
```

최종 검증은 **43 tests, 43 pass, 0 fail**(약 1.14초), standalone strict TypeScript 검사 **exit 0**이었다. 중복 접수, commit된 stream/usage, sequential calls, 승인·거절·plan, checkpoint, turn/tools/duration/tool timeout/UTF-8/context 한도, provider 오류/length/finish 누락, cancel/late output/terminal once, cleanup 불확실성, approval identity, close, quarantine, PreparedTool identity/metadata drift를 포함한다. 마지막 회귀 검증은 `reservedBytes`의 정확한 catalog 비용과 history trim, tool turn 후 commit된 transcript 재구성, 도구 자체 timeout의 결과 commit → Run 실패와 다음 turn 미호출을 확인한다.

## 검증 범위와 한계

- 초기 43개 테스트는 fake port 기반이다. 아래 추가 단계에서 실제 SQLite·filesystem·approval·command supervisor 연결을 검증했다. 실제 API transport·공급자 계정·Electron 및 전체 monorepo 검증은 통합 담당 세션이 실행한다. API key는 사용하지 않았다.
- 비협조적인 JavaScript promise를 강제로 중단할 수는 없다. grace를 넘으면 실패와 workspace 격리를 남기며 late 기록을 차단한다. 임의 도구의 외부 효과를 되돌렸다고 표시하지 않는다.
- workspace 격리는 coordinator 메모리에서 유지된다. command crash/restart 정리에는 통합 담당자의 `executionLockPath`/supervisor lease가 필요하다. 일반 custom tool의 영구 효과 lease나 사용자 cleanup 확인 API는 현재 고정 port에 없다.
- 도구의 write 여부는 `requiresApproval`과 두 built-in effect tool 이름으로 판별한다. false를 반환하는 custom 도구의 부작용 여부를 runner가 자동 추론할 수는 없다.
- delta는 매 event commit하므로 공개 stream과 durable 기록이 일치하지만, 매우 작은 delta가 많은 공급자에는 commit coalescing 최적화가 남아 있다.
- 공급자의 tool ID는 같은 Run 전체에서 유일해야 한다. ProviderAdapter는 usage를 한 turn의 공급 값으로 정규화해야 하며 누적·증분 usage 정책을 runner가 추정하지 않는다.

## 계약 변경

담당 파일 밖의 schema/API는 변경하지 않았다. 통합 담당자가 추가한 optional executionLockPath와 ContextRequest.reservedBytes를 전달한다. 향후 영구 cleanup quarantine/확인·lease 상태를 노출하려면 별도 명시적 port가 필요하다.

## 추가 단계 — 실제 모듈 lifecycle 경합 검증

2026-10-04 추가 요청에 따라 `packages/engine/src/runner/lifecycle-integration.test.ts`를 작성했다. 실제 `SqliteStore`, `ApprovalManager`, `ScriptedProvider`, `buildContext`, workspace open, read/patch/command 도구, SQLite 실행 잠금과 command supervisor를 연결한다. 임시 Git workspace를 `git init`으로 생성하며 기존 checkout과 다른 담당 소스는 수정하지 않는다. 외부 모델 호출은 없다. `JournalStore`는 실제 SqliteStore를 상속해 원래 transaction이 반환한 뒤 정확한 commit 경합을 관찰하고, checkpoint 기록 실패 회귀에서는 `workspace.changed` commit 한 번만 의도적으로 거절한다.

새 테스트 12개(8개 top-level + 4개 경합 하위 사례)는 다음을 확인한다.

- 두 workspace가 동시에 승인을 기다려도 A 취소는 B 승인/AbortSignal을 바꾸지 않는다. 같은 workspace의 다른 세션은 busy이고, 동일 요청 재접수와 request conflict는 busy보다 먼저 처리된다. 취소된 A의 lease만 해제해 다른 A 세션의 실제 read가 실행되며 B는 계속 승인 대기한다. provider ID가 재사용돼도 durable tool UUID는 충돌하지 않는다.
- `approval.requested`가 commit되는 즉시 취소하거나, 실제 allow의 `approval.resolved` commit 직후 취소해도 patch 효과가 생기지 않는다. 승인 대기 상태가 먼저 durable하게 남고, 요청 직후 취소는 expired, 이미 commit한 allow는 allowed 기록을 유지한다.
- 한 provider turn의 완성 patch calls 두 개 중 첫 번째 `workspace.changed` commit 직후 취소하면 첫 효과와 checkpoint는 남고 두 번째의 tool row/approval/effect는 생성되지 않는다.
- 실제 명령의 duration 종료는 PID 부재(ESRCH), 실행 잠금 해제, 변경 checkpoint, 단일 failed terminal을 모두 확인한다. output 초과도 UTF-8 byte 한도, artifact 파일의 실제 크기, checkpoint → failed terminal 순서를 확인한다. patch/read 결과로 context가 넘치면 두 도구의 결과와 patch checkpoint는 유지하고 다음 model turn을 부르지 않는다.
- close는 실제 명령이 정리되기 전에는 반환하지 않고 다른 workspace의 미결 승인을 만료한다. 반환 뒤 두 Run의 cancelled 기록, 실제 PID 부재, command checkpoint 및 실행 잠금 해제를 확인한다.

이 과정에서 runner 결함을 실제 모듈로 재현하고 수정했다. 실제 patch가 파일을 변경한 뒤 checkpoint 저장에 실패하면 `PATCH_CHECKPOINT_FAILED`를 반환하고 active 실행 marker를 남긴다. 기존 runner는 이 오류를 일반 도구 오류로 처리해 다음 turn 뒤 completed를 기록했고, 취소와 경합하면 오류 없는 cancelled를 기록했다. `uncertain()`과 executeTool 오류 처리를 보강해 `PATCH_CHECKPOINT_FAILED`, `COMMAND_CLEANUP_UNCERTAIN`, `COMMAND_EFFECTS_LOCK_FAILED` 같은 효과/기록/lease 불확실성을 `CLEANUP_UNCERTAIN`으로 정규화한다. 정상 실행과 abort 양쪽에서 Run을 failed로 마감하고 현재 workspace를 격리하며, 원래 cause code를 오류 메시지에 보존한다. 일반 `COMMAND_EFFECTS_BUSY`는 다른 실행의 잠금 경합이므로 이 목록에 포함하지 않았다.

수정 전 회귀 테스트는 각각 completed/cancelled로 실패했고, 수정 뒤 checkpoint 0개·실제 파일 효과 존재·active marker 유지·새 Run `CLEANUP_PENDING`·기존 receipt duplicate·terminal 1개를 확인하며 통과했다. 고정 port/public API는 변경하지 않았다.

실제 검증 명령과 결과:

```sh
node_modules/.bin/tsx --test packages/engine/src/runner/lifecycle-integration.test.ts packages/engine/src/runner/coordinator.test.ts
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --target ES2024 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node packages/engine/src/runner/index.ts packages/engine/src/runner/lifecycle-integration.test.ts packages/engine/src/runner/coordinator.test.ts
node --test packages/engine/dist/runner/lifecycle-integration.test.js packages/engine/dist/runner/coordinator.test.js
```

source **55 tests / 55 pass / 0 fail**(약 2.24초), compiled **55 tests / 55 pass / 0 fail**(약 2.73초), strict TypeScript **exit 0**. 새 lifecycle 사례만으로는 12개이며 기존 단위 43개와 함께 변경 영향만 검증했다. compiled 확인은 설치된 esbuild로 소유한 runner index와 새 test만 ESM/node24로 변환해 기존 통합 담당의 compiled sibling modules에 연결했다. 전체 build/package 설정은 변경하지 않았다.

추가 한계/제안: 현재 `executionLockPath`는 DB 전체의 effect marker 하나이므로 다른 workspace의 승인·provider·read는 동시에 진행되지만 두 write/command 효과가 모두 동시에 성공한다고 보장하지 않는다. 이 검증은 owner와 승인 취소의 격리를 확인한다. workspace별 effects 병렬화를 원하면 facade의 startup recovery와 함께 workspace별 durable lock catalog/lease를 설계해야 하며 runner만 경로를 바꾸면 crash guard를 우회하므로 변경하지 않았다. 정리 불확실성이 발생한 effect marker의 수동 reconciliation/API와 재시작 facade 회귀는 통합 담당의 추가 범위다. Windows command 사례는 POSIX process-group 계약 때문에 skip이고, 이번 macOS 실행에서는 skip 없이 통과했다.

## 추가 단계 — provider native replay 보존

2026-10-04 통합 담당자가 추가한 `ProviderReplay`, `Message.providerReplay`, `ProviderMessage.providerReplay`, `finish.replayItems` 계약을 runner에 연결했다. 담당 파일 밖의 contracts/ports/context/provider는 수정하지 않았다.

정상 finish의 replayItems를 수신하는 시점에 검증하고 deepcopy해 provider iterator가 원본을 나중에 변경해도 영향을 주지 않는다. 이 값은 turn 내부에서만 보관하고 iterator가 정상 종료했으며 finish reason과 complete call이 일치할 때만 assistant의 `providerReplay = {providerId: provider.id, items}`에 넣어 `message.completed` projection과 함께 commit한다. text.delta projection과 모든 journal payload에는 opaque output을 넣지 않는다. length, unsupported/incomplete reason, finish 뒤 provider error/content, finish 누락, finish 뒤 iterator 종료 전 취소에서는 replay와 complete tool effects를 기록/실행하지 않는다.

검증은 descriptor 기반으로 getter/toJSON을 실행하지 않으며 Node의 `types.isProxy`로 proxy trap을 부르기 전에 거절한다. 배열과 plain Object/null-prototype JSON object만 허용하며 함수·accessor·cycle·undefined·nonfinite number·bigint·symbol·nonenumerable field·class/Date·잘못된 item shape·과도한 깊이를 거절한다. 저장된 providerReplay wrapper를 포함해 객체 깊이를 최대 64로 제한하고 provider ID에도 context 계약의 byte/control-character 조건을 적용한다. JSON escape와 UTF-8 byte를 항목마다 계산해 전체 replay envelope를 `maxContextBytes` 이하로 제한한다. malformed payload에는 값 없는 고정 `INVALID_PROVIDER_REPLAY`, 크기 초과에는 고정 `CONTEXT_LIMIT` 오류를 사용한다.

새 fake 회귀는 정상 tool turn의 deepcopy/바인딩/다음 context 전달, 잘못된 metadata 19종과 getter/proxy 호출 0회, oversized replay, 미완료/실패 turn 5종, runtime incomplete reason, 정상 finish 뒤 iterator 종료 전 취소 및 replayItems getter를 확인한다. 실제 SQLite 회귀는 completed assistant projection과 metadata의 같은 commit, 실제 context를 거친 다음 turn 전달, snapshot 변경의 원본 격리, DB close/reopen 후 재생 및 후속 Run 보존을 확인한다. oversized replay에서 commit된 부분 text만 남고 SQLite tool/approval/checkpoint/effect가 모두 없는 것도 확인했다.

최신 검증:

```sh
node_modules/.bin/tsx --test packages/engine/src/runner/coordinator.test.ts packages/engine/src/runner/lifecycle-integration.test.ts
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --target ES2024 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node packages/engine/src/runner/index.ts packages/engine/src/runner/coordinator.test.ts packages/engine/src/runner/lifecycle-integration.test.ts
node --test packages/engine/dist/runner/coordinator.test.js packages/engine/dist/runner/lifecycle-integration.test.js
```

source **88 tests / 88 pass / 0 fail**(약 1.59초), compiled **88 tests / 88 pass / 0 fail**(약 1.52초), strict TypeScript **exit 0**. 현재 74개 fake/unit + 14개 실제 모듈 사례다. compiled 확인에서는 소유한 runner index와 두 test만 기존 esbuild로 변환했다. 실제 provider API/계정 호출과 vendor response 의미 해석·native wire mapping은 provider 담당 범위이며 여기서는 opaque JSON과 정상 종료/기록/도구 경계만 검증했다. 전체 monorepo·Electron 검증은 통합 담당이 수행한다.

## 추가 단계 — GUI 복원용 workspace maintenance lease

2026-10-04 runner의 공개 메서드를 다음 형태로 확정했다. ports/facade/public index/contracts/config는 변경하지 않았다.

```ts
withWorkspaceLease<T>(
  workspaceId: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T>

quarantineWorkspace(workspaceId: string): void
```

메서드를 호출하면 첫 await 전에 workspace 존재를 확인하고 모든 세션의 실제 store snapshot에서 nonterminal Run을 검사한다. 다른 coordinator나 직접 store admission으로 생성되어 local owner가 없는 persisted Run도 `WORKSPACE_BUSY`로 거절한다. 같은 workspace의 다른 maintenance도 `WORKSPACE_BUSY`, cleanup 격리는 `CLEANUP_PENDING`, 닫히는 coordinator는 `ENGINE_CLOSED`로 거절하며 callback을 실행하지 않는다. 검사가 끝난 즉시 메모리에 예약하고 callback은 다음 microtask의 abort 검사 후 시작하므로 호출 직후의 submit 경합에서도 새 Run이 생성되지 않는다.

예약 중 새 same-workspace submit은 `WORKSPACE_BUSY`이고 다른 workspace는 기존 admission을 계속 사용한다. 기존 session/requestId는 먼저 `store.admit`으로 돌려보내 duplicate receipt와 `REQUEST_ID_CONFLICT` 판정을 유지한다. Run cancel은 기존 owner의 abort/approval 경로를 유지하며 maintenance signal과 섞지 않는다. 정상 반환과 안전한 throw는 callback settlement 후 finally에서 예약을 해제한다.

`close()`는 새 admission을 막고 진행 중 lease에 `ENGINE_CLOSED` abort reason을 동기 전달한 뒤 operation의 실제 settlement를 기다린다. 시작 전 abort면 callback 자체를 건너뛴다. maintenance에는 Run의 1초 cleanup grace를 적용하지 않으므로 복원 서비스의 파일 handle close, 변경 관측 및 effect-lock 해제가 끝나기 전에 close 성공을 알리지 않는다. 기존 owner 취소/정리도 함께 기다린다. abort listener가 close를 재호출할 때 같은 promise를 받도록 closePromise를 abort dispatch 전에 저장했다.

실제 restore service가 반환하는 `effectsUncertain=true` 또는 `executionBlocked=true`, 기존 cleanup flag 및 unsafe effect error는 `CLEANUP_UNCERTAIN`으로 정규화하고 workspace를 격리한다. 진행 중 lease의 정리가 불확실하면 lease 호출과 close 양쪽이 실패한다. 반면 관측 완료된 부분 복원/취소 결과는 `failed[].mayHaveChanged`만으로 격리하지 않고 원래 T와 observations를 보존한다. 안전한 `CANCELLED`/stale preview/일반 오류는 caller에게 그대로 전달하며 close는 callback 정리가 끝난 뒤 정상 종료한다. generic T의 cyclic data/details도 처리할 수 있도록 uncertainty 검사를 visited set과 반복 stack으로 변경해 stack overflow 및 sibling flag 누락을 막았다.

호출자는 effect/관측/cleanup 전체를 operation promise에 포함하고 전달받은 signal을 서비스로 넘겨야 한다. operation 안에서 자기 자신의 `runner.close()`를 await하거나 background effect를 분리하면 이 계약을 충족하지 못한다. 비협조적인 operation이 settle하지 않으면 close도 기다린다. 예약과 quarantine은 coordinator별 메모리이며 현재 facade의 단일 coordinator 경계를 보호한다. 동일 store에 여러 coordinator를 만들어 다른 인스턴스로 submit하거나 직접 store.admit을 호출하는 것을 전역으로 막는 durable maintenance lock은 아니다. 복원 효과의 crash guard는 실제 restore service의 기존 executionLockPath 잠금이 담당한다. 기존 Run의 fulfilled failed terminal을 close rejection으로 바꾸는 정책은 이 변경에 포함하지 않았다.

후속 요청으로 `quarantineWorkspace`를 추가했다. 실제 `getWorkspace`로 identity를 먼저 검증한 뒤 현재 coordinator의 unsafe set에 넣으며 반복 호출은 idempotent다. startup의 restore journal pending recovery나 효과 이후 metadata 기록 실패를 통합 담당자가 확인하면 명시적으로 호출할 수 있다. 효과를 재실행하거나 기존 Run/기록을 변경하지 않고 새로운 submit과 maintenance를 `CLEANUP_PENDING`으로 차단한다. 원래 receipt의 duplicate/conflict와 store history 읽기는 계속 가능하다. 안전한 restore result에 metadata 기록 오류가 추가돼도 T를 변형하지 않으므로 caller는 복원 관측값과 기록 실패를 함께 반환하면서 workspace를 격리할 수 있다. runner가 review journal을 열거나 닫지는 않는다. root는 lease를 포함한 runner.close settlement 후 journal을 닫아야 한다.

검증 파일은 기존 coordinator 단위 테스트, lifecycle integration, 새 `maintenance-integration.test.ts`다. 단위 106개는 sync 예약, persisted active 검사, close 전 callback skip, 1초가 지나도 실제 정리를 기다리는 close, 재진입 promise identity, 안전한 throw/반환 보존, unsafe flag/error, cyclic generic 결과 및 명시적 quarantine의 identity/idempotence/history 계약을 확인한다.

실제 모듈 추가 13개는 다음 경계를 검증한다. 기존 lifecycle 14개도 모두 함께 통과했다.

- 실제 승인 patch가 만든 checkpoint를 readonly preview 후 복원한다. 예약 중 새 submit을 거절하고 duplicate/conflict를 보존하며 다른 workspace의 실제 승인 대기 Run cancel은 maintenance signal을 바꾸지 않는다. 복원된 파일·관측 hash·effect lock 해제·후속 read Run 접수를 확인한다.
- 별도 세션의 local owner 없는 created/running/awaiting_approval/cancelling persisted Run 모두 maintenance callback 시작 전에 busy다. 실제 restore의 writable file guard 안에서 늦게 들어온 submit과 경쟁 maintenance도 차단된다.
- 실제 파일 변경 후 readonly accounting open을 gate해 close abort, 파일 관측, execution lock 해제, callback finally 정리를 차례로 확인한다. 안전한 cancelled RestoreResult를 그대로 반환하며 finally gate가 풀리기 전 close가 끝나지 않는다.
- stale preview는 사용자 외부 변경을 보존하고 안전하게 lease를 해제한다. 실제 post-effect observation open에 한정한 EACCES fault injection은 unobserved result와 durable active marker를 유지하고 workspace를 격리한다. persisted uncertain effect marker와 close 중 observation failure도 caller/close의 `CLEANUP_UNCERTAIN`을 확인한다.
- 별도 SQLite metadata-table의 완료 UPDATE를 두 번째 connection의 `BEGIN EXCLUSIVE`로 막아 native errcode 5 (`SQLITE_BUSY`)를 실제 발생시킨다. callback이 `quarantineWorkspace`를 호출한 뒤 원래 복원 결과와 `recordMetadataError` 객체 identity를 그대로 반환한다. filesystem/observations/effect-lock cleanup은 안전하게 완료되지만 새 실행/lease는 차단되고, 기존 receipts·history·getReviewDiff·다른 workspace 실행은 유지된다. 완료 metadata row는 pending 그대로다.

마지막 사례는 이름 그대로 별도 실제 SQLite metadata 테이블 fixture다. 작성 시점에 통합 담당자의 `review/audit.ts`가 아직 없었으므로 `ReviewJournal` 구현 자체를 연결했다고 주장하지 않는다. production audit finish/recoverPending 및 GUI wrapper/journal close 순서는 통합 담당 소유 범위이며, runner API와 callback 결과 보존·명시적 quarantine 경계까지 검증했다.

최종 검증 명령:

```sh
node_modules/.bin/tsx --test packages/engine/src/runner/coordinator.test.ts packages/engine/src/runner/lifecycle-integration.test.ts packages/engine/src/runner/maintenance-integration.test.ts
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --target ES2024 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node packages/engine/src/runner/index.ts packages/engine/src/runner/coordinator.test.ts packages/engine/src/runner/lifecycle-integration.test.ts packages/engine/src/runner/maintenance-integration.test.ts
node --test packages/engine/dist/runner/coordinator.test.js packages/engine/dist/runner/lifecycle-integration.test.js packages/engine/dist/runner/maintenance-integration.test.js
```

source **133 tests / 133 pass / 0 fail**(약 2.30초), compiled **133 tests / 133 pass / 0 fail**(약 2.30초), strict TypeScript **exit 0**, skip/cancelled **0**. 현재 106개 fake/unit + 27개 실제 모듈 사례다. 설치된 esbuild로 소유한 runner index와 test 세 개만 ESM/node24 compiled 출력으로 변환했다. scoped diff whitespace 검사도 통과했다. 다른 담당 소스/config/ports/public API index는 수정하지 않았고 외부 모델 호출·의존성 설치·Git 변경 명령은 실행하지 않았다.

## 후속 단계 — GUI facade·validation 통합

통합 담당자의 후속 위임에 따라 이번 단계의 소유 범위는 `packages/engine/src/engine.ts`, 새 `gui-facade.integration.test.ts`, `packages/contracts/src/validation.ts`, 새 `gui-validation.test.ts`다. root가 public index exports/renderer/build/E2E/실제 Codex probe를 소유하며 여기서는 해당 파일·공용 dependency·Git commit을 변경하지 않는다.

engine dispatch에 다음 여섯 명령을 연결했다.

| 명령 | payload | 결과 |
| --- | --- | --- |
| `file.list` | `{workspaceId,path?}` | `listWorkspaceFiles`의 bounded entries/경고 |
| `file.read` | `{workspaceId,path}` | `readWorkspaceFile`의 text/hash/경고 |
| `workspace.getStatus` | `{workspaceId}` | `getWorkspaceStatus`의 Git 상태 |
| `review.previewRestore` | `{runId,checkpointId}` | 실제 readonly `RestorePreview` |
| `review.restore` | `{runId,checkpointId,previewFingerprint}` | `RestoreCommandResult` |
| `review.history` | `{runId}` | `ReviewHistoryResult = {runId,operations}` |

`RestoreCommandResult`와 `ReviewHistoryResult`를 engine.ts에서 type으로 공개했다. 복원 명령 결과는 기존 RestoreResult 필드에 `operationId: commandId`, `duplicate: boolean`, optional `recordMetadataError: {code,message}`를 더한다. audit 완료 의미는 서비스가 반환했다는 뜻이다. partial/cancelled/uncertain 결과도 observations와 실제 flags를 보존해 `ok:true` domain 결과로 반환하고, 서비스가 throw한 경우에는 기록된 실패와 `ok:false` 오류를 반환한다. audit finish가 실패한 반환 결과에는 `REVIEW_RECORD_FAILED` metadata와 경고를 추가하고 workspace를 격리한다. UI는 이 필드를 성공과 구분해 표시할 수 있다. duplicate terminal reply는 audit의 bounded stored result를 재생한다.

preview/restore는 checkpoint가 요청 run의 실제 checkpoint 목록에 속하는지 먼저 검증한다. 새 restore는 terminal run만 허용하며 coordinator workspace lease와 canonical executionLockPath를 사용한다. readonly preview는 실행 중에도 activeRunIds/canRestore=false를 제공할 수 있다. workspace presentation과 review history는 효과 lease나 terminal Run commit을 만들지 않는다.

별도 ReviewJournal은 파일 DB의 `realpathSync(primaryDB) + '.review.sqlite'`, memory DB는 `artifactDir/review.sqlite`다. 지정하지 않은 memory artifactDir는 instance별 임시 경로를 사용해 독립 memory 엔진끼리 같은 owner lock을 잡지 않게 했다. Journal owner를 취득한 다음 primary active-run recovery를 실행한다. `recoverPending`의 started→interrupted 및 기존 interrupted operation이 primary run/session/workspace/checkpoint binding과 일치하는지 확인하고 모든 해당 workspace를 재격리한다. 생성 실패 시 journal과 primary store를 모두 닫는다. 기존 command supervisor의 startup effect-marker guard는 유지했다.

복원 중 audit.get와 commandId/binding 비교를 fresh preview·lease·quarantine보다 먼저 수행한다. 완료 기록은 효과를 재실행하지 않고 재생하며 다른 binding은 conflict, pending/interrupted는 no-replay 오류다. 동시 동일 요청은 첫 dispatch의 동기 in-flight map으로 같은 promise를 기다린다. 공개 journal API가 dispatch와 callback microtask 사이에 operation을 등록해도 callback의 두 번째 get/binding 검사로 이미 알려진 효과를 실행하지 않는다. 새 audit.start의 durable commit, 실제 복원, 성공/실패 audit.finish 및 기록 실패 처리는 모두 lease callback 안에 있어 close가 audit 저장을 앞지를 수 없다. `closePromise`를 coordinator abort 전에 저장하며 lease 정리 이후 ReviewJournal → primary store 순으로 닫는다.

validation은 기존 envelope/data-property 검사와 ID 한도를 재사용한다. 여섯 명령은 허용한 필드만 받고 malformed options/undefined/getter/비JSON payload를 거절한다. file.list는 omitted path와 명시적 빈 root를 구분하고 file.read는 경로가 필수다. 상대 경로는 4096 UTF-8 byte, exact Unicode, forward slash canonical segments만 허용하며 절대/Windows drive/backslash/traversal/빈 segment/control character/unpaired surrogate를 거절한다. 제외 경로와 symlink/filesystem 검사는 presentation helper가 수행한다. restore fingerprint는 정확한 64자리 lowercase SHA-256이고 preview에는 fingerprint/options를 받지 않는다.

최종 GUI facade 검증은 실제 Git workspace·SqliteStore·restore service·ReviewJournal을 연결한 7개 사례다. setup은 유효한 completed patch checkpoint를 실제 SQLite transaction으로 기록하며, 실제 승인 patch Run 자체는 앞선 runner lifecycle 검증과 root GUI E2E 범위다. 이번 facade 사례는 다음을 확인한다.

- file/list/read/status 및 preview/restore 결과, 동시 동일 dispatch의 in-flight coalescence, DB reopen 후 durable duplicate replay와 fingerprint binding conflict. 사용자 파일을 다시 변경해도 같은 commandId는 효과를 재실행하지 않는다. history 조회와 복원 뒤에도 terminal primary snapshot/event seq가 그대로다.
- 다른 Run의 checkpoint를 preview/restore로 지정하면 ownership error이고 active source Run은 restore를 거절한다. active readonly preview는 canRestore=false다.
- started operation이 재시작 후 interrupted가 되고, 두 번째 재시작에서도 workspace가 계속 격리된다. 동일 operation의 no-replay, 기존 Run duplicate/conflict와 readonly history/file 읽기, 다른 workspace 실행은 유지된다.
- 실제 ReviewJournal.finish의 transaction을 두 번째 SQLite connection의 `BEGIN EXCLUSIVE`로 막아 native `SQLITE_BUSY`를 발생시킨다. 효과·observations·effect lock cleanup은 완료되고 원래 결과와 `REVIEW_RECORD_FAILED`를 반환하지만, 완료 감사는 started로 남고 새 effects는 격리된다. 앞 단계의 대체 metadata-table fixture와 달리 이번에는 production ReviewJournal API를 직접 호출한다.
- stale preview 실패는 durable failed operation으로 남고 safe failure 후 새 Run을 허용한다. 실패 요청의 duplicate는 filesystem open 0회로 기록된 오류만 반환한다.
- dispatch admission과 lease microtask 사이 public journal start가 같은 ID를 등록하는 경합에서 filesystem 효과를 만들지 않고 pending을 반환한다.
- 실제 restore의 after-effect accounting open을 gate해 close와 synchronous close 재진입을 발생시킨다. 같은 close promise를 유지하고 accounting 중 journal/store가 열려 있으며, 관측과 cancelled completed audit를 저장한 다음 닫는다. reopen 후 audit 완료 결과와 기존 terminal snapshot 불변을 확인한다.

검증 명령:

```sh
node_modules/.bin/tsx --test packages/engine/src/engine.test.ts packages/engine/src/gui-facade.integration.test.ts packages/contracts/src/validation.test.ts packages/contracts/src/gui-validation.test.ts
node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --target ES2024 --module NodeNext --moduleResolution NodeNext --skipLibCheck --types node packages/engine/src/engine.ts packages/engine/src/engine.test.ts packages/engine/src/gui-facade.integration.test.ts packages/contracts/src/validation.ts packages/contracts/src/validation.test.ts packages/contracts/src/gui-validation.test.ts
```

source **39 tests / 39 pass / 0 fail**(약 1.85초), strict TypeScript **exit 0**, skip/cancelled **0**. validation 기존 11 + 신규 12, facade 기존 9 + 신규 7이다. 별도의 임시 실제 Git/SQLite 실행으로 복원·durable duplicate/conflict·history·presentation·terminal sequence도 확인했고 scoped diff whitespace 검사도 통과했다. runtime source facade가 package validation import를 읽게 하기 위해 소유한 contracts validation/test의 ignored JS 출력만 기존 esbuild로 갱신했다. 전체 build/compiled/E2E/package/commit은 root 소유 범위로 남겼다. GUI·public index exports·공용 dependency·review/workspace helper 구현은 수정하지 않았다. 외부 모델/API 호출이나 기존 checkout의 Git 변경 명령은 없다. 테스트용 임시 workspace에서만 git init을 사용했다.
