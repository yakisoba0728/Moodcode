# 지속 개선 최신 검증

2026-10-07, macOS arm64 / Node 26.9.0. 일곱 번째 구현 commit은 `5d70a228d166d767b9e788b843c97c7f4b3e1569`다. [기계 판독 결과](engine-goal-verification.json), [일반 provider 복구](engine-provider-recovery.md), [summary proof V2·호환](engine-summary-recovery.md), [TODO](../../TODO.md)를 따른다. GUI·Electron은 실행하지 않았고 실제 프로젝트의 unresolved 기록에 대신 결정하지 않았다.

| 검증 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과 |
| 동일 전체 목록, `MOODCODE_ENGINE_TEST_CONCURRENCY=2 npm run test:engine` | 2,057 tests · 2,055 pass · 실패 0 · 조건부 2 skip · 66,882.709792ms |
| 컴파일 집중 검사 | 174/174 통과; 전체 gate와 겹치므로 합산하지 않음 |
| 코딩 fixture 평가 | 3/3 통과 |
| 커밋 후 실제 Codex | 일반 provider 복구 뒤 새 Run 1회, overflow summary 복구 뒤 새 Run 1회, active-prefix 요약·최종 답변 2회 통과 |

## 일곱 번째 구현과 독립 검토

- **일반 결과의 별도 host 결정**: DB7 `provider_recovery_acknowledgments`에 confirmed cleanup, exact terminal Run/최신 Turn·uncertain Attempt, logical request/context·원래 입력·usage·부분 출력·도구 관측·immutable refs의 fingerprint를 저장한다. same-boot 신규 uncertainty는 재시작을 요구한다. 정상 취소의 확정 interrupted 호출은 NOT_NEEDED이며 missing/unknown cleanup은 차단한다. 원래 outcome/usage/control/inbox를 바꾸거나 원래 호출 retry/activation/resume를 수행하지 않는다.
- **부분 도구 제안**: 완성된 `tool.call`을 provider 완료 전에 Part로 보존한다. 실제 도구는 유효한 finish 이후에만 실행하므로 transport/timeout 때는 interrupted 제안/input만 남는다. 실제 부분 text/reasoning/media/proposal와 prior completed read, promoted steer를 확인했다. 원래 user/steer message가 정확한 admission/promoted input과 다른 경우를 차단했다.
- **참조와 도구 증거**: 일반 ToolResultEnvelope.metadata의 도메인 상태를 cleanup 증거로 오인하던 검사를 수정했다. bare source IDs의 missing/foreign/ambiguous owner와 이전 semantic summary의 누락을 차단하고, earlier revision의 원본까지 bounded closure로 pin한다. ACK 이후 baseline-only 원문/중간 요약/Run·Turn owner drift도 검증한다. 임의 파일·pixels·HTTP 재조회는 복구 source로 사용하지 않는다.
- **summary proof V2**: 기존 pin 목록이 fingerprint에 결합되지 않아 목록 제거가 coverage를 무력화하던 문제를 수정했다. DB7 SQL pin SHA·original startup frontier와 V2 domain scope를 fingerprint에 결합하고 validation에서 다시 계산한다. baseline-only drift 뒤 pin 제거·coordinated pin digest 변경·closure 누락을 거부한다. 기존 DB5/V1 body/scope/fingerprint와 정확한 역사 receipt는 그대로 보존하되 V1 admission은 inactive다. 새 V2 결정은 host의 명시적 새 요청을 요구하며 자동 재승인하지 않는다.
- **원자 저장·crash·운영**: provider uncertain Attempt 저장 뒤 Turn fail 전, ACK COMMIT 직전/직후의 세 프로세스를 실제 SIGKILL했다. native/v1 audit 실패 rollback, DB6→7 migration 전체 rollback과 기존 opaque 기록/V1 decision 보존, DB7 archive/import의 새 physical binding을 확인했다. 여러 ordinary candidate·독립 summary/effect·live owner/maintenance·queue/control blocker를 보존한다. metrics schema 6은 원래 uncertainty와 historical/raw 결정 수를 분리하며 validity/outcome은 null이다.
- **검증 fixture 보존**: host close 성공만으로 live cleanup을 확정하던 검증 경계를 수정했다. 실제 natural-done proof와 host close를 따로 확인하며 실패하거나 종료 proof가 확인되지 않으면 임시 DB를 보존한다. 새 복구 검증과 기존 overflow 검증은 startup부터 whole snapshot을 금지한다.

## 실제 모델 범위와 조회 비용

`verify-provider-recovery.mjs --live`는 private DB에서 authored transport 오류와 text/reasoning/미실행 tool proposal를 만든 뒤 한 번의 명시적 host 결정을 사용했다. 기존 인증의 실제 Codex 새 요청은 정확히 1회이고 input/output 448/5를 관측했다. 원래 unknown state·부분 관측·usage·control/context는 그대로이며 실제 logical request 2,617 bytes의 SHA가 natural-done proof와 일치한다. 새 Run의 head revision 1→2와 재시작 뒤 receipt/pins가 유지됐다. 실제 unknown Codex 서버 종료를 재현한 검증은 아니다.

기존 overflow-summary fixture의 V2 결정 뒤 실제 새 요청 1회도 통과했다. input/output 1,586/5, logical request 12,003 bytes, head revision 2→3과 원래 failed ordinary/uncertain summary·usage input 9/output null 보존을 확인했다. active-prefix는 fixture-directed read 20회 뒤 실제 summary input/output 1,986/184와 final 2,686/23을 관측했다. raw tool source가 요청에서 빠진 임의 값을 memory에서 정확히 회수했고 context는 14,754/16,384 bytes였다. 세 live script 모두 통과·종료 확인·임시 파일 정리, snapshot 0회다. 모델의 자율 20턴 코딩 전략·원격 서버 uncertainty·과금 결과로 확대하지 않는다.

현재 full gate의 synthetic 1k/10k ordinary predicate는 clear 199 bytes·5 queries, 첫 unknown 204 bytes·2 queries로 같았다. configured summary의 첫 미승인 후보는 211 bytes·3 queries, 10k synthetic ledger 후보의 cap은 2,987 bytes·4 queries이며 retained text/body validation 이전에 차단했다. writes·full snapshot은 0이다. 이는 JavaScript에 반환된 SQL 값과 단일 elapsed 표본이며 물리 I/O·전체 proof aggregate·production 처리량 상한이 아니다. provider 후보 자체는 64개/선택 증거 8MiB를 제한하지만 provider/summary/Turn 및 owner 조회를 합친 예산과 중복 읽기는 후속이다.

초기 source provider 통합의 3개 실패는 새로 보존한 interrupted tool Part를 옛 기대값이 빠뜨린 경우였다. proposal의 input/state/no execution을 확인하도록 수정했다. 첫 compiled 집중 검사의 1개 실패는 기존 archive fixture의 DB6 고정값이며 현재 DB_VERSION을 확인하도록 수정했다. 이후 집중 174/174와 첫 전체 2,057개 gate가 통과했다. 이전 각 묶음의 실패·exit 137은 해당 역사 보고서에 보존한다.

G1-18과 G1-20을 완료했다. 다음은 **G1-19 공유 조회 예산·중복 source 읽기**다. 원래 75개 중 71개 완료, 외부 OS/provider/hosted CI 항목 E5-08/E5-13/E6-07/E6-08과 image token 비용·GUI 노출은 그대로 남는다. Git remote는 없으며 goal은 활성 상태다. [여섯 번째 JSON](engine-goal-sixth-verification.json)은 이전 내용을 정확히 보존했다.

---

# 여섯 번째 묶음의 이전 검증

2026-10-07, macOS arm64 / Node 26.9.0. 여섯 번째 구현 commit은 `11da9861f436b1c70daf34a7815c48ef7a8681fa`다. [여섯 번째 기계 판독 결과](engine-goal-sixth-verification.json), [일반 Attempt 종료 계약](engine-attempt-cleanup.md), [summary 복구](engine-summary-recovery.md), [TODO](../../TODO.md)를 따른다. GUI·Electron을 실행하지 않았고 프로젝트의 실제 unresolved 기록을 대신 승인하지 않았다.

| 검증 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과 |
| 동일 전체 목록, `MOODCODE_ENGINE_TEST_CONCURRENCY=2 npm run test:engine` | 1,968 tests · 1,966 pass · 실패 0 · 조건부 2 skip · 64,472.414791ms |
| 코딩 fixture 평가 | 3/3 통과 |
| 컴파일 집중 검사 | 132/132, 이후 실제 crash/integration 24/24; 전체 gate와 겹치므로 합산하지 않음 |
| 커밋 후 실제 Codex | 새 ordinary Run 1회, active-prefix 요약 1회·최종 답변 1회 통과 |

## 여섯 번째 구현과 독립 검토

- **별도 종료 증거**: DB6 `attempt_cleanup`에 owner·provider/model·context·logical request SHA와 bytes를 고정한다. prepared/dispatched intent, confirmed/uncertain/not-dispatched를 구분하며 terminal과 native/v1 audit를 원자 저장한다. 실제 `next/return().done === true`만 confirmed다. finish 이벤트·외부 generator 종료·promise resolve는 근거로 사용하지 않는다. outcome uncertainty와 usage를 바꾸거나 legacy proof를 backfill하지 않는다.
- **소비자 종료와 타이머**: 출력/protocol/저장 실패·취소 때 실제 adapter return을 시도하고 정산을 저장한 뒤 Run을 종료한다. 독립 실제 엔진 검사에서 1초 inner/outer 타이머 경합을 재현해, adapter return 한도 1초와 Turn generator 정산 합류 grace 3초를 구별했다. 저장 flush 오류가 return 시도를 건너뛰던 경계와 이미지 wrapper의 truthy done도 수정했다.
- **격리와 좁은 origin**: ordinary uncertain Attempt·unknown cleanup은 재시작 뒤 새 작업·resume·maintenance를 계속 차단한다. summary host 결정은 최신 failed ordinary Attempt, 0 Parts, 확인된 overflow return, 동일 owner/provider/model/context·시간 순서·cleanup SHA를 만족하는 정확한 origin만 처리한다. wrong source/hash/cleanup payload와 다른 ordinary uncertainty는 차단한다. 원래 Turn/Attempt/summary·usage·queue/control은 유지한다.
- **실제 crash**: summary usage 저장 직후와 uncertain 정산 직후, Turn dependency 저장 전의 두 프로세스를 실제 SIGKILL했다. startup의 interrupted Turn을 strict origin으로 읽어 host 결정을 만들고 새 명시적 작업만 실행했다. 종료 proof와 failed ordinary Attempt는 불변이며 원래 요약 retry/activation/resume는 0이다.
- **migration·archive·진단**: DB5→6의 기존 opaque 기록·partial usage·events 보존과 주입 실패 rollback, foreign owner·large record·journal 실패를 확인했다. DB6 archive/hash가 typed cleanup을 보존한다. native metrics schema 5의 상태·missing observation은 raw SQL counts이며 record validity/원격 outcome은 null이다. cleanup-only unknown도 durable workspace evidence에 포함한다.

## 조회 비용과 실제 모델 범위

1천/1만 개 synthetic 완료 ordinary 행에서 configured execution predicate는 모두 clear 199 bytes·5 queries, 첫 unknown 204 bytes·2 queries였다. writes·summary text·full snapshot은 0이다. synthetic uncertain Turns 65개는 payload를 읽기 전 7,858 bytes·5 queries로 차단했다. 이는 JavaScript로 반환된 SQL 값과 단일 elapsed 표본이며 물리 I/O나 처리량 보장이 아니다. Turn payload 합계 8MiB와 각각의 ACK/source 예산은 별도이며 전체 합산 8MiB를 보장하지 않는다.

`verify-attempt-cleanup.mjs --live`는 private fixture의 ordinary overflow/unknown summary 뒤 기존 인증으로 새 Codex 요청 1회만 허용한다. 실제 요청의 logical SHA·12,003 bytes·context identity가 cleanup 행과 일치했고 natural done proof가 재시작 뒤 보존됐다. actual input/output은 1,586/5, 원래 synthetic summary usage는 input 9/output null이다. host 결정은 context head revision 2를 보존했고 새 Run이 3으로 변경한 뒤에도 exact decision retry가 유지됐다. unknown Codex 서버 종료나 실제 과금 확정 검증으로 표시하지 않는다.

같은 commit의 active-prefix 검증은 fixture-directed 읽기 20회 뒤 실제 요약 input/output 1,987/186을 관측했고, 원문 도구 결과가 요청에서 빠진 임의 값을 기억에서 정확히 회수했다. context는 14,755/16,384 bytes, full snapshot 조회는 0이다. 모델의 자율 코딩 전략을 검증한 것은 아니다. 두 live script 모두 engine close와 임시 파일 정리를 확인했다.

첫 집중 검사의 유일한 실패는 archive fixture가 DB 버전 5를 고정한 기대값이었다. DB_VERSION 사용으로 수정한 뒤 132개가 통과했다. 이후 첫 전체 1,965개 통과 상태에서 독립 리뷰가 crash origin과 truthy done을 찾아 3개 검사를 추가했고 최종 전체 1,968개가 통과했다. 새 crash fixture의 contextual iterator 타입 오류도 수정했다. 성공·중간 결과·실패 범위를 JSON에 구별했다.

G1-17을 완료했다. 다음 G1-18은 cleanup이 확인되어도 남는 ordinary outcome uncertainty의 명시적 host 결정, G1-19는 여러 source 검증의 공유 조회 예산이다. 원래 열린 외부 OS/provider/hosted CI 항목과 media token 비용·GUI 노출을 유지한다. Git remote는 없고 goal은 활성 상태다.

---

# 다섯 번째 묶음의 이전 검증

2026-10-07, macOS arm64 / Node 26.9.0. 다섯 번째 구현 commit은 `29b59a115bacac79e4a55a4429618ea455b8553d`다. [다섯 번째 기계 판독 결과](engine-goal-fifth-verification.json), [명시적 host 복구 계약](engine-summary-recovery.md), [요약 수명·사용량](engine-summary-attempts.md), [TODO](../../TODO.md)를 함께 확인한다. GUI·Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,896 tests / 1,894 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 |
| 실제 복구 엔진 경계 | 12개 integration·7개 lease·16개 source unit, journal rollback·commit 전후 실제 SIGKILL·archive/import·queue 보존 |
| 저장소 측정 | 같은 1k/10k typed fixture·64KiB 부분 출력, 이전 commit class와 현재 구현 비교·실제 partial index plan 확인 |
| 커밋 후 실제 Codex | summary+answer 2회, 임시 uncertainty 결정 뒤 명시적 새 Run 1회 성공·종료/임시 파일 정리 확인 |

`npm run typecheck`, `MOODCODE_ENGINE_TEST_CONCURRENCY=2 npm run test:engine`, `node scripts/evaluate-engine.mjs`를 실행했다. 전체 gate의 테스트 목록을 줄이지 않았고 기본 동시성은 4로 유지한다. 후속 검증은 동일한 구현 commit에서 `node scripts/verify-active-prefix.mjs --live`, `node scripts/verify-summary-recovery.mjs --live`를 기존 로컬 Codex 인증으로 실행했다. source·compiled focused 결과는 서로 겹치므로 전체 테스트 수에 더하지 않는다.

## 다섯 번째 구현과 독립 검토

- **명시적 복구 결정**: DB5의 append-only `summary_recovery_acknowledgments`와 host preview/ACK를 연결했다. startup recovery 전에 캡처한 부팅 frontier·정확한 owner/source/revision·usage·결정 시 context baseline·물리 DB/artifact identity를 검증한다. ledger·native/v1 audit는 한 트랜잭션이며 결정은 원래 uncertainty·usage·부분 출력·memory·pause·inbox를 보존한다.
- **수명과 격리**: 전용 quiescent lease는 일반 실행·command cleanup·복원·maintenance·별도 runtime quarantine을 계속 차단한다. 결정 중 다른 session의 unpaused ticket이 자동 pause되던 실제 경계를 수정했다. 대기 ticket만 정리하고 durable inbox/control과 명시적 후속 실행을 유지한다. persisted summary blocker를 generic runtime quarantine에 섞지 않는다.
- **반복과 재시작**: 같은 request/fingerprint는 이후 context head 변화·재시작·maintenance·다른 runtime quarantine에도 읽기 전용 원래 receipt를 반환한다. 승인된 불변 source/pins가 바뀌면 새 실행을 차단한다. archive/import는 ledger를 보존하지만 새 물리 저장소에서 원래 결정을 실행 허용 근거로 쓰지 않는다. 실제 자식 프로세스의 ACK COMMIT 전 SIGKILL은 record/audit 0개, COMMIT 후 SIGKILL은 1개를 보존했다. 자동 provider retry·checkpoint activation은 0이다.
- **조회와 스트리밍**: usage는 retained text 없이 metadata와 owner/proof를 검증한다. 쓰기 경로는 트랜잭션 안에서 full record를 한 번 읽고 같은 usage/progress/빈 delta는 상태 전환 이후 durable write를 생략한다. 실제 관측·nullable 사용량·UTF-8·정산·journal rollback 의미는 유지한다. DB5의 workspace uncertainty partial index를 fallback과 configured admission에 연결했다.
- **migration·검사 상한**: DB4의 opaque 기록·nullable usage·native/v1 event를 보존하며 DB5에 빈 ledger와 index를 추가한다. 주입한 migration failure는 rollback한다. 64개 후보·source 512 messages/128 Turns 또는 Runs·선택 증거 2MiB/8MiB·ledger 64KiB 한도를 넘거나 증거가 불완전하면 차단한다. owner/header 추가 조회를 포함한 모든 SQL 반환량이나 SQLite 물리 I/O를 이 예산으로 보장하지 않는다.

## 저장소 비용의 조건부 측정

동일한 synthetic primary fixture에 실제 65,536-byte summary observation을 기록하고 이전 `ede1519`의 storage class와 현재 빌드 class를 각각 실행했다. baseline source SHA-256은 `1edaec5d64c6be8e7d3090f552d45927e59e7a2ba703724ca0d9e736eb7ab98c`다. 1천/1만 행 모두 아래 SQL 반환량·query·write 수가 같다. 이는 JS로 반환된 SQL 값의 계측이며 물리 디스크 읽기량이나 production 처리량이 아니다. 한 번씩의 elapsed 값은 JSON에 그대로 남겼다.

| 연산 | 이전 → 현재 JS SQL bytes | 이전 → 현재 query | 이전 → 현재 write |
| --- | --- | --- | --- |
| getUsage | 67,849 → 2,378 | 7 → 7 | 0 → 0 |
| 같은 usage/progress | 202,775 → 67,849 | 17 → 7 | 1 → 0 |
| text observation | 202,775 → 67,849 | 17 → 7 | 1 → 1 |
| terminal settlement | 136,206 → 68,744 | 15 → 10 | 4 → 4 |

최종 gate의 configured uncertainty 조회는 첫 미승인 후보에 211 bytes·3 query, unrelated workspace에 189 bytes·3 query, clear workspace에 163 bytes·2 query를 반환했다. 모두 summary text·큰 context·snapshot·write는 0이다. 1만 불확실 후보에서도 첫 미승인 행은 211 bytes로 차단했고, synthetic ledger cardinality로 후보 상한을 넘겼을 때는 65개 identity의 2,987 bytes·4 query 후 차단했다. synthetic ledger 행을 유효한 ACK로 인정한 검증이 아니다.

## 커밋 후 실제 모델 확인

`gpt-6.1-sol`에서 20번 fixture-directed local read 뒤 실제 summary 한 번과 최종 답변 한 번을 실행했다. 원본 도구 메시지가 요청에서 빠진 임의 값을 memory에서 정확히 회수했고, typed summary는 completed/activated·cleanup true였다. 요약 요청 7,642 bytes, retained text 907 bytes·truncation false, 최종 context 14,772/16,384 bytes, full snapshot 0회다. summary input 1,964/output 202와 ordinary Attempt input 2,567/output 19는 별도 합계이며 미제공 summary cached/reasoning·20개 fixture usage는 null/누락으로 유지했다. 모델의 20턴 자율 코딩 전략 평가로 확대하지 않는다.

복구 live의 uncertainty는 cleanup 연산이 없는 **임시 provider fixture**다. 같은 boot의 preview 차단, restart 후 eligible, exact host ACK, 원래 state/usage/부분 출력·pause/memory 보존을 먼저 검증했다. 이후 실제 Codex 새 Run 한 번이 `READY`로 완료됐고 input 2,739/output 5를 관측했다. head 변화와 두 번째 재시작 뒤 ACK가 유효하고 exact retry는 duplicate이며 source summary retry·candidate activation은 0이다. stored uncertain은 여전히 1개, 결정 record 1개, full snapshot 0회다. 실제 Codex transport가 불확실해진 상황이나 원격 cleanup/과금을 검증했다고 표시하지 않는다. 실제 프로젝트의 unresolved 기록에는 결정을 내리지 않았다.

## 전체 gate의 재실행 기록과 남은 범위

첫 gate의 후보 상한 fixture는 추가된 empty-workspace indexed preflight를 포함하지 않아 query 기대값 3/실제 4로 실패했다. 두 번째는 기존 Git timeout fixture의 Node interpreter가 500ms 안에 PID marker를 쓰지 못했다. 첫 fixture의 실제 query 수를 반영하고, 두 번째 fixture는 POSIX shell이 owned PID를 먼저 쓰고 `exec sleep`해 실제 OS 종료 검증을 유지하도록 수정했다. 세 번째 전체 실행은 aggregate 없이 exit 137로 끝났고 원인은 확정하지 못했다. 세 결과와 hash를 성공 결과와 구분해 JSON에 보존했다. 최종 같은 테스트 목록의 동시성 2 실행은 1,896개·실패 0이다.

G1-15/16을 완료했다. 다음 **G1-17**은 일반 provider Attempt의 실제 cleanup 관측을 durable 증거로 남기는 작업이다. overflow 요약과 일반 Turn/Attempt가 함께 uncertain이면 현재 host 결정도 차단하며, 기존 상태에서 cleanup을 추정해 backfill하지 않는다. 이미지 token 비용·다른 media·실제 Anthropic·Windows native backend·hosted Linux/Windows/Node24 CI·GUI 노출은 남아 있다. Git remote는 없고 goal은 활성 상태다. 아래 과거 결과는 해당 구현 commit의 근거로 보존한다.

---

# 네 번째 묶음의 이전 검증

2026-10-07, macOS arm64 / Node 26.9.0. 네 번째 구현 commit은 `ede15196edc16f63ee8c4183f628c50d6745df2d`다. [네 번째 기계 판독 결과](engine-goal-fourth-verification.json), [요약 수명 명세](engine-summary-attempts.md), [host API](engine-host-api.md), [TODO](../../TODO.md)를 함께 확인한다. GUI·Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,850 tests / 1,848 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 |
| 실제 요약 엔진 경계 | 19개 lifecycle, 8개 quarantine, 8개 provider cleanup, 두 scope 서비스·storage·metrics fixture 통과 |
| 실제 세션 이미지 경계 | storage 10개·actual engine 5개, 재시작/40턴/cutoff/unsupported/cap·full snapshot 0 |
| 커밋 후 실제 Codex | 요약+답변 2회, 이미지+재시작 text Run 2회 성공·종료/임시 파일 정리 확인 |

`npm run typecheck`, `npm run test:engine`, `node scripts/evaluate-engine.mjs`를 실행했다. 같은 커밋에서 `node scripts/verify-active-prefix.mjs --live`, `node scripts/verify-session-image.mjs --live`를 기존 로컬 Codex 인증으로 검증했다. 새 인증·외부 발행·GUI 실행은 수행하지 않았다.

## 네 번째 구현과 독립 검토

- **별도 요약 기록**: DB4의 typed summary attempt와 latest nullable usage를 두 요약 서비스에 연결했다. prepared/dispatch/streaming, 정상 stop+iterator 완료·확인된 cleanup, publication 대기, 실패/interrupted/uncertain을 나눈다. summary를 ordinary Turn/Attempt로 만들지 않는다. source/owner/CAS/revision metadata를 비교하고 실제 checkpoint·pointer 활성화 트랜잭션 안에서만 completed로 바꾼다.
- **실패·재시작**: 64KiB retention cap, UTF-8 잘림·surrogate split, 공유 output/summary allowance, partial usage 회귀, native/v1 journal fault와 양 pointer/revision rollback을 확인했다. prepared/dispatched/provider-completed unpublished 세 단계 실제 강제 종료 뒤 자동 retry·activation은 0이다. terminal Run의 미확인 요약도 정산하고 같은 workspace의 새 Run·첫 maintenance·다른 session resume를 차단한다. 기존 exact request 조회와 정상 workspace의 active Run pause/resume를 유지한다.
- **사용량·조회**: host의 session-bound get/list, owner-before-payload·최대 100개/1MiB page와 record cap을 연결했다. metrics schema 3은 전체 typed summary 합계와 recent legacy event window, ordinary Attempt 합계를 구분한다. synthetic SQL fixture의 typed 2,101개와 recent 2,000개 event window를 따로 검증했으며 2,101번 실제 모델 호출을 뜻하지 않는다.
- **이미지**: session-wide partial index로 최신 이미지 header 하나를 찾고 exact user·origin Run을 count/byte budget 안에 예약한다. 완료된 memory cutoff 위로 raw user와 refs를 복원한다. 새 text Run·40번 완전 tool turn·재시작·cap·잘못된 owner/reference/ordinal·지원하지 않는 provider를 검증했다. 원본 pixels/replay/refs는 수정하거나 삭제하지 않는다.
- **추가 재현 결함 수정**: 이미지 async-generator 래퍼가 inner next 실패 뒤 cleanup 성공을 잘못 전달하던 경계를 transparent iterator로 바꿨다. 일반 provider executor도 return Promise 성공만 보던 오류를 고쳐 `done === true`를 요구한다. `done:false`인 HTTP retry와 overflow recovery는 새 dispatch 없이 uncertain으로 종료한다. 두 가지 orphan quarantine 순서 문제도 실제 fixture로 재현·수정했다.

첫 전체 gate부터 실패 0이다. source focused 중 legacy Input.id와 초기 Message.id를 혼동한 이미지 fixture, 고정 DB3 migration 기대값과 native event page cap을 수정했다. 오류를 실제 production 결함과 구분해 JSON에 기록했다.

## 커밋 후 실제 모델 확인

`gpt-6.1-sol`에서 20번 fixture-directed local read 뒤 실제 요약 한 번·최종 답변 한 번을 실행했다. 원본 도구 메시지가 provider context에서 빠진 임의 32자리 값을 memory에서 정확히 회수했다. 요약 요청은 7,642 bytes, typed receipt는 completed/activated, partial text 790 bytes·truncation false, source와 summary revision binding·cleanup 기록이 일치했다. 최종 context는 14,754/16,384 bytes이고 전체 snapshot 조회는 0회였다. 이는 모델이 20턴 코딩 전략을 자율 선택한 평가가 아니다.

요약 input 2,040/output 188은 별도 durable summary 합계에, 최종 일반 Attempt input 2,695/output 24는 ordinary 합계에 기록했다. 요약 cached/reasoning 값과 20개 fixture-directed Attempt의 usage 누락을 0으로 채우지 않았다. 과금 합계는 unknown이다.

이미지 live는 첫 Run에서 실제 64×64 red PNG를 보내되 답변은 `READY`만 요청했다. 엔진을 닫고 같은 DB를 다시 연 뒤 attachments가 없는 text Run에서 색을 질문했다. 실제 모델은 red로 답했고, 두 요청 모두 정확한 이미지 frame/blob 한 개를 전송했다. 두 번째 최신 user에는 image attachment가 없고 anchor는 첫 Run의 original message와 일치했다. raw image message는 한 개, DB/context의 base64 pixels는 0이며 full snapshot 조회도 0회였다. 최종 context 2,242/8,192 bytes, 두 일반 Attempt 합계 input 592/output 20·reasoning subset 8이며 image token 비용은 unknown이다.

## 남은 범위

G1-13/14는 완료했다. 다음 G1-15는 요약 usage/progress 조회에서 retained text를 반복 읽는 비용과 admission uncertainty SQL index를 최적화하는 작업이다. G1-16은 unresolved summary의 명시적인 host recovery 결정 계약이다. 현재 uncertainty를 자동으로 해제하거나 원래 요약을 재실행하지 않으며 workspace 격리가 지속된다.

이미지 token 비용·audio/video/file 입력과 media 출력·실제 Anthropic 계정·Windows native Job backend·hosted Linux/Windows/Node24 CI·GUI 노출은 미완료다. Git remote는 없다. metadata/source/coverage cap 안에 남는 관측만 기억하며 SQLite의 전체 물리 I/O 상한은 보장하지 않는다. goal은 활성 상태다. 아래 이전 live 과업은 각각 해당 구현 commit의 근거로 보존한다.

---

# 세 번째 묶음의 이전 검증

2026-10-07, macOS arm64 / Node 26.9.0. 세 번째 구현 commit은 `04031cb38fb6d98d292ee93ade1240a04c63b10e`다. [세 번째 기계 판독 결과](engine-goal-third-verification.json), [active-prefix 명세](engine-active-prefix.md), [TODO](../../TODO.md)를 함께 확인한다. GUI와 Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,777 tests / 1,775 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 |
| 실제 20/50턴 engine fixture | 첫 도구 관측의 임의 nonce를 exact quoted source→derived memory로 유지, 비활성 대조군에서는 최종 context에서 제거 |
| 실제 prefix 경계 | steer·memory/head CAS·cancel/exact retry·close·overflow same-Turn retry·변경된 frontier의 retry 중단·필수 context/output/source cap |
| 커밋 후 실제 Codex | `gpt-6.1-sol` 요약 1회·최종 답변 1회, 원본 도구 메시지가 요청에서 빠진 임의 값 정확히 회수, cleanup 확인 |

`npm run typecheck`, `npm run test:engine`, `node scripts/evaluate-engine.mjs`, `node scripts/verify-active-prefix.mjs --live`로 확인했다. 실제 검증은 20번의 fixture-directed local `read_file` 뒤 실제 model summary 한 번과 최종 답변 한 번이다. 모델이 20턴 코딩 전략을 자율 선택한 평가로 표시하지 않는다. summary source는 4개 exact messages/7,642-byte 요청이며 최종 context는 envelope 포함 14,754/16,384 bytes다. 원본 관측과 refs/replay를 보존하고 full snapshot 조회는 0회였다.

실제 summary usage는 input 1,988/output 187, 최종 일반 Attempt는 input 2,689/output 21이다. 요약의 cached/reasoning 값은 null이고 일반 Attempt 합계는 summary를 포함하지 않는다. 20개 fixture-directed Attempt의 미제공 usage도 0으로 만들지 않았다. 과금량은 unknown이다. 기존 로컬 Codex 인증만 사용했고 임시 DB·저장소의 종료·삭제를 확인했다.

## 세 번째 구현과 독립 검토

- **의미 기억**: initial goal/latest steer/image user/recent complete exchange를 보호하며 exact typed text/tool facts만 old whole exchange 단위로 요약했다. 준비된 기억과 실제 모델 ContextPlan이 모두 검증된 뒤 source/owner/frontier/CAS를 재확인해 두 revision·document와 v1/v2 activation events를 함께 저장한다. checkpoint metadata도 immutable summary revision에 hash bind한다.
- **예산과 실패**: 알려진 모델 reserve와 실제 JSON envelope/escaping을 먼저 예약한다. 이미 관측한 output delta는 local summary cap이 거부해도 공유 Run 예산에 남는다. 이전 checkpoint의 protected suffix가 커져 초기 계획이 실패하면 다음 checkpoint로 한 번 회복할 수 있다. steer arrival·CAS·취소·불완전 출력에는 이전 기억을 유지한다.
- **실행·저장 경계**: ordinary logical Turn/Attempt를 summary용으로 만들지 않는다. overflow recovery는 출력 전 failed Attempt와 underlying iterator cleanup 증거를 요구하며 source가 바뀌면 stale retry를 중단한다. tool facts·Part/Attempt의 payload↔SQL owner와 aggregate byte probe를 검증했다. 물리 SQLite 읽기량을 이 cap으로 보장하지 않는다.
- **이미지와 일반 요약**: 최신 active Run의 중간 이미지가 이후 text steer 때문에 window에서 빠지던 실제 40턴 실패를 수정했다. media projection과 prefix의 required IDs를 합쳐 pixels/ref anchors를 보호했다. completed-history summary는 provider 전에 캡처한 memory revision을 CAS에 사용해 늦은 summary가 승자를 덮어쓰지 않도록 고쳤다.

독립 source/compiled 16개 actual prefix integration과 14개 context·17개 storage fixtures가 의미·소유·byte·negative outcome·이미지·정리를 검증했다. 전체 gate의 첫 실행은 기존 Git diagnostics fixture가 비어 있는 준비 marker를 PID 0으로 읽어 실패했다(1,775 tests / 1 fail). 빈 marker 대기·PID 검증과 결정적 회귀를 추가했다. 최종 frozen source의 전체 1,777개는 실패 0이며 두 로그 hash와 실패 원인을 JSON에 기록했다.

## 남은 범위

G1-09a/b는 별도 host opt-in으로 완료했다. 다음 G1-13은 summary의 전용 durable lifecycle/usage·crash/close 복구다. 현재 Run recovery가 미공개 candidate를 자동 활성화·재시도하지 않지만 summary interrupted/uncertain 상태를 별도 record로 복원하지 않는다. G1-14는 active Run 밖 이전 Run의 최신 이미지 anchor다. 현재 메타데이터 1,024 messages/Turns, 64 pending steer, source/coverage cap 이상의 모든 과거 관측을 기억한다고 보장하지 않는다.

이미지 token 비용, 실제 Anthropic·다른 media 입력/출력, Windows native Job backend, hosted Linux/Windows/Node24 CI, 새 GUI 노출은 미완료다. Git remote는 없으며 goal은 활성 상태다. 이전 live 과업은 아래 해당 구현 commit의 근거로 보존하고 이번 커밋에서 재실행했다고 표시하지 않는다.

---

# 두 번째 묶음의 이전 검증

2026-10-07, macOS arm64 / Node 26.9.0. 두 번째 구현 commit은 `59d1f42716452e104ec526e031263b528b36078b`다. [두 번째 기계 판독 결과](engine-goal-second-verification.json), [목표](engine-improvement-goal.md), [TODO](../../TODO.md)를 함께 확인한다. GUI와 Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,715 tests / 1,713 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 |
| 실제 Codex 이미지 이력 | 커밋 후 `gpt-6.1-sol` 도구 없는 요청 2회 완료·red 인식 2/2 |
| 실제 image transport·storage | 두 요청 모두 1 frame/1 resolved blob, 두 번째에 old occurrence 1개 provenance, 원본 refs 2개 유지, bounded disk index 1개·후보 0개·삭제 없음 |
| 긴 세션·자원 수명 | 130개 세션, 128 pinned 관찰, 취소/저장 실패 후 cache 슬롯 반환, 실제 disk close 대기 |

`npm run typecheck`, `npm run test:engine`, `node scripts/evaluate-engine.mjs`, `node scripts/verify-media-history.mjs --live`로 확인했다. 마지막 live 실행은 구현 commit 이후이며 현재 로컬 Codex 인증과 자체 64×64 빨간 PNG를 사용했다. 새 credential을 만들거나 계정 내용을 출력하지 않았으며 임시 DB·이미지·저장소의 종료와 삭제를 확인했다. 이미지 token 비용은 계속 unknown이고 text/ref estimate의 `complete:false`도 유지된다.

## 두 번째 구현과 독립 검토

- **디스크 진단**: 주 DB owner/ref index와 engine-owned canonical 경로를 host API로 연결했다. regular-file logical 크기·inode 중복·DB sidecars·scan coverage·sample/JSON cap·취소를 표시한다. raw contents를 읽거나 orphan을 삭제하지 않는다. 주 DB index는 child DB를 포함하지 않으며 관찰 후보가 active import의 publish→CAS 사이에 생길 수 있다.
- **이미지 이력**: 생성 시 명시한 host opt-in으로 이전 pixels만 생략한다. 원문 text/ID/refs/replay를 보존하고 최신 pixels·goal/latest steer·complete exchange·quoted notice를 필수로 budget에 넣는다. metadata가 부족하면 이전 context head를 유지하고 provider 호출 전에 실패한다. summary/overflow recovery는 원래 image source를 검사한다.
- **bounded 실행 조회**: 유지보수 입장과 exact 요청, 승인 생성/취소, child pending 승인·terminal assistant 결과를 소유자 범위 SQL로 읽는다. 실제 retry/child allow·부모 cancel·자식 cancel 7개 fixture는 전체 snapshot을 처음부터 금지해도 종료까지 통과했다. queue pending/steer를 primary Run 요청으로 오인하지 않는다.
- **지침 cache 수명**: idle LRU 128개와 observe lease로 오래된 세션 수 때문에 이후 실행이 막히던 문제를 수정했다. cache eviction 후 baseline은 저장 문서의 root/scope/hash 검증을 거쳐 복원하고 실제 파일 삭제는 baseline을 제거한다.

독립 검토는 full image index를 붙인 반환이 4,096-byte cap을 7,053 bytes로 넘던 결함과 큰 저장 revision의 SQLite RangeError를 재현했다. 반환을 bounded scanner report만 유지하고 SQL revision/rowid projection을 수정한 뒤 실제 fixtures가 통과했다. child allow/cancel과 maintenance가 남겨둔 full-snapshot 경로도 해당 독립 fixtures로 확인해 수정했다.

source 22개 이미지 policy fixture와 독립 compiled, 실제 ContextService/SQLite 5개, 디스크 facade/close 3개, cache 수명 3개·host 옵션 1개, owner-bound SQL·실제 filesystem fixture를 포함한 전체 compiled gate가 성공했다. 이 검증을 API만 있는 미연결 모듈이나 mocked HTTP 결과와 구분한다. 이전 coding/delegation live는 아래 `64435d7`의 근거이며 이번 커밋에서 다시 실행했다고 표시하지 않는다.

## 다음 구현 범위

G1-08, G1-09a, G1-11, G1-12는 완료했다. **G1-09b active-prefix semantic checkpoint**는 아직 설계 단계다. active Run의 exact source/hash·complete boundary·Run/turn/attempt owner·CAS 계약, 중간 steer와 summary 취소/출력/정리 실패, 원문 anchors·pixels·replay 보존을 다음 묶음에서 구현·검증한다. 이력 생략이나 extractive excerpt를 의미 요약 완료로 표시하지 않는다.

디스크 수치는 물리 할당량이나 원자 snapshot이 아니며 자동 retention/삭제를 수행하지 않는다. 이미지 정책은 host opt-in이고 source/provenance도 hard cap 안에서만 활성화된다. 실제 Anthropic·audio/video/file·media 출력, Windows native Job backend, hosted Linux/Windows/Node24 CI, 새 기능의 GUI 노출은 완료 처리하지 않았다. 현재 Git remote가 없고 goal은 활성 상태다.

---

# 첫 묶음의 이전 검증

2026-10-07, macOS arm64 / Node 26.9.0. 구현 commit은 `64435d705ea6e68d7e3502d64d4fd1f2976004ae`다. [첫 묶음 결과](engine-goal-first-verification.json), [목표](engine-improvement-goal.md), [TODO](../../TODO.md)를 함께 확인한다. GUI와 Electron 앱을 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 TypeScript build/typecheck | 성공 |
| 전체 headless engine gate | 1,646 tests / 1,644 pass / 0 fail / 0 cancelled / Windows 조건 2 skip |
| coding fixture 평가 | 3/3, expected diff·검사·범위 보존 확인 |
| 실제 Codex 기본 coding 과업 | read_file→승인 apply_patch→승인 run_command, 변경·테스트·cleanup 확인 |
| 실제 Codex 확장 과업 | 승인된 parent→read-only child→동일 요청 재사용, 이미지 red 인식 2/2 |

실제 모델은 기존 로컬 Codex 인증의 `gpt-6.1-sol`이다. 위임은 child의 실제 DB에서 완료 read_file 1회를 확인하고 결과의 자동 inbox 전달·병합이 없음을 확인했다. 이미지 인식은 자체 생성한 64×64 빨간 PNG와 도구 없는 응답으로 검증했으며 원본 bytes가 transcript/context에 저장되지 않았음을 확인했다. 모든 과업은 임시 저장소에서 실행하고 정리했다. 다른 모델·계정·provider에 결과를 확대하지 않는다.

## 구현과 독립 검토

- DB3의 latest-per-attempt usage: 반복·부분·safe retry·provider 실패·취소·native/v1 journal 실패·terminal 불변·재시작·archive.
- bounded active history: 1k/10k SQL window, 실제 36턴/560개의 서로 다른 완료 read, 8KiB context의 24턴/92개 완료 read, 초기 목표·latest steer·완전 exchange·원본 replay 보존.
- immutable image store와 transport: owner/CAS/hash/MIME/container/size/animation/symlink/close·archive, 실제 admission/context/provider 연결, unsupported 입력/출력 거부.
- delegate_task: 요청별 exact approval·pinned committed snapshot·읽기 도구·부모 잔여 budget·취소·중복·효과 잠금·복원·초기화 수명.

독립 검토는 이미지의 text-only 의미 요약·extractive pruning·receipt 재조회, live Run 전체 exchange의 조기 필수화, archive worktree path, async configureChild 반환 문제를 발견했다. 수정한 뒤 교차 fixture와 전체 gate를 통과했다. [이미지 검토](research/2026-10-07-image-integration-review.md), [위임 검토](research/2026-10-07-delegation-review.md), [실제 loop 측정](research/2026-10-07-accounting-review.json)을 따른다.

마지막 전체 gate의 한 실행은 exit 137로 중단되어 성공 결과로 사용하지 않았다. 종료 원인은 확인하지 못했다. 같은 최종 source의 재실행이 1,646개 전체를 통과했으며 JSON에 이 중단과 완료 실행의 로그 hash를 기록했다.

## 남은 범위

이미지 token 비용은 unknown이며 container 검사는 pixel decoder가 아니다. active-prefix 생략을 의미 요약으로 간주하지 않는다. DB bounded snapshot 밖의 이전 이미지와 active-prefix 의미 요약은 다음 범위이며, 이후 구현된 디스크 진단·명시적 이미지 정책은 위 두 번째 검증을 따른다. 복원 worktree는 ownership 미확인 역사 데이터이며 verify/start/merge/cleanup을 거부하고 fresh 작업은 별도 worktree를 만든다.

audio/video/file 입력, media 출력, 실제 Anthropic 계정, Windows native Job backend, hosted Linux/Windows/Node24 CI, GUI 새 기능 노출은 완료 처리하지 않았다. 현재 Git remote가 없어 hosted CI를 실행하지 않았다. goal은 활성 상태로 다음 구현을 계속한다.
