# Moodcode 엔진 계약 v2

구현 범위: E0-01·E0-02 계약과 validator, 이후 실제 inbox·scheduler·native 실행·조회 연결. 기본 통합은 [headless 통합 보고서](engine-native-final-verification.md), 지속 개선의 최신 실행은 [goal 검증](engine-goal-verification.md)을 따른다. OpenCode 구현·프롬프트·테스트를 복사하지 않고 Moodcode의 기존 durable Run 계약에 추가했다.

## 기존 API와 새 journal

`SCHEMA_VERSION=1`, `EngineEvent.runId` 필수, 기존 `EngineStore`·`CoordinatorPort`·`ProviderAdapter`의 필수 멤버를 보존한다. `run.submit`은 즉시 실행 접수이며 기존 `RunReceipt {runId,inputId,admittedSeq,duplicate}`와 workspace busy·exact retry 의미를 유지한다. 새 입력 API는 workspace 실행을 기다릴 수 있는 별도 경로다.

새 `SESSION_SCHEMA_VERSION=2`의 `SessionEventV2`는 `stream:'session-v2'`와 session별 독립 seq를 가진다. `runId`는 선택적이며 Run 생성 전 입력 이벤트는 실제 `inputId`와 session에 귀속된다. pending 입력 때문에 가짜 Run·사용자 transcript를 생성하지 않는다. v1과 v2 seq는 서로 다른 cursor다. `SessionEventCursor`는 schema·stream·sessionId를 포함한다.

`projectSessionEventToV1(event, legacySeq)`는 실제 runId가 있고 v1에 대응하는 이벤트만 투영한다. 새 입력·제어 이벤트는 제외한다. 반드시 v1 journal이 할당한 별도 seq를 전달해야 한다. 투영 helper만으로 기존 journal에 이벤트를 자동 기록하지 않는다.

첫 입력·제어 명령은 `input.accept`, `input.list`, `input.cancel`, `session.pause`, `session.resume`, `session.events`다. 추가 계약은 `engine.getCapabilities`, `run.getTurns`, `turn.getParts`, `artifact.get`, session tasks 조회·CAS 수정, question 조회·답변·거부, `session.getContext`, `session.searchHistory`, `session.getDiagnostics`다. history query는 UTF-8 1024 bytes의 literal text이며 page·response byte 상한과 owner-bound beforeMessageId를 둔다. diagnostics는 `{sessionId}`를 받아 [known/null 및 관측 범위를 표시한 metrics](engine-native-metrics.md), context 진단, workspace 관찰 상태를 반환한다. `validateSessionCommand`는 기본적으로 `COMMAND_UNAVAILABLE`을 반환하며 실제 handler가 준비된 host의 명시적 `enabledCommands`만 허용한다. 기존 `validateCommand`는 v1 경로를 유지한다. 향후 schemaVersion은 두 validator에서 `UNSUPPORTED_SCHEMA_VERSION`으로 거부한다. v2 결과는 별도 `SessionCommandResult`다. capabilities의 선택적 `extensions`는 실제 연결된 command/schema만 광고한다.

## identity와 수명

| 객체 | identity·불변조건 |
|---|---|
| Input | session/requestId exact retry의 단위. config와 delivery가 identity에 포함된다. pending·cancelled에는 runId·promotedSeq가 없다. promoted에는 실제 runId와 admittedSeq보다 큰 v2 promotedSeq가 있다. |
| Run | 기존 inputId는 primary input. v2 inputIds는 primary를 정확히 한 번 포함하며 steer binding을 추가한다. Run 상태는 기존 enum을 유지하고 미확정 효과는 failed/interrupted + requiresRecovery uncertainty로 표시한다. |
| Turn | Run 안의 logical turn이며 Input IDs·context revision을 연결한다. terminal 상태 completed/failed/interrupted/uncertain에는 completedAt이 필수다. uncertain은 recovery-required 원인을 반드시 가진다. |
| ProviderAttempt | logical turn 안의 재시도 단위. prepared에는 dispatchedAt이 없다. dispatch 이후 상태에는 dispatch 시각이 필요하다. 전송 전 실패도 기록할 수 있으며 uncertain은 dispatch 증거와 원인을 요구한다. context overflow recovery가 같은 Turn에서 새 Attempt를 생성하면 Attempt별 contextRevisionId로 재구축한 context를 연결한다. |
| ToolCallIdentity | 내부 id는 durable 실행 identity다. providerCallId는 해당 provider turn에 보내는 call/result pairing identity다. 서로 다른 turn에서 provider ID가 반복되어도 내부 ID를 별도로 만든다. |
| MessagePart | message/turn owner, index, revision, open/terminal 상태. text/reasoning/tool/media를 구별하고 다른 variant의 필드를 거부한다. 저장소는 owner 일치·revision 증가·terminal 불변·조회 순서를 확인해야 한다. |
| ContextRevision | session + revision, 출처 sourceIds, text/hash, baseline/update/summary. 선택적 turn binding은 runId를 요구한다. SHA-256 계산·내용 일치와 provenance의 실제 존재는 저장 구현의 책임이다. |

validator는 객체를 독립 복사하고 정확한 enum·bounded integer·canonical UTC timestamp·lowercase SHA-256 형식을 확인한다. JSON payload는 acyclic plain data, dense array, finite number, bounded UTF-8·크기·깊이·node 수를 요구하며 getter를 실행하지 않는다. 오류는 제출한 값을 포함하지 않는다. 서로 다른 record의 실제 참조 관계와 상태 전이는 저장소의 transaction에서 확인한다.

## 저장 ports

`SessionEngineStore extends EngineStore, SessionInboxPort, ExecutionRecordStore`를 추가해 기존 저장 구현의 필수 API를 바꾸지 않는다.

- `acceptInput`, `getInput`, `listInputs`, `cancelInput`: durable inbox 접수·조회·취소. list cursor는 session을 바꾸어 사용할 수 없다.
- `promoteInput(inputId,runId?)`: runId 생략 시 새 Run, 전달 시 실제 active Run binding. 반환 `InputPromotion {input,run,receipt}`의 input seq는 v2, receipt seq는 v1이다.
- `promoteSteers(inputIds,runId)`: cutoff로 선택한 bounded batch를 한 transaction에서 해당 Run에 연결한다. provider stream·도구·승인 진행 중에는 호출하지 않는다.
- `getSessionControl`, `setSessionPaused`: revision이 있는 영구 pause/resume 상태. Run 취소 뒤 queue 자동 실행을 막고 대기 입력을 보존한다.
- `readSessionEvents`, `subscribeSessionEvents`: v2 journal replay/live stream. v1 readEvents/subscribe는 보존한다.
- `putTurn/getTurn/listTurns`, `putAttempt/getAttempt`, `putPart/listParts`, `putContextRevision/getContextRevision`: owner·revision·terminal 검증을 원자 수행한다.

## 예산과 artifact

`RunConfig.budgets?:EngineBudgets`와 `RunConfigInput.budgets?:Partial<EngineBudgets>`는 additive다. 생략하면 v1 normalized config의 JSON shape도 유지된다. 명시한 경우 shared default와 layer를 병합하고 모든 field를 bounded safe integer로 검증한다. `retryBaseDelayMs`만 0을 허용한다.

`agentProfileId`와 `agentProfileRevision`도 선택적이며 생략 시 v1 shape를 유지한다. ID·revision은 bounded identifier이고 revision 단독은 거부한다. 기본값과 다른 명시적 profile ID는 이전 profile revision을 상속하지 않는다. host가 admission에서 profile의 최종 provider/model/reasoning/allowance와 revision을 결정한다. coordinator는 `getAllowedTools(run)`을 Run 시작에 복사하고 provider schema·captured catalogue·실제 tool handler에 동일하게 적용한다.

`turnAllowance`는 새 사용자 입력 promotion 뒤 허용할 logical turn 수이며 steer 적용 때 reset한다. `maxTurns`는 Run 전체 절대 상한으로 reset하지 않는다. `maxToolCallsPerTurn`과 Run 전체 `maxToolCalls`도 별개다. pending 개수/bytes, steer batch, read concurrency, provider attempt·request/inactivity timeout, retry delay, summary calls/bytes, artifact/producer bytes의 상한을 각각 둔다. runtime budget 계정은 기존 상한을 계속 유지한다.

`ContextRequest.consumeSummaryOutput(bytes)`는 summary output도 같은 Run maxOutputBytes에 누적한다. summary 전용 bytes/calls 상한은 별도로 적용한다. public output이 없는 명시적 provider context overflow에 대한 recovery만 같은 logical Turn 안에서 최대 한 번 허용하며, provider attempt 및 Run 전체 상한을 유지한다.

`ArtifactReference`는 파일 경로 대신 identity/hash/retention·부분 결과 정보를 공개한다. `observedBytes`는 읽은 원본 bytes다. producer loss를 아는 경우 `observedBytes=storedBytes+artifactTruncatedBytes+producerTruncatedBytes`, 전체 loss를 모르는 stream 종료는 `producerTruncatedBytes=null`이며 observedBytes는 retained+artifact-truncated의 하한이다. complete=true는 completed outcome, producer/artifact loss 0인 경우에만 가능하다. expiresAt은 createdAt 이후다. 파일 hash·owner·size·retention은 artifact 저장 모듈에서 검증한다.

`ToolResultEnvelope`는 displayContent와 modelContent를 구분하고 structuredData/metadata/warnings/artifactRefs를 담는다. 기존 `ToolResult.content/isError/data/artifacts`는 그대로이며 선택적 structuredResult를 추가했다. `ArtifactCheckpointBinding`은 실제 Run/internal tool/선택적 turn·attempt와 checkpoint·artifact IDs를 연결하고 partial을 표시한다. runner는 같은 실행의 checkpoint·refs를 검증한 뒤 `checkpoint.artifacts` event에 identity/hash/partial을 기록한다. 기존 immutable Checkpoint와 review 소비자는 새 필드를 요구하지 않는다. unconfirmed tool cleanup은 artifact 결과에 관계없이 recovery-required로 남긴다.

`Message.toolResult?`는 outcome·warnings·artifactRefs의 additive metadata다. 도구 결과 message와 같은 원자 commit에 저장하며 기존 content·provider replay·transcript를 바꾸지 않는다. 오래된 큰 결과는 모델 context에서만 제한된 관측 요약과 artifact identity로 투영한다. `read_artifact`는 같은 session의 과거 owner/hash에 해당하는 원본 bytes를 page로 읽으며, 과거 관측을 현재 파일 상태로 표시하지 않는다. provider call ID와 artifact의 내부 tool ID는 서로 다른 identity다.

## 검증

`packages/contracts/src/engine-v2-contracts.test.ts`의 20개 자체 fixture와 기존 계약 테스트를 모두 보존했다. 최신 집중 검증 `node --import tsx --test packages/contracts/src/*.test.ts`는 총 46/46 통과했다. pending 무소유·promotion binding, exact normalized config, 독립 journal projection, future version, disabled commands, terminal·uncertainty, 내부/provider ID, parts, JSON 구조, artifact 회계와 provenance, native paging·task/question/context/history payload 및 profile identity를 확인한다. 계약 fixture는 아직 연결되지 않은 실행 기능의 완료 증거로 사용하지 않는다.

## 별도 문서 참조

`input.accept`/`InputRecord`와 promotion 결과 Run/user Message는 optional `documents: InputDocumentAttachment[]`를 보존한다. 이미지 `attachments`와 분리하며 absent와 explicit empty는 다른 exact request identity다. PDF 1개/512KiB·합산 decoded media 1MiB 계약, explicit MIME/model 및 unknown-token policy, host-only import는 [문서 입력 명세](engine-input-documents.md)에 정의한다. DB8은 latest-document user partial index만 추가하며 기존 v1/v2 payload와 provider/summary 복구 ledger를 재작성하지 않는다.
