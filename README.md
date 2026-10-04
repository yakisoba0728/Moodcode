# Moodcode

Electron 데스크톱 앱을 목표로 하는 로컬 코딩 에이전트다. 현재 구현 범위는 GUI보다 먼저 개발하는 독립 TypeScript/Node 엔진과 개발용 JSONL harness다.

엔진이 세션·요청 접수·모델 turn loop·도구·승인·취소·SQLite 기록과 replay를 소유한다. 모델 adapter는 한 turn의 통신만 담당한다. GUI를 연결할 때 같은 엔진을 Electron utility process에서 실행한다. 설정 파일, 저장소 변경 감시, DB 검사·백업, 변경 복원 preview와 runtime 진단도 구현했다. 실제 완료 범위와 검증 결과는 [구현 상태](docs/moodcode/implementation-status.md)에 기록한다.

## 개발 실행

현재 개발 runtime은 `.nvmrc`의 Node 26.9.0이며, 최소 Node 24의 `node:sqlite` API를 사용한다. Git이 필요하다. 최종 Electron bundle 검증과 공개 지원 OS 결정은 별도 단계다.

```sh
npm ci
npm run build
npm test
npm run demo
npm run test:electron
npm run test:electron-runtime
npm run doctor -- --workspace . --json
npm run harness -- --db /tmp/moodcode-local.sqlite
```

`demo`는 임시 Git 저장소와 scripted 모델에서 파일 읽기·patch 승인·적용·명령 승인·테스트 실행·결과 조회를 연결하는 로컬 검증이다. 임시 fixture에 대해서만 승인한다. 실제 공급자 성공 여부를 검증하는 호출은 아니다.

실행 환경의 npm이 설치 script 승인을 요구하면 Electron runtime과 esbuild의 설치 상태를 확인한다. 저장소 테스트와 Electron smoke는 각각 다른 실행 경계를 확인한다.

## JSONL harness

stdin에 command envelope를 한 줄씩 전달한다. 실행 중에도 승인과 취소 command를 보낼 수 있다. stdout은 JSONL result/event, stderr는 진단이다. EOF와 signal은 진행 중인 실행을 정리하고 종료한다.

```json
{"schemaVersion":1,"commandId":"open-1","type":"workspace.open","payload":{"path":"/absolute/path/to/repository"}}
```

반환된 workspace ID로 `session.create`를 호출하고 session ID로 `run.submit`을 호출한다. config가 없으면 scripted/local, plan 모드와 기본 budget를 사용한다. `run.submit` 결과는 접수 receipt이며 최종 응답은 event/snapshot에서 조회한다.

지원 command는 `engine.getCapabilities`, `workspace.open`, `session.create`, `session.list`, `session.getSnapshot`, `run.submit`, `run.cancel`, `approval.decide`, `review.getDiff`, `events.subscribe`다. 파일 쓰기와 명령 실행은 build 모드에서도 요청별 승인이 필요하다. 같은 workspace는 활성 Run 하나다. 같은 session/request ID의 재전송은 기존 접수 결과를 반환한다.

모델 adapter는 `scripted`, `openai-compatible`(Chat Completions), `openai-responses`(Responses)다. Responses의 reasoning·phase·원본 도구 호출 항목은 SQLite에 보존하고 후속 turn에서 재생한다. HTTP adapter는 호출자가 지정한 endpoint·model·API key를 사용한다. 실제 모델 연결과 계정 권한은 별도 검증 대상이다. API key는 환경 변수로 주입한다.

## 설정

`--config`와 `--workspace-config`로 JSON 파일을 지정한다. 우선순위는 기본값 → 사용자 파일 → workspace 파일 → 명시적 CLI flag → `run.submit`의 명시적 config다. 지정하지 않은 요청 필드는 엔진 기본값을 따른다. 공급자 ID는 위 세 종류를 지원한다.

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
- `apps/engine-harness`: GUI 없는 개발용 입력·이벤트·기록 조회
- `docs/moodcode`: 제품·엔진 설계, 병렬 작업 범위, 구현 보고서
- `docs/opencode-analysis`: 구현 전 OpenCode 원본 분석

Run은 완료·실패·사용자 취소·프로세스 중단을 구별한다. 재시작 시 미완료 실행은 interrupted로 기록하고 도구를 자동 재실행하지 않는다. SQLite transaction은 journal과 공개 상태를 함께 기록하며, 파일·shell 효과까지 원자적으로 묶지는 않는다.

명령 실행은 별도 supervisor가 담당한다. 엔진 프로세스가 강제 종료되면 supervisor가 원래 POSIX process group을 정리한다. 효과가 진행 중이거나 정리 여부가 불확실하면 SQLite 실행 marker가 엔진 재시작을 차단한다. 파일 patch도 같은 실행 잠금을 사용한다. 불확실한 marker를 자동 제거하지 않으며, 이를 확인하고 해제하는 사용자 흐름은 후속 구현 대상이다. 현재 명령 실행은 macOS에서 검증했고 Windows에서는 지원하지 않는다.

현재 GUI·대화형 PTY·MCP·멀티 에이전트·OAuth·compaction·공개 배포는 구현 범위 밖이다. 임의 shell 명령의 모든 부작용이나 동시에 외부에서 편집한 파일의 원인을 정확히 복원한다고 보장하지 않는다.

[엔진 명세](docs/moodcode/engine-spec.md) · [구현 계획](docs/moodcode/implementation-plan.md) · [병렬 작업 계약](docs/moodcode/parallel-implementation.md) · [세션 목록](docs/moodcode/implementation-sessions.json)
