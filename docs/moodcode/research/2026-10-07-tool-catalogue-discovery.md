# 많은 도구의 스키마 비용과 discovery 구현 계획

2026-10-07. G1-27은 아직 구현되지 않았다. `217f77f`의 기존 eager catalogue와 정적 profile을 authored 임시 HTTP MCP·합성 provider로 비교하고, 독립 구현 범위를 정했다. 실제 계정·외부 network·MCP tools/call·ACK·wholeSnapshot은0이다.

## 실제 엔진 관측

| 구성 | 모델에 노출한 도구 | 문맥 예약 bytes | logical provider request bytes | local provider 호출 | 결과 |
|---|---:|---:|---:|---:|---|
| 기본 core | 21 | 10,158 | 11,861 | 1 | completed |
| core + MCP40 | 전송 전 실패 | 344,678 | null | 0 | CONTEXT_LIMIT |
| 기존 profile: read_file + MCP1 | 2 | 9,051 | 10,827 | 1 | completed |
| 기존 profile: core21 + MCP1 | 22 | 18,521 | 20,297 | 1 | completed |

MCP40개의 inputSchema는 각8,269B로 정상 등록됐다. 전체 runtime 도구는61개이며 schema/name/description JSON344,656B, messages/tools envelope 예약344,678B다. 기본 maxContextBytes262,144B를 넘겨 admission 뒤 `Context reservation leaves insufficient space for a serialized message array.`로 실패한다. 문맥 한도를 안전하게 적용한 결과이며 새로운 보안 결함으로 분류하지 않는다.

Source와 독립 bundle에서 네 조건이 동일했다. 마지막 대조군은 기본 도구21개를 모두 보존한다. 작은2개 profile은 core20개를 숨기는 별도 대조군이다. 성공한1turn도 초기 예약과 dispatch 전에 catalogue를 두 번 만들었다. Host capabilities 호출은 이 계측에서 제외했다. Serialized bytes의 관측이며 token·시간·물리 I/O/처리량 절감은 측정하지 않았다. 로그·fixture SHA·소스8개 pin은 [최신 JSON의 nextLocalCandidate](../engine-goal-verification.json)에 기록한다.

## 공개 소스 비교

Codex `0b863c69f50335acd92164aab971cb58d298c2fe`의 [tool search cache](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/core/src/tools/handlers/tool_search.rs#L60)는 deferred source의 identity와 dynamic 정보가 같은지 확인한 뒤 search handler를 재사용한다. [tool search entries](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/tools/src/tool_search.rs#L15)는 후보 이름을 schema materialization 없이 순회하고 선택한 결과만 loadable 형태로 전개한다. 그 provider-specific namespace/SDK protocol이나 원본 구현·설명·테스트를 Moodcode에 복사하지 않는다.

OpenCode `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`의 선택한 registry 경로는 허용된 canonical 도구 정의를 전개한다. 이 좁은 관찰을 전체 저장소에 tool discovery가 없다는 주장으로 확대하지 않는다. 기존 pi/Amp/Claude Code 비교의 profile·child 문맥 경계는 [위임 조사](2026-10-07-delegation.md)를 따른다.

## Moodcode에서 구현할 계약

기본 eager 동작은 유지하고 host가 명시적으로 bounded discovery를 켠다. 현재 scope·profile·host allowlist·policy를 통과한 이름/설명/schema SHA/bytes metadata만 검색한다. 검색 결과가 등록되지 않은 handler나 승인·child 권한을 만들지 않는다. 기본 core 도구의 보존과 configurable schema/count 한도는 별도다.

등록 시 canonical schema/descriptor bytes와 SHA를 계산한다. 전체 schema clone 전에 선택 count와 UTF-8 합계를 제한하고, bounded 결과에서 정확한 등록 이름을 선택한다. 검색/선택은 일반 도구 예산을 소비하며 모델에게 현재 결과가 다음 경계에서 노출된다는 사실을 표시한다. 필요한 schema만 다음 safe turn boundary에서 materialize한다.

같은 catalogue snapshot으로 reservation→context plan→provider request를 고정한다. Summary await/steer/registry 변화로 snapshot이 바뀌면 bounded 재계획하고 retry 중에는 노출을 바꾸지 않는다. 현재 capture token·policy version·MCP connection/catalogue 재검증과 outer approval fingerprint·receipt를 유지한다. Hidden forced call은 prepare/effect 전에 거절한다. 캐시는 불변 metadata/schema 데이터에 한정하고 prepared request나 실행 권한을 재사용하지 않는다.

필수 회귀는 eager 호환/core21 보존, many schemas에서 선택된 호출만 materialize, denied/profile names 비노출, metadata/결과/schema 한도, UTF-8 accounting, 외부 schema 변경·정책/MCP epoch 변화·hidden call, child 권한 축소, steer/overflow 중 fresh reservation, exact retry·cancel/cleanup uncertainty와 실제 코딩 loop다. 전체 gate·로컬 커밋으로 완료하기 전 실제 deferral이나 provider-native tool_search 지원을 표시하지 않는다.
