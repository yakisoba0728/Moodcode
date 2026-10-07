# 일반 도구의 시작 의도와 재시작 복구

G1-26은 복구가 원래 `running` ToolRecord를 `interrupted`로 바꾸기 전에 시작 의도를 보존한다. 모델의 ProviderAttempt가 완료됐고 로컬 스트림 정리가 확인됐어도, 이어서 실행한 도구의 결과까지 확인됐다는 뜻은 아니다. 결과가 없는 native 도구는 같은 workspace의 실행을 차단한다.

## 포착하는 경계

실행 직전 durable `tool.running`과 실제 콜백 진입 뒤의 강제 종료를 모두 보수적으로 처리한다. 기록한 intent만으로 콜백 진입·물리 전송·원격 수신·외부 효과를 증명하지 않는다. Frontier의 `originalToolState`는 `running`, `callbackEntry`는 `unverified`, `effectOutcome`은 `unknown`이다.

`requested`, `awaiting_approval`, proposal-only는 시작한 도구의 증거로 사용하지 않는다. 도구 이름·현재 read hint·완료된 파일 checkpoint·원래 provider의 cleanup도 일반 도구의 완료 증거를 대신하지 않는다. command/patch의 별도 effect marker와 기존 workspace quarantine은 그대로 검사한다.

## 원래 owner와 증거

선택한 ToolRecord의 SQL/session/Run/workspace owner와 원문을 대조한다. Native 도구에는 정확히 하나의 같은 owner tool proposal, Turn, 최신 ProviderAttempt가 필요하다. Tool 이름·입력·Part index/revision/state, provider/model과 Attempt context revision의 owner를 확인한다. Retry/overflow의 Attempt는 Turn 생성 시점과 다른 context revision을 사용할 수 있으므로 두 revision의 단순 동일성을 요구하지 않는다.

Frontier는 internal toolCallId, proposalPartId, session/workspace/Run/Turn/Attempt, provider/model/context, 원래 tool ordinal을 기록한다. 원래 ToolRecord·Turn·Attempt의 canonical SHA와 결과를 제외한 immutable proposal SHA를 결합한다. Ordinal은 문자열로 보존하되 SQL 원래 숫자 열로 선택·정렬하며 JavaScript safe integer를 넘는 값을 반올림하지 않는다.

새 기록은 실행 권한이나 새 승인·MCP receipt가 아니다. ProviderAttempt의 완료·usage·cleanup, 부분 text/reasoning, 원래 입력·proposal·승인·context는 변경하지 않는다. Frontier 원문에 credential이나 도구 결과를 복사하지 않는다.

## 같은 transaction의 복구

복구 순서는 다음과 같다.

1. 기존 MCP pending receipt를 같은 transaction에서 정산한다.
2. 원래 `running` 후보의 bounded owner/proposal을 검증하고 frontier를 선택한다.
3. `tool.recovery_frontier`를 native/v1 두 저널에 같은 payload로 남긴다.
4. 기존 ToolRecord·approval·Run interruption을 처리한다.
5. 열린 native Turn을 `tool_effect` uncertainty로 정산하고 session을 pause한다.

새 frontier의 native owner는 `awaiting_tools` Turn, completed 최신 Attempt, open proposal이어야 한다. 이미 terminal uncertain인 Turn의 기존 독립 차단은 보존하며 중복 frontier를 만들지 않는다. 다른 terminal owner·foreign/missing/duplicate proposal·owner/payload 불일치·한도 초과는 typed error로 전체 transaction을 rollback한다. 두 저널 중 하나의 insertion 실패도 MCP 사전 정산과 원래 tools/control/sequences까지 함께 rollback한다.

MCP receipt는 단순 존재나 SQL safe-looking flags만으로 면제하지 않는다. Exact native/승인/proposal proof를 검증한 `not-dispatched` 또는 `response-terminal`이면서 request-local cleanup=true인 경우에만 일반 시작 의도 때문에 추가 불확실성을 만들지 않는다. pending prepared는 첫 단계에서 not-dispatched로 정산한다. Intent·uncertain 또는 cleanup 미확인은 독립 차단을 유지한다. Terminal 응답은 외부 rollback이나 모든 background 활동의 종료 보장이 아니다. [MCP 계약](engine-mcp-execution.md)을 따른다.

## 한도와 조회 범위

`TOOL_RECOVERY_FRONTIER_LIMITS`는 내부 capture의 running 후보 최대1,024개, 페이지64개, 선택된 owner/proposal/ToolRecord 각1MiB다. ID와 owner scalar는 bounded SQL metadata를 먼저 반환하며 oversized 원문을 JavaScript로 가져오기 전에 거절한다. Proposal 선택에는 DB9의 기존 `mcp_native_tool_proposals` expression index와 result-free projection을 재사용한다. DB version은9, metrics schema는6으로 유지한다.

Capture는 같은 transaction의 [공유 증거 예산](engine-recovery-evidence-read.md)을 사용한다. 선택 원문 합계8MiB와 raw cache4,096주소는 SQLite 내부 JSON 계산·물리 I/O·전체 startup 시간/메모리의 상한이 아니다. 모든 후보 선택 뒤 audit를 발행해 선택 중 owner cache를 재사용하지만, write 뒤 journal owner 검사가 새 본문을 읽으면 같은 예산에 추가로 계산한다. 기존 legacy/native recovery의 전체 `.all()`는 이 bounded selection 범위 밖이다.

## 보존과 호환

Startup을 반복해도 같은 frontier를 다시 기록하거나 provider/tool을 재실행하지 않는다. `hasUncertainWorkspace`와 기존 native Turn 차단으로 다른 session의 새 Run·resume·queue promotion·workspace maintenance도 막는다. Queue 입력은 pending으로 보존한다. Backup/archive/import는 원래 저널과 Turn uncertainty를 보존하고 pause하며 ACK·retry·완료 추정을 수행하지 않는다.

진짜 v1-only running 기록에 native Turn/proposal이 없으면 `tool.recovery_frontier.unchecked`로 `unchecked-no-native-execution` coverage를 기록하고 기존 v1 복구 의미를 유지한다. 새 Turn·Attempt·승인·MCP receipt를 만들거나 native 차단이 검증됐다고 표시하지 않는다. Native Turn이 있는데 proposal만 없는 경우는 v1 호환으로 우회하지 않고 실패한다.

이미 과거 복구가 ToolRecord를 interrupted로 다시 쓴 이력은 이번 forward capture로 소급 인증하지 않는다. 별도의 retrospective 정책과 증거 검증이 필요하다. 현재 일반 tool effect/MCP 전용 host ACK API는 없으며 provider/summary ACK로 이 차단을 해제하지 않는다. 실제 unresolved 프로젝트 기록을 대신 승인하지 않는다.

실제 SIGSTOP/SIGKILL 7개 phase와 저장소 owner/한도/rollback 검증의 정확한 source·bundle·로그는 [최신 기록](engine-goal-verification.json), 공개 비교와 최초 실패는 [조사](research/2026-10-07-tool-recovery-frontier.md)에 남긴다.
