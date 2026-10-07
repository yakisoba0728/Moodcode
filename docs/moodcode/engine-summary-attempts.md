# 요약 요청의 저장·복구·사용량

완료된 대화의 semantic memory와 진행 중 Run의 active-prefix memory는 일반 model Turn/Attempt와 별도의 요약 요청이다. DB4의 `summary_attempts`와 `summary_usage`가 각 요청의 owner, 준비한 source/request identity, 상태, 제한된 부분 출력과 최신 사용량을 보존한다. 일반 `provider_attempts` 행이나 Turn/입력 allowance를 추가하지 않는다.

## 상태와 활성화

| 상태 | 저장된 근거 |
| --- | --- |
| `prepared` | source, request, provider/model, Run owner와 CAS 기대값을 준비했다 |
| `dispatched` | provider 요청을 시작하려고 했다 |
| `streaming` | 출력·진행·usage를 관측했다. 정상 stop과 iterator 완료를 확인해도 아직 활성화되지 않은 결과는 이 상태다 |
| `completed` | 정상 provider 완료·cleanup과 checkpoint/revision 활성화가 같은 DB 트랜잭션에서 확정됐다 |
| `failed` | cleanup을 확인했지만 유효한 요약이나 활성화 결과가 없다 |
| `interrupted` | 취소·close·재시작으로 종료됐고 요청 정리 또는 요청을 시작하지 않은 사실을 확인했다 |
| `uncertain` | provider cleanup이나 durable 정산을 확정하지 못했다 |

`finish: stop`만으로 성공 처리하지 않는다. 그 뒤 iterator의 `next().done === true`가 필요하다. 실패·취소 정리에서도 `return().done === true`를 확인한다. 내부 iterator의 실패 뒤 외부 generator가 닫혔다는 사실을 cleanup 증거로 사용하지 않도록, 엔진의 이미지 래퍼는 실제 내부 iterator 결과를 전달한다. 필수 정리에 실패한 요청은 자동 재시도하지 않는다.

provider가 끝난 결과에도 checkpoint CAS·source frontier·최종 context 계획 검증이 남는다. active-prefix는 summary revision, provider context revision, 두 문서의 활성 pointer와 typed completed 상태를 원자적으로 기록한다. 완료 이력 memory도 자신의 summary revision·memory pointer와 completed 상태를 함께 기록한다. 공개 상태 변경 API로 `completed`를 직접 만들 수 없다. 실패·충돌 때 기존 활성 memory/context를 유지한다.

## 부분 출력과 사용량

부분 텍스트 보관 한도는 65,536 UTF-8 bytes다. 실제로 관측한 bytes, 보관한 bytes, 보관 한도에 따른 잘림을 따로 기록한다. 거부한 출력 delta도 공유 Run 출력 예산과 관측 bytes에 반영한다. provider의 최종 답변 원문을 정상 transcript에 넣었다는 뜻은 아니다.

사용량의 input/output/cache/reasoning 네 필드는 관측 전에는 `null`이다. 최신 누적 snapshot만 보관하고 감소·음수·unsafe integer·inclusive total을 넘는 subset을 거부한다. cache/reasoning은 inclusive total의 부분량이며 더하지 않는다. 실패·중단·불확실한 요청도 마지막 유효 snapshot을 보존한다. terminal 상태에서는 동일 snapshot의 중복만 허용한다. 일반 Attempt 합계, 별도 요약 합계와 legacy journal 합계는 서로 다른 관측 지표이며 과금 합계로 표시하지 않는다.

native metrics schema 5의 `summaryAttempts`는 typed 상태와 부분 출력·publication 대기 수를, `summaryAttemptUsage`는 전체 typed 요청의 최신 사용량과 usage가 없는 요청 수를 반환한다. 기존 `summary`는 최근 2,000개 matching journal window의 관측을 계속 표시한다. DB1~3의 이벤트에서 typed 수명을 추정해 backfill하지 않는다. DB5의 결정 ledger와 DB6 ordinary cleanup 수는 원래 summary uncertainty와 별도로 집계하며 유효한 summary cleanup 수로 표시하지 않는다.

usage 조회는 retained text를 제외한 제한된 metadata projection과 SQL UTF-8 byte 검증을 사용한다. streaming 변경은 트랜잭션 안에서 전체 summary를 한 번 읽고, 이미 반영한 usage/progress를 다시 쓰지 않는다. `updatedAt`는 마지막 실제 저장 변경 시각이다. 서비스의 실시간 inactivity timer는 progress를 계속 관측한다.

## 재시작과 host 조회

재시작 시 prepared 요청은 interrupted, dispatched/streaming 중 cleanup proof가 없는 요청은 uncertain으로 정산한다. provider 완료와 cleanup이 확인됐지만 공개되지 않은 후보는 interrupted가 된다. 원래 Run이 terminal이어도 해당 요청의 owner를 확인해 정산한다. 미완료 후보를 자동 요청하거나 활성화하지 않는다. uncertainty는 session/workspace의 durable recovery 근거로 남는다. archive/export/import는 typed 상태와 usage를 보존하며 import가 실행 재개를 의미하지 않는다.

host는 session owner를 지정해 `getSummaryAttempt`, `getSummaryUsage`, `listSummaryAttempts`로 조회한다. 목록은 최대 100개와 별도 반환 byte cap을 적용하고, 잘못된 session/run cursor와 다른 owner의 요청을 거부한다. GUI 화면에 노출했다는 뜻은 아니다. [host API](engine-host-api.md), [active-prefix](engine-active-prefix.md), [최신 검증](engine-goal-verification.md)을 함께 따른다.

재시작 뒤에도 unresolved uncertainty는 새 작업을 차단한다. [명시적 host 복구 계약](engine-summary-recovery.md)은 부팅 전 기록과 정확한 source·저장소 binding을 확인해 별도 결정을 저장한다. 원래 요약을 재실행·활성화하거나 cleanup 상태를 성공으로 바꾸지 않는다.
