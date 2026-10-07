# 일반 provider Attempt의 종료 증거

DB6의 `attempt_cleanup`은 일반 모델 호출의 종료 관측을 `ProviderAttempt`의 결과 상태와 따로 저장한다. `confirmed`는 등록된 provider iterator가 끝났다는 엔진 관측이다. 원격 서버의 중지·과금 확정이나 모델 출력의 성공을 의미하지 않는다. timeout·transport 오류·취소로 outcome이 `uncertain`이면 cleanup이 확인되어도 그 outcome을 바꾸지 않는다.

구현은 `11da986`이며 [종료 수명 비교](research/2026-10-07-cleanup.md), [검증 결과](engine-goal-verification.md)를 따른다. 원본 구현·프롬프트·테스트를 복사하지 않고 Moodcode의 저장·복구 계약과 fixture로 작성했다.

## Identity와 상태

각 행은 하나의 ordinary Attempt에 속한다. session/workspace/Run/Turn, provider/model, 선택적 context revision, 요청 projection·SHA-256·UTF-8 byte count를 고정한다. projection은 `engine-turn-request-v1`이며 최종 Turn ID·Attempt ID·metadata 설정을 포함한 엔진의 `TurnRequest` JSON이다. 이미지 해석 wrapper와 provider HTTP encoding 전에 측정하므로 raw HTTP body·resolved pixels의 해시가 아니다. 원문 prompt·도구 설명·이미지 bytes를 cleanup 행에 저장하지 않는다.

| 상태 | 의미 | `cleanupConfirmed` |
| --- | --- | --- |
| `prepared` | identity를 저장했으며 dispatch intent가 없다 | null |
| `dispatched` | provider 실행 전 intent를 저장했다 | null |
| `confirmed` | 실제 `next().done === true` 또는 `return().done === true`를 관측했다 | true |
| `uncertain` | 종료를 관측하지 못했거나 재시작 시 dispatched가 남았다 | false |
| `not-dispatched` | prepared owner에 dispatch timestamp/request ID가 없음을 검증했다 | null |

terminal 행은 불변이며 동일 정산 재요청은 읽기 전용으로 반환한다. `finish: stop`, falsy/truthy 이외의 `done`, 외부 generator의 단순 종료, promise resolve만으로 confirmed를 만들지 않는다. registered adapter와 이미지 wrapper의 실제 iterator 반환 결과를 확인한다.

## 실행과 저장 순서

ordinary Attempt prepared → cleanup identity → cleanup dispatch intent → ordinary Attempt dispatched → provider factory 순서를 따른다. terminal cleanup과 v1/native journal은 한 트랜잭션에 저장하며 retry나 overflow 요약보다 앞선다. cleanup의 durable 정산이 실패하면 자동 retry와 계속 실행을 차단한다. dispatch intent 이후 ordinary journal이 실패한 경우도 실제 호출을 추정해서 안전하다고 바꾸지 않는다.

자연 종료 외의 중간 종료·출력 상한·protocol 실패·취소·저장 실패는 provider signal을 중단하고 실제 iterator의 return을 시도한다. 누락·거부·accessor 실패·timeout·`done !== true`는 uncertain이다. adapter return 대기는 1초다. coordinator가 Turn generator를 닫을 때는 기존 pending wait, 실제 return, durable 정산을 합류하도록 최대 3초의 별도 grace를 둔다. 타이머 경합 때문에 Run terminal 기록보다 cleanup 저장이 늦어지는 구간을 실제 엔진 fixture로 확인해 수정했다.

## 재시작·복구

startup은 존재하는 prepared/dispatched cleanup을 최대 100행씩 정산한다. strict no-dispatch 조건을 만족하는 prepared만 `not-dispatched`이며 나머지는 `uncertain/recovery`다. 오래된 ordinary Attempt에 새 proof를 만들어 backfill하지 않는다. 기존 outcome과 usage는 그대로다. DB5→6 migration은 빈 cleanup 테이블과 partial index만 추가하며 원래 기록을 보존한다. DB6 archive와 hash는 새 테이블을 포함하고 이전 archive 버전도 유지한다.

ordinary uncertain Attempt, uncertain cleanup, terminal Run에 남은 dispatched cleanup과 검증할 수 없는 uncertain Turn은 workspace의 새 접수·resume·maintenance를 재시작 뒤에도 차단한다. 기존 request의 exact retry 조회는 같은 receipt를 반환한다. DB7의 [일반 provider host 결정](engine-provider-recovery.md)은 independently confirmed cleanup과 exact uncertain dispatch에만 적용하며 원래 outcome을 보존한다. missing/unknown cleanup은 여전히 차단한다.

[summary host 결정](engine-summary-recovery.md)은 한 가지 좁은 origin을 처리한다. 최신 ordinary Attempt가 `failed`, 현재 Turn의 Parts가 0개이며 cleanup이 `iterator-return-done/error/PROVIDER_CONTEXT_OVERFLOW`로 confirmed인 경우에만, 그 실패 때문에 시작한 unknown summary의 owner·provider/model/context·시간 순서와 cleanup record SHA를 결합한다. ordinary uncertain Attempt나 별도 unknown cleanup에는 적용하지 않는다.

정상 실패 경로는 Turn의 `summaryDependency`에 exact summary ID·failed Attempt ID·cleanup SHA를 보존한다. startup 직전 summary가 streaming 또는 uncertain인데 아직 Turn 연결 기록이 저장되지 않은 경우, 불확실 결과가 없는 `interrupted` Turn을 같은 엄격한 origin 검사로 읽는다. 실제 SIGKILL 두 경계에서 이를 검증했다. ACK는 원래 interrupted/uncertain Turn, failed Attempt, cleanup, summary와 usage를 바꾸지 않고 새 작업을 명시적으로 접수할 수 있게 한다. 원래 호출의 재시도·요약 활성화·session resume는 0이다.

## 조회·지표·한도

host의 `getAttemptCleanup(sessionId, attemptId)`는 지정 session owner를 확인하고 typed 행을 반환한다. source/SQL identity·owner·요청 hash/context가 어긋나거나 oversized이면 실패한다. native metrics schema 6의 `attemptCleanup`은 상태별 수와 `attemptsWithoutObservation`을 반환한다. `recordValidity`와 `providerOutcomeConfirmed`는 null이며 이 SQL 집계만으로 증거 유효성이나 원격 결과를 확정하지 않는다. cleanup-only uncertainty도 `recovery.workspacesWithDurableEvidence`에 포함하지만 현재 admission 허용 여부는 별도 predicate가 판단한다.

cleanup JSON은 16KiB, owner JSON은 각각 1MiB, logical request bytes는 64MiB로 제한한다. execution predicate는 uncertain Turns 최대 64개, 선택 Turn payload 합계 8MiB를 제한하며 크기를 먼저 조회한다. 각 summary ACK/source에는 별도 증거 한도가 있다. 모든 owner 조회와 여러 ACK/source를 합친 단일 8MiB 한도나 물리 디스크 I/O 상한을 보장하지 않는다. 이러한 합산 예산과 반복 조회 비용은 후속 최적화 항목이다.

foreign owner·기록 변조·큰 payload·terminal mutation·native/v1 journal rollback·migration rollback·no-backfill·cancel/timeouts·consumer close·실제 overflow/ACK·다른 uncertainty·archive/import를 자체 fixture로 검증했다. 실제 Codex 검증은 임시 DB의 synthetic overflow/summary uncertainty 뒤 새 요청 1회와 실제 종료 proof 보존만 확인한다. 실제 미확정 Codex 서버 종료와 청구 결과를 검증한 것으로 확대하지 않는다. 앱은 실행하지 않는다.
