# MCP 호출 효과와 로컬 종료 — 2026-10-07

G1-25의 근거는 승인된 실제 loopback peer와 Moodcode 엔진·SQLite에서 확인한 실패다. 공개 엔진의 구조와 MCP 명세를 비교했으며 코드·프롬프트·테스트를 복사하지 않았다.

## 원래 결함

`/tmp/moodcode-mcp-accepted-effect-review.test.mts`는 실제 HTTP peer가 임시 effect marker를 쓰고500ms 동안 계속 처리하도록 구성했다. 정확한 엔진 도구 승인 뒤100ms timeout, host disconnect, 사용자 cancel을 각각 실행했다. 세 경우 모두 원격 작업이 아직 진행 중인데 workspace uncertainty가 false였고 명시적 새 Run이 허용됐다. timeout/disconnect는 모델 두 번째 turn으로 이어져 Run completed였고 cancel은 cancelled였지만 격리가 남지 않았다.

세 안전성 assertion은 RED다. provider full snapshot0, 외부 계정/프로젝트 DB/실제 프로젝트 ACK0이며 peerCalls는 경우별1이다. fixture SHA `7acffb69b6757a9df0cede23b792247f9595ee8982f13ce4f50390abfc368714`, 로그 `/tmp/moodcode-mcp-accepted-effect-review-source.log` SHA `7327fb75614f9d8545e6f768768cabedb95e1b8ba5eab9e4791a62c7c3c91aab`를 보존했다.

별도 `/tmp/moodcode-g125-native-remote-restart-review.test.mts`는 approved/running tool·awaiting_tools Turn·completed provider Attempt를 실제 native store에 기록한 뒤 재시작했다. Tool/Part는 interrupted로 보존됐지만 Turn uncertainty와 workspace 차단이 없었다. 이 fixture는 실제 원격 effect/acceptance를 주장하지 않는다. receipt 없는 과거 chronology는 이번 수정으로 소급 인증하지 않는다.

원래 transport는 pending 요청을 제거하고 cancellation을 보낸 뒤 ordinary error를 반환했다. runner는 이를 실패 tool 결과로 모델에 전달했다. provider Attempt는 도구 실행 전에 이미 completed이므로 provider dispatch recovery만으로 원격 도구를 추적할 수 없었다. HTTP의 상관된 response와 body/reader cleanup도 분리되지 않았다.

## 공개 비교의 범위

OpenCode pinned `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`의 [mcp/catalog.ts](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/mcp/catalog.ts#L53)는 schema 변환·client.callTool의 abort/timeout·isError 처리를 보여준다. 이 선택된 코드의 timeout/cancellation 경계를 참고했으며 OpenCode 전체의 crash/remote rollback 보장을 평가했다고 확대하지 않는다.

Codex pinned `0b863c69f50335acd92164aab971cb58d298c2fe`의 [binding.rs](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/codex-mcp/src/binding.rs#L304)는 captured catalogue 아래의 call preparation과 timeout을 연결한다. [connection_manager.rs](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/codex-mcp/src/connection_manager.rs#L931)는 interruption과 connection cleanup의 수명을 다룬다. 이 구조는 catalogue/자원 경계를 비교하는 근거이며 원격 도구의 효과 종료 증거가 아니다.

MCP [취소 명세](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)의 optional notification은 작업 완료/취소 불가 등의 경우 무시될 수 있다. Moodcode는 notification 송신과 로컬 Promise 종료를 peer rollback으로 취급하지 않는다. [도구 명세](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)의 annotations 신뢰 경계도 readOnlyHint 자동 면제에 대한 근거가 되지 않는다. Pi/Amp/Claude의 이전 공개 비교는 유지하지만 이번 local effect failure를 이 제품들의 비공개 내부 동작에 적용하지 않는다.

## 독립 구현과 실제 회귀

DB9의 receipt는 exact native owner·실제 outer 승인·immutable proposal과 최종 논리 RPC/연결/catalogue를 결합한다. builtin HTTP fetch/stdio write 직전 synchronous intent를 저장하고, 응답의 terminal 여부와 request-local cleanup을 독립 관측한다. shared stdio 종료를 정상 RPC의 필수 조건으로 추가하지 않는다. 외부 transport는 API 진입 intent만 보수적으로 기록한다.

실제 엔진 통합20개는 accepted timeout/disconnect/cancel, success/isError/JSON-RPC error, input_required/wrong ID/malformed, 승인 전 cancel/credential 실패/catalogue 변경, native/v1 정산 rollback, engine close·restart·archive와 exact retry를 실행했다. 원래 provider Attempt completed·confirmed cleanup·usage와 부분 text/reasoning·제안·승인·입력을 보존했다. 새 모델 continuation/Run은 차단하고 queue는 pending으로 남긴다. late peer reply도 격리를 자동 해제하지 않는다.

두 SIGKILL 경계는 actual durable http-fetch intent 뒤 peerCalls0인 경우와 parent가 소유한 peer의 실제 acceptance marker 뒤 peerCalls1인 경우를 구분한다. 재시작의 provider 재호출/도구 재전송/ACK/snapshot은0이다. intent만으로 acceptance를 주장하지 않고 원래 peer가 계속 살아 있는 후자의 관측만 실제 원격 진행의 증거로 사용한다.

통합 검토가 추가로 찾은 RED는 `dispatchMcpExecution` commit 뒤 callback이 throw한 경우다. 실제 HTTP0·durable intent/block true인데 모델이 두 번째 turn을 실행했다. beforeSend 실패가 미전송 정산으로 이어지고, 이미 커밋된 intent와의 충돌을 처리하면서 기존 uncertainty flag가 false로 덮였다. 별도 sticky journalUncertain을 유지해 물리 전송/acceptance를 만들어내지 않고 CLEANUP_UNCERTAIN을 보존했다. 최초 `/tmp/moodcode-g125-committed-intent-callback-source-first.log`를 유지한다.

기본 stdio의 미전송 intent 실패에서 cancellation notification1회가 나가는 회귀도 제거했다. body.cancel/getReader/releaseLock의 구체 cleanup failure를 보수적으로 태그하고 generic fetch failure와 구별했다. TS void callback에 async 함수가 들어갈 수 있으므로 prepared/intent의 Promise/thenable observer는 실제 전송 전 거절하며 settled 비동기 반환은 전송 후 journal uncertainty로 남긴다. Native Promise rejection만 intrinsic으로 관측하고 arbitrary thenable의 작업을 join/취소하지 않는다. custom marker/subclass override는 physical hook으로 승격하지 않는다.

storage의 기존 SQL 측정 fixture 두 실패는 새 metadata-only predicate1개를 반영하지 않은 query-count 기대값이었다.4→5와7→8을 갱신하며 본문 읽기0·write0·1k/10k returned-byte 안정과 partial index 검사를 유지했다. receipt workspace와 실제 Run workspace가 다른 경우도 같은 single SQL의 두 indexed route로 차단하며 이 방어를 임의 SQL 변조 전체의 인증 보장으로 확대하지 않는다.

전체 gate·source pin·최종45/76/20 focused source/bundle와 초기 import blocker·논리 hash fixture 호환은 [기계 판독 검증](../engine-goal-verification.json)에 기록한다. 집중 검사를 전체 검사 수에 더하지 않는다. [실행 계약](../engine-mcp-execution.md)이 운영 의미와 한도다.

## 남은 한계

receipt 없는 legacy 기록은 native state를 보존하며 전송·응답 증거를 backfill하지 않는다. 이번 보장은 새 typed tools/call에 대한 forward 계약이다. 원래 native chronology RED와 새 typed startup green은 서로 다른 증거다.

서버 terminal 선언은 외부 활동 전체의 종료/rollback 증거가 아니다. 현재 MCP 전용 복구 ACK/해제 API가 없으며 provider/summary ACK를 재사용하지 않는다. custom transport 실제 wire·외부 MCP 운영 계정·모든 플랫폼의 remote process 종료를 계측하지 않았다. 실제 프로젝트 unresolved 기록·provider/summary ACK와 GUI를 변경하지 않았다.

다음 G1-26은 같은 source `4a15286`의 별도 generic native tool SIGKILL fixture다. MCP receipt0인 requested/native-running-intent/callback-entered3phase에서 미시작 control1pass와 시작 경계2red가 source·private bundle에서 재현됐다. ToolRecord를 interrupted로 먼저 바꾼 뒤 Turn의 startup 판정에서 시작 intent가 누락되는 문제다. 원래 provider Attempt completed/cleanup confirmed와 정확한 요청 retry 재실행0은 유지되지만 다른 session 새 Run이 허용됐다. 이 fixture는 외부 효과/peer acceptance를 주장하지 않는다. `/tmp/moodcode-receiptless-tool-frontier-review-source-pins.json`에13개 파일·로그 SHA와 실제 source/bundle 결과를 남겼다. bounded owner-bound forward capture와 이미 interrupted인 과거 이력의 별도 retrospective 정책을 구분한다.
