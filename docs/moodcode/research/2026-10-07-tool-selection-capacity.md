# 제한된 도구 선택 집합의 전환

2026-10-07. G1-28 구현 전 실제 기능 한계와 구현 후 관측이다. G1-27 `ad787d6`의 Run-local selected union이 count를 채운 뒤 다른 도구로 교체할 경로가 없는지 authored 임시 엔진·합성 provider·무효과 read counter로 확인했다. 보안 결함·불확실 외부 효과로 분류하지 않는다. 현재 계약은 [도구 검색](../engine-tool-discovery.md), 완료 검증은 [최신 보고서](../engine-goal-verification.md)를 따른다.

| 선택 한도 | A 검색·실행 뒤 B 검색 | B 실행 | 끝까지 광고한 noncore |
|---|---|---:|---|
| 1 | TOOL_DISCOVERY_LIMIT 두 번; 강제 B는 TOOL_NOT_FOUND | 0 | A |
| 2 | 정상 추가 | 1 | A+B |

각 private Run의 provider dispatch는4, wholeSnapshot0, workspace uncertainty=false였다. 항상 보일 core를 명시적으로 비운 private 두-tool 대조군이며 기본 core21 동작을 숨겨서 최적화한 production 사례로 표시하지 않는다. Source/private bundle 각각2/2와 scoped noEmit을 확인했다. Fixture SHA는 `aa964e8b431811338e01234521e7be8ebd1f096e06486dfc6c3d315164ffb6a9`다. Exact source graph·로그·관측은 [최신 JSON의 nextLocalCandidate](../engine-goal-verification.json)에 연결했다. Repository source 변경·계정·외부 효과·ACK는0이다.

## 독립 구현 범위

기본 add 동작을 유지하며 discover_tools에 explicit replace 또는 별도 bounded release 입력을 설계한다. 새 집합의 현재 허용 metadata·count/UTF-8 schema 합계를 먼저 검증하고 결과/native Part 저장 뒤 다음 safe model boundary에만 반영한다. Core/always-visible 도구는 유지하며 교체는 승인·handler 등록·child 권한을 부여하지 않는다.

한도1 A→B 교체·A hidden/B실행1, failed query/oversize rollback, same-batch 이전 catalogue, profile/policy·cancel/stale·overflow 고정 capture·MCP exact 승인/unknown cleanup·Run-local/restart를 검증해야 한다. Query가 no-match인 replace의 의미와 새 결과 metadata·one-use prepared identity를 명시한다. 자동 eviction이나 복구 때 선택 재실행을 추측해 추가하지 않는다.

## 공개 비교의 범위

Codex `0b863c69f50335acd92164aab971cb58d298c2fe`의 [immutable 후보](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/tools/src/tool_search.rs#L19)와 [query 결과](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/core/src/tools/handlers/tool_search.rs#L215) 경로는 후보와 결과 materialization을 분리한다. 읽은 범위에서 Moodcode 같은 Run union cap/release 계약은 확인하지 못했으므로 upstream이 이 전환을 해결한다고 주장하지 않는다.

## 구현 후 관측

`93bfeaa`에서 optional action add/replace를 자체 구현했다. No-match replace는 selected noncore를 비우고 현재 허용 core/always/discover를 유지한다. Default add의 생략 input/result는 호환을 유지한다. Action은 exact prepared identity·preview·fingerprint에 결합하고 count/UTF-8 새 집합 검사 뒤 결과/native Part 저장과 다음 모델 경계에서만 활성화한다.

Actual default core21·한도1 fixture의 MCP 광고는 []→A→A→B→B이며 합성 provider5회·exact outer 승인과 terminal peer RPC2회로 완료했다. 교체 뒤 강제 A는 TOOL_NOT_FOUND였다. 같은 batch replace B/A/B에서는 이전 A만 승인된 terminal RPC1이고 신규 B는 hidden/approval0이며 다음 경계 B만 노출된다.

Helper16/독립22/actual14 source와 private bundle·scoped noEmit, 기존 discovery85 source 회귀, 전체2,553 pass·실패0·조건부2 skip·fixture3/3이 통과했다. Native Part 저장 실패·cancel/policy 변경·count/UTF-8 실패·no-match clear·accepted timeout 격리·provider503 동일 catalogue retry·restart/exact retry·child 제한을 확인했다. Trusted pending helper의 commit-order count/bytes 검증은 regular model state tools의 병렬화를 의미하지 않는다.

구현 전 replace 입력 거절은 missing API 대조군이다. 작성 중 preview 누락 관측은 actual RED 전에 고쳤고 final production defect 재현으로 표시하지 않는다. 임시 helper/actual 로그 이름4개 충돌은 prior manifest bytes를 보존하고 소스 변경 없이 서로 다른 prefix에서 세 scoped gate를 재실행했다. 원로그를 재구성하지 않았다. 최종 source/log SHA와 구분은 [기계 판독 결과](../engine-goal-verification.json)에 있다. 실제 Codex 회귀는 도구0개인 child text1회이며 실제 모델 replace/MCP 호출·token/latency/I/O 절감을 주장하지 않는다.

OpenCode `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`의 [선택한 registry](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/tool/registry.ts#L106)는 permission-filtered 전체 definitions를 전개한다. 모델 작업 집합 slot과 같은 비교 대상이 아니다. 이번 제안은 실제 Moodcode 한도1 재현에 근거하며 원본 코드·설명·테스트를 복사하지 않는다.
