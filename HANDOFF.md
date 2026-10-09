# Moodcode 작업 인계

갱신일: 2026-10-10, Asia/Seoul. 새 세션은 이 문서 → [TODO](TODO.md) 상단 → 해당 기능의 검증 문서를 읽고 현재 Git 상태부터 확인한다. 아래 과거 테스트 집계는 각각 기록한 커밋의 결과이며 현재 소스의 새 결과로 합산하지 않는다.

## 프로젝트와 결정

- Moodcode는 로컬 저장소·명령 실행 중심의 Electron 데스크톱 코딩 에이전트다. 자체 TypeScript/Node 엔진을 구현하며 OpenCode 엔진을 그대로 재사용하지 않는다.
- OpenCode의 엔진·TUI·GUI 등 [8개 분석](docs/opencode-analysis/README.md)을 완료했고, 이어 [19개 공개 에이전트 조사](docs/coding-agent-engine-review/README.md)와 [1:1 비교](docs/coding-agent-engine-review/one-to-one-comparison.md)·[구현안](docs/coding-agent-engine-review/implementation-blueprint.md)을 작성했다. 조사 코드와 의존성·생성 결과를 제품 코드로 취급하지 않는다. 출처·라이선스와 독립 구현을 유지한다.
- 엔진을 먼저 구현하고 GUI에 연결하는 순서다. 짧고 책임이 명확한 코드, 필요한 최신 주석을 유지한다. 줄 수만 줄이기 위한 검증 삭제·과도한 파일 분할은 하지 않는다.
- 사용자는 병렬 에이전트 작업을 요청했고 이후 새 앱 세션 생성은 중단하도록 지정했다. 새 세션을 임의 생성하지 않는다.
- 저장소는 공개 `yakisoba0728/Moodcode`, 기본 브랜치 `main`이다. 사용자는 테스트·커밋·푸시를 승인했다.

## 구현된 범위

| 범위 | 현황과 근거 |
|---|---|
| 자체 메인 엔진 | 1차 G1-29와 2차 MC2-01~20의 80/80 하위 항목·20/20 기능군을 명시 지원 범위에서 완료. [2차 수용](docs/moodcode/engine-phase-two-final-acceptance-verification.json) |
| 실행·저장·복구 | 요청 중복 방지, queue/steer, Turn/Part, 도구 승인·취소, SQLite/journal, checkpoint·diff·복원·archive, crash quarantine |
| 확장 엔진 | MCP, PTY, child/team·worktree, workflow·ACP, 요약·context 예산, LSP·저장소 탐색, 제한된 모델별 미디어 입력/출력 |
| Desktop | 같은 엔진을 utility process로 실행. sandbox preload, 고급 패널, provider 설정·암호화 키·계정, 진단·복구·백업·검토형 업데이트 |
| Windows | x64 Job Object 명령 실행과 실제 Node/Electron CI 완료. Windows PTY·arm64는 미검증 |
| 코드·테스트 점검 | 소유 1,092개 파일의 읽기·책임 매핑 및 처음 36개 문제의 수정/유지 판단. RF-01~08의 유한 점검·리팩터링 수용 완료. [전체 점검 근거](docs/moodcode/next-whole-review-source-verification.json) |
| 실제 Anthropic | 지정 workspace의 Haiku 5.5에서 text·tool replay·PNG, 공개 reasoning summary·서명 replay·클라이언트 취소, 임시 코딩 과업 확인. 다른 모델·원격 과금 취소까지 검증했다고 주장하지 않음. [후속 수용](docs/moodcode/engine-followup-20261010-verification.json) |
| Codex 계정 로그인 | SIWC 에이전트 이름 등록을 고정 Codex client PKCE 브라우저 로그인으로 교체. 사용자가 실제 로그인 성공 확인. [현재 인증 계약](docs/moodcode/desktop-account-auth.md) |

공개 API/command schema, DB23, 승인·cancel·unknown·no-replay·budget 계약을 보존한다. 모델 adapter는 한 turn 통신을 담당하고 도구·승인·실행 상태는 엔진이 소유한다. Main은 계정과 rotating grant를 소유하며 renderer·journal에 credential을 노출하지 않는다.

## 최신 보강과 검증

사용자 요청: **실제 코딩 검증 → 실행 중 토큰 자동 갱신 → LSP 오류 수정**, 에이전트 병렬 작업, 테스트·커밋·푸시, 전체 문서화와 다음 세션 인계.

시작 기준은 `2a13f2e`이고 그 직전 로그인 구현은 `e3032f0`이다. 최신 통합 결과는 [검증 요약](docs/moodcode/engine-account-lsp-followup-verification.md)·[바이트 핀과 실행 기록](docs/moodcode/engine-account-lsp-followup-verification.json)을 기준으로 읽는다.

| 작업 | 변경 영역 | 확인한 동작 |
|---|---|---|
| 실제 앱 계정 코딩 | `scripts/verify-desktop-codex-account.mjs`, `desktop-codex-account-verification*.mjs` | 선택 앱 계정 `gpt-6.1-sol`의 catalog GET 1회·모델 POST 4회 모두 HTTP 200. read→승인 patch→승인 명령→10개 테스트 PASS. 같은 요청의 추가 HTTP 0, 기존 vault/settings/DB 불변. 전체 Native cleanup은 unknown이며 원본 보존 |
| R-AUTH 자동 갱신 | `main/accounts.ts`, `main/host.ts`, `main/index.ts`, `worker/core.ts`, `worker/runtime.ts`, `worker/protocol.ts`, `worker/credential-broker*.ts` | 매 turn Main에서 최신 credential 전달, single-flight·개별/마지막 취소·종료·늦은 응답·계정 pin·비공개 경계 구현. 실제 Electron utility에서 같은 generation 1의 두 credential revision과 취소·exit 0 확인. 실제 계정의 강제 만료/원격 grant 회전은 별도 미검증 |
| R-LSP 좌표 | `packages/engine/src/lsp/typescript-native*`, native BOM helper/tests, `repository/native-typescript-bom.test.ts` | Native 전용 leading BOM wire·UTF16 projection 구현. 원문/hash·일반 LSP 유지. 실제 disk 좌표 37–42의 RED를 원문 좌표 38–43으로 수정; 최신 native fixture 8/8. 원래 전체 실행의 다른 경합 trigger는 정확히 재현하지 못함 |

LSP의 기존 전체 실패는 `bom-crlf-astral-definition`이다. `e3032f0` 로컬 전체는 5,303개 중 5,299 pass·1 fail·skip 3, 동일 파일 단독은 2/2 pass였다. 이후 같은 코드의 실제 OS CI 세 workflow는 성공했다. 원래 실패를 삭제하거나 단독 성공으로 전체 성공을 만들지 않는다. Native disk BOM 제거와 열린 문서 BOM 보존의 차이는 확인했고, 같은 원래 경합의 재현 여부와 일관된 projection 수정의 검증을 구분한다.

최종 로컬 build·전체 compiled **5,326/5,323 pass/실패 0/취소 0/skip 3**·DB23 비교·CLI 6/6·계정 GUI·Settings GUI는 통과했다. 첫 전체 7개 실패와 fixture 수정·실행 조건 차이는 최신 검증 문서에 보존했다. 게시 커밋 `16e266a`의 OS CI는 11개 중 10개 성공, Desktop packages windows-2025 1개 실패였다. 새 계정 코딩 테스트의 `run_command`가 `WINDOWS_JOB_BACKEND_UNAVAILABLE`로 실패했고, 원인은 해당 job이 그 단계 전에 Job Object 애드온을 빌드하지 않은 CI 순서였다(제품 결함 아님). `69c320d`에서 이 테스트를 별도 단계로 옮겨 Windows에서만 Node 애드온 빌드→테스트→제거로 격리했고 세 OS Desktop packages가 통과했다. [hosted CI 기록](docs/moodcode/engine-account-lsp-followup-hosted-ci.json).

## 남아 있는 후속

- N-03: 실제 브라우저 로그인 사용자 확인과 선택한 앱 계정의 모델 조회·코딩 추론 확인 완료. 완료한 실제 요청을 상태 확인만을 위해 반복하지 않는다.
- R-AUTH·R-LSP: 위 유한 구현 범위와 원격 갱신·역사적 경합의 미확정 범위를 구분한다. 최신 전체 gate 결과는 검증 문서에서 확인한다.
- N-05: 실제 macOS·Windows 서명/공증·설치·공개 update feed. 인증서·배포 자격 준비가 필요하다.
- E5-13: 더 넓은 공급자/모델·PDF·미디어·usage/cost 검증. 이미 검증한 모델·MIME·상한과 구분한다.
- R-PTY-01: 과거 정상 종료 불일치의 원본 PID/PGID/native outcome 근거와 원인 판단. 새 collector 개선·현재 성공으로 과거 원인 해결을 주장하지 않는다.

이전 전체 goal의 외부 조건 대기 기록은 보존한다. 이번 인계 시 `get_goal`은 `goal:null`을 반환해 활성 goal은 확인되지 않았다. 이 문서 작성으로 자동 재개·예약 실행을 설정하지 않았다. 서명·광범위 미디어·과거 실패 조건을 임의 완료하지 않는다.

## 개발·검증 명령

Node는 `.nvmrc`의 26.9.0, 최소 24다. 의존성이 이미 있으면 불필요하게 재설치하지 않는다. 여러 에이전트는 같은 checkout을 공유하므로 같은 파일의 편집 담당을 하나로 정하고 공동 build는 통합 담당자가 순서대로 수행한다.

```sh
git status --short
git log -5 --oneline
npm run build:desktop
node scripts/test.mjs
node --test scripts/desktop-codex-account-verification.test.mjs
node scripts/test-desktop-codex-refresh.mjs
node scripts/test-desktop-accounts.mjs artifacts/desktop-accounts-next
node scripts/test-desktop-settings.mjs
node scripts/inspect-engine-db-contract.mjs --compare docs/moodcode/next-db-contract-baseline.json
git diff --check
```

전체/엔진 launcher는 기존 engine CI와 같은 동시성 4를 기본으로 사용한다. `MOODCODE_ENGINE_TEST_CONCURRENCY`로 1~32를 지정할 수 있다. 첫 CPU 기본 동시성 실행의 실패와 새 bounded 실행 결과를 소급 합치지 않는다. Source 테스트는 **절대 tsx loader 경로**를 사용한다. 상대 `--import`는 임시 repo CWD를 상속할 때 기존 process fixture에서 실패할 수 있다. 완료 집계에는 실패·skip·cancelled를 함께 기록한다.

실제 계정 검증은 사용량을 소비한다. 이번 요청 범위에서만 수행하며, 다음 세션이 단지 상태를 읽는 경우 다시 호출하지 않는다. API 키·access/refresh/ID token·private routing ID를 채팅, stdout, 환경 변수 덤프, 임시 plaintext JSON, Git에 남기지 않는다. `.env.local`과 로컬 Codex 인증은 내용을 출력하지 않는다. 실제 계정 vault/settings/DB를 테스트 fixture로 수정하지 않는다.

## 원본과 증거 위치

- [TODO](TODO.md): 상단 현재 상태, 아래 단계별 역사적 기록. 오래된 완료/진행 숫자를 현재 상태로 혼동하지 않는다.
- [README](README.md), [host API](docs/moodcode/engine-host-api.md), [지원 범위](docs/moodcode/next-feature-support-draft.json), [CI](docs/moodcode/engine-ci.md).
- `artifacts/desktop-account-auth-20261010/`: 기존 로그인 검증·원래 전체 LSP 실패·단독 성공 로그. ignored 로컬 원본이며 추적 JSON의 SHA와 대조한다.
- `artifacts/desktop-account-coding-20261010/`: 이번 실제 계정 코딩의 local/live 원본과 실패 기록.
- `artifacts/engine-account-lsp-20261010/`: 이번 통합 build·회귀·DB 계약·원 utility 검증의 로컬 자료.
- 기존 고정 [인증 검증 JSON](docs/moodcode/desktop-account-auth-verification.json)은 역사적 record다. 이후 [사용자 로그인 확인](docs/moodcode/desktop-account-auth-user-confirmation.json)을 별도로 남겼으며 과거 pending 필드를 소급 수정하지 않았다.

Ignored artifact는 새 checkout에 자동 포함되지 않는다. 새 세션이 같은 checkout을 쓰면 원본을 재사용하고, 다른 머신에서는 추적된 요약/핀과 공개 CI artifact의 실제 가용성을 확인한다. 원본을 발견하지 못하면 있다고 가정하거나 성공 근거를 재구성하지 않는다.

## 다음 세션의 시작

먼저 현재 HEAD·remote main·미커밋 diff를 확인하고, 위 세 작업의 최종 문서/검증 기록을 읽는다. 작업 중인 다른 에이전트가 있으면 파일 소유를 합의하고 그 diff를 덮어쓰지 않는다. 완료한 실제 계정 호출·전체 테스트를 이유 없이 반복하지 않는다. 실패·변경·새 우려가 있으면 영향 검증 후 필요한 통합 검증을 수행한다.

다음 순서: `gh run list --commit <현재 HEAD>`로 CI 확인 → 실패가 있으면 원본 보존 후 최소 수정 → 열린 TODO의 자격·근거 준비 → 완결 기능 단위 구현/검증 → 문서·커밋·푸시. 실제 만료 관측과 서명 배포는 먼저 검증 범위를 정하고, 필요한 계정 사용·배포 권한이 현재 요청에 있는지 확인한다.

앱 프로세스가 열려 있을 수 있다. 이 문서의 과거 PID나 다른 세션의 PTY ID를 재사용해 신호를 보내지 않는다. 현재 프로세스·명령·소유를 다시 확인하고 정상 종료 경로를 사용한다. 일반 텍스트 채팅에서 화면 캡처 도구를 호출하지 않는다.

인계용 요청 예시: “Moodcode의 HANDOFF.md와 TODO.md 상단, 최신 검증 기록을 읽고 현재 Git 상태를 확인해. 완료 항목은 반복하지 말고 남은 구현·검증을 에이전트로 병렬 진행해. 테스트와 문서·커밋·푸시까지 처리해.”
