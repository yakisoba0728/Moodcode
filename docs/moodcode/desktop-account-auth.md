# Desktop Codex 계정 로그인

확인일: 2026-10-10. Moodcode의 새 로그인은 Codex/OpenCode가 사용하는 브라우저 OAuth 경로로 교체했다. 기존 SIWC의 Moodcode 앱 연결·에이전트 이름 등록 흐름은 과거 구현으로 분리한다. 사용자가 수정한 앱의 실제 브라우저 로그인 성공을 확인했고, 선택한 앱 계정의 모델 조회·native 코딩 요청도 통과했다. Main 소유 자동 credential broker를 구현하고 로컬 회전·취소와 실제 Electron utility 연결을 검증했다. 실제 OAuth grant의 만료·갱신은 아직 검증하지 않았다.

## 사용 흐름

설정에서 Codex 계정 로그인을 시작하면 시스템 브라우저가 열린다. 인증 후 Moodcode로 돌아와 저장한 계정과 모델을 선택한다. 명시적인 갱신·계정 변경·로그아웃 전에 기존 엔진 worker를 정산하고, 새 worker에는 선택한 계정의 credential만 전달한다. 실행 중 요청 전 자동 갱신은 같은 worker에서 private broker로 처리한다. 이 경로는 Moodcode가 관리하는 계정이며, 기존 로컬 Codex 로그인 읽기 경로도 별도로 유지한다.

만료가 가까운 정상 계정은 갱신한다. 갱신 실패·불확실 상태로 재로그인이 요구되면 브라우저에서 다시 로그인해야 한다. 다른 로컬 Codex 계정이나 API 키로 자동 대체하지 않는다. 모델 목록은 조회한 메타데이터이고, 실제 접근 권한은 선택 모델 요청의 결과로 확인한다.

각 provider turn 시작 전에 worker가 Main에 현재 credential을 요청한다. Main은 선택한 app UUID·모델과 원래 utility 연결을 확인하고, 만료가 60초 이내인 토큰을 갱신한 뒤 암호화 저장 완료를 확인한다. 같은 연결의 동시 요청은 한 갱신을 공유하며, 개별 Run 취소는 해당 waiter만 해제한다. 마지막 waiter 취소·계정 변경·utility 종료·앱 종료는 갱신을 취소하고 늦은 응답을 거절한다. worker는 native routing ID가 바뀐 credential을 받아들이지 않는다. 원격 401은 실패로 남기며, credential 교환이나 도구 호출을 자동 replay하지 않는다.

## 프로토콜과 경계

| 항목 | 새 Codex 계정 경로 |
|---|---|
| 브라우저 인증 | 고정 Codex public client, `https://auth.openai.com/oauth/authorize`, 새 state·S256 PKCE |
| 토큰 교환·갱신 | 같은 client로 `https://auth.openai.com/oauth/token`; 로그인에 사용한 callback URI와 verifier를 정확히 바인딩 |
| 요청 권한 | OpenCode native 로그인에서 확인한 `openid profile email offline_access`; SIWC 동적 등록·에이전트 이름·resource 권한과 구분 |
| 모델·추론 | native Codex catalog 및 고정 `https://chatgpt.com/backend-api/codex/responses`; Platform API 모델 목록과 구분 |
| 두 계정 ID | 화면·설정의 app UUID와 요청 헤더의 private ChatGPT account ID를 분리 |
| worker 연결 | `providerId=codex`, `credentialMode=chatgpt`, 빈 사용자 base URL; turn별 bearer·routing ID·redaction secrets는 Main↔utility private 채널 |

App UUID는 저장한 ChatGPT 사용자 등록(subject)을 식별한다. 연결 중 재로그인·갱신은 기존 subject와 native routing ID의 동일성을 확인한다. 로그아웃은 토큰과 private routing ID를 제거하므로, 그 뒤 같은 subject의 명시적 브라우저 재로그인에서는 다른 workspace 선택을 허용한다. 새 grant로 모델을 다시 조회하고 worker를 재시작하며, app UUID를 workspace의 영구 식별자로 취급하지 않는다.

토큰·ID-token·refresh-token은 main이 소유한 암호화 계정 저장소에 보관한다. Renderer의 계정 view·설정·journal에 credential을 넣지 않는다. 안전한 OS 암호화 저장소가 없으면 저장을 거절한다. 기존 SIWC 계정 기록은 새 native 계정으로 자동 승격하지 않으며, 레거시 기록의 보존·격리와 명시적 재로그인을 구분한다.

갱신은 직렬화하며, 원격 요청 전에 불확실 상태를 남긴다. 요청·저장 완료를 확인하지 못하면 이전 rotating grant를 자동 재시도하거나 확인되지 않은 새 토큰을 활성화하지 않는다. 브라우저 로그인 취소·창 reload 뒤 늦게 돌아온 교환 결과도 저장하지 않는다. 창 reload는 진행 중인 Run을 유지하므로 해당 Run의 자동 갱신을 중단시키지 않는다. 앱 종료는 새 계정 작업을 거절하고 진행 중 갱신과 private waiters를 정산한다. 로그아웃의 로컬 credential 제거와 원격 revocation 확인은 별도 결과다.

## 검증 상태

Source와 실행 근거의 바이트 핀·결과는 [구현 당시 검증 기록](desktop-account-auth-verification.json)에 정리했다. 이 기록의 브라우저 pending은 당시 상태로 보존한다. 이후 사용자가 보고한 실제 로그인 성공은 [사용자 확인 기록](desktop-account-auth-user-confirmation.json)에 별도로 남겼다.

프로토콜 연구는 로컬 OpenCode source와 공식 Codex 문서를 직접 대조했고, 동결한 인증 구현과 Main·Settings·preload·worker·Codex provider 연결을 독립 검토했다. 고정 client의 issuer·audience·서명·subject와 supported routing ID를 확인한다. 검증된 ID-token의 top-level 또는 nested native account ID만 사용하며, 서명을 확인하지 않은 access-token claim이나 organizations fallback은 사용하지 않는다. 실제 로그인 성공은 사용자 확인 범위이며, 모든 계정·workspace·갱신 조건의 호환성을 뜻하지 않는다.

`npm run build:desktop`이 성공했고 계정 source 25/25, Codex provider 55/55, compiled bridge 102/102, 전체 실행에 포함된 Settings 47/47이 통과했다. 숨겨진 실제 Electron 계정 GUI는 로그인·선택·갱신·로그아웃·같은 등록 재연결·삭제와 설정의 native Codex 바인딩을 확인했다. 외부 인증은 fixture였으며 추론 요청은 0회였다. Main utility 6개의 ACK·exit 0과 앱 exit 0을 관측했지만, 전체 Native cleanup은 null/unknown으로 남기고 원본을 보존했다. 별도 Settings GUI도 통과했으며 실제 공급자 요청은 0회였다. Loopback fixture 성공을 실제 계정 로그인·모델 entitlement·서버 revocation 검증으로 세지 않는다.

로그인 구현 당시 전체 compiled 실행은 5,303개 중 5,299 pass·1 fail·기존 Windows skip 3이었다. 실패는 기존 native TypeScript corpus의 `bom-crlf-astral-definition` 좌표 precision/recall 검증이다. 동일 파일의 단독 실행 2/2는 통과했으나, 전체 실패 원인을 확정하거나 전체 PASS로 바꾸지 않는다. Source 회귀의 기존 process 3개는 상대 `--import` loader가 임시 작업 CWD에서 해석되지 않아 실패했으며, 절대 loader 경로의 동일 3개는 통과했다. 이 실행 조건 문제를 새 인증·PTY 제품 결함으로 판정하지 않는다. 이후 R-LSP 수정과 현재 전체 회귀는 [코딩·자동 갱신·LSP 후속 검증](engine-account-lsp-followup-verification.md)에 별도로 기록한다.

선택한 앱 계정의 실제 `gpt-6.1-sol` 검증은 암호화 계정 저장소를 읽기 전용으로 사용했다. Catalog GET 1회와 추론 POST 4회 모두 HTTP 200을 관측했고, 임시 저장소의 읽기→정확히 승인한 patch→고정 테스트 명령→완료를 확인했다. 원래 테스트를 보존한 채 10개 테스트가 모두 통과했으며, 같은 request ID의 재접수는 같은 Run을 반환하고 추가 HTTP 요청은 0회였다. 기존 앱 설정·DB·계정 vault를 쓰거나 로컬 Codex 계정으로 대체하지 않았다. 검증 원본은 보존했다. 테스트 명령의 native cleanup과 Engine close를 관측했지만, 전체 효과의 cleanup은 unknown으로 남기며 원격 실행·과금 정리를 증명하지 않는다.

자동 갱신 source 검증은 Accounts 31/31, Host 55/55, worker core 25/25, broker 7/7의 별도 실행에서 통과했다. 로컬 OAuth·암호화 fixture에서 회전 공유·취소·저장 실패·불확실 marker 보존·재시작 뒤 재사용 금지를 검증했고, 실제 SQLite Engine과 loopback HTTP에서 두 turn의 서로 다른 credential 전달과 401의 추가 요청 0을 확인했다. 별도의 실제 Electron utility probe도 같은 generation에서 두 turn·private 요청 3회/응답 2회·마지막 waiter 취소 1회와 utility ACK·exit 0, 앱 exit 0을 확인했다. 이 probe의 credential과 HTTP는 fixture이며 외부 요청은 0회다. utility의 물리적 종료를 실제 OAuth grant 갱신이나 전체 native 효과·서버 측 취소의 증거로 승격하지 않는다. 최신 source/runtime 핀·원시 기록과 통합 회귀는 후속 검증 문서를 따른다.

기존 로컬 Codex 인증으로 native catalog GET을 총 네 번 관측했고 추론 요청은 0회였다. Moodcode 버전 `0.1.0`을 `client_version`에 쓴 두 요청은 HTTP 200·모델 0개였고, 설치 Codex 버전 `0.162.0-alpha.17.2`와 호환 값 `0.162.0`은 각각 HTTP 200·모델 11개였다. Catalog의 native 호환 버전을 Moodcode 앱 버전·User-Agent와 분리하는 근거다. 이 관측은 새 Moodcode 계정의 브라우저 로그인·추론 완료를 뜻하지 않는다.

N-03의 실제 브라우저 로그인 조건은 사용자 확인으로 기록했고, 선택한 앱 계정의 모델 조회와 완료된 native 코딩 요청은 이번 후속 검증으로 확인했다. 이 결과는 다른 계정·모델의 접근 권한이나 실제 OAuth grant 만료·갱신의 검증이 아니다. N-05 서명·공증·설치·공개 feed, E5-13의 더 넓은 모델·PDF·미디어·비용, R-PTY-01의 역사적 실패 원인은 별도 조건으로 유지한다. R-LSP와 현재 통합 회귀의 완료 판정은 후속 검증 기록을 따른다.

기존 [SIWC 구현·fixture 기록](next-desktop-auth-progress.json)은 당시 동적 등록 경로의 역사적 근거다. 새 Codex 로그인이나 실제 사람 로그인 완료의 근거로 재사용하지 않는다.

## 조사 근거와 호환성 한계

[공식 Codex 인증 문서](https://learn.chatgpt.com/docs/auth)는 브라우저 로그인, 로컬 캐시와 갱신, 기본 loopback callback을 설명한다. [현재 Codex login source](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs)와 [token claim source](https://github.com/openai/codex/blob/main/codex-rs/login/src/token_data.rs)는 조사일의 upstream 구현이며, 고정된 Moodcode 배포 계약으로 간주하지 않는다.

로컬 OpenCode의 `packages/opencode/src/plugin/openai/codex.ts`를 프로토콜 참고로 읽었다. 직접 코드를 복사하지 않았다. OpenCode의 localhost callback과 현재 Codex의 127.0.0.1 callback·추가 connector scopes는 차이가 있다. Native flow에서 nonce·만료·갱신 응답 필드를 SIWC fixture 가정으로 강제하지 않으며, JWT claim 파싱만으로 독립 identity 검증을 보증하지 않는다. 로컬 구현 검증·사용자 로그인 확인·실제 모델 호출의 근거를 구분한다.
