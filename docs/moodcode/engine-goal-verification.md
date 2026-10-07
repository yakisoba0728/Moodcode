# 엔진 지속 개선 검증 — 열세 번째 검토 지점

구현 커밋은 `4a15286ebdc59f0316b5c73eedb210376d31cbc9`다. macOS arm64 / Node26.9.0에서 G1-25 DB9 MCP 호출의 영속 dispatch/outcome과 불확실성 차단을 구현·검증했다. Goal은 활성 상태이며 GUI를 실행하지 않았다.

## 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript build/typecheck | 통과 |
| 전체 headless engine, concurrency4 | 2,404개 중2,402 pass, 실패0, 취소0, 조건부2 skip; 58,176.0ms |
| fixture 코딩 평가 | 3/3 |
| MCP transport 집중 source / 독립 bundle | 각각45/45 |
| storage/migration/기존 uncertainty 집중 source / bundle | 각각76/76 |
| actual engine/HTTP/SQLite/approval/SIGKILL 통합 source / bundle | 각각20/20 |
| 독립 ROOT 통합 읽기 전용 검토 | 추가 수정 결함0 |
| 같은 source 실제 Codex child text | 1회 통과; root/PDF/외부 MCP 계정 요청0 |

새 source tests는71개이며 집중 검사를 전체 수에 더하지 않는다. 정확한 command/log/SHA와 source50개 pin·초기 실패·실제 관측은 [기계 판독 결과](engine-goal-verification.json)에 기록한다.

## 도구 시작과 결과의 별도 증거

원래 readonly baseline의 actual approved HTTP peer는 임시 effect를 기록하고 계속 처리했다. timeout/disconnect/cancel 뒤 새 Run을 허용한3red를 새 typed receipt 회귀로 수정했다. 별도 native chronology가 실제 원격 acceptance/effect를 증명했다고 확대하지 않는다.

Receipt는 internal tool/session/workspace/Run/Turn/Attempt와 실제 허용된 outer 승인·immutable proposal/approval SHA, provider/model/context, server/connection UUID/catalogue/protocol/transport, 최종 논리 RPC ID/SHA/bytes에 결합한다. builtin HTTP fetch/stdio write 직전에 synchronous intent를 저장한다. 원문/headers/credential은 receipt에 넣지 않는다. custom transport는 exact builtin send hook 없이 conservative API-entry intent만 기록한다.

지원하는 bounded envelope/content 검사의 correlated terminal tool result/isError/JSON-RPC error와 request-local cleanup을 분리한다. resultType 없는 호환 응답도 허용한다. 응답은 서버의 최종 선언이며 rollback/외부 background activity 종료 보장은 아니다. post-intent timeout/disconnect/cancel·invalid/nonterminal response 또는 미확인 로컬 정리는 모델 continuation·새 Run·queue promotion을 차단한다. queue 입력은 pending으로 보존한다. 원래 provider Attempt/cleanup/usage와 text/reasoning/proposal/승인/입력을 유지한다.

첫 terminal 관측은 불변이며 late reply·provider/summary ACK가 차단을 해제하지 않는다. startup은 prepared→not-dispatched, intent→uncertain으로 정산하고 이미 uncertain receipt의 별도 blocker/아직 열린 Turn도 유지한다. native/v1 audit rollback, receipt workspace/실제 Run workspace의 indexed metadata routes, archive/recovery logical hash·import pause와 exact retry 재전송0을 확인했다. [계약](engine-mcp-execution.md), [공개 비교·실제 증거](research/2026-10-07-mcp-effect-outcomes.md)를 따른다.

## 검토에서 발견한 추가 회귀

Actual committed-intent 뒤 callback throw는 HTTP0·durable intent/block true인데 모델2turn/Runcompleted로 이어졌다. 전송 전 기록 실패를 미전송 정산으로 처리하다 기존 uncertainty flag가 false로 덮인 것이다. sticky journalUncertain으로 물리 전송/peer acceptance를 만들지 않고 모델1turn/CLEANUP_UNCERTAIN과 격리를 보존했다. 최초 RED와 수정 후 targeted/whole source·bundle 로그를 유지한다.

stdio의 미전송 실패에서 cancellation notification1회가 나가는 회귀도 제거했다. body.cancel/getReader/releaseLock의 구체 disposal 실패를 generic fetch failure와 구분한다. prepared/intent의 async observer는 wire 전에 거절하고 settled async는 전송 후 journal uncertainty다. Native Promise rejection만 관측하며 arbitrary thenable 작업을 join/취소하지 않는다. legacy cancellation notification은 best effort라 local cleanup=true를 통지 성공/원격 abort proof로 해석하지 않는다.

기존 SQL fixture 두 실패는 새 metadata-only query1개를 포함하지 않은 기대값이었다.4→5와7→8을 갱신하며 원래 provider/result 본문 읽기0·write0·1k/10k returned-byte 안정과 partial index 검사를 유지했다. ROOT의 최초 boundedJson import 오류는 실제 통합 case 실행 전 ESM instantiation blocker였고 수정 후 실제20개를 실행했다. DB9 이전 logical hash 목록은 보존하고 기존 resigned archive fixture에는 새 table을 포함했다.

## 실제 계정 회귀와 보존

같은 source의 Codex `gpt-6.1-sol` child text1회가 READY·natural confirmed cleanup으로 완료했다. Input266/output5, cached/reasoning0, billed=null이다. 논리 request1746bytes·SHA `e591c25e2b7bc2d7e6566622049249bd30c4e9f709240597eb6a3beca22d7b45`이며 raw HTTP digest가 아니다.

Host-only opaque PDF54bytes는 모델 요청에 넣지 않았다. Child storage→archive/validate→historical metadata→pause import를 확인했다. historical proof의 metadata10456bytes/refs1/charged rows28/child1/raw mirror491520bytes/elapsed9.6ms는 해당 단일 관측이다. 원격 PDF 인식이나 물리 I/O/처리량 상한이 아니다. Snapshot0, 실제 요청1, child pause1·새 physical authority0·restored typed child reexport 거절·임시경로 제거가 통과했다. 실제 프로젝트 unresolved 기록에는 ACK하지 않았다.

[열두 번째 JSON](engine-goal-twelfth-verification.json)은 `56097557cef98cb2d5829aac55beb31150ee4620`의 원본 bytes 그대로 보존했다. SHA는 `3687f817071c15f8592fadc6991e975d4edcaaaeea70fc81e567ca66519362a7`다. 현재 DB9/metrics6이며 MCP 전용 metrics aggregate와 ACK/해제 API는 아직 없다. 이전 historical/physical mapping·mirror/crash·AbortSignal composite 제한은 원본 기록을 유지한다.

## 다음 실제 결함

G1-26의 별도 actual generic tool fixture는 MCP receipt0 상태에서 native tool.running commit 또는 local callback 진입 뒤 SIGSTOP/SIGKILL했다. 재시작이 ToolRecord를 먼저 interrupted로 쓰고 Turn을 interrupted/no uncertainty로 정산해 새 Run이 허용된2red를 source·private bundle에서 재현했다. 미시작 requested control은 정상이다. 이 관측은 시작 intent/콜백 진입의 증거이며 외부 효과나 peer acceptance를 주장하지 않는다. 이 새3case는 현재2,402-pass 전체 gate의 완료 범위에 포함되지 않는다.

다음은 같은 recovery transaction에서 원래 시작 frontier를 bounded exact native owner/proposal로 검증해 capture하고 tool_effect uncertainty를 보존하는 작업이다. stronger typed MCP safe proof·command/patch effect marker를 구분하며 이미 과거 recovery가 interrupted로 바꾼 기록에 소급 coverage를 주장하지 않는다. receipt 없는 legacy/native chronology는 새 MCP 계약으로 인증하지 않는다. [TODO](../../TODO.md)와 [지속 개선 목표](engine-improvement-goal.md)를 따른다. 외부 OS/provider/CI4개·GUI 제외를 유지하며 goal은 활성 상태다.
