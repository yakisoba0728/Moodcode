# 역할별 리소스 권한과 명령 사전 검사

MC2-11의 역할 규칙·판단 기록·사전 검사 port를 기존 엔진의 prepare/approval/execute 흐름에 연결했다. GUI나 공급자 계정 호출이 필요하지 않으며, 설정을 생략한 호출은 기존 권한 흐름을 사용한다.

## 실제 연결 지점

`EngineOptions.roleResourcePolicy`, `resolveRoleResources`, `commandPreflight`가 `ScopedToolRuntime`으로 전달된다. Runner는 저장된 `AgentProfiles.forRun()` 결과를 검증하고 eager/discovery catalogue에 `{ id, revision }`을 결속한다. 모델이 도구 인자에 적은 역할 이름으로 profile을 바꾸지 않는다.

| API | 계약 |
|---|---|
| `RoleResourcePolicy({ revision, rules })` | immutable host 정책 snapshot. 역할·도구·효과·리소스 규칙과 ID를 복사해 고정 |
| `evaluate(input, signal?)` | workspace/root·역할 revision·준비 fingerprint·기존 판단·리소스를 결속한 bounded receipt |
| `assertCurrent(receipt, current, signal?)` | 같은 정책 instance가 발급한 receipt와 현재 scope·실제 경로·입력의 일치 검사 |
| `ScopedToolRuntime.bindProfile(catalogue, profile)` | 현재 handler capture를 유지하며 host profile 결속. 같은 capture/profile은 cached handle 반환 |
| `getPolicyDecisionReceipt(prepared)` | runtime-owned unchanged 요청에서 detached immutable 관측값 반환. 현재 권한을 재검증하거나 승인하지 않음 |
| `getPolicyDecisionFailure(error)` | runtime이 발급한 deny 오류의 WeakMap 관측값만 반환. 임의 producer error/details를 읽지 않음 |
| `engine.getPolicyDecisionReceipts(options)` | session/run/seq에 한정된 bounded native journal 조회. 과거 관측값은 실행 capability가 아님 |

준비 단계에서 receipt를 private Request에 보관하고, outer approval fingerprint에 profile/receipt hash를 포함한다. 원래 producer의 `PreparedTool` 객체·입력·fingerprint는 그대로 유지한다. 실행 직전에 scope·source·resource·analyzer를 재검증하고, 비동기 검사 후 catalogue와 inner/outer snapshot을 다시 확인한다.

## 권한 합성

deny가 allow와 ask보다 우선한다. Plan의 효과 제한, 기존 `ToolPolicy`의 ask, producer의 `requiresApproval`, registration의 exact approval을 role/preflight allow로 낮추지 않는다. 추가 정책이 ask이면 기존 scoped grant로 새 판단을 건너뛰지 않는다.

모든 실제 리소스가 역할의 allowance에 포함되어야 allow다. 알려지지 않은 효과·리소스, 결속되지 않은 profile은 ask다. host 리소스 선언 callback이 실패하면 실행 요청을 발급하지 않는다. 명시한 `all` selector도 unknown 리소스를 allowance로 바꾸지 않는다.

리소스 callback은 실행 가능한 원본 요청 대신 깊게 동결된 사본과 host identity·producer scope를 받는다. callback은 host 코드이며, 모델 인자나 MCP 설명문의 권한 주장을 승인 근거로 삼지 않아야 한다.

## 파일과 MCP identity

파일 selector는 POSIX 형식의 canonical workspace-relative path와 명시적인 descendants flag를 사용한다. `..`, 절대 경로, backslash, NTFS stream과 혼동되는 colon, 과도한 path depth를 거절한다. workspace root의 realpath와 device/inode를 확인하고, 파일의 실제 target 또는 아직 없는 파일의 가장 가까운 기존 parent를 고정한다.

symlink 밖의 경로와 dangling symlink는 거절한다. allow는 실제 target에 적용하고, deny/ask는 요청한 alias와 실제 target 모두에 적용한다. 따라서 `src/**` allowance를 이용해 symlink로 `private/**` 파일을 읽는 권한을 얻지 못한다. 내용 hash와 실제 open/write 직전 안전성은 기존 producer revalidation 계약이 계속 담당한다. 이 receipt는 파일 lock이나 OS sandbox를 제공하지 않는다.

MCP 리소스는 정확한 `serverId`, `connectionId`, `catalogueRevision`, `uri`로 식별한다. 이 값은 host가 확인한 연결과 resource catalogue에서 제공해야 한다. callback은 실제 prepared 요청이 사용하는 resource와 identity의 관계까지 확인해야 한다. 임의 tool arguments·description·readOnlyHint에서 접근 범위를 추론하지 않는다. URI를 로컬 파일 권한으로 해석하지 않는다. 연결·catalogue·URI가 바뀌면 준비부터 다시 진행한다.

## 명령 사전 검사

`CommandPreflightRegistry`는 host가 설치한 trusted analyzer만 등록한다. analyzer의 ID·revision·declared source SHA, registry generation, 정확한 command/canonical absolute cwd, workspace/session/run, producer fingerprint, policy revision, 실제 source revision을 결속한다.

| 단계 | API |
|---|---|
| 등록 | `register({ id, revision, sourceSha256, analyze })` |
| 준비 | `capture(binding, analyzerId, signal?)` |
| 검사 | `run(request, { signal, deadlineMs })` |
| 재검증 | `assertCurrent(receipt, current, signal?)` |
| 합성 | `decision(receipt, baseDecision, requiresApproval)` |

runtime 설정은 `registry`, `selectAnalyzer(observation)`, `resolveSourceRevision(observation)`, 선택적인 `deadlineMs`다. selector의 undefined는 host의 명시적 미적용이다. 적용하도록 선택한 analyzer에 source callback이 없거나 undefined이면 `COMMAND_PREFLIGHT_SOURCE_REQUIRED`로 거절한다. source callback은 현재 작업에 필요한 실제 source hash/generation을 제공하며, 미커밋 변경도 반영해야 한다. tool catalogue revision이나 Git HEAD만으로 대체하지 않는다. 이 모듈은 repository 전체를 자동으로 읽지 않는다.

명령은 producer가 정규화한 정확한 `prepared.input.command/cwd`를 사용한다. command를 다시 작성하거나 상대 cwd를 임의로 정규화해 승인된 입력과 다르게 실행하지 않는다. receipt에는 command SHA만 기록하고 raw command는 복제하지 않는다. analyzer 결과의 deny/ask finding은 aggregate allow보다 우선한다.

기본 deadline은 1초, 최대 5초이며 결과 8KiB·finding 32개·등록 analyzer 32개·실제로 미완료인 callback 8개로 제한한다. 실패·잘못된 결과·시간 초과는 ask다. 취소된 도구 준비는 실행 요청을 반환하지 않는다. 늦게 완료한 callback이 과거 timeout receipt를 allow로 바꾸지 않는다. 시간 초과/취소 후에도 아직 실행 중인 callback은 capacity를 계속 점유한다.

analyzer는 효과 없는 trusted host 검사로 구현해야 한다. AbortSignal/deadline은 협력적 취소이며 callback의 물리 종료, CPU 격리 또는 외부 효과 정리를 증명하지 않는다. JavaScript의 Promise/thenable 처리는 port 결과 validator 이전에 발생할 수 있다. validator는 자신이 받은 plain record/array의 accessor·proxy·hidden field·sparse array를 읽지 않고 거절하며, 이것이 임의 host 코드를 sandbox하는 기능은 아니다. 모든 receipt의 `osIsolation`은 false다.

## 영구 기록과 검증 범위

준비된 allow/ask 관측과 runtime-owned role/preflight deny 관측은 `tool.policy_decision`에 기록된다. native/legacy journal 기록은 같은 store transaction을 사용한다. 승인 wrapper 발급 전 deny의 fingerprint는 `producer-prepared-denied` 범위이며, 실제 승인 wrapper의 fingerprint와 구분된다. 저장한 관측값을 복구 과정의 승인이나 효과 재실행 허가로 재사용하지 않는다.

독립 모듈과 runtime/실제 Engine 테스트는 파일·symlink·root 교체, role/resource/scope/revision 변동, exact approval/grant, MCP identity 변경, source 변경, analyzer 등록 변경·실패·시간 초과·취소·capacity·동시 dispatch, immutable/proxy/accessor 입력을 확인한다. 실제 Engine은 eager/discovery의 allow/deny와 승인 없는 판단의 durable page 조회를 확인하고, 실제 승인된 로컬 명령 및 승인 후 미커밋 source 변경 시 효과 0을 검증한다.

전체 원격 MCP host 등록/재연결 운영 흐름, GUI 표현, Windows 실제 OS 동작, analyzer의 물리 실행 격리는 이 테스트의 완료 주장에 포함하지 않는다. MC2-11d의 실제 원격 host 경계와 기존 플랫폼 검증 항목은 별도로 추적한다.
