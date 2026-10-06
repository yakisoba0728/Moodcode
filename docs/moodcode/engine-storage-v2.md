# Native session 저장 계약

`SqliteStore(path, hostBudgets?)`는 하나의 SQLite owner와 transaction으로 v1 Run 저장과 v2 session 저장을 함께 처리한다. 기본 budget은 계약 패키지의 `DEFAULT_ENGINE_BUDGETS`를 따른다. 모든 변경은 record와 `session-v2` event를 같은 transaction에 쓰고 commit 뒤 subscription waiter를 깨운다. 원본 DB를 열었다는 이유로 실행이나 복구를 시작하지 않는다.

## 입력과 제어

| 메서드 | 결과 및 규칙 |
| --- | --- |
| `acceptInput(AcceptInput)` | `InputReceipt`; pending 입력만 저장한다. 같은 session/request ID의 prompt·config·delivery가 같으면 duplicate, 다르면 `REQUEST_ID_CONFLICT`다. |
| `getInput(inputId)` | 검증하고 복사한 `InputRecord`; 없으면 `INPUT_NOT_FOUND`다. |
| `listInputs(sessionId, cursor?, limit=50)` | `{inputs,nextCursor}`; cursor는 `{sessionId,afterSeq}`이고 다른 session에 재사용할 수 없다. limit은 1..100, page는 최대 8MiB다. |
| `pendingInputs(sessionId, delivery?, limit=100)` | admitted 순서의 pending prefix. limit은 1..1024, record JSON을 읽기 전 SQL byte metadata로 8MiB를 제한한다. |
| `promoteInput(inputId, runId?)` | `{input,run,receipt}`. runId 생략 시 가장 오래된 pending 입력을 실제 Run admission과 원자적으로 연결한다. runId 지정은 같은 active Run에 steer를 원자적으로 연결하며 user 메시지도 함께 기록한다. |
| `promoteSteers(inputIds, runId)` | bounded distinct batch를 pending steer 순서로 한 transaction에서 반영한다. 하나가 실패하면 모두 rollback한다. |
| `cancelInput(inputId)` | pending→cancelled, 재호출은 idempotent. promoted 입력은 Run cancellation을 사용한다. |
| `listRunInputIds(runId)` / `listRunInputs(runId)` | 최대 1024개의 provenance. 전체 record 읽기는 8MiB도 검사한다. |
| `getSessionControl(sessionId)` | `{sessionId,paused,revision,updatedAt,reason?}`; 미생성 control은 revision 0이다. |
| `setSessionPaused(sessionId, paused, reason?)` | durable 제어. reason은 `user`, `run_cancelled`, `recovery_required`다. 동일 값은 event를 추가하지 않는다. |

Pending quota는 session별 count와 정규화된 입력 JSON의 UTF-8 bytes를 합산한다. 기본값은 64개/1MiB이며 host budget과 입력 config budget 중 더 작은 값을 적용한다. 개별 입력이 host quota를 늘릴 수 없다. duplicate를 quota보다 먼저 확인하고, cancelled/promoted 입력은 pending 용량을 차지하지 않는다. workspace 실행 공정성과 wake scheduling은 runner의 책임이다.

`InputRecord.admittedSeq/promotedSeq`와 `InputReceipt.admittedSeq`는 v2 stream 순서다. `InputPromotion.receipt.admittedSeq` 및 기존 v1 `RunReceipt`는 v1 stream 순서다. `readSessionEvents(sessionId,afterSeq,limit=100)`와 `subscribeSessionEvents`는 v2만 읽으며 기존 `readEvents`/`subscribe`와 cursor를 교환하지 않는다. read limit은 1..100, page는 8MiB다. subscriber는 read 전에 waiter를 등록해 commit 사이의 wake를 놓치지 않는다.

## 실행 기록

`putTurn/getTurn/listTurns`, `putAttempt/getAttempt`, `putPart/listParts`, `putContextRevision/getContextRevision`은 session→Run→Turn→attempt/Part ownership을 검사한다. 모든 record는 schemaVersion 2이며 v1 snapshot을 재작성하지 않는다. 새 Turn은 index 0부터 연속이고 이전 Turn settlement가 필요하다. 새 attempt는 prepared부터 시작하며 dispatch 전 durable 기록을 만든다. prepared→dispatched→streaming→terminal 전이를 기록하고, failed attempt 뒤에만 bounded retry를 허용한다. 기본 provider attempt allowance는 2다.

새 Part는 message별 index 0부터 연속이며 revision 0/open으로 시작한다. 갱신은 revision+1이며 text/reasoning의 durable prefix를 다시 쓸 수 없다. tool arguments와 Part identity는 불변이다. 한 Turn의 Part는 최대 4096개와 host `maxProducerBytes`를 적용한다. 기본 byte cap은 16MiB다. Turn 완료는 latest provider attempt completed와 모든 Part settlement가 필요하다. terminal Turn/attempt/Part는 같은 값의 재저장을 제외하고 변경할 수 없다.

`listTurns`는 Run당 1024개/16MiB, `listParts`는 Turn당 4096개/16MiB를 record JSON을 읽기 전에 검사한다. 초과는 부분 성공 대신 오류다. `listTurnsPage(runId,afterTurnId?,limit=50)`와 `listPartsPage(turnId,afterPartId?,limit=100)`는 owner에 속한 ID cursor, 1..100 limit, 8MiB prefix page를 반환한다. 결과는 각각 `{turns,nextCursor}` / `{parts,nextCursor}`다. nextCursor가 null이면 현재 끝이다.

Context revision은 session별 revision 1부터 연속이며 text의 SHA-256을 검증한다. 저장된 revision은 불변이고 supersedesId가 있다면 바로 이전 revision이어야 한다. Turn에 한 번 연결한 context revision은 바꿀 수 없다.

`nextContextRevisionIndex(sessionId)`와 `getLatestContextRevision(sessionId)`는 각각 최신 revision+1과 최신 record 하나를 SQL로 읽는다. allocation은 예약이 아니므로 실제 저장 시 연속 revision 검증을 다시 한다. `commitContextDocument(runId,eventType,payload,{revision,kind,expectedRevision,data})`는 immutable context revision·active 문서 CAS·v1/v2 settlement 이벤트를 하나의 transaction에서 활성화한다. journal insertion이나 CAS 실패는 전부 rollback한다. `hasActiveRuns(workspaceId,excludedRunId?)`는 전체 snapshot 없이 indexed workspace 실행 여부를 확인한다.

명시적 `recoverInterrupted`는 prepared attempt를 interrupted, dispatched/streaming attempt를 uncertain으로 바꾼다. 열린 Part를 interrupted로 닫으며 마지막 durable prefix를 유지한다. 모호한 provider dispatch를 가진 Turn은 uncertain으로 남고 session을 `recovery_required`로 pause한다. 재시작 시 자동 provider 재전송이나 effect 재실행은 하지 않는다.

## 문서와 모델 이력

`getSessionDocument(sessionId,kind)`는 `{revision,data}|null`, `putSessionDocument(sessionId,kind,expectedRevision,data)`는 새 `{revision,data}`를 반환한다. 최초 expectedRevision은 0이고 이후 현재 값과 일치해야 한다. stale write는 `REVISION_CONFLICT`다. kind는 소문자로 시작하는 1..64자 `[a-z0-9_.-]` namespace이고 plain JSON data는 262144 bytes 이하로 복사·검증한다. journal은 kind/revision/hash만 기록하며 문서 변경과 원자적이다.

`readModelHistory(sessionId,maxMessages=200,maxBytes=8MiB)`는 `{snapshot,omittedRuns,omittedMessages,beforeRunId}`를 반환한다. 전체 `getSnapshot`을 먼저 호출하지 않고 최근 129 Run의 indexed count/byte metadata를 읽어 최대 128 Run의 완전한 묶음을 선택한다. 메시지/tool/approval/native replay를 같은 Run 묶음으로 보존한다. maxMessages는 1..4096, maxBytes는 1024..32MiB다. 가장 최근 필수 Run 묶음이 들어가지 않으면 `MODEL_HISTORY_LIMIT`이며 그 Run의 tool exchange를 잘라 내지 않는다. v1 전체 snapshot과 event cursor는 별도로 유지한다.

`searchHistory(sessionId,{query,beforeMessageId?,limit=50,maxBytes=262144})`는 `{matches,nextCursor}`다. match는 `{messageId,runId,role,createdAt,snippet,contentBytes,truncated}`이며 source provenance를 유지한 plain content excerpt다. query는 최대 1024 UTF-8 bytes의 literal string이고 SQL wildcard와 backslash를 escape한다. session에 속한 beforeMessageId만 cursor로 허용하며 최신 message부터 내림차순으로 읽는다. limit은 1..100, maxBytes는 1024..1MiB다. SQLite가 source content에서 최대 512 Unicode character snippet만 projection하므로 큰 원문을 JavaScript에 먼저 로드하지 않는다. native replay/암호화 continuation은 검색 대상과 결과에 포함하지 않으며, recalled text를 새 instruction이나 command로 활성화하지 않는다.

`native-crash.test.ts`는 실제 child process의 admission·promotion·attempt prepared·provider dispatch·Run settlement 직전/직후를 SIGSTOP→SIGKILL한다. 재시작 후 기존 provider 호출/자체 fixture write-tool effect 수의 추가가 0이고, 원본 v1/v2 event prefix·Input identity·completed Turn이 유지되는 것을 확인한다. dispatched attempt는 uncertain, prepared attempt는 interrupted이며 active Run과 session은 interrupted/recovery_required로 보호한다. 이미 완료된 Run 뒤의 pending queue도 startup에서 자동 실행하지 않는다. 해당 6개 signal fixture는 Windows에서 skip한다.

Focused storage test는 실제 v1 migration, injected journal rollback, 요청 충돌/용량, atomic queue/steer promotion, dual subscriptions, provider dispatch recovery, Part prefix/terminal guards, CAS rollback, bounded model query를 검증한다. 라이브 provider와 GUI는 이 테스트 범위에 포함하지 않는다.

`getNativeMetrics(sessionId?)`는 전체 primary 상태 SQL 집계와 범주별 최신 2,000 matching v1 이벤트 관측을 read transaction으로 제공한다. 기존 `getMetrics`는 유지하고, event coverage·usage 포함 관계·byte/time 출처·외부 저장소 미관측은 [Native 지표 계약](engine-native-metrics.md)을 따른다.
