# Headless engine CI와 OS 검증 범위

2026-10-07 기준 `.github/workflows/engine.yml`을 작성했다. **워크플로 구성과 로컬 launcher 검증만 완료했으며 GitHub Actions를 실행하거나 Linux/Windows 실제 통과를 확인하지 않았다.** 기존 엔진 전체 gate는 macOS arm64 / Node v26.9.0에서 root 세션이 확인한 결과이다. CI green badge나 다른 OS 지원 증거로 바꾸어 해석하지 않는다.

## 구성한 matrix

| Lane | Runner / Node | 실행 범위 | 현재 확인한 상태 |
| --- | --- | --- | --- |
| POSIX full | `macos-15` arm64 × `24.x`, `26.x` | locked install, PTY 준비·native module 확인, headless typecheck/build/test, local scripted eval | 로컬 macOS Node26에서 엔진 gate 통과 이력; 새 matrix 실행은 미확인 |
| POSIX full | `ubuntu-24.04` x64 × `24.x`, `26.x` | 위와 동일, 실제 POSIX child/group/PTY fixture 포함 | CI 구성 완료; Linux 실제 실행 미확인 |
| Windows portable | `windows-2025` x64 × `24.x`, `26.x` | headless source typecheck/build, contracts 전체, 명시한 SQLite fixture, fake native ownership port fixture | CI 구성 완료; Windows 실제 실행 미확인; 전체 엔진 지원을 뜻하지 않음 |

runner 이름과 architecture는 [GitHub-hosted runner 공식 표](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)를 확인했다. `latest` runner 대신 OS label을 고정했다. OS 이미지 내부 도구와 Node patch는 계속 갱신될 수 있으므로 artifact에 실제 platform/arch/Node/commit을 기록한다. 이 matrix는 Node 24 이상을 다루며 Node22 이하·Bun·Electron ABI 검증은 포함하지 않는다. macOS Intel/Linux arm64/Windows arm64 역시 후속이다.

## Action 버전과 실행 권한

공식 release 페이지 및 tag의 action metadata를 확인하고 다음 SHA를 사용한다. 조회 시점과 이후 업데이트는 구분한다.

| Action | 확인한 release | 고정 SHA |
| --- | --- | --- |
| [actions/checkout](https://github.com/actions/checkout/releases/tag/v7.0.1) | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [actions/setup-node](https://github.com/actions/setup-node/releases/tag/v7.0.0) | v7.0.0 | `820762786026740c76f36085b0efc47a31fe5020` |
| [actions/upload-artifact](https://github.com/actions/upload-artifact/releases/tag/v7.0.0) | v7.0.0 | `bbbca2ddaa5d8feaa63e36b76fdaad77386f024f` |

셋 모두 tag의 `action.yml`에서 Node24 action runtime을 확인했다. [checkout 공식 요구사항](https://raw.githubusercontent.com/actions/checkout/v7.0.1/README.md)은 runner v2.327.1 이상이다. 이 workflow는 GitHub-hosted runner용이며 오래된 self-hosted runner에서의 실행을 보장하지 않는다. [upload-artifact 설명](https://github.com/actions/upload-artifact/blob/v7.0.0/README.md)에 따라 v4+가 지원되지 않는 GHES는 별도 구성이 필요하다.

이 workflow는 push/pull_request/workflow_dispatch만 사용하고 contents read 권한만 요청한다. checkout은 `persist-credentials: false`이다. 라이브 provider key나 Codex account, 배포 secret을 전달하지 않는다. setup-node의 npm cache는 lockfile에 묶인 package cache이며 native node_modules를 OS 간 복사하지 않는다. 동일 ref의 새 run은 이전 run을 취소할 수 있다. 취소되거나 runner가 강제 중단되면 마지막 artifact 업로드 자체가 끝나지 않을 수 있다.

## 설치와 gate 순서

`npm ci --include=optional`로 lockfile의 root/workspace dependency 및 optional node-pty를 설치한다. `ELECTRON_SKIP_BINARY_DOWNLOAD=1`을 설정하여 root dev dependency의 Electron binary 다운로드를 생략한다. GUI를 실행하거나 데스크톱 build/package를 호출하지 않는다. dependency install script는 npm 기본 동작대로 수행된다.

설치 다음 `node scripts/prepare-pty.mjs`를 호출한다. 이 명시적 helper는 macOS node-pty prebuilt spawn-helper 실행 비트를 보정한다. POSIX lane은 optional native module을 실제 require하고 spawn API가 없으면 실패한다. module load 자체를 실제 PTY 종료 검증으로 간주하지 않는다. 실제 TTY·resize·input·cancel·supervisor parent-loss 검증은 후속 engine fixture가 담당한다. Windows lane은 준비 결과와 지원 공백을 기록하고 실제 PTY를 시작하지 않는다.

compiler는 `tsc -b packages/contracts packages/engine apps/engine-harness`만 대상으로 한다. typecheck는 기존 build-mode의 타입 검사/emit이며 build는 `--force`로 headless output을 다시 생성한다. root 전체 `npm run build`, desktop renderer, Electron launch는 사용하지 않는다. POSIX 테스트는 기존 `scripts/test-engine.mjs`를 사용한다. 평가도 기존 `scripts/evaluate-engine.mjs`의 세 local scripted coding task이며 실제 모델 품질·네트워크 provider 연결·과금·계정 인증의 증거는 아니다.

POSIX full lane은 build 이후 `node .github/scripts/engine-ci.mjs test-media-local`도 실행한다. 기존 engine fixture/eval은 별도 `.mjs` CLI 테스트를 포함하지 않으므로 이 단계에서 `plan-media-verification.test.mjs`와 `verify-media-account.test.mjs`를 명시적으로 실행한다. 실행기는 `MOODCODE_MEDIA_VERIFY_TEST_ENGINE=compiled`로 빌드된 엔진을 사용하며, 실제 native media receipt·로컬 HTTP fixture·입력 거부·중복·partial 취소·paused import·불확실한 cleanup 보존을 확인한다. 라이브 계정 CLI나 `--live`는 호출하지 않으며 fixture 통과에 account 검증 credit을 부여하지 않는다. 이 단계의 명령·compiled 선택·stdout/stderr·실패는 `test-media-local` 로그와 step 기록에 남는다. Windows portable lane 범위에는 추가하지 않는다.

push/pull_request의 경로 필터에는 `scripts/verify-media-account*.mjs`와 `scripts/plan-media-verification*.mjs`를 포함하여 해당 실행기·계획·테스트만 변경해도 CI 실행 조건을 충족한다. 워크플로 구성 변경과 로컬 단계 통과는 실제 GitHub hosted run 등록·완료 확인과 구분한다.

## Windows partial gate

`.github/scripts/engine-ci.mjs`의 명시 목록은 `storage`, `migrations`, `native-inbox`, `native-records`, `native-documents-history`, `history-search`, `next-stage-history-metrics`, `terminal-approval`이다. contracts의 compiled 테스트 전체와 `tools/command/backends.test.js`도 실행한다. 이 목록은 SQLite journal/CAS/history/migration/terminal approval 및 portable ownership callback 계약을 다룬다. 빠진 compiled fixture나 비어 있는 contracts 발견은 실패한다. 신규 storage 테스트가 자동으로 포함되지는 않으며 portability 확인 뒤 목록을 갱신한다.

POSIX signal crash, symlink/permission ownership/backup, 실제 shell/process group/PTY, worktree·LSP process lifetime와 local coding eval는 Windows lane에서 실행하지 않는다. `v1-compatibility` 파일에는 POSIX recovery/backup 경계도 함께 있어 partial 목록에서 제외했다. 이는 해당 기능의 Windows 정상 동작을 확인했다는 의미가 아니다.

실제 native Windows Job Object binding이 없으므로 `WindowsJobCommandBackend`는 capability unavailable을 유지한다. backends fixture의 fake host callback이 통과해도 Job Object assignment/child tree/timeout/parent crash를 Windows OS에서 검증한 것으로 기록하지 않는다. actual Windows fixture는 명시적으로 skip되고 result metadata의 `windowsFullEngineVerified`는 false이다. E5-08의 native 구현과 실제 Windows process-tree 검증은 남아 있다. Windows partial lane 자체도 첫 실제 Actions 실행 전까지 미검증이다.

## 결과와 실패 로그

보조 launcher는 Node 표준 API로만 실행하고 dynamic shell command를 만들지 않는다. `artifacts/engine-ci/`에 environment.json, steps.json, results.json, 각 작업의 합친 log와 분리된 stdout/stderr, PTY module 준비 결과를 저장한다. eval의 구조화된 JSON은 실패한 task가 있어도 파싱 가능하면 evaluation.json으로 남긴다. compiler/fixture/eval exit code를 그대로 gate 실패로 반영한다. helper 오류도 launcher-error.log에 기록한다.

job summary와 upload-artifact step은 `if: always()`이며 job/matrix별 artifact 이름으로 14일 보관한다. dependency install 실패도 install.log에 남긴다. checkout/setup-node 이전 실패나 전체 runner 강제 종료는 파일 artifact를 만들지 못할 수 있으므로 GitHub job log를 함께 확인해야 한다. fixture는 임시 저장소와 가짜 credential만 사용한다. 실제 계정 파일/환경 변수 덤프/모델 응답을 CI artifact로 수집하지 않는다.

## 완료한 로컬 확인과 다음 검증

로컬에서는 launcher `node --check`, fixture 세 개, YAML parsing과 trigger/matrix/고정 SHA/always-summary 구조, plan/summary가 실행 없이 현재 darwin·Node26 및 `not-a-github-run`을 기록하는 것을 확인했다. 이 확인은 설치를 새로 실행하거나 workflow를 dispatch하지 않았다. GitHub expression의 실제 평가나 hosted image에서의 optional native dependency 설치도 아직 확인하지 않았다.

첫 실제 Actions run에서 Node24/26 두 ABI의 PTY load/TTY fixture, Linux group/descendant 정리, Windows SQLite close/locking, artifact 결과·실패 retention을 확인한다. 실패를 skip으로 숨기기보다 해당 OS의 구현 문제 또는 명시적 지원 공백으로 분리해 수정한다. editor UI·GUI smoke·packaging·서명/배포는 별도 승인된 pipeline 범위이다.
