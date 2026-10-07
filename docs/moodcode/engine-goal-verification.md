# 지속 개선 최신 검증

2026-10-07, macOS arm64 / Node 26.9.0. 여덟 번째 구현 commit은 `42218a82b0975b6d8cfb53e0e458e2493bd8a2c7`다. [기계 판독 결과](engine-goal-verification.json), [공유 조회 계약](engine-recovery-evidence-read.md), [TODO](../../TODO.md)를 따른다. GUI·Electron은 실행하지 않았고 실제 프로젝트의 unresolved 기록에 대신 결정하지 않았다.

| 검증 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과 |
| 같은 전체 목록, `MOODCODE_ENGINE_TEST_CONCURRENCY=2 npm run test:engine` | 2,089 tests · 2,087 pass · 실패/취소 0 · 조건부 2 skip · 68,099.213458ms |
| 독립 scoped source / bundle | 공용·provider 58/58, summary·native 90/90, 실제 mixed engine 8/8; 전체 gate와 겹치므로 합산하지 않음 |
| 코딩 fixture 평가 | 3/3 통과 |
| 커밋 후 실제 Codex | 일반 provider 복구 뒤 새 요청 1회, overflow summary 복구 뒤 새 요청 1회 통과 |

## 구현과 독립 검토

- **공통 예산과 접수 경로**: summary, ordinary provider, uncertain Turn, cleanup과 native owner 읽기가 한 SQLite transaction의 8MiB 선택 증거 예산과 최대 4,096개 raw cache 주소를 공유한다. runner의 새 실행·resume·maintenance가 통합 `hasUncertainWorkspace`를 사용하며, custom store의 기존 두 predicates fallback은 유지한다. 각 영역이 따로 통과해도 합계가 넘으면 실행을 차단한다.
- **변경 감지와 CAS**: 원래 문자열만 재사용한다. 다른 provider/summary hash 구조나 파싱한 객체·validity는 cache하지 않는다. owner/source/pin/fingerprint와 fresh CAS를 다시 검증한다. 같은 connection의 writes, 같은 크기 수정, owner만 변경, delete/reinsert, rollback과 외부 변경 시 cache를 무효화하며 선택 bytes는 환급하지 않는다. 다음 transaction·역사 receipt와 ACK write 사이에는 cache를 유지하지 않는다.
- **본문 반환 제한**: 크기 header 뒤 callback이 Session owner를 9MiB로 키우면 초기 구현은 9,437,262B를 반환한 뒤 거부했다. 독립 검토에서 발견하고 SQL 본문 조회에도 exact byte 조건을 추가했다. 최종 실제 cleanup fixture는 큰 owner 반환 0B, 원문·두 journal rollback, cleanup proof 미확정 보존과 이후 정상 dispatch를 검증했다. aggregate 한도를 넘는 다음 Part도 읽기 전에 차단한다.
- **순서와 호환**: ordinal·seq·admitted_seq를 문자열 CAST 별칭으로 정렬하던 9→10 경계 결함을 수정했다. validation은 숫자 열로 정렬하고 기존 provider V1 digest의 group encoding은 유지한다. 기존 valid ACK의 source SHA·exact receipt·validity와 새 ordinal 9/10의 eligible 결정을 확인했다. summary V1의 inactive admission·V2 pin coverage는 유지한다.
- **일반 읽기와 소유권**: proof 밖의 일반 getter는 기존 읽기 동작을 유지한다. summary 원본 Run/message의 foreign SQL owner는 본문 전에 거부하고, usage metadata는 retained partial text를 반환하지 않는다. 실제 새 Run·새 uncertainty·head CAS·새 ACK·재시작에서 다시 검사하며 원래 상태/control/inbox/dispatch는 읽기 검사로 바뀌지 않는다.

## 실제 엔진 조회 측정

일반 transport uncertainty의 confirmed return, 독립 completed-history summary uncertainty, failed overflow와 연결된 uncertain Turn/summary를 모두 실제 private engine에서 만든 뒤 재시작·명시적 fixture ACK했다. 이전 `5d70a22`의 engine/contracts 전체 소스를 `git archive`로 고정하고 동일 작성 fixture를 독립 bundle로 실행했다. 중간 구현이 섞인 첫 측정은 비교에서 제외했다.

| 동일 mixed 과업 | SQL 호출 | SQL 반환 값 bytes | raw JSON/projection bytes |
| --- | ---: | ---: | ---: |
| 이전 두 predicates의 합계 | 296 | 249,210 | 211,983 |
| 새 통합 predicate | 368 | 121,980 | 83,173 |

raw 본문 반환량 **60.8%**, SQL 반환 값 **51.1%** 감소다. mutation marker와 owner 재검사 때문에 query 수는 **24.3% 증가**했다. epoch 두 호출은 table-valued PRAGMA를 사용한 한 호출로 합쳤다. 각 raw 주소/projection은 변경 없는 같은 transaction에서 한 번 반환됐고, 다음 검사에서는 다시 읽었다. writes·changed rows·whole snapshot·실제 모델 호출은 이 fixture에서 0이다. 물리 I/O·SQLite 내부 JSON 계산·파싱한 객체 메모리·production 처리량이나 latency의 전체 상한으로 확대하지 않는다.

새 ACK의 같은 positive fixture도 Summary 본문 44회/17,683B→14회/5,880B, Provider 52회/18,832B→15회/5,379B로 줄었다. query 수는 각각 116→147, 141→162로 늘었다. 정확한 역사 retry는 ledger 본문 한 번을 유지하고 epoch 검사로 query 3→4다. class의 첫 미승인 후보는 기존처럼 query 2/body 0이다. 공개 workspace facade의 추가 owner size·epoch 조회는 별도로 포함한다. 1k/10k predicate의 total_changes 값이 한 자리 늘면서 반환 metadata가 1B 달라지는 조건도 기록했다.

큰 실제 fixture는 700KiB ordinary 관측 5개와 summary 이력 2개를 사용했다. Summary **1,690,198B**, ordinary execution **7,214,738B**는 개별 clear이지만 distinct union **8,904,648B**는 8MiB를 넘는다. 통합 검사는 **8,187,196B**만 반환하고 blocked였으며 다음 **717,183B** Part 본문 조회는 0회다. 실제 submit/resume가 CLEANUP_PENDING을 반환하고 대기 입력·control·원래 outcome·dispatch 수를 보존했다. 700KiB foreign summary 원본은 owner metadata에서 차단해 본문 반환 0회다.

## 실제 Codex 범위

같은 `42218a8`에서 기존 로컬 인증으로 정확히 두 요청을 보냈다. authored uncertainty와 결정은 private 임시 DB에만 존재한다. 일반 provider 복구 뒤 실제 새 요청은 input/output **448/5**, logical request **2,617B**, head revision **1→2**였다. overflow summary 뒤 실제 새 요청은 **1,586/5**, logical request **12,003B**, head revision **2→3**이었다. 두 요청은 READY로 완료됐고 natural-done cleanup proof·logical SHA·재시작 뒤 결정 보존을 확인했다. 원래 uncertainty/usage/부분 제안·control/context는 그대로였다. 두 script의 host close와 live cleanup은 각각 confirmed이며 임시 파일을 정리했다.

이번에 active-prefix live 요청을 추가 반복하지 않았다. 이전의 실제 요약/회수는 [일곱 번째 결과](engine-goal-seventh-verification.json)에 보존하고, 이번 전체 gate의 회귀 검사로 확인했다. 실제 원격 uncertainty·서버 중지·과금은 검증하지 않았다. 실패하거나 live cleanup이 미확정이면 script는 임시 DB를 보존한다.

## 실패 기록과 이어갈 범위

초기 ordinary predicate 검사 3개 중 2개는 새 size/epoch 호출을 제외한 옛 query 수 때문에 실패했다. 수정 뒤 root 집중 15개 중 3개는 1k/10k total_changes의 decimal 자리 수 차이 1B를 무조건 동일하게 기대해 실패했다. bounded metadata 차이와 고정 query 수를 각각 검증하도록 수정했다. 큰 실제 fixture의 첫 실패는 위 숫자 정렬 결함을 발견했다. 각 로그/hash와 독립 9MiB 관측/최종 회귀를 JSON에 구분했다. 전체 gate와 실제 모델 검증은 첫 실행에서 통과했다.

G1-19를 완료했다. 기존 provider/summary/Turn 도메인의 논리 예산·후보·row·source·owner 한도도 유지한다. 프로젝트의 실제 결정을 대신 승인하거나 원래 호출을 자동 retry/activation/resume하지 않는다. 원래 열린 **E5-08, E5-13, E6-07, E6-08**은 외부 OS/provider/CI 검증 조건을 유지한다. GUI는 제외하며 다음 로컬 엔진 개선 범위를 조사하고 goal을 활성 상태로 유지한다.

[일곱 번째 기계 판독 결과](engine-goal-seventh-verification.json)는 이전 문서 commit `4f4ae49`의 bytes 그대로 보존했다. 첫 번째부터 여섯 번째 JSON도 기존 파일을 유지한다.
