# 엔진 지속 개선 검증 — 열다섯 번째 검토 지점

구현 커밋은 `ad787d6be7cfdedee973ac223aa5908783572f6c`다. macOS arm64 / Node26.9.0에서 G1-27의 필요한 도구 검색·선택과 정확한 문맥 예약을 구현·검증했다. 기본 eager 동작을 유지하는 host opt-in이며 goal은 활성 상태다. GUI를 실행하지 않았다.

## 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript build/typecheck | 통과 |
| 전체 headless engine, concurrency4 | 2,503개 중2,501 pass, 실패0·취소0·조건부2 skip; 60,077.3ms |
| fixture 코딩 평가 | 3/3 |
| runtime source / 독립 bundle | 각각38/38; 기존24개·새14개 |
| 독립 runtime 검토 source / bundle | 각각18/18 |
| Run 선택 helper source / bundle | 각각14/14 |
| actual engine/SQLite/approval/HTTP/child source / bundle | 각각15/15 |
| 네 담당 범위 scoped noEmit | 모두 통과 |
| 같은 source 실제 Codex child text | opt-in 상태1회 통과; root/PDF/외부 MCP 계정 요청0 |

새 테스트는61개다. 집중 검사를 전체 수에 더하지 않는다. 정확한 command/log/SHA·source167개 pin과 초기 오류는 [기계 판독 결과](engine-goal-verification.json)에 기록한다. 전체 manifest를 줄이거나 skip을 추가하지 않았다.

## 문맥 초과와 실제 개선

이전 `217f77f`의 authored source/private bundle4조건에서 core21개+정상 MCP schema40개(각8,269B)의 reservation344,678B가 default context262,144B를 넘겨 provider0/CONTEXT_LIMIT이었다. 기존 정적 profile로 core21+MCP1개를 노출한 대조군은 reservation18,521B/provider1/completed다. 이것은 안전한 문맥 제한과 기존 profile의 증거이며 새로운 보안 결함으로 표시하지 않는다.

G1-27 실제 임시 엔진15개 검증의 positive loop에서는 MCP40개를 등록해도 core21개를 유지하며 도구22→23→23, 예약10,584→18,968→18,968B, 논리 request12,287→21,368→21,601B였다. 합성 provider3회와 정확히 승인한 peer tools/call1회로 완료했다. 검색 결과에는 bounded metadata만 있고 schema·handler·승인을 포함하지 않는다. 두 fixture의 이름/설명도 다르므로 정적 대조군 대비 시간·토큰 절감률을 계산하지 않는다.

별도 runtime-only 계측에서 metadata catalogue/search의 schema clone은0, 선택1개의 materialize는1회/array8,346B, eager40개는40회/array333,801B였다. 이는 그 직접 runtime 연산의 관측이며 전체 엔진 allocation·token·latency·물리 I/O 개선으로 확대하지 않는다.

## 저장·권한·retry 경계

현재 composed scope·host allowlist·profile·mode·policy를 metadata 노출 전에 적용하고 registry/policy/token이 바뀌면 selection을 버린다. Count/UTF-8 schema 예산을 clone 전에 확인한다. 검색은 일반 state 도구이며 정상 tool 예산과 prepare/execute·configured approval을 거친다. ToolRecord completed와 native Part result가 저장된 뒤 다음 모델 경계에서만 schema를 추가한다.

동일 provider 응답의 hidden proposal은 이전 catalogue로 resolve하여 승인/dispatch0이다. Selected unknown MCP 도구는 실제 outer approval과 원래 exact owner/RPC/cleanup receipt를 유지한다. Timeout 후 durable uncertainty가 continuation·새 Run·queue를 막고 restart에서도 원래 증거를 보존한다. Search는 grant·등록되지 않은 handler·child 권한을 만들지 않는다.

동일 private catalogue로 reservation→context build→provider request를 고정하고 adapter에는 detached schema clone을 전달한다. Async context build 중 변경은 제한된 재계획 뒤 steer를 다시 확인한다. 동일 logical Turn의 overflow retry는 catalogue를 바꾸지 않으며 변경 시 TOOL_DISCOVERY_STALE로 재시도 전에 중단한다. 실제 첫 Attempt의 cleanup은 확인됐고 controlled host recovery hook에서 변경했다. Semantic summary를 호출했다는 주장은 아니다.

실제 child는 read_file/discover_tools 두 이름만 할당받아 parent MCP를 찾거나 호출하지 못했고 명시적 연결 상속 요청은 CHILD_TOOL_UNAVAILABLE이었다. Policy opt-in 상속과 tool authority 상속은 별개다. Exact retry/restart는 이전 검색·provider·tool을 replay하지 않는다. Whole snapshot은0이다. [전체 계약·한도](engine-tool-discovery.md), [공개 비교](research/2026-10-07-tool-catalogue-discovery.md)를 따른다.

## 최초 검사와 수정

첫 whole gate는2,500 pass/1fail/2skip이었다. 기존 WorkspaceObserver directory replacement 시험의 pending rejection에 Git setup await 뒤에 assertion이 붙어 unhandled rejection이 됐다. Test-only early catch로 original Promise를 보존하고 같은 error code·한 번 실패·worker cleanup assertion을 계속 요구한다. 생산 observer는 변경하지 않았다. 집중13개가 통과한 뒤 source를 동결해 최종 whole gate를 다시 실행했다.

Partial wiring의 callback 미정의8실패, 구현 전 opt-in fixture의 기존 eager CONTEXT_LIMIT, negotiated MCP _meta를 빼먹은 exact RPC assertion1실패와 gitRoot:null scoped TS fixture 오류를 구별해 보존했다. Overflow mismatch는 source 검토 가설로 발견해 actual RED 전에 고정했으며 재현한 결함으로 표시하지 않는다.

## 실제 모델 회귀와 보존

동일 source의 기존 로컬 Codex 인증으로 gpt-6.1-sol child text1회가 READY/natural confirmed cleanup으로 완료됐다. Child에 명시적으로 할당한 도구는0이며 opt-in reservation24B와 tools-array SHA를 실제 archive child event에서 확인했다. 실제 모델이 discovery나 MCP를 호출했다는 증거는 아니다.

Input266/output5·cached/reasoning0·billed=null이다. 논리 request1,746B/SHA `8fb319df17d9ed4fa66dc598a1ffc0112425c882188a8d58997a790d1091c1a5`이며 raw HTTP SHA가 아니다. Host-only PDF54B는 모델에 전송하지 않았다. Child storage→archive/validate→historical metadata→pause import·restored typed reexport 거절·임시경로 제거가 통과했다. Historical metadata10,456B/refs1/charged rows28/child1/raw mirror491,520B/9.7ms는 그 표본이고 I/O/latency 상한이 아니다.

[열네 번째 JSON](engine-goal-fourteenth-verification.json)은 `8faf0e9` 원본 bytes 그대로 보존했다. SHA는 `647bc661a228c5773a6cedddf2ddf5f6e5b309809c4dd74fc6945e0c1792401f`다. DB9/metrics6·기존 G1-25/26 receipt/frontier·ACK·원본 기록을 유지하며 migration은 없다.

## 다음 구현

현재 선택 집합은 union으로 누적한다. 별도 actual source/private bundle2조건에서 maxSelectedTools1이면 A 검색/실행 후 B 검색2회가 TOOL_DISCOVERY_LIMIT이고 강제 B는 TOOL_NOT_FOUND/실행0이다. 한도2 대조군은 A+B 노출과 B 실행1회다. 무효과 read counter를 사용한 기능 한계이며 보안 결함이나 원격 실행 불확실성으로 표시하지 않는다.

G1-28은 기본 추가 동작을 보존하면서 명시적인 selected working-set 교체/해제를 구현한다. 새 집합을 먼저 검증하고 결과 저장 뒤 다음 경계에만 반영하며 core/profile/policy/승인/현재 batch/overflow/cleanup을 보존한다. [조사](research/2026-10-07-tool-selection-capacity.md), [TODO](../../TODO.md), [목표](engine-improvement-goal.md)를 따른다. 원래 외부 OS/provider/CI4개와 GUI 제외는 유지한다.
