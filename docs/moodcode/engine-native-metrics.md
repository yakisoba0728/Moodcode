# Native 엔진 진단 지표

`SqliteStore.getNativeMetrics(sessionId?: string): NativeMetricsReport`는 primary DB의 read transaction 하나에서 진단 snapshot을 반환한다. session ID를 생략하면 전체 DB, 지정하면 해당 session만 집계한다. 없는 session은 `SESSION_NOT_FOUND`, 닫힌 store는 `STORE_CLOSED`다. 조회는 이벤트·상태·복구 처리에 쓰지 않고 실행을 시작하지 않는다. prompt, tool output, provider replay, artifact 경로와 원본 문서 내용은 반환하지 않는다.

## 관측 범위

`coverage.records='all-primary-records-in-scope'`인 입력·Run·Turn·attempt·Part·checkpoint·summary revision은 현재 저장된 전체 record를 SQL로 집계한다. count, 상태, UTF-8 byte 합계와 시간 합계만 JavaScript로 반환한다. 전체 transcript나 snapshot을 먼저 읽지 않는다. SQL 결과 크기는 고정되어 있지만 scoped record count/byte/time 집계는 이력 규모에 따라 scan하며, distinct artifact ID 집계는 SQLite의 group 작업을 사용한다. 실행 시간이나 DB 내부 temporary storage 사용량이 일정하다는 보장은 아니다.

관측 이벤트는 아래 세 범주마다 **최근 2,000개의 matching v1 이벤트**만 사용한다. 관련 없는 이벤트는 한도를 차지하지 않는다. 각 `coverage.usage/summary/tools`는 matchingEvents, selectedEvents, omittedEvents, truncated, oldest/latest `{sessionId,seq}`와 filter를 제공한다. 모든 session을 합친 조회는 DB insertion order를 사용하며 서로 독립인 session seq를 비교하지 않는다. cursor의 seq는 v1이고 v2 journal과 교환할 수 없다.

| 범주    | Matching 이벤트                                                                        | 지표                                                 |
| ------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| usage   | `run.usage`, `context.prepared`                                                        | main usage observation 합계, 마지막 context metadata |
| summary | `summary.prepared/dispatched/completed/failed`, `provider.usage`의 `purpose='summary'` | 요약 lifecycle 관측, attempt별 마지막 usage snapshot |
| tools   | `tool.completed/failed/denied`, `checkpoint.artifacts`                                 | cleanup 불확실 관측, artifact 참조·binding           |

기존 `getMetrics(sessionId)`의 반환 형식과 의미는 그대로다. 그 API의 usageWindowTruncated 역시 모든 이벤트 가운데 최근 2,000개라는 뜻이 아니라 **run.usage/context.prepared matching 이벤트 합계의 한도**다. 새로운 report는 정확한 omitted 수와 cursor를 추가로 제공한다. v1과 v2에 동시에 기록되는 summary settlement는 v1만 읽어 두 번 세지 않는다.

## 지표 의미

입력은 pending/promoted/cancelled 상태와 queue/steer delivery를 구분한다. `pendingRequestBytes`는 pending 입력의 정규화된 AcceptInput JSON UTF-8 bytes이며 record metadata와 실제 DB 파일 크기를 포함하지 않는다. pendingAge는 조회 generatedAt에서 createdAt을 뺀 wall clock 시간이다. promotionWait는 promoted 입력의 updatedAt−createdAt이다. v1 backfill의 입력은 원본 Run timestamp를 두 필드에 사용하므로 0ms는 backfill 기록상의 간격이며 원래 큐 대기 시간의 측정이 아니다.

Turn/attempt/Part는 **현재 상태**를 센다. 동일 Part의 여러 revision을 여러 개로 세지 않는다. attempt retries는 index>0인 attempt record 수이고 turnsWithRetries는 해당 Turn 수다. retriesWithChangedContext는 직전 attempt와 contextRevisionId가 다른 경우다. 현재 attempt에는 retry의 HTTP/overflow 원인이 저장되지 않으므로 overflowRecoveries는 null이며 unavailable에 이유가 있다. 컨텍스트 변경을 overflow 성공으로 추정하지 않는다.

시간은 durable createdAt/completedAt 또는 dispatchedAt/completedAt의 간격이다. samples, missing, invalid, totalMs/minMs/maxMs를 함께 제공하며 elapsed가 없으면 합계도 null이다. parse할 수 없는 날짜와 역전된 간격은 invalid, 필요한 timestamp가 없으면 missing이다. 밀리초 간격은 SQLite julianday 차이를 반올림한다. 이는 wall clock interval이며 실제 provider CPU 시간, TTFT, tool effect 시간이나 높은 정밀도의 stopwatch 측정이 아니다. 합계가 safe integer를 넘으면 null이다.

providerUsage는 선택된 `run.usage`의 필드별 **observed-event-sum**이다. input/output은 inclusive total이고 cachedInputTokens는 input의 부분집합, reasoningOutputTokens는 output의 부분집합이다. 캐시·추론 값을 inclusive total에 다시 더하지 않는다. 새 runner는 main usage에 attempt identity를 덧붙일 수 있지만 legacy event에는 없고 기존 event-sum은 cumulative observation 중복이나 실제 청구 금액을 확정하지 못한다. 기존의 관측 event sum을 billing total로 바꾸지 않는다.

각 usage 필드는 `{tokens,observed,missing,invalid,sumOverflow}`다. 0도 observed이고, 한 번도 관측하지 못한 값은 null이다. safe nonnegative integer만 사용하며 boolean·음수·소수와 inclusive total을 초과한 cache/reasoning 값은 invalid다. 유효값과 누락이 섞인 경우 tokens는 관측된 부분 합계이며 observed/missing을 반드시 함께 확인해야 한다. 안전한 정수 범위를 넘는 합계는 null/sumOverflow=true다.

summary usage는 같은 summaryAttemptId에 대해 가장 나중의 provider.usage snapshot 또는 summary.completed.usage를 한 번만 사용한다. 완료 이벤트와 여러 cumulative usage snapshot을 더하지 않는다. 요약 실패 전에 관측한 usage도 포함한다. attempt ID가 없는 usage/completion 이벤트는 usageEventsWithoutAttemptId에 세고 deduplicated 합계에서 제외한다. 이 deduplication은 선택된 2,000 matching 이벤트 창 안에서만 완전하다. main usage와 summary usage는 별도 관측 범주로 반환한다.

## 아티팩트와 복구

artifact references는 모든 current media/tool Part의 참조와 tools 이벤트 창의 artifactRefs/checkpoint binding을 합친 **참조 출현 횟수**다. uniqueIds는 그 범위의 ID 집합이고 byte 합계는 ID마다 한 번만 계산한다. 같은 ID의 SHA 또는 byte 선언이 다르면 conflictingMetadataIds에 세고 해당 ID의 byte 합계를 제외한다. checkpoint-only ID처럼 byte를 모르는 참조는 storedBytesUnknownIds로 표시한다. declaredStoredBytes/declaredObservedBytes는 metadata를 아는 ID의 부분 합계이며 실제 디스크 점유량이 아니다. legacy path 기반 artifacts는 별도 legacyReferences/legacyDeclaredBytes이며 ID 기반 byte 합계에 합치지 않는다.

checkpoint는 원본 primary checkpoint record 전체의 total/incomplete/files/serializedJsonBytes다. JSON bytes에는 before/after file image와 metadata가 포함되며 현재 workspace 파일이나 artifact 저장소의 allocation을 뜻하지 않는다.

recovery는 recovery_required로 paused된 session, uncertain Turn/attempt, CLEANUP_UNCERTAIN Run과 선택된 tools 창의 cleanupConfirmed=false/cleanupUncertain=true 관측을 구분한다. workspacesWithDurableEvidence는 primary에 이런 recovery-required/uncertain/cleanup-error 상태가 남은 workspace의 distinct 수다. 실제 실행 coordinator의 메모리 quarantine 수, review journal, recovery acknowledgement ledger, terminal journal, artifact 파일 수·실제 bytes는 읽지 않는다. 관련 값은 null과 unavailable의 설명을 반환한다. recovery evidence와 runtime quarantine을 같은 값으로 간주하지 않는다.

## 검증

`storage/native-metrics.test.ts`는 빈 DB의 null/0, session/global scope, 조회 중 양쪽 journal 불변, pending UTF-8 quota bytes, 상태/retry/context-change, Korean Part bytes, wall clock 간격의 정상·누락·불량, inclusive cache/reasoning 관계, invalid/safe-integer overflow, 요약 cumulative snapshot/dual-journal settlement 중복 제거, 실패 요약 usage, 이벤트 창 omission, artifact ID 중복/불일치/unknown metadata, checkpoint 및 durable recovery evidence를 확인한다. 사용량 검증은 로컬 fixture이며 라이브 provider의 청구 API나 실제 artifact disk usage 검증은 포함하지 않는다.

## Durable attempt usage

DB3의 `attemptUsage`는 전체 scope의 attempt_usage record에서 attempt별 최신 snapshot 한 개만 합산한다. 기존 providerUsage의2,000-event 창과 별개이고 둘을 더하지 않는다. attemptsWithUsage/attemptsWithoutUsage를 제공하며 관측없는 필드는 null/missing, cached/reasoning은 inclusive subset이다. 실패 전 usage도 보존하고 중복 snapshot은 멱등이다. source=all-attempt_usage-records-in-scope, aggregation=latest-snapshot-per-durable-attempt이며 billedTokens=null이다. 데이터 migration은 legacy event에서 새로운 usage record를 추정하지 않는다.
