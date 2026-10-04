# Moodcode 구현 상태

갱신일: 2026-10-04, Asia/Seoul. 자체 엔진에 Electron 데스크톱 GUI를 연결했다. 작업 범위를 나누어 인증·workspace·복원·host와 탐색·대화·복구·장기 이력을 병렬 구현하고 통합했다. [실행 결과](./verification-results.json), [실행 안내](../../README.md), [모듈별 보고서](./implementation-reports/)에서 근거와 세부 한도를 확인할 수 있다.

## 현재 사용 가능한 흐름

로컬 Git 저장소 열기 → 세션 생성 → Codex 모델에 요청 → 실제 텍스트·도구 기록 확인 → 파일 수정 승인 → 명령 실행 승인 → 테스트 결과·변경 전후 diff 확인까지 연결되어 있다. Plan은 읽기·분석이며, Build도 파일 수정과 명령마다 승인이 필요하다. 화면 새로고침은 엔진 실행을 취소하지 않는다. 사용자가 중지하면 엔진이 정리 후 취소 terminal을 기록한다.

파일 목록·읽기는 Run을 만들지 않는 읽기 전용 명령이다. 마지막 파일 변경은 복원 preview를 확인한 뒤 실행하며, 현재 파일 hash와 preview fingerprint를 다시 검사한다. 외부 편집 충돌은 사용자 파일을 보존한다. 복원 결과는 별도 SQLite review journal에 저장되어 reload/reopen 후 조회할 수 있다. 완료된 Run의 terminal 이후에는 Run 이벤트를 추가하지 않는다.

Codex에 로그인되어 있고 로컬 모델 설정이 있으면 기본 공급자는 Codex다. 현재 계정의 `gpt-6.1-sol`로 실제 모델·도구 loop를 검증했다. 토큰은 매 turn 로컬 인증에서 읽고 고정된 Codex 경로로만 전송한다. 인증 파일을 갱신하지 않으며, renderer·설정·journal에 인증값을 저장하지 않는다. 앱 자체 로그인·토큰 갱신은 후속 범위다. 별도 API 키를 쓰는 공급자는 safeStorage 암호화 또는 환경 변수로 연결한다.

## 구현 결과

| 범위 | 현재 동작 |
|---|---|
| 엔진·기록 | versioned 계약, 엄격한 입력 검증, workspace/session/request 접수, 중복·충돌·busy 처리, SQLite journal/projection, live/snapshot/replay |
| 모델·context | Scripted, Chat Completions, Responses, Codex adapter; bounded context·완전한 tool exchange·reasoning/phase/native replay |
| 코딩 도구 | 파일 목록·읽기·검색, hash를 검사하는 patch, POSIX 명령·timeout·cancel·bounded output |
| 승인·프로세스 | fingerprint 승인·거절·만료, terminal에서 pending 승인 정리, 별도 command supervisor와 effect marker |
| 변경 검토·복원 | Run diff, 정확한 텍스트 전후 표시, readonly restore preview, workspace maintenance lease, durable restore audit·중복 실행 방지·미확정 결과 격리 |
| 데스크톱 host | 별도 utility의 엔진/SQLite 소유, sandbox/context isolation preload, sender 검증, bounded invalidation, reload detach·재연결·종료 정리 |
| GUI | 프로젝트·세션, 대화·도구 카드, 승인·거절, Plan/Build, 중지, 파일 읽기·diff, 복원 확인·기록, 모델 설정·초안 보존 |
| 앱 bundle | Vite/esbuild production build, macOS arm64 `.app`, ASAR 내부 command supervisor 실행 |
| 추가 서비스 | config 병합, WorkspaceObserver, SQLite 검사·backup, readonly marker 검사, doctor와 JSONL harness |


## 탐색·대화·복구 후속 구현

- `.gitignore`의 중첩·예외 규칙, `.venv`·Python 캐시 등의 탐색 제외, 남은 출력 예산과 UTF-8 페이지를 반영했다. 같은 읽기 반복은 차단하고 변경 후 검증 읽기는 허용한다.
- Plan/Build 기본 지침, 작은 탐색 범위, 출력이 잘렸을 때의 후속 행동을 context에 넣는다. 긴 대화는 기존 메시지의 출처가 있는 8 KiB 이하 발췌 요약과 최근 완전한 tool exchange를 사용한다. 원본과 native replay는 보존한다.
- GFM 표, 12종 선언 언어 코드 강조, 사용자 클릭에 따른 원문 복사, 긴 코드 페이지, 저장소 내부 파일·줄 이동과 오류별 다음 행동을 표시한다.
- 이력은 작업 단위 20개씩 읽으며 최신 실행 상태·취소는 별도로 유지한다. 공급자가 보고한 token 사용량과 실제 직렬화 context bytes를 표시하고 미제공·최근 2,000개 이벤트 한도를 구분한다.
- Codex 로컬 모델 목록·추론 강도와 로그인 메타데이터 새로고침을 연결했다. 로그인·토큰 갱신은 Codex에서 수행한다.

현재 단계의 한도·검증 근거는 [후속 구현 보고서](./implementation-reports/13-engine-desktop-followup.md)에 기록했다. 이전 실제 Codex 계정 검증은 아래 기록으로 보존하며, 이번 회귀 검증에는 실제 공급자 호출이 포함되지 않는다.

## 검증 결과

| 실행 | 결과 |
|---|---|
| 전체 compiled 테스트 | 1,282개 중 1,281 통과, 실패·취소 0, Windows 전용 1 skip |
| 실제 Electron GUI E2E | read→patch 승인→명령 승인→완료·diff, pending 승인 reload, 승인 거절, running reload·cancel, 외부 편집 이후 stale restore 거절, 정상 복원·durable history·file read, utility 강제 종료 후 재연결 통과 |
| 후속 대화·이력·복구 GUI | GFM·코드 페이지·원문 native copy·줄 이동, 25개 이력 paging·최신 취소, 중단 복원→두 DB backup 검증→재연결·full restart 통과. 네트워크 호출 0 |
| 실제 macOS 설정 저장 | native safeStorage 암호화·0600 파일·renderer credential 미반환, dialog 오류 표시·저장 키 삭제·Codex 전환 통과. 공급자 호출 0회 |
| 실제 Codex 모델 | 현재 `gpt-6.1-sol` 최소 텍스트 요청 성공. 임시 Git 저장소에서 read_file→apply_patch 승인→run_command 승인→테스트 exit 0·cleanup 확인→완료 성공 |
| 실제 Codex GUI | renderer→sandbox preload→main→utility→실제 Codex→durable snapshot→renderer 응답 표시 성공 |
| macOS bundle | Electron 44.5.1 / Node 24.21.0 / arm64 `.app`의 utility·SQLite·renderer 시작, packaged fixture override 무시, ASAR supervisor의 실제 명령 exit 0·cleanup 확인 성공 |
| Desktop host 작업 세션 | source/compiled 132/132 통과, 실제 Electron host smoke 29/29 확인. 상세는 11-desktop-host 보고서 |

자동 GUI 검증은 임시 Git 저장소·user data·scripted fixture만 사용한다. 실제 Codex 검증은 별도로 명시적 실행했고, 정확히 지정한 임시 파일 변경·테스트 명령만 승인했다. 계정 인증값·원본 응답·reasoning ciphertext를 검증 보고서에 기록하지 않았다. 이전 엔진 단계의 838개 테스트와 데스크톱 단계의 1,199개 테스트·실제 Codex 결과는 실행 결과 JSON의 이전 단계 기록으로 보존한다. 이번 단계의 실제 대화 표시·이력·복구 GUI 및 최신 arm64 bundle 검증도 통과했다.

최종 읽기 전용 검토에서 찾은 설정 오류 표시, credential 삭제, 복원 기록 실패 표시, history 합계 및 화면 전환 경합을 수정했다. renderer store의 늦은 응답·구독·재연결·같은 request ID 재시도는 별도 6개 테스트로 검증한다. 명령 정리 중 `EPERM`은 종료 확인으로 취급하지 않고 제한 시간 동안 실제 group 부재를 관측하며, 계속 접근할 수 없으면 미확정 결과를 유지한다. [GUI 통합 검증 보고서](./implementation-reports/12-desktop-integration.md)에 최종 근거를 기록했다.

## 공개 연결 범위

공개 command는 `engine.getCapabilities`, `workspace.open`, `workspace.getStatus`, `file.list`, `file.read`, `session.create`, `session.list`, `session.getSnapshot`, `session.getHistory`, `session.getMetrics`, `run.submit`, `run.cancel`, `approval.decide`, `review.getDiff`, `review.previewRestore`, `review.restore`, `review.history`, `events.subscribe`다. GUI와 JSONL은 같은 계약 검증을 사용한다.

`review.restore`는 command ID를 작업 ID로 기록하고, 같은 binding의 재전송은 기록된 결과를 돌려준다. 새 복원은 terminal Run의 checkpoint여야 하며, 같은 workspace의 Run·복원 lease와 동시에 진행하지 않는다. 중단된 복원 기록이나 결과 기록 실패는 해당 workspace의 추가 실행을 차단한다.

`integrityCheck()`, `backup()`, `WorkspaceObserver`, `getDiagnostics()`, `inspectExecutionLock()`은 engine 프로그램 API다. GUI 진단·복구와 대화 DB 백업을 연결했다. 복구는 별도 utility에서 현재 fingerprint와 실제 ownership·PID/group 부재를 다시 확인하고 대화·복원 DB 백업을 검증한 뒤 exact binding을 ledger에 남긴다. 원본 Run·복원 journal과 terminal event는 바꾸지 않는다.

## 남은 작업과 한계

- group PID가 없는 effect marker, 살아 있는 프로세스, 접근 권한 부족, daemon 등 종료를 증명할 수 없는 상태는 복구 화면에서도 차단한다.
- macOS 서명·공증·설치/업데이트, Linux 지원 검증, Windows process-tree 실행. 현재 bundle은 서명되지 않은 개발용 앱이다.
- 앱 자체 Codex 로그인·토큰 갱신, 다중 계정 선택, 추가 공급자·모델별 실제 계정 검증.
- 고급 semantic compaction·전체 이력 검색, 대화형 PTY, MCP, worktree 병렬 실행, 제품 subagent와 LSP/편집 기능.
- 원래 POSIX process group을 벗어난 daemon, 저장소 밖 효과, binary·directory·mode·ownership 전체 복원은 지원 범위 밖이다. 파일 복원은 독립 적용이므로 부분 실패가 가능하다.

OpenCode GUI의 주요 코딩 작업 경로를 연결한 첫 버전이며, 전체 제품 기능의 동등 구현을 의미하지 않는다. 서명된 공개 배포와 장기 세션 기능은 후속 단계다.
