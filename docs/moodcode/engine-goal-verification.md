# 엔진 지속 개선 검증 — 열두 번째 검토 지점

구현 커밋은 `8c07e280ba61d501912951f4847dca2594dc8915`다. macOS arm64 / Node 26.9.0에서 G1-24 exact archive의 historical child 문서 조회를 구현·검증했다. Goal은 활성 상태이며 GUI를 실행하지 않았다.

## 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript build/typecheck | 통과 |
| 전체 headless engine, concurrency 2 | 2,333개 중 2,331 pass, 실패 0, 취소 0, OS 조건 2 skip; 81,380.4ms |
| fixture 코딩 평가 | 3/3 |
| archive 집중 source / 독립 bundle | 각각 40/40; 기존 32개 포함 |
| 순수 진단 source / 독립 bundle | 각각 16/16 |
| 독립 actual engine/archive source / bundle | 각각 13/13 |
| 원본 live script 독립 offline E2E | local mock child1, 실제 계정/network/credential0, 통과 |
| 같은 source 실제 Codex child text | 1회 통과; root/PDF 원격 요청0 |

새 source tests는 37개이며 scoped와 전체 gate 수를 더하지 않는다. Log·SHA·source28개 pin·초기 실패·actual 측정은 [기계 판독 결과](engine-goal-verification.json)에 기록한다.

## 보관 자료의 명시적 조회

Standalone `inspectArchivedChildDocumentStorage`는 필수 directory/exact manifest SHA/root session/Run/task IDs를 검증한다. Root native/payload owner·정확한 task를 index 본문 전에 확인하고, 전체 archive validation 중 이미 검증한 selected child index를 같은 frame에서 재사용한다. 현재 엔진·원본 저장소·provider를 열거나 recovery/ACK/physical ownership을 부여하지 않는다.

Actual root/child/grandchild의 PDF metadata·원본/archive inode/stat/SHA 보존을 확인했다. Child11개 중1개 선택에서도 전체 proof11개와 index1회씩·frame1개를 유지했다. Legacy ancestor의 partial archive와 verified grandchild의 complete 선택, external null totals, 같은 크기 blob/manifest 변경·oversized foreign owner·proof budget 부족의 거절을 확인했다.

선택 cap8/32와 전체 child proof32를 구분한다. Metadata samples는 기본16/최대128/명시적0개이며 id/kind/MIME/bytes/SHA만 반환한다. Report32KiB/최소4KiB를 넘으면 samples부터 줄이고 상세 생략·partial을 남기며 알려진 counts/부분합을 유지한다. Whole archive 파일/logical DB 검사는 공유8MiB JSON proof 예산 밖이다. [조회 계약](engine-archive-child-document-inspection.md), [비교·runtime 경계](research/2026-10-07-archive-child-inspection.md)를 따른다.

## 독립 검토에서 수정한 회귀

사전 취소 signal의 공개 property shadow, 실제 async 진입 뒤 abort/property 변경의 두 fixture가 검증 보고서를 잘못 반환하는 실패를 재현했다. Strict 입력 검증만으로 두 번째 문제가 해결되지 않았고, observer 없는 private AbortSignal.any도 로컬 Node26.9에서 실패했다. Operation 동안 native derived observer를 활성화하고 finally에서 해제한 뒤 direct/composite actual 회귀가 통과했다.

진입 전 이미 가려진 composite ancestry의 과거 취소는 제공된 native getter 자체도 false로 관측되므로 공개 API로 재구성하지 않는다. 진입 이후 active 관측의 cancellation은 유지한다. 동기 OS/SQL을 강제로 중단하거나 event loop timer가 검증 중 반드시 실행된다고 주장하지 않는다.

공통 validator refactor로 기존 sync validateEngineArchive의 proof deadline 시작이 whole hash 전으로 이동한 회귀도 수정했다. Controlled performance.now를 quick_check 경계에서3000ms 전진시키는 red를 보존했고, public validation은 기존 lazy proof 시작, 새 inspector는 entry frame을 유지한다. 이 검사는 실제 I/O wall-time 측정이 아니다. Instance arrow instrumentation과 v1 empty audit의 초기 fixture 오류도 production 오류와 구분했다.

## 실제 계정과 보존

같은 커밋의 Codex `gpt-6.1-sol` child text 요청1회가 READY로 완료했다. Input266/output5 tokens, natural confirmed/iterator-next-done/natural-done cleanup을 확인했다. Logical request1746bytes, SHA `d1906ba3827c25edba61bdeb8d8362fb43bfc81a67f69d0df1242895c8a8a3da`이며 raw HTTP body digest나 billing 확정 값이 아니다.

Host-only opaque PDF54bytes의 exact metadata를 archive→새 historical API→pause import로 확인했다. Historical proof는 metadata10456bytes/refs1/charged rows28/child1/raw mirror454656bytes/elapsed11.3ms였고 physical rebinding·execution resume·ACK rebinding은 모두 false였다. Snapshot조회0, 추가 실제 요청0, child pause1·restored typed source reexport 거절·임시경로 제거가 통과했다. 실제 프로젝트 unresolved 기록에는 ACK하지 않았다.

[열한 번째 JSON](engine-goal-eleventh-verification.json)은 `d341644a76fd57b25dadcdf3251c8f83afe078f2`의 원본 bytes 그대로 보존했다. SHA는 `2a6b4d05a7e3864d485959af24e3b6f5a7f7a42eec593b149072f5c08f00596e`다. DB8/metrics6, 원래 source/historical 소유권과 reexport 한계, 이전 crash/anonymous mirror 경계도 유지한다.

## 다음 실제 결함

G1-25 readonly baseline의 local HTTP peer는 승인된 MCP 호출의 임시 effect를 실제로 기록하고 계속 실행했다. Timeout/disconnect/cancel 뒤 engine이 workspace를 차단하지 않고 새 Run을 허용한 안전성 검사3개가 모두 실패했다. 별도 native chronology도 restart에서 workspace block이 사라지는 gap을 확인했으며 해당 fixture 자체는 원격 효과를 주장하지 않는다. 이 새 회귀는 아직2331-pass 기존 full gate에 포함되지 않았다.

다음은 MCP tools/call별 durable dispatch/outcome proof와 실행/재시작/archive 차단이다. Transport 진입은 remote acceptance 증명이 아니며 provider/summary cleanup·ACK가 MCP 효과를 대신 확정하지 않는다. 자동 재전송·실제 프로젝트 ACK를 수행하지 않는다. [TODO](../../TODO.md)와 [지속 개선 목표](engine-improvement-goal.md)를 따른다. 외부 OS/provider/CI4개와 GUI 제외를 유지하며 goal은 활성 상태다.
