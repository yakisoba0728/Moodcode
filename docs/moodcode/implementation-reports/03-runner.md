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
