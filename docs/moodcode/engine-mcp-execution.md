# MCP 도구 호출의 실행 기록과 불확실성

G1-25는 DB9에서 승인된 `tools/call`의 원래 native owner와 전송·응답·로컬 정리를 별도 기록한다. 모델 스트림이 끝난 뒤 원격 도구의 최종 응답 없이 timeout/disconnect/cancel로 결과가 불확실해진 경우 새 작업을 차단한다. GUI에는 아직 노출하지 않았다.

## 정확한 호출과 승인

`mcp_executions`의 primary key는 엔진의 internal toolCallId다. Session/workspace/Run/Turn/ProviderAttempt와 provider/model/context revision, 실제 허용된 **outer** approval ID/fingerprint, immutable proposal/approval SHA를 결합한다. MCP가 전달하는 RPC ID를 실행 권한으로 사용하지 않는다.

연결 UUID·catalogue revision·server/tool·protocol/transport와 최종 JSON-RPC ID/SHA/bytes도 기록한다. SHA는 `_meta`를 포함한 최종 논리 JSON-RPC envelope의 UTF-8 인코딩에 대한 값이다. HTTP headers·원격 acceptance·청구 값의 hash가 아니며 요청/응답 원문·credential을 receipt에 넣지 않는다.

native Run은 running, Turn은 awaiting_tools, 원래 provider Attempt는 completed, 승인된 ToolRecord는 running, proposal Part는 open이어야 준비·dispatch할 수 있다. 같은 identity의 정확한 재조회는 기존 receipt를 반환하지만 다시 전송할 권한을 부여하지 않는다. Part의 result가 커져도 result-free proposal projection의 원래 입력·owner pin을 검사한다.

## 전송 경계와 상태

| 상태 | 기록한 관측 | 새 실행 차단 |
|---|---|---|
| prepared | 승인·native owner·논리 요청이 준비됨 | 자체로는 차단하지 않음 |
| dispatch-intent | 실제 전송 경계 직전 intent를 durable 저장함 | 차단 |
| response-terminal | 정확히 상관된 terminal 응답과 요청별 로컬 정리 확인 | 자체로는 차단하지 않음 |
| uncertain | 전송 후 결과 또는 로컬 정리 미확인 | 차단 |
| not-dispatched | prepared 상태에서 전송 경계 이전 종료 | 로컬 정리가 미확인이면 차단 |

기본 HTTP transport는 credential/header/encoding/사전 취소 검사 뒤 fetch 직전에, 기본 stdio는 stdin write 직전에 synchronous durable intent를 기록한다. 기록 실패는 실제 fetch/write를 막는다. callback이 commit 뒤 throw한 경우에도 저장 결과가 불명확하므로 uncertainty를 잃지 않는다. 이 경계는 peer가 요청을 받거나 효과를 실행했다는 증명이 아니다.

외부 custom transport에는 실제 wire 직전 hook의 증거가 없으므로 conservative `legacy-api-entry`를 기록한다. 임의 capability marker나 builtin subclass의 send override를 기본 physical hook으로 신뢰하지 않는다. 엔진을 거치지 않은 McpClient의 optional observer는 native owner/승인/storage authority를 자동으로 제공하지 않는다. custom EngineStore가 native receipt port를 지원하지 않으면 엔진 MCP 전송을 거절한다.

prepared는 not-dispatched로, dispatch-intent는 response-terminal 또는 uncertain으로 한 번 정산한다. terminal 관측은 불변이다. timeout/disconnect/cancel 뒤 도착한 late 응답은 첫 정산을 고쳐 쓰거나 격리를 자동 해제하지 않는다.

## 원격 결과와 로컬 정리

지원하는 bounded envelope/content 검사에 통과한 complete tool result, `isError` tool result, 상관된 JSON-RPC error는 서버가 선언한 최종 응답으로 기록한다. resultType 없는 호환 응답도 허용한다. 실패 응답도 작업의 rollback이나 모든 외부 활동의 종료를 보증하지 않는다. malformed·wrong ID·oversized 응답과 지원하지 않는 input_required는 terminal proof로 인정하지 않는다.

`remoteResponseObserved`, `effectsUncertain`, `transportCleanupConfirmed`, `executionBlocked`를 분리한다. 응답이 있었지만 body/reader/pending 정리가 미확인이면 response SHA를 보존한 uncertain이며 effectsUncertain=false, executionBlocked=true다. 정리한 HTTP 요청이나 cancellation notification은 원격 효과의 취소 증거가 아니다. shared stdio 프로세스 전체 종료도 성공한 단일 RPC의 정리 조건으로 요구하지 않는다.

첫 응답/실패 뒤 로컬 cleanup join의 추가 대기는 최대250ms, 연결 close의 join은 최대1000ms다. RPC timeout은 기본10초, 선택1..60000ms이며 이 값들과 별개다. 구체적인 body.cancel/getReader/releaseLock 실패는 정리 미확인으로 분류한다. generic fetch/read/검증 실패 자체만으로 모든 로컬 정리가 실패했다고 추정하지 않는다. Legacy HTTP/stdio cancellation notification은 best effort이며 transportCleanupConfirmed=true가 통지의 성공이나 모든 통지 body의 정리를 증명하지 않는다. 이 수치는 peer의 응답/종료 보장이나 강제적인 OS 실행 시간 상한이 아니다.

prepared/intent observer가 Promise/thenable을 반환하면 전송 전 거절한다. settled observer의 비동기 반환은 이미 전송한 뒤 journal uncertainty로 처리한다. Native Promise rejection은 intrinsic then으로 관측하지만 arbitrary thenable의 비동기 작업을 join/취소하지 않는다.

MCP의 공식 [취소 명세](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)는 취소 알림을 optional 요청으로 정의하며 처리 완료·취소 불가 등의 경우 수신자가 무시할 수 있음을 설명한다. 따라서 Moodcode는 알림 전송만으로 원격 효과가 종료됐다고 판단하지 않는다. [도구 명세](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)의 annotations 신뢰 경계에 맞춰 readOnlyHint도 승인·불확실성 검사 면제 근거로 사용하지 않는다.

## 모델 loop·재시작·보관

post-intent unknown 또는 로컬 정리 미확인은 CLEANUP_UNCERTAIN과 native Turn의 tool_effect uncertainty로 연결한다. 모델 다음 turn·새 Run·queue promotion·workspace maintenance/resume는 기존 uncertainty gate를 따른다. queue 입력은 정책에 따라 pending으로 보존할 수 있지만 provider를 자동으로 호출하지 않는다. 원래 provider Attempt/cleanup/usage와 텍스트·reasoning·proposal·승인·입력은 유지한다.

workspace predicate는 receipt의 indexed metadata와 실제 Run owner를 검사한다. provider/summary ACK가 MCP receipt를 해제하지 않는다. 종료된 Run/Turn이 있어도 unresolved receipt가 독립적으로 차단한다. startup은 pending prepared를 not-dispatched, intent를 uncertain으로 정산하고, 이미 uncertain인 receipt와 아직 끝나지 않은 Turn도 연결하며 session을 pause한다. receipt 없는 이전 native records에 remote intent나 acceptance를 소급해서 만들지 않는다.

DB8→9 migration은 테이블/index만 추가한다. native/v1 event와 receipt mutation은 같은 SQLite transaction에서 commit/rollback한다. backup/archive/recovery의 logical primary hash에 DB9 테이블을 포함한다. import는 원래 receipt/approval/partial output/usage를 보존하고 session을 pause하며 실행·재전송·ACK를 자동 수행하지 않는다.

## Host 조회와 한도

`engine.getMcpExecution(sessionId, toolCallId)`는 exact session owner를 확인한 bounded receipt를 반환한다. store port는 `getMcpExecution(toolCallId, expectedSessionId?)`다. lookup에 새 실행·retry·원격 cancellation·복구 결정을 부여하지 않는다. 현재 MCP 전용 host ACK/해제 API는 없다.

receipt JSON16KiB, 선택된 native owner/proposal JSON 각1MiB, 논리 request/response1MiB, bounded ID256bytes를 제한한다. SQL header의 길이/owner를 본문보다 먼저 검사한다. 공통 [증거 조회 예산](engine-recovery-evidence-read.md)과 transaction cache를 사용한다. startup은 receipt를100개 단위로 페이지 처리하며 전체 startup의 고정 시간/메모리 상한으로 확대하지 않는다.

실제 임시 HTTP peer와 엔진·SQLite·승인·SIGKILL, 기본 stdio/custom fetch fixture로 검증한다. 정확한 source/log/실패 수정·전체 gate 수치는 [최신 검증](engine-goal-verification.json)에 기록한다. 외부 운영 MCP의 원격 rollback/취소 확인·모든 custom transport의 wire 계측·receipt 없는 legacy 호출의 소급 복구·Windows native 종료 검증은 완료 범위 밖이다.
