# Moodcode

Electron 기반 로컬 코딩 에이전트다. 자체 TypeScript/Node 엔진, 데스크톱 GUI와 개발용 JSONL harness를 구현했다.

엔진이 세션·요청 접수·모델 turn loop·도구·승인·취소·SQLite 기록과 replay를 소유한다. 모델 adapter는 한 turn의 통신만 담당한다. GUI는 같은 엔진을 Electron utility process에서 실행하며 sandbox preload bridge로 연결한다. 설정 파일, 저장소 변경 감시, DB 검사·백업, 변경 복원 preview와 runtime 진단도 구현했다. 실제 완료 범위와 검증 결과는 [구현 상태](docs/moodcode/implementation-status.md)에 기록한다.

현재 후속 작업은 내부 엔진 우선이다. [엔진 TODO](TODO.md)의 기반 74/75와 2차 80/80 항목·20/20 기능군을 명시한 지원 범위에서 구현·검증했다. queue/steer·Turn/Part·요약·scoped tools·MCP·PTY·child/team·workflow·ACP·승인한 변경 통합·LSP·archive·미디어·진단을 자체 엔진에 연결했고 native Windows, 고급 GUI와 계정·업데이트 준비를 통합했다. 후속 저장 직렬화 개선·renderer lazy loading·main utility 종료 관측을 검증했다. `663a3a0` 수용 기준의 macOS CI 전체 4,853개 중 4,851 pass·실패 0·기존 Windows skip 2, 새 실제 30분 실행의 입력 1,532개·382회 누적을 확인했다. [엔진 검증](docs/moodcode/next-continuation-engine-verification.json)·[현재 진행](docs/moodcode/next-continuation-progress.json)·[host API](docs/moodcode/engine-host-api.md)를 따른다. 실패·unknown fixture 원본 보존과 영향 회귀를 보강했고 최종 구현 `663a3a0`의 OS CI 11개도 통과했다. [현재 수용 근거](docs/moodcode/next-continuation-acceptance.json)를 따른다. 실제 추가 공급자 계정·SIWC 로그인·서명 배포는 사용자의 준비 후 검증 결정으로 대기하며 과거 PTY 실패 원인은 미확정이다.

전체 최초 점검은 소유 1,092개 파일의 실제 읽기·매핑과 독립 대조를 마쳤고, 후속 36건의 수정·유지 판정을 기록했다. 현재 공동 빌드와 네 프로젝트 전체 compiled 회귀 5,243개 중 5,240 pass·실패 0·Windows 전용 skip 3, 코딩 과업 3/3·quick 복구·성능·실제 GUI 7-flow를 통과했다. 공개 API와 DB23 catalogue를 유지했다. 새 소스의 실제 30분 관측·지원 OS CI·패키지 수용은 아직 남아 있다. 기존 `663a3a0` 결과와 현재 소스의 검증 범위를 구분한다. [현재 소스·로컬 검증](docs/moodcode/next-whole-review-source-verification.json)을 따른다.

OpenCode/pi/Amp/Claude Code/Codex 등 19개 공개 코딩 에이전트의 근거를 비교하며 자체 엔진을 구현했다. 2차 최종 source `99bf6f0`의 전체 로컬 gate는 4,701개 중 4,699 pass·실패 0·기존 Windows 조건부 skip 2이며 실제 공개 CI 여섯 작업도 통과했다. macOS/Linux 전체 엔진과 Windows portable 범위를 구분하며, 이 결과가 모든 OS·공급자·GUI의 검증을 의미하지는 않는다. [최종 검증](docs/moodcode/engine-phase-two-final-acceptance-verification.json), [기본 도구 문맥 계약](docs/moodcode/engine-eager-catalogue-context.md), [TODO](TODO.md)를 따른다. 후속 PTY 진단·복합 실행 검증·코딩 평가·성능 baseline을 구현했다. 별도 932개 입력 동결본에서 전체 회귀 4,723개 중 4,721 pass·실패 0·기존 skip 2, 60회 반복, native 코딩 과업 3/3, quick/standard 성능 gate를 통과했다. 공개 CI 여섯 작업도 통과했으며 [보강 검증 근거](docs/moodcode/engine-hardening-verification.json)를 따른다.

## 개발 실행

2차의 원래 80개 작업과 20개 기능군은 완료했다. [진행표](docs/moodcode/engine-phase-two-progress.json)와 [최종 검증](docs/moodcode/engine-phase-two-final-acceptance-verification.json)을 따른다. Electron의 고급 패널에서 inbox·tasks/questions·MCP·PTY·child/team·workflow·LSP를 연결한다. 첫 workflow 화면은 읽기·진단 범위이며 고급 효과는 명시적 host 설정·대상 선택·승인을 요구한다.

현재 개발 runtime은 `.nvmrc`의 Node 26.9.0이며, 최소 Node 24의 `node:sqlite` API를 사용한다. Git이 필요하다. macOS arm64·Linux x64·Windows x64의 서명 없는 개발용 bundle과 실제 utility 실행을 검증했다. Windows 명령은 Job Object를 사용하며 Windows PTY·arm64 앱은 미검증 범위다. 고급 GUI 전체 흐름은 macOS에서 검증했다. 실제 서명·공증·설치 배포는 별도 조건이다.

```sh
npm ci
npm run prepare:pty
npm run desktop
npm test
npm run test:desktop
node scripts/test-desktop-conversation.mjs
node scripts/test-desktop-history-recovery.mjs
npm run package:desktop
npm run test:desktop-package
npm run build
npm run demo
npm run test:electron
npm run test:electron-runtime
npm run doctor -- --workspace . --json
npm run harness -- --db /tmp/moodcode-local.sqlite
```

데스크톱에서 로컬 저장소를 열고 작업을 생성한다. Plan은 읽기·분석, Build는 승인받은 파일 수정·명령 실행을 진행한다. 대화·도구·승인·변경 전후 diff·파일 읽기·복원 기록을 확인할 수 있다. 화면 새로고침은 실행을 취소하지 않으며, 중지 버튼으로 취소한다. 대화는 표·코드 강조·원문 복사·파일 줄 이동을 지원하고, 이력은 20개 작업씩 읽는다. 탐색은 Git 제외 규칙과 가상환경·캐시를 반영하며 큰 결과는 continuation으로 나눠 읽는다. 상태 표시줄의 사용량은 공급자가 보고한 값만 표시한다.

Codex에 로그인되어 있고 로컬 모델 설정이 있으면 기본 연결은 **Codex 계정**이다. API 키를 입력하지 않는다. 엔진은 매 turn 현재 Codex 인증을 읽고 고정된 Codex endpoint로 통신하며 자체 도구 loop를 실행한다. 인증 파일을 갱신하거나 토큰을 renderer·설정·journal에 저장하지 않는다. 인증이 없으면 화면에 표시된 로컬 테스트 모델로 시작한다. 설정에서 Codex나 API 공급자를 선택할 수 있다. 로컬 Codex 모델 목록과 모델별 추론 강도를 선택하고 로그인 상태·목록을 새로고침할 수 있다. 목록은 캐시의 메타데이터이며 실제 모델 접근 권한은 요청 시 확인된다. 별도 API 키는 Electron safeStorage 암호화가 가능한 경우에만 저장한다.

`npm run package:desktop` 결과는 `release/mac-arm64/Moodcode.app`이다. 현재 서명·공증되지 않은 개발용 bundle이다. `npm run verify:codex`는 실제 계정 사용량을 소비하는 명시적 검증 명령이며, 기본 테스트에는 포함되지 않는다. 임시 저장소의 정확히 지정한 수정·명령만 자동 승인하고 fixture를 삭제한다.

`demo`는 임시 Git 저장소와 scripted 모델에서 파일 읽기·patch 승인·적용·명령 승인·테스트 실행·결과 조회를 연결하는 로컬 검증이다. 임시 fixture에 대해서만 승인한다. 실제 공급자 성공 여부를 검증하는 호출은 아니다.

실행 환경의 npm이 설치 script 승인을 요구하면 Electron runtime과 esbuild의 설치 상태를 확인한다. 저장소 테스트와 Electron smoke는 각각 다른 실행 경계를 확인한다.

앱을 열지 않는 엔진 검증은 다음과 같다. 기본 테스트와 평가는 로컬 fixture이며, live 검증만 현재 Codex 계정의 사용량을 소비한다.

```sh
npm run typecheck
npm run test:engine
node scripts/evaluate-engine.mjs
node scripts/verify-engine-resilience.mjs --profile quick --runtime compiled
node scripts/verify-engine-resilience.mjs --profile extended --runtime compiled
node scripts/benchmark-engine.mjs --profile quick --runtime compiled
node scripts/verify-codex.mjs --live
node scripts/verify-engine-extensions.mjs --live
node scripts/verify-active-prefix.mjs --live
node scripts/verify-summary-recovery.mjs --live
node scripts/verify-child-document-storage.mjs --live
```

resilience는 실제 로컬 명령의 완료·취소·강제 종료/재시작을 반복하며, 평가와 benchmark는 scripted 공급자를 사용한다. 계정·API 키를 읽거나 외부 모델을 호출하지 않는다. 성능 수치는 호스트별 관측값이며 실제 모델의 코딩 품질이나 응답 지연을 평가한 값이 아니다. [안정성 하네스](docs/moodcode/engine-resilience.md)와 [코딩 평가·성능](docs/moodcode/engine-evaluation-performance.md)을 따른다.

전체 엔진 gate는 기본 동시성 4다. 메모리가 부족한 호스트에서는 `MOODCODE_ENGINE_TEST_CONCURRENCY=2 npm run test:engine`처럼 1~32 사이의 동시성을 지정할 수 있다. 테스트 목록은 같다. 요약 복구 live 검증의 불확실 요청은 임시 fixture이며 실제 Codex 호출은 host 결정 뒤 명시적인 새 Run 한 번이다.

Child 문서 저장 live 검증은 실제 Codex 자식 text 요청 1회와 보관·검증·pause import를 확인한다. Host가 저장한 opaque PDF는 원격 요청에 포함하지 않는다. 성공한 경우 소유한 임시 경로를 제거하고 실패하면 검토용으로 보존한다.

## JSONL harness

stdin에 command envelope를 한 줄씩 전달한다. 실행 중에도 승인과 취소 command를 보낼 수 있다. stdout은 JSONL result/event, stderr는 진단이다. EOF와 signal은 진행 중인 실행을 정리하고 종료한다.

```json
{"schemaVersion":1,"commandId":"open-1","type":"workspace.open","payload":{"path":"/absolute/path/to/repository"}}
```

반환된 workspace ID로 `session.create`를 호출하고 session ID로 `run.submit`을 호출한다. config가 없으면 scripted/local, plan 모드와 기본 budget를 사용한다. `run.submit` 결과는 접수 receipt이며 최종 응답은 event/snapshot에서 조회한다.

지원 command는 `engine.getCapabilities`, `workspace.open`, `workspace.getStatus`, `file.list`, `file.read`, `session.create`, `session.list`, `session.getSnapshot`, `session.getHistory`, `session.getMetrics`, `run.submit`, `run.cancel`, `approval.decide`, `review.getDiff`, `review.previewRestore`, `review.restore`, `review.history`, `events.subscribe`다. 파일 쓰기와 명령 실행은 build 모드에서도 요청별 승인이 필요하다. 같은 workspace는 활성 Run 하나다. 같은 session/request ID의 재전송은 기존 접수 결과를 반환한다.

v2 command envelope는 `schemaVersion:2`를 사용하며 queue/steer inbox·pause/resume·독립 session events·Turns/Parts/artifact·tasks/questions/context/history/diagnostics 조회를 제공한다. event와 cursor의 `stream`은 `'session-v2'`이고 v1 seq와 v2 seq는 서로 다른 cursor다. [v2 계약](docs/moodcode/engine-contracts-v2.md)과 런타임 capabilities를 확인한다. `run.submit`은 기존 즉시 실행·busy·중복 접수 의미를 유지한다.

모델 adapter는 `scripted`, `openai-compatible`(Chat Completions), `openai-responses`(Responses), `codex`(현재 Codex 로그인)다. 데스크톱은 네 종류를 선택할 수 있고 JSONL harness 설정은 기존 세 종류를 지원한다. Responses의 reasoning·phase·원본 도구 호출 항목은 SQLite에 보존하고 후속 turn에서 재생한다. HTTP adapter는 호출자가 지정한 endpoint·model·API key를 사용한다. 현재 Codex 계정의 `gpt-6.1-sol` 실제 응답과 read→patch 승인→명령 승인→완료를 검증했다. 다른 공급자·모델·계정 권한은 별도 검증 대상이다. Harness의 API key는 환경 변수로 주입한다.

## 설정

`--config`와 `--workspace-config`로 JSON 파일을 지정한다. 우선순위는 기본값 → 사용자 파일 → workspace 파일 → 명시적 CLI flag → `run.submit`의 명시적 config다. 지정하지 않은 요청 필드는 엔진 기본값을 따른다. JSONL 설정의 공급자 ID는 `scripted`, `openai-compatible`, `openai-responses`를 지원한다.

```json
{
  "providerId": "openai-responses",
  "modelId": "YOUR_MODEL_ID",
  "mode": "plan",
  "limits": { "maxTurns": 8 },
  "providers": {
    "openai-responses": {
      "baseURL": "https://api.openai.com/v1",
      "apiKeyEnv": "MOODCODE_API_KEY"
    }
  }
}
```

파일에 credential 값은 저장하지 않는다. `apiKeyEnv`가 없으면 `MOODCODE_API_KEY`, 다음으로 `OPENAI_API_KEY`를 조회한다. 명시한 환경 변수에 값이 없으면 실패한다. 설정 파일과 부모 경로의 symlink는 거절하므로 실제 경로를 사용한다.

```sh
npm run harness -- --config /absolute/path/moodcode.json
```

`integrityCheck()`, `backup()`, `WorkspaceObserver`, checkpoint 복원·preview, `inspectExecutionLock()`은 engine 패키지의 프로그램 API다. JSONL의 공개 command와 연결된 범위는 위 command 목록을 따른다.

## 구조와 기록

- `packages/contracts`: versioned command/result/event/snapshot 타입과 입력 검증
- `packages/engine`: 독립 엔진, provider, workspace, tools, permission, storage, review
- `apps/desktop`: Electron main·utility·sandbox preload, React 작업 화면과 모델 설정
- `apps/engine-harness`: GUI 없는 개발용 입력·이벤트·기록 조회
- `docs/moodcode`: 제품·엔진 설계, 병렬 작업 범위, 구현 보고서
- `docs/opencode-analysis`: 구현 전 OpenCode 원본 분석

Run은 완료·실패·사용자 취소·프로세스 중단을 구별한다. 재시작 시 미완료 실행은 interrupted로 기록하고 도구를 자동 재실행하지 않는다. SQLite transaction은 journal과 공개 상태를 함께 기록하며, 파일·shell 효과까지 원자적으로 묶지는 않는다.

명령 실행은 별도 supervisor가 담당한다. 엔진 프로세스가 강제 종료되면 supervisor가 원래 POSIX process group을 정리한다. 효과가 진행 중이거나 정리 여부가 불확실하면 SQLite 실행 marker가 엔진 재시작을 차단한다. 파일 patch도 같은 실행 잠금을 사용한다. 불확실한 marker를 자동 제거하지 않으며, 진단·복구 화면에서 현재 상태를 확인한다. 종료가 확인된 상태만 대화·복원 DB 백업 검증과 사용자 확인을 거쳐 복구 기록에 남기고 차단을 해제한다. 살아 있는 PID/group, 권한 부족 또는 기록되지 않은 group은 해제하지 않는다. Windows x64 Job Object 명령 실행은 Node 24/26의 실제 Windows CI에서 별도로 검증했다. Electron bundle·ARM64·대화형 PTY·OS sandbox의 지원 범위는 해당 검증과 구분한다. [Windows 근거](docs/moodcode/next-windows-ci-verification.json).

복원은 workspace lease 안에서 확인한 fingerprint를 재검증한다. 별도 SQLite review journal에 효과 전 시작과 결과를 기록하므로 완료된 Run의 terminal-last 규칙을 유지한다. 미확정 복원 기록은 재시작 후에도 해당 workspace의 새 실행을 차단한다. 복구 확인은 원본 복원 기록·Run을 수정하지 않고 별도 ledger에 exact binding을 저장한다. 중단된 모델·도구는 자동 재실행하지 않는다. 진단 화면의 대화 DB 백업 버튼은 대화 DB만 저장하며, 복구 절차의 자동 백업은 대화·복원 DB를 함께 보존한다.

대화형 PTY·MCP·worktree child 실행·의미 요약은 엔진 API로 구현했고 고급 GUI 소비도 연결했다. Anthropic adapter는 host 등록 방식으로 text/tool·공개 reasoning summary·replay를 제공하며 실제 계정은 추가 검증이 필요하다. 이미지·PDF·선택한 audio/video 모델의 제한된 계약을 구현했으며 실제 계정 검증은 기록한 모델·형식에 한한다. 앱 로그인·토큰 갱신·계정 선택과 검토형 업데이트를 구현했고, 실제 사용자 로그인·서명/공증·공개 배포는 외부 조건이 남아 있다. [현재 지원 범위와 검증 한계](docs/moodcode/next-feature-support-draft.json), [CI 구성과 실제 결과](docs/moodcode/engine-ci.md)를 따른다. 임의 shell 명령의 모든 부작용이나 동시에 외부에서 편집한 파일의 원인을 정확히 복원한다고 보장하지 않는다.

[엔진 명세](docs/moodcode/engine-spec.md) · [구현 계획](docs/moodcode/implementation-plan.md) · [병렬 작업 계약](docs/moodcode/parallel-implementation.md) · [세션 목록](docs/moodcode/implementation-sessions.json)
