# 엔진 지속 개선 검증 — 열네 번째 검토 지점

구현 커밋은 `217f77f1f88ad1624bc938adec4763a3996fd46f`다. macOS arm64 / Node26.9.0에서 G1-26 일반 native 도구의 원래 시작 의도를 복구 전에 보존하고 workspace 격리를 유지하도록 구현·검증했다. Goal은 활성 상태이며 GUI를 실행하지 않았다.

## 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript build/typecheck | 통과 |
| 전체 headless engine, concurrency4 | 2,442개 중2,440 pass, 실패0, 취소0, 조건부2 skip; 57,594.9ms |
| fixture 코딩 평가 | 3/3 |
| storage 집중 source / 독립 bundle | 각각98/98; 신규 unit17개 포함 |
| 독립 storage 검토 source / bundle | 각각14/14 |
| actual engine/SQLite/approval/HTTP/SIGKILL source / bundle | 각각7/7 |
| 세 담당 범위 scoped noEmit | 모두 통과 |
| 같은 source 실제 Codex child text | 1회 통과; root/PDF/외부 MCP 계정 요청0 |

새 source tests는38개다. 집중 검사를 전체 수에 더하지 않는다. 정확한 command/log/SHA와 source55개 pin·초기 실패·실제 관측은 [기계 판독 결과](engine-goal-verification.json)에 기록한다. 첫 whole gate도2,440 pass였으며, 최종 cache 주석 수정까지 source를 동결한 뒤 전체 gate를 한 번 더 실행했다.

## 수정한 실제 결함

MCP receipt 없는 일반 도구의 durable running-intent 또는 local callback 진입 뒤 SIGSTOP/SIGKILL하면 복구가 ToolRecord를 먼저 interrupted로 다시 쓰고 native Turn을 interrupted/no uncertainty로 정산했다. 원래 요청 retry는 재실행0이었지만 다른 session의 명시적 새 Run은 허용되는2red를 source/private bundle에서 재현했다. Requested 대조군은 정상이다. 이는 local 시작 intent/콜백 marker의 증거이며 원격 acceptance·외부 효과 발생을 주장하지 않는다.

수정은 같은 transaction에서 기존 MCP pending을 먼저 정산하고 원래 running 후보의 exact owner/proposal을 bounded 검증해 포착한다. 원래 ToolRecord·Turn·Attempt·immutable proposal SHA와 원래 ordinal을 native/v1 `tool.recovery_frontier`에 기록한 뒤 legacy interruption을 처리한다. Callback entry는 unverified, effect outcome은 unknown이다. 열린 Turn의 tool_effect uncertainty와 pause를 유지하며 provider 완료/cleanup·checkpoint/read hint로 일반 도구 완료를 추정하지 않는다. [계약](engine-tool-recovery-frontier.md), [공개 비교와 최초 실패](research/2026-10-07-tool-recovery-frontier.md)를 따른다.

## 실제 대조군과 보존

실제7phase는 proposal-only/requested/awaiting-approval, running-intent/execute-entered, MCP response-terminal/not-dispatched다. 미시작3개와 정확한 terminal/미전송+confirmed cleanup2개는 일반 frontier를 만들지 않는다. MCP response 대조군의 parent-owned 임시 peer tools/call은1, auth 사전 거절은0이다. 이미 확인한 receipt를 safe-looking flags나 current hint로 대신하지 않는다.

두 started phase는 startup2·archive/import 뒤에도 새 Run·resume·maintenance·queue promotion을 차단하고 pending 입력을 보존한다. 원래 Attempt completed·provider cleanup confirmed·usage11/4/cached2/reasoning1, text/reasoning·proposal·입력·허용된 승인과 pre-rewrite SHA가 유지된다. 자동 provider/tool replay·ACK·wholeSnapshot은0이다.

Foreign/missing/duplicate proposal, 원래 input/owner/승인 drift, terminal 불변성, 숫자 ordinal precision, 후보 cap1,024/page64/record1MiB/shared selected JSON8MiB와 DB9 expression index를 확인했다. 두 저널 insertion 실패는 사전 MCP 정산·원래 tools/Turn/Run/control/sequences까지 rollback한다. 9MiB proposal/context owner의 SQL returned bytes0은 metadata 보강 뒤 실행한 GREEN 검증이며 최초 RED로 표시하지 않는다.

초기 unit7개 실패는 session_controls/index 이름/FK fixture 작성 오류였다. Actual fixture가 native event limit100 대신256을 요청한 실패도 따로 보존했다. 기존 MCP fixture의 receiptless native running clear 기대 한 곳은 block으로 강화하고 MCP row0·native/v1 frontier 각각1을 요구했다.

## 실제 계정 회귀와 이전 기록

동일 source의 Codex `gpt-6.1-sol` child text1회가 READY·natural confirmed cleanup으로 완료했다. Input266/output5, cached/reasoning0, billed=null이다. 논리 request1746bytes·SHA `d780d2343589441fa607de3ec59d98824c701b94f2054cd95388b8475eeb2800`이며 raw HTTP digest가 아니다.

Host-only PDF54bytes는 모델에 전송하지 않았다. Child storage→archive/validate→historical metadata→pause import를 확인했다. 단일 historical proof의 metadata10456bytes/refs1/charged rows28/child1/raw mirror491520bytes/elapsed8.5ms는 물리 I/O나 latency 상한이 아니다. 실제 요청1·snapshot0·child pause1·physical authority0·restored typed child reexport 거절·임시경로 제거가 통과했다.

[열세 번째 JSON](engine-goal-thirteenth-verification.json)은 `53b4e9f25976e0b48b7a4d9265411f4ca35e33dd`의 원본 bytes 그대로 보존했다. SHA는 `f6852c957635a0d7e579159782a5c6c0b37eae5ab1d977abbc0d7b1456cf3100`이다. DB9/metrics6은 유지하며 새 migration/projection·일반 tool/MCP 전용 ACK는 없다.

진짜 v1-only native owner 없는 기록은 unchecked audit와 이전 의미를 유지한다. Native Turn이 있는데 proposal이 빠진 경우는 실패한다. 이미 과거 recovery가 interrupted로 쓴 이력은 소급 인증하지 않는다. 공통 selected JSON/cache 한도는 기존 전체 startup `.all()`·SQLite 내부 JSON 계산·전체 물리 I/O/시간을 제한하지 않는다. Journal write 뒤 owner 재조회도 남은 예산을 소비한다.

## 다음 실제 최적화 후보

추가 authored source/private bundle의 실제4조건에서 기본 core21개의 reservation은10,158B다. 정상 등록된 MCP schema40개(각8,269B)를 더하면61개 reservation344,678B로 기본 context262,144B를 넘겨 모델 호출0/CONTEXT_LIMIT이 된다. 기존 profile로 core21개+MCP1개를 선택하면22개 reservation18,521B·logical provider request20,297B·모델1/completed다. 이는 기존 정적 profile 대조군이며 동적 deferral의 완료 증거가 아니다.

G1-27은 필요한 도구를 bounded discovery로 찾아 다음 안전한 모델 경계에 노출하는 host opt-in을 구현한다. 같은 catalogue로 schema reservation/context plan/provider request를 고정하고 profile/policy/revision/승인 경계를 유지한다. 기본 eager 동작을 보존하며 provider-native tool_search capability를 추측하지 않는다. 측정은 serialized bytes와 실제 local 경계이며 token/시간/physical I/O 절감은 측정하지 않았다. [TODO](../../TODO.md), [지속 개선 목표](engine-improvement-goal.md)를 따른다. 외부 OS/provider/CI4개·GUI 제외를 유지하며 goal은 활성 상태다.

도구 discovery의 실제 baseline과 독립 구현 범위는 [조사](research/2026-10-07-tool-catalogue-discovery.md)를 따른다.
