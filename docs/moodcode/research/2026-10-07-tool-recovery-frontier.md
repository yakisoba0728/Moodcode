# 일반 도구의 시작 의도와 crash 복구 비교

2026-10-07. G1-26은 Moodcode의 실제 재시작 결함을 수정한다. 아래 공개 소스는 고정된 revision의 관찰 범위이며 구현·프롬프트·테스트를 복사하지 않았다.

## 공개 소스에서 구분한 의미

OpenCode `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`의 [session execution](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/execution.ts)은 현재 process가 소유한 active execution의 join·wake·interrupt lifetime을 구분한다. [session processor](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/processor.ts#L331)는 tool call을 pending에서 running으로 바꾸고, halt 경로는 남은 tool deferred를 잠시 기다린 뒤 Part를 aborted/error로 정산한다. 이는 선택한 live process 경로의 동작이며 전체 crash 복구나 외부 효과 종료의 보장으로 확대하지 않는다.

Codex `0b863c69f50335acd92164aab971cb58d298c2fe`의 [context normalization](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/core/src/context_manager/normalize.rs#L21)은 누락된 tool output을 모델 입력에서 일관된 형태로 보완한다. 같은 파일의 반복 normalization 설명은 그 synthetic output을 원래 durable 이력에 저장하는 것과 구분한다. 모델 입력의 call/output 대응은 실제 callback·도구 완료·외부 효과 proof가 아니다.

Moodcode의 `context/index.ts`도 불완전하거나 손상된 call을 설명하는 assistant text로 투영하며 원래 도구 결과나 native replay를 만들지 않는다. 이 문맥 처리는 workspace admission의 효과 격리를 대신할 수 없다. [기존 MCP 결과 조사](2026-10-07-mcp-effect-outcomes.md), [provider 종료 비교](2026-10-07-cleanup.md)와 함께 도구 시작 intent·모델 완료·로컬 cleanup·외부 결과를 분리한다.

## 수정 전 실제 관측

`4a15286ebdc59f0316b5c73eedb210376d31cbc9` 기반의 authored 임시 엔진과 SQLite에서 세 phase를 source/private bundle로 각각 실행했다. `requested`는 callback0인 정상 대조군이었다. Durable native tool.running 직후 callback0, 실제 local callback entry marker 뒤의 두 phase는 SIGSTOP/SIGKILL 후 recovery가 ToolRecord를 먼저 interrupted로 바꾸고 Turn을 interrupted/no uncertainty로 정산했다. 원래 요청의 retry는 재실행0이었지만 다른 session의 명시적 새 Run은 provider1로 완료했다.

이 두 실패는 원래 시작 intent가 격리 판단에서 사라진 증거다. Local callback marker와 durable intent를 원격 acceptance·외부 효과 발생으로 표현하지 않는다. Receipt0과 원래 completed Attempt·confirmed provider cleanup·부분 출력/usage를 대조했다. 최초 fixture·worker·source/bundle 실패 로그와 source pin은 [열세 번째 원본 기록](../engine-goal-thirteenth-verification.json)에 보존한다.

## 독립 구현과 회귀

같은 recovery transaction에서 강한 MCP 미전송 proof를 먼저 정산하고, 원래 running 후보의 exact native owner/proposal을 bounded 조회로 capture한다. Two-journal frontier는 원래 JSON의 canonical SHA를 기록하며 rewritten interrupted ToolRecord를 해시하지 않는다. Native Turn을 tool_effect uncertainty로 정산해 startup2·archive/import·새 실행/resume/maintenance/queue 차단을 유지한다. [자체 계약](../engine-tool-recovery-frontier.md)을 따른다.

실제 엔진 통합7개는 proposal-only/requested/awaiting-approval, running-intent/execute-entered, actual MCP correlated terminal/사전 auth 거절을 포함한다. MCP terminal 대조군은 parent-owned 임시 HTTP peer가 요청1을 받고 최종 응답을 돌려준 뒤 killed되며, not-dispatched 대조군은 peer request0이다. 결과 proof와 request-local cleanup이 모두 확인된 두 경우에는 일반 frontier를 만들지 않는다. 강제 종료는 엔진 process에 적용하며 peer lifetime이나 외부 activity 종료를 주장하지 않는다.

Storage unit17개와 독립14개는 foreign/missing/duplicate proposal, input/owner/approval drift, original record SHA, ordinal precision, 후보/본문/공유 예산, DB9 expression index, native/v1 audit rollback, genuine v1 unchecked와 이미 interrupted 역사 비보충을 확인한다. 9MiB proposal/context owner scalar의 returned-byte0 검사는 metadata 보강 뒤에 처음 실행한 GREEN 관측이며 새 RED 재현으로 표현하지 않는다.

초기 unit fixture의 session_controls/index 이름/FK 오류, actual integration fixture의 session event page cap 오류, 기존 MCP fixture의 receiptless native running을 clear로 기대한 한 회귀는 각각 보존한다. 마지막 회귀는 기대값을 block으로 강화하고 MCP row0·native/v1 frontier 각각1을 요구했다. 새로운 transport나 외부 계정의 성공으로 테스트 숫자를 확대하지 않는다. 현재 source/bundle·전체 gate·실제 계정 text 회귀는 [최신 검증](../engine-goal-verification.json)에 별도로 기록한다.

## 남는 범위

원래 v1-only 기록의 native coverage는 unchecked이며, 이미 interrupted로 다시 쓴 과거 이력의 retrospective 인증은 구현하지 않았다. 전용 host 복구 결정을 추가하려면 원래 effect outcome을 덮어쓰지 않는 별도 exact evidence 계약이 필요하다. Capture의 returned JSON 예산은 기존 전체 startup `.all()`나 물리 I/O의 상한이 아니다. 외부 OS/provider/CI·GUI와 실제 프로젝트 ACK는 이번 작업에 포함하지 않는다.
