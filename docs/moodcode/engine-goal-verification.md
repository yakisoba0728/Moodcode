# 엔진 지속 개선 검증 — 열여섯 번째 검토 지점

구현 커밋은 `93bfeaa0f292c2251c6623a6130ab52b5746d59f`다. macOS arm64 / Node26.9.0에서 G1-28의 제한된 도구 선택 교체를 구현·검증했다. 사용자의 후속 요청에 따라 [1차 종료 범위](engine-phase-one-exit-criteria.md)는 G1-29 수정과 최종 검사·문서·커밋으로 고정한다. 현재 goal은 active이며 GUI를 실행하지 않았다.

## 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript build/typecheck | 통과 |
| 전체 headless engine, concurrency4 | 2,555개 중2,553 pass, 실패0·취소0·기존 OS 조건부2 skip; 60,720.6ms |
| fixture 코딩 평가 | 3/3 |
| Run 선택 helper source / private bundle | 각각16/16 |
| 독립 검토 source / private bundle | 각각22/22 |
| 실제 engine/SQLite/approval/HTTP/child source / bundle | 각각14/14 |
| 세 담당 범위 scoped noEmit | 모두 통과 |
| 기존 G1-27 source 회귀 | 85/85 |
| 같은 source 실제 Codex child text | opt-in 상태1회 통과; root/PDF/외부 MCP 계정 요청0 |

새 테스트는52개다. 집중 검사와 G1-29 구현 전6조건은 전체 수에 더하지 않는다. Source 170개 pin·command/log/SHA와 관측 범위는 [기계 판독 결과](engine-goal-verification.json)에 기록했다. Whole manifest와 기존 skip 조건을 유지했다.

## 선택 교체

`discover_tools`에 optional action add/replace를 추가했다. 생략 add의 normalized input/result는 유지한다. Replace는 현재 허용 query matches로 selected noncore를 교체하고 no-match면 selected만 비운다. 현재 허용 core/always/discover를 유지한다. Action을 original prepared input/preview/fingerprint에 결합하고 새 집합의 count/UTF-8 schema-array 한도를 clone 전에 검사한다.

Pending 결과는 ToolRecord completed와 native Part result가 저장된 뒤 다음 모델 경계에서 활성화한다. 두 저장을 단일 transaction으로 묶었다는 주장은 아니다. 저장 실패·취소·stale/discard는 교체를 활성화하지 않는다. 같은 batch는 이전 catalogue를 계속 사용한다. Trusted helper의 여러 pending 작업에서도 아직 저장되지 않은 clear/replace로 다른 add의 공간을 확보하지 못하며, commit/discard 순서에 따른 count/bytes를 보수적으로 검사한다. Model state-tool 병렬 실행을 추가하지 않았다.

Actual 한도1 A→B 전환은 기본 core21을 보존하고 MCP 광고 []→A→A→B→B, provider5회·exact outer approval/terminal peer RPC2회로 완료했다. 교체 후 강제 A는 TOOL_NOT_FOUND였다. 같은 batch replace B/A/B는 기존 A만 승인된 terminal RPC1, 신규 B는 hidden/approval0이며 다음 경계 B만 노출된다.

Default add capacity·no-match clear·UTF-8 schema/query/action 실패·native result 저장 실패·policy 변경·cancel·accepted B timeout의 원래 uncertainty/새 Run/queue 차단을 확인했다. Exact retry/restart는 원래8개 table을 그대로 보존하며 선택·검색·provider·도구를 replay하지 않는다. HTTP503 retry는 같은 B tools array와 SHA를 유지하고 새 Attempt/원래 confirmed cleanup 뒤 approved RPC1로 완료한다. 제한 child는 read_file/discover_tools만 받아 부모 A/B metadata·호출0이며 명시적 MCP 상속은 거절된다. [계약](engine-tool-discovery.md), [구현 전후 조사](research/2026-10-07-tool-selection-capacity.md)를 따른다.

## 초기 관측과 증거 정리

기존 G1-27의 replace 입력 거절/옛 add 한도는 missing API 대조군이며 final production defect가 아니다. 작성 중 action 없는 preview 관측은 actual RED 전에 수정했다. 최초와 최종 결과를 구별한다.

Helper/actual 담당자가 임시 로그4개 경로를 공유해 SHA가 덮였던 evidence collision을 확인했다. Prior manifest bytes를 보존하고 원로그는 재구성하지 않았다. Source 변경 없이 unique run-selection/selection-integration prefix에서 source·bundle·noEmit을 다시 실행했다. 독립 review prefix는 충돌하지 않았다. 최종 whole gate는 새52개를 모두 포함하며 실패0이다.

## 실제 모델과 이전 결과 보존

기존 로컬 Codex 인증의 gpt-6.1-sol child text1회가 natural confirmed cleanup으로 완료됐다. Child 할당 도구0개·opt-in reservation24B와 tools-array SHA를 확인했다. 실제 모델의 replacement/MCP 호출 검증으로 표시하지 않는다. Input266/output5·cached/reasoning0·billed=null이다. Logical request1,746B이며 raw HTTP SHA가 아니다.

Host-only PDF54B·historical metadata10,456B/refs1/rows28/child1/raw mirror491,520B/elapsed9.2ms와 archive/validate/import pause·restored typed reexport 거절·임시 fixture 제거가 통과했다. Whole snapshot0이다. 표본 elapsed/bytes를 성능·물리 I/O 상한으로 확대하지 않는다.

[열다섯 번째 JSON](engine-goal-fifteenth-verification.json)은 `4dbff6d` 원본 bytes 그대로 보존했다. SHA는 `1024aace754fdef8761fa6294e02637bffab3b10e173e79633810288ab105a72`다. DB9/metrics6·기존 MCP/native frontier·승인/ACK·원본 journal을 유지하며 migration은 없다.

## 1차 마지막 수정과 종료

G1-29의 actual source/private bundle6조건에서 eager의 초기 예약10,158B가 schema 증가 뒤에도 남고 실제 최신 예약은18,524B였다. Byte cap32,768의 stale plan28,146B가 실제36,512B로 실패/provider0이지만 최신 예약 보정과 자연 사전등록 대조군은21,629B/provider1/completed였다.

별도 known conservative window32,768/outputreserve1,024·config cap65,536에서는 stale 계획29,170이 통과하지만 actual envelope estimate37,536으로 provider1회가 전송됐다. 두 최신 대조군은22,653이었다. Actual tokenizer나 원격 모델 거절을 측정하지 않았다. [실제 조사](research/2026-10-07-eager-catalogue-reservation.md)를 따른다.

이 문제를 마지막 필수 수정으로 마무리한 뒤 동일 final source의 전체 typecheck/engine/eval3/live1·문서·로컬 커밋·clean tree가 모두 충족되면 goal을 complete로 바꾼다. 새 기능/G1-30 작업은 시작하지 않는다. 원래 외부 OS/provider/CI4개와 GUI는2차로 이월한다. 앱의 active objective 문구는 제공 도구로 편집할 수 없어 그대로지만 실제 작업과 완료 판단은 [수정 목표·종료 명세](engine-phase-one-exit-criteria.md)를 따른다.
