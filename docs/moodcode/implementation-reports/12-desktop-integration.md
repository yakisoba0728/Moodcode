# Moodcode 데스크톱 통합 검증

2026-10-04, Asia/Seoul. 자체 엔진과 Electron GUI를 통합하고, 사용자가 지정한 기존 Codex 로그인으로 실제 모델과 코딩 도구 loop를 검증했다. 세부 모듈 구현은 03·04·05·07·11 보고서를 따른다. 이 보고서는 최종 통합 담당 범위다.

## 구현

- React 작업 화면: 프로젝트·세션, 초안, Plan/Build, 대화·도구 기록, fingerprint 승인·거절, 취소, 파일 읽기, 정확한 전후 diff, 복원 확인·기록, 모델 설정.
- renderer store: committed snapshot 조회, invalidation 병합, monotonic sequence, generation·선택 revision guard, 늦은 subscription 해제, reload 시 실행 유지, 같은 request ID 재시도.
- Electron production build: Vite renderer, esbuild main·utility·CJS preload·command supervisor, ASAR를 사용하는 macOS arm64 개발용 앱. renderer는 로컬 파일과 sandbox bridge로 실행된다.
- 설정: Codex 로그인 메타데이터, API 공급자 endpoint/model, native safeStorage 암호화, 저장 키 삭제. 설정 실패는 열린 dialog에서 표시한다.
- 복원 결과: metadata 저장 실패와 미확정 effects를 성공과 구분해 표시하고, bounded history 배열 대신 totals를 사용한다. 늦은 파일·preview·restore 응답은 현재 workspace/Run을 덮어쓰지 않는다.

## 실제 계정 검증

현재 로컬 Codex 모델은 `gpt-6.1-sol`이다. 실제 Codex 응답은 모델 adapter로 받아 Moodcode 자체 엔진의 도구와 승인 정책으로 실행했다. 최소 텍스트 요청, 임시 Git 저장소의 `read_file` → `apply_patch` 승인 → 정확한 `node --test math.test.mjs` 명령 승인 → exit 0·cleanup 확인 → completed를 검증했다. 실제 GUI에서도 renderer → sandbox preload → main → utility → Codex → durable snapshot → renderer 응답 표시가 성공했다.

토큰은 매 turn 로컬 Codex 인증 파일에서 읽고 고정된 Codex 경로에만 사용한다. 인증 파일을 수정하거나 갱신하지 않았다. renderer·설정·journal·검증 보고서에 credential을 복사하지 않았다. 앱 자체 로그인과 토큰 갱신은 후속 범위다. 실제 호출은 기본 테스트에 포함하지 않으며, `npm run verify:codex`로 명시적으로 실행한다.

## 최종 검증

| 명령/경계 | 결과 |
| --- | --- |
| `npm test` | 1,199 tests / 1,198 pass / 0 fail / 0 cancelled / Windows 1 skip |
| `npm run test:desktop` | 실제 Electron GUI 코딩·승인·복원·취소·프로세스 중단 복구 5개 시나리오와 native 설정 검증 성공 |
| `npm run test:desktop-package` | 현재 production `.app` 시작, utility/SQLite·context isolation, packaged fixture override 무시, ASAR supervisor 실제 명령 exit 0·cleanup 확인 성공 |
| renderer store | DOM 없는 fake DesktopApi로 독립 6개 회귀 테스트 통과; 전체 테스트에 포함 |
| 최종 읽기 전용 검토 | 발견한 7개 UI/상태 문제 수정 후 남은 blocker 없음; 소스 검토와 실제 실행 검증은 별도 수행 |

GUI E2E는 실제 임시 Git 저장소와 utility engine을 사용한다. patch를 승인하기 전 파일이 변경되지 않고, 거절하면 이후 명령도 실행되지 않는다. 승인 대기와 실행 중 reload가 새 Run 또는 재실행을 만들지 않는다. 외부 편집 후 stale 복원은 파일을 보존하고, 정상 복원은 durable history에 남으며 완료된 Run의 마지막 event sequence는 유지된다. 파일 목록·읽기는 Run을 만들지 않는다. 해당 앱이 소유한 utility PID만 강제 종료하고, 재연결 후 interrupted Run을 확인하며 모델·도구를 자동 재실행하지 않는다.

Native 설정 검증은 임시 user data와 fake credential을 사용하고 공급자 요청을 0회로 유지한다. encrypted storage의 파일 mode 0600, plaintext 미저장, renderer credential 미반환, dialog 오류 표시, 기존 저장 키 삭제, Codex 설정 전환을 실제 macOS Electron에서 확인했다.

전체 병렬 테스트에서 드러난 WorkspaceObserver 초기 sampling 경합은 고정 sleep 대신 실제 sample 완료를 기다리는 테스트로 보정했다. 실제 Git/파일 sampling 구현은 유지했다. 명령 정리 중 일시적 `EPERM`은 absence 증거가 아니므로 group 관측을 제한 시간 내 계속한다. 접근 거절이 지속되면 cleanup은 false이고 기존 uncertainty 정책을 유지한다. 이 경계의 네 가지 회귀 테스트와 기존 실제 자식·손자 프로세스 정리 테스트가 통과했다.

## 제공 결과와 한계

앱은 `release/mac-arm64/Moodcode.app`이며 생성 결과는 Git에서 제외한다. 소스·테스트·빌드 설정과 실행 결과는 저장소에 보존한다. 현재 bundle은 서명·공증되지 않았으며 기본 Electron 아이콘을 사용한다. 공개 배포·updater, Linux/Windows 지원 검증, 앱 자체 인증 갱신, uncertainty 복구 화면, history paging/compaction, PTY·MCP·제품 subagent는 남은 범위다.
