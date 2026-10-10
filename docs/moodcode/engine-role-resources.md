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

모든 실제 리소스가 역할의 allowance에 포함되어야 allow다. 알려지지 않은 효과·리소스, 결속되지 않은 profile은 ask다. host 리소스 선언 callback이 실패하면 실행 요청을 발급하지 않는다. 명시한 `all` selector도 unknown 리소스를 allowance로 바꾸지 않는다. deny·ask `all` selector는 unknown 리소스에도 적용된다.

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

## 로컬 HTTP MCP host 통합 검증 추가

`permission/mcp-role-resources-integration.test.ts`의 8개 테스트는 실제 loopback HTTP 서버, `McpClient`/`HttpMcpTransport`, `engine.connectMcp()`, model tool loop와 approval 명령을 사용한다. eager 호출과 `discover_tools`의 저장된 검색 결과가 다음 모델 경계에서 실제 MCP 도구를 활성화하는 호출을 검증한다. 등록된 도구의 `readOnlyHint`, 설명문, 모델 인자에 담긴 다른 server/connection/revision 주장은 권한으로 사용하지 않는다. 두 호출 모두 unknown 효과와 producer의 exact approval을 유지한다.

host resolver는 자신이 보관한 `connectMcp()` 결과의 scope·tool names·resource catalogue를 확인하고, 해당 `McpClient.id`, `connectionId`, `revision`과 실제 등록된 URI를 선언한다. 등록되지 않은 URI는 명시적인 host `all` allowance가 있어도 unknown/ask로 남는다. 이 fixture의 resource contract는 해당 서버의 `read_resource` 인자 URI 하나이며, 일반 MCP 도구의 효과 범위를 자동으로 알아내는 계약은 아니다.

정상 승인 호출은 실제 HTTP 요청의 SHA, 연결·catalogue revision, approval ID/fingerprint, native `mcp.execution.prepared`/`dispatch_intent`/`response_terminal`와 `engine.getMcpExecution()` 관측값을 확인한다. 역할 판단은 `engine.getPolicyDecisionReceipts()`의 observation-only 기록에 남으며, 설명문이나 모델 인자의 원문 marker를 포함하지 않는다. response 관측과 transport cleanup은 이 로컬 fixture 호출의 증거이며 외부 서버의 부작용 전체를 증명하지 않는다.

승인 대기 중 실제 client close, 같은 server ID의 새 연결, 실제 SSE `notifications/resources/list_changed`를 각각 발생시킨다. 이전 capture를 승인해도 대상 resource RPC는 0회이고 native MCP execution row도 발급되지 않는다. catalogue 변경을 발생시키는 fixture control RPC는 대상 resource 호출과 별도로 센다. 재연결 후 새 run은 새로운 fingerprint/승인을 요구하고 새 connection에만 전송된다.

기존 immutable policy fixture는 특정 도구에 한정한 명시적 `all` selector와 host의 정확한 resource tuple 선언을 결합한다. 추가 dynamic fixture는 실제 등록이 완료된 뒤 host port로 exact connection/catalogue/URI selector를 설치한다. 승인 대기 중 deny 정책을 설치하면 이전 승인 capture의 resource RPC는 0회이며, 새 run은 실제 role deny와 해당 generation을 기록한다. allow를 다시 설치한 run은 새 fingerprint/승인을 거쳐 실제 MCP 응답을 받는다. receipt 조회는 여러 bounded journal page를 순서대로 읽어 후속 run의 generation까지 검증한다. 외부 cloud MCP, stdio 전체 운영 조합, Windows 실제 OS와 MC2-11d 전체 완료를 주장하지 않는다.

## Host 역할 정책 교체

`RoleResourcePolicyRegistry(initialSnapshot?)`는 host가 공유하는 CAS holder다. 초기 snapshot을 생략하면 empty rules로 ask하며, 정책 없는 기본 엔진의 동작으로 바뀌지 않는다. `EngineOptions.roleResourcePolicyRegistry`는 기존 immutable `roleResourcePolicy`와 동시에 지정할 수 없다. parent/child 엔진은 같은 registry 객체를 사용한다. 모델에게 정책 교체 도구나 registry capability를 노출하지 않는다.

| API | 계약 |
|---|---|
| `registry.capture()` | 현재 generation과 실제 immutable policy instance를 담은 host-only opaque capture |
| `registry.replace(expectedRegistryRevision, snapshot)` | 현재 registry revision과 같은 경우에만 내부에서 새 policy instance를 생성하고 generation 증가 |
| `registry.assertCurrent(capture)` | 해당 registry가 발급한 동일한 현재 capture만 허용. shallow/JSON copy·다른 registry·이전 generation 거절 |
| `engine.replaceRoleResourcePolicy(expectedRegistryRevision, snapshot)` | 명시적으로 registry를 설정한 열린 엔진의 host port. registry가 없으면 `ROLE_POLICY_UNSUPPORTED` |

registry generation은 tool catalogue revision, 기존 `ToolPolicy.version`, policy snapshot의 revision과 별개다. 같은 snapshot revision/hash를 재설치해도 새 generation이며, stale CAS나 잘못된 snapshot은 현재 정책을 바꾸지 않는다. holder는 현재 capture 하나만 강하게 보관하고 과거 capture의 ownership은 WeakSet으로 확인한다. 별도 change listener 목록이나 전역 revision 계산을 만들지 않는다.

eager/discovery catalogue와 prepared 요청은 private capture에 결속한다. 교체 이후 기존 catalogue는 `TOOL_CATALOGUE_STALE`/`TOOL_DISCOVERY_STALE`가 되어 모델 경계에서 다시 capture하며, 이전 승인 결과로 도구를 실행하지 못한다. 비동기 producer prepare·preflight·물리 resource revalidation 이후에도 generation을 다시 확인한다. runtime outer fingerprint와 observation-only provenance에는 registry identity/generation을 포함하고 원래 producer 입력/capability는 보존한다. 기존 grant에는 role generation이 없으므로 dynamic registry runtime은 이를 승인 대체로 채택하지 않는다.

정책 교체는 앞으로의 dispatch 권한을 바꾼다. 이미 producer에 넘겨 실행을 시작한 작업의 효과를 취소하거나 원격 서버의 효과를 되돌리지 않는다. 일반 MCP tool arguments와 resource 접근의 의미 관계는 여전히 host가 선언해야 한다. 기존 instance-owned physical receipt 검사와 MCP producer의 정확한 prepared/revision 검사를 대체하지 않는다.

`permission/engine-role-registry-child.test.ts`는 실제 `EngineChildren` admission, Git worktree, 독립 child DB와 기본 `run_command` producer를 사용한다. live parent와 세 child가 같은 registry instance를 공유하는지 확인한다. 첫 child의 승인 대기 중 parent가 deny를 설치하면 old approval은 allowed로 저장되더라도 command는 실패하고 파일 효과는 0이다. 새 child는 새 generation의 role deny를 기록하며 승인이나 파일 효과를 만들지 않는다. allow 재설치 후 세 번째 child는 새 fingerprint/승인을 통해 실제 명령을 실행하고 자신의 worktree에만 파일을 쓴다. child 엔진이 닫힌 뒤 독립 DB에서 이전 allow 관측·새 deny·tool 결과를 다시 읽는다. 이 실제 명령 검증은 macOS source/dist에서 통과했으며 Windows는 실행하지 않았다.

`ScopedToolRuntime.assertPreparedCurrent(prepared, context)`는 실행을 시작하기 전 보관한 opaque 요청을 검사하는 비소비 host port다. runtime ownership·미사용 상태·inner/outer snapshot·정확한 context·catalogue/profile/policy와 현재 role/preflight를 확인하고, 비동기 host 관측 후 다시 확인한다. grant가 있으면 현재 ID/revision만 읽는다. producer prepare/execute/revalidate, 승인 요청, grant 소비나 replay를 호출하지 않으며 `request.used`를 설정하지 않는다. 통과한 요청은 이후 기존 `execute()`에서 같은 원본 capability로 다시 검증·실행해야 한다. 이 검사 자체는 승인을 제공하지 않는다. 독립 테스트는 반복 검사 후 실제 동일 handle 실행, clone/used/owner/mutation 및 policy/analyzer/source/grant 변경 시 producer invocation 0을 확인한다.
