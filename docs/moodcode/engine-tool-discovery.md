# 필요한 도구의 검색과 문맥 예약

G1-27의 host opt-in 계약이다. 기본 eager 도구 노출은 유지한다. 구현 커밋·전체 gate·실제 계정 회귀는 [최신 검증](engine-goal-verification.md), 최초 문맥 초과와 공개 소스 비교는 [조사](research/2026-10-07-tool-catalogue-discovery.md)를 따른다.

```ts
import { createEngine, DEFAULT_TOOL_DISCOVERY_POLICY } from '@moodcode/engine';

const engine = createEngine({
  dbPath: '/absolute/path/to/moodcode.sqlite',
  toolDiscoveryPolicy: DEFAULT_TOOL_DISCOVERY_POLICY,
});
```

`EngineOptions.toolDiscoveryPolicy`는 `kind: 'bounded-tool-discovery', version: 1`과 optional `alwaysVisibleToolNames`, `maxSelectedTools`, `maxSchemaBytes`를 받는다. DB를 열기 전에 plain bounded data로 검증·복사한다. `validateToolDiscoveryPolicy`, 정책·metadata types와 상수를 public export한다. Direct coordinator port는 검증된 정책을 받는 trusted host API다.

## 현재 범위의 도구만 찾기

기본 build scope에서는 기존 core21개와 `discover_tools`를 항상 광고한다. Host가 `tools`를 지정한 경우 그 도구 목록을 core로 사용한다. `alwaysVisibleToolNames`를 지정하면 그 정확한 목록과 검색 도구를 사용한다. 두 경우 모두 현재 scope composition·host allowlist·agent profile·Plan mode·tool policy를 먼저 적용한다. Denied 이름을 검색 결과에 포함하지 않으며 검색 도구가 profile 밖이면 강제 호출도 `TOOL_NOT_ALLOWED`다.

등록 때 bounded schema를 소유하고 canonical schema/definition SHA와 실제 JSON UTF-8 bytes를 캐시한다. 캐시는 불변 데이터이며 승인·prepared handle·effect authority를 담지 않는다. 후보 metadata에는 이름·설명·schema/definition SHA와 bytes만 있다. Metadata 검색은 full schema를 복제하지 않는다.

`discover_tools` 입력은 query와 optional limit이다. Query는 UTF-8 256B 이하·nonempty·control-free 문자열이고 trim/lowercase로 정규화한다. Limit은 기본4, 최대8이다. 이름 exact/prefix/contains, 설명 contains 순으로 검색하고 동률은 이름으로 정렬한다. 결과 설명은 UTF-8 prefix512B로 자르고 truncation을 표시한다. 전체 결과 JSON은32KiB 이하이며 schema·handler·grant를 반환하지 않는다.

## 실행과 선택의 경계

검색은 일반 `state` 도구다. 일반 tool-call·output·duration 예산, scoped prepare/execute, host 정책의 승인을 따른다. Active Run/session/workspace/Turn/Attempt/tool owner를 확인하며 prepared handle은 original identity와 한 번의 실행에 결합한다.

검색 결과는 pending selection이다. 일반 ToolRecord의 completed 결과와 native Part가 저장된 뒤에만 선택을 반영하고, schema는 다음 모델 경계에서 광고한다. 같은 provider 응답에 검색과 숨겨진 호출이 함께 있어도 현재 catalogue의 hidden 호출은 prepare·승인·원격 dispatch 전에 거절한다. 검색은 새로운 handler를 등록하거나 권한을 넓히지 않는다.

선택 집합은 Run-local이다. 다른 Run·exact request retry·restart로 선택이나 실행 권한을 복원하지 않는다. Registry/policy/token 변경은 기존 selection을 버리고 새 검색을 요구한다. 도구 연결이 바뀐 뒤 이전 승인·prepared request로 호출할 수 없다. 선택된 unknown MCP 도구도 기존 exact outer approval과 [dispatch/outcome receipt](engine-mcp-execution.md)를 요구한다.

기본 child는 검증된 정책을 상속하지만 assigned tool names를 확대하지 않는다. Child에 검색 도구를 할당해도 parent MCP 연결은 자동 상속되지 않는다. 실제 제한된 child의 검색 결과에서 parent MCP가 빠지고 명시적 연결 상속 요청은 `CHILD_TOOL_UNAVAILABLE`이다.

## 같은 정의를 예약하고 전송하기

Selected schema는 count와 JSON array UTF-8 byte 합계를 full clone 전에 검사한다. 같은 private catalogue를 schema reservation·context build·provider request에 사용한다. 모델 어댑터에는 detached deep clone을 전달해 요청 변조가 cached capture를 바꾸지 않는다.

Async context build에서 등록·정책이 바뀌면 제한된 재계획을 수행한다. 재계획 뒤 들어온 steer도 다음 dispatch cutoff 전에 다시 확인한다. Steer 또는 dispatch catalogue rebuild는 각각 최대16회, 한 context build의 catalogue retry도 최대16회다. 지속 변경은 typed error로 끝난다.

Overflow retry는 같은 logical Turn의 schemas/handler capture를 유지한다. Context recovery 중 registry가 바뀌면 `TOOL_DISCOVERY_STALE`로 재시도 전에 중단한다. 이전 schema로 전송한 요청을 새 handler에 연결하지 않는다. 기존 provider cleanup/summary ownership은 그대로 유지한다.

Opt-in `context.prepared`에는 `reservedToolBytes`, `toolCatalogueSha256`, `advertisedToolNames`, registryRevision/policyVersion을 추가한다. 예약은 `JSON.stringify({ messages: [], tools })`의 UTF-8 bytes에서2를 뺀 값이다. Catalogue SHA는 **실제 광고한 tools array JSON**의 SHA이며 registration의 canonical definition SHA 또는 raw HTTP SHA와 구별한다. 전체 schema를 기억용 대화문에 저장하지 않는다. DB9/metrics6과 기존 event schema를 유지한다.

## 한도와 실제 검증

| 대상 | 기본값 | 상한·의미 |
|---|---:|---|
| 선택한 noncore 도구 | 8 | 32; 명시적0 허용 |
| core + 검색 + 선택 도구 | 현재 허용 scope | 합계256 |
| 광고한 tools array JSON | 128KiB | 1MiB; messages/tools envelope 별도 |
| 후보 metadata | 현재 허용 scope | 4,096개, 합계512KiB |
| 등록 input schema / 설명 | — | 64KiB / UTF-8 8KiB |
| Query / 결과 수 | 최대256B / 기본4 | 결과 최대8 |
| 결과 설명 / 전체 결과 | 최대512B | 합계32KiB |

Metadata bytes가 candidate count보다 먼저 한도에 도달할 수 있다. Schema cap을 통과해도 전체 provider context cap은 별도로 적용한다. 현재 선택은 union으로 누적하므로 선택 count를 소진한 Run에서 다른 도구로 작업 집합을 바꾸려면 별도 기능이 필요하다. 자동 eviction·release/replace는 G1-27 완료 범위 밖이다.

실제 임시 엔진·HTTP MCP·합성 provider15개에서40개 큰 schema를 등록한 뒤 core21개를 보존하며 광고22→23→23, 예약10,584→18,968→18,968B, provider3회와 정확히 승인된 peer tools/call1회로 완료했다. Hidden same-batch 호출·profile/policy·일반 예산·approval 전 취소·timeout uncertainty·queue 차단·exact retry·registry 재계획·overflow stale·제한 child를 확인했다. Whole snapshot은0이다.

Runtime14개·독립18개·Run helper14개를 source/private bundle로 검증했다. Existing runtime24개도 집중38개 검사에 포함하며 전체 gate에 다시 더하지 않는다. Helper의 commit 콜백 검사는 상태 경계 검사이고 durable 저장은 실제 통합에서 확인한다. Overflow 시험은 실제 첫 Attempt/cleanup과 controlled host recovery callback을 사용하며 semantic summary 호출을 했다는 주장이 아니다.

Provider-native tool_search/namespace protocol, 외부 MCP 계정, token/시간/물리 I/O 절감은 검증하지 않았다. 기본 eager와 host capabilities의 full-schema 진단은 호환을 유지한다. 원본 엔진 코드는 복사하지 않았으며 GUI는 이번 범위에서 실행하지 않는다.
