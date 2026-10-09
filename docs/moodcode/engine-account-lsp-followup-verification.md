# 계정 코딩·자동 갱신·native LSP 후속 검증

기준: 2026-10-10, 시작 커밋 `2a13f2edab7cbb1cf35183450acc372288dfef8d`. [작업 인계](../../HANDOFF.md), [현재 TODO](../../TODO.md), [실행·바이트 핀](engine-account-lsp-followup-verification.json)을 함께 읽는다. 이 문서는 과거 인증 검증 JSON을 덮어쓰지 않는다.

## 실제 선택 앱 계정

이미 로그인한 Moodcode의 선택 계정을 암호화 vault에서 읽기 전용으로 사용했다. 로컬 Codex 인증 fallback·계정 refresh·settings/vault/기존 DB 쓰기는 없었다. 격리된 Electron 프로세스와 새 임시 저장소에서 `gpt-6.1-sol`로 다음 동작을 관측했다.

- Native catalog GET 1회·모델 POST 4회 모두 HTTP 200. 반환한 모델 8개 중 설정한 모델을 확인했다.
- 기준 addition 테스트 RED → `read_file` → 정확한 승인 patch → 승인된 `node --test --test-reporter=tap math.test.mjs` → 10개 테스트 PASS·실패 0.
- 곱셈 코드·원래 테스트 파일 hash 유지. 동일 requestId는 같은 Run으로 정산하고 추가 HTTP 0.
- 관측 input/output usage 합계 4,154/177. 과금 확인·모든 원격 사용량·서버 취소의 근거로 사용하지 않는다.
- Provider 4회의 자연 종료·실제 명령 cleanup·Engine close·소유 Electron exit 0을 관측했다. 전체 Native cleanup은 `null/unknown`이며 원본과 선택한 사본 14쌍을 보존했다.

`scripts/verify-desktop-codex-account.mjs`는 `--live`를 요구하고 실패 요청을 포함한 POST 상한 6·deadline 180초를 적용한다. 이미 완료한 이 검증은 단순 상태 확인을 위해 재호출하지 않는다. 실패한 준비 단계는 원본에 기록했으며 외부 호출 0이었다. 검증 당시 9개 source/compiled 핀을 최종 build 뒤 독립 대조해 모두 일치했다. 이 코딩 결과는 엔진·provider의 실제 계정 경로 확인이며 GUI의 새로운 실제 코딩 화면 조작 검증을 뜻하지 않는다.

## 실행 중 credential 자동 갱신

Worker의 각 Codex turn 시작 시 비공개 broker로 Main의 최신 credential을 요청한다. Main이 계정 vault·freshness·rotating grant를 소유한다. 실행 중 갱신은 settings 저장·idle 검사·worker 재시작을 요구하지 않는다.

- 원 연결 generation·선택 app 계정·private native 계정·모델을 pin한다. 늦은 응답과 변경된 선택을 거절한다.
- Main single-flight와 waiter별 취소, 마지막 waiter/연결 종료의 refresh 취소, shutdown의 queued browser 억제를 확인했다.
- Private 요청/취소/응답은 renderer·일반 command response·journal로 전달하지 않는다. 이전/새 credential redaction은 한 연결에 1,024개까지 유지하고 상한 초과는 닫힌 실패로 처리한다.
- Worker는 대기 요청·timeout을 제한한다. Main 종료·비정상 응답·계정 불일치·불확실한 grant를 자동 재시도하지 않는다. HTTP 401 blind retry나 도구 replay를 추가하지 않았다.

Source focused Accounts 31/31·Host 55/55·broker 7/7·Worker core 25/25를 확인했다. 실제 SQLite/loopback HTTP와 서명된 fixture의 rotation·pending marker·저장 실패·재시작 quarantine도 확인했다. 이것은 실제 사용자 grant를 회전한 검증이 아니다.

`scripts/test-desktop-codex-refresh.mjs`는 실제 bundled worker를 **original Electron utility**에서 실행한다. Synthetic credential·intercepted HTTP로 두 turn, credential 요청 3·reply 2·취소 1·취소된 flight 1, 같은 generation 1·spawn 1, Main ACK·utility exit 0·앱 exit 0을 관측했다. 외부 HTTP 0이며 사용자 app/vault를 읽지 않는다. 세 OS package CI에 이 검증을 추가했다. 실제 계정의 만료와 원격 grant 회전은 R-AUTH-LIVE로 남긴다.

## Native TypeScript BOM 좌표

설치한 native TS7 `7.0.2`의 disk 경로는 leading UTF-8 BOM을 제거하고, 기존 overlay는 BOM을 보존했다. 실제 disk definition 0:37–42와 원문 expected 0:38–43의 독립 RED를 관측한 뒤 native connection에 한정한 wire·좌표 projection을 구현했다.

- `didOpen`/전체 `didChange`에서 leading BOM만 제거한다. 원본 document/version과 중간 BOM은 보존한다.
- 첫 줄 native 입력은 UTF16 −1, 결과·formatting·diagnostics는 +1로 원문에 투영한다. 다른 줄·일반 LSP는 유지한다.
- Navigation의 기존 검증·파일 읽기 단계에서 원문 hash와 definition/reference/symbol/link 범위를 확인한다. 새로운 임의 파일 읽기나 추가 wire 요청은 없다.
- 종료 시 mirror를 정산하고 기존 document cap·cancel·deadline을 유지한다. 공개 command schema·DB23은 변경하지 않았다.

최신 실제 native fixture 8/8 PASS는 disk/open·reference·symbol·전체 변경·BOM 제거·동일 version·formatting bytes·omission·pre-abort를 포함한다. 기존 512-module corpus도 새 실행에서 확인했다. Upstream binary의 buildinfo commit은 `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`, `modified:true`이므로 해당 commit의 pristine 재현 빌드라고 주장하지 않는다.

과거 `e3032f0` 전체 5,303/5,299 pass/1 fail/skip 3의 `bom-crlf-astral-definition`과 단독 2/2 PASS를 보존한다. 당시 35–42/26–33의 정확한 경합 trigger는 재현되지 않았다. 확인한 disk mismatch의 수정과 원래 실패의 정확한 원인 규명은 구분한다.

## 통합 실행과 실패 보존

최종 build와 전체 gate를 동시성 4로 통과했다. **5,326개 중 5,323 PASS·실패 0·취소 0·기존 Windows skip 3**, 278,871.432083ms였다. `scripts/test.mjs`에 기존 `test-engine.mjs`/engine CI와 같은 기본 4·환경 변수 범위 1~32를 명시했다. 테스트 목록·제품 deadline·assertion·skip은 이 변경으로 줄이지 않았다.

DB23 baseline 비교·live verifier CLI 6/6·계정 GUI·Settings GUI도 통과했다. 계정 GUI의 로그인·선택·갱신·로그아웃·재연결·삭제는 외부 인증 fixture이며 추론 0회다. Utility 6개 ACK/exit 0·앱 exit 0은 관측했고 전체 Native cleanup unknown은 유지했다. 기존 GUI 원본을 덮어쓰지 않도록 계정 GUI script에 별도 artifact 디렉터리 인자를 추가했다. Settings GUI는 암호화 키 저장/제거·비공개 경계·설정 오류 표시를 확인했고 provider 0회였다. 격리 환경에서 로컬 Codex 전환은 관측하지 않았다.

새 게시 커밋의 OS CI는 아직 확인 전이다. 이전 커밋의 성공을 이번 구현의 11개 hosted job 성공으로 사용하지 않는다. 다음 세션은 remote HEAD에 맞는 실제 job 상태와 실패 로그를 먼저 확인한다. 이후 관측한 hosted 결과(10/11)와 Windows CI 순서 수정은 위 문장을 고치지 않고 [hosted CI 기록](engine-account-lsp-followup-hosted-ci.json)에 별도로 남겼다.

첫 CPU 기본 동시성 전체 실행은 5,326개 중 5,316 PASS·7 fail·기존 Windows skip 3이었다. 다음 판정을 별도로 남겼다.

| 실패 | 확인한 조치/한계 |
|---|---|
| 새 LSP fixture 3개 | typed workspace의 no-Git sentinel이 잘못 선언됨. `gitRoot:''`, branch null로 실제 scope를 정정하고 원 assertion 유지. compiled 8/8 PASS |
| 기존 account decline | 의미가 다른 네 outcome에 30ms timeout fixture가 공유됨. timeout만 30ms, 나머지는 원래 fixture 500ms 사용. callback HTTP 정산과 오류/no-exchange/listener-close 유지. source 31/31 PASS |
| 기존 code-mode caps | 같은 compiled case 단독 1/1 PASS. 원 전체는 실제 allocation 7초 만료. 실패 당시 세부 process phase unknown, 제품 budget 수정 없음 |
| 기존 PR/inbox | 같은 compiled case 단독 1/1 PASS. 원 전체는 `verify_changes` 5초 만료. 세부 실패 phase unknown, 제품/fixture budget 수정 없음 |
| 기존 긴 코딩 loop | 같은 compiled case 단독 1/1 PASS·7.8초. 원 전체는 Run 30초 만료. 완료 결과를 원 전체 PASS로 합산하지 않음 |

첫 build의 새 fixture type 오류, SSE 성공 fixture 형식 오류, Git repository 사전조건 누락과 live launcher 준비 실패도 원본을 보존했다. 수정된 fixture의 성공으로 원래 실패 기록을 삭제하지 않았다. 이번 build·DB23 비교·GUI·전체·CI의 확정 결과와 핀은 JSON을 따른다.

## 인계 시 남은 범위

N-05의 실제 서명/공증·installer·public update feed, E5-13의 추가 공급자/모델·PDF·미디어, R-PTY-01의 과거 native 종료 원인, R-LSP-HIST의 원래 trigger, R-AUTH-LIVE의 실제 expiry/rotation을 남긴다. 계정 권한·서명 자격·역사적 원본이 필요한 항목은 준비 조건을 TODO에서 확인한다.

Raw artifact는 ignored 로컬 자료다. 다른 checkout은 Git에 남긴 요약·바이트 핀과 실제 공개 CI artifact의 가용성을 확인해야 한다. 현재 앱이 이전 bundle로 실행 중일 수 있으므로 실행 중 프로세스와 새 build를 동일시하지 않는다. 과거 PID/PTY를 재사용하지 않는다.
