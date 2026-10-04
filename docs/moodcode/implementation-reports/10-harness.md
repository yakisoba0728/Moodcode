# 10 — JSONL harness와 Electron utility smoke

작성일: 2026-10-04, Asia/Seoul. layered config와 native Responses CLI 연결까지 구현 완료. 승인된 command 실행을 포함한 `npm run test:electron`과 담당 source/compiled 테스트 **각각 100/100개가 모두 통과했다**. 초기 runner/patch PreparedTool 연결 오류는 통합 담당자의 수정 이후 재검증하여 해결을 확인했다. 담당 경계를 지켜 다른 모듈은 수정하지 않았다.

## 구현 파일과 export

- `apps/engine-harness/src/index.ts`: `main`, `parseArguments`, `resolveCliConfig`, `resolveApiKey`, `withSubmitDefaults`, `USAGE`, `runHarness` 및 transport/config 타입. 직접 실행할 때만 CLI를 시작한다. `loadConfig` 및 `createEngine({dbPath, artifactDir, providers, defaults})`에 실제 연결하며 imports는 ESM/.js suffix다.
- `apps/engine-harness/src/protocol.ts`: `runHarness`, `HarnessEngine`, `HarnessOptions`, `HarnessOutcome`. fake/real engine에 같은 transport를 사용한다.
- `apps/engine-harness/src/protocol.test.ts`: transport와 CLI 선택 테스트 15개.
- `apps/engine-harness/src/cli.integration.test.ts`: 실제 CLI subprocess/SQLite/임시 Git repository/local HTTP SSE fixture 통합 테스트 6개.
- `apps/engine-harness/src/config.test.ts`: CLI explicit flag·설정 우선순위·env reference 독점 선택·legacy/default helper 호환성·invalid 입력 보존 단위 테스트 26개.
- `apps/engine-harness/src/responses.integration.test.ts`: 실제 CLI subprocess/native Responses loopback HTTP/config/auth/SSE/SQLite·WAL/replay 통합 테스트 7개.
- `apps/engine-harness/src/electron-smoke.test.ts`: Electron script orchestration·정확한 fixture 승인·command cleanup·checkpoint·재개방 증거 보존 테스트 **46개(하위 사례 포함)**. 기본 테스트에서 Electron binary를 띄우지 않는다.
- `scripts/electron-smoke.cjs`: 창 없는 Electron main 실행, `utilityProcess.fork`, 실제 utility report 검증, bounded timeout/signal/fixture cleanup, 최종 JSON report. fixture 검증용 `runSmoke`, `launchUtility`, `timeoutFromEnvironment`를 export한다.
- `scripts/electron-engine-child.cjs`: 실제 utility runtime에서 `node:sqlite` in-memory SQL probe → compiled engine import → workspace/session → scripted command 요청 → 정확한 fixture 승인 → 실제 command와 다음 text turn 완료 → snapshot/journal/checkpoint → close → reopen/persistence → close. fixture 검증용 `runEngineProbe`, `parseArguments` 및 고정 fixture 상수를 export한다.

고정 계약 파일·다른 담당 모듈·package.json·lockfile·공통 build 설정은 수정하지 않았다. git mutation이나 npm install을 실행하지 않았다. 별도 사용자 채팅을 만들거나 메시지를 보내지 않았다.

## JSONL protocol

stdin은 고정 `CommandEnvelope` 한 줄이며 다음 command를 처리한다: `engine.getCapabilities`, `workspace.open`, `session.create`, `session.list`, `session.getSnapshot`, `run.submit`, `run.cancel`, `approval.decide`, `review.getDiff`, `events.subscribe`.

```json
{"schemaVersion":1,"commandId":"open-1","type":"workspace.open","payload":{"path":"/absolute/workspace"}}
```

stdout은 다음 형태다. 진단은 stderr다. `run.submit` 응답은 접수 receipt이며 최종 모델 답변과 구별된다.

```json
{"type":"result","schemaVersion":1,"commandId":"open-1","ok":true,"result":{}}
{"type":"event","subscriptionId":"subscribe-1","event":{"schemaVersion":1,"seq":1}}
```

`events.subscribe`는 먼저 facade에 dispatch하여 session/cursor 검증을 받는다. 성공 result를 출력한 다음 `engine.subscribe(sessionId, afterSeq, signal)` reader를 연결한다. subscriptionId는 해당 commandId이며, reader 실패는 `type:"subscription.error"`로 출력한다. 복구는 소비자가 마지막 수신 seq 이후 새 구독을 여는 방식이다. 구독을 닫는 새 command는 고정 계약에 추가하지 않았다.

command handler는 실행 완료를 기다리지 않고 비동기로 병렬 접수한다. 일반 command 슬롯이 찬 경우에도 run.cancel/approval.decide에는 별도 슬롯이 있다. subscription 용량은 await 전에 예약하여 동시 구독이 제한을 우회하지 않는다.

기본 한도는 입력 한 줄 1 MiB, 출력 한 레코드 1 MiB, 대기 출력 4 MiB, 일반 command 64개, 제어 command 8개, 구독 32개, 오류 메시지 2,048자/code 128자, stderr 진단 약 16 KiB, cleanup 10초다. LF/CRLF·분할 UTF-8 입력·마지막 newline 없는 JSON도 처리한다. 잘못된 JSON/UTF-8/알 수 없는 command/지나치게 큰 줄은 bounded error 뒤 다음 줄을 받는다. 출력 queue 초과·broken output·cleanup timeout은 오류 종료다.

EOF/SIGINT/SIGTERM은 새 입력을 중단하고 구독 signal을 abort한다. 이미 접수한 dispatch mutation이 끝나면 engine.close로 실행을 취소하고 DB를 닫는다. stdout이 막혀도 engine.close는 출력 drain과 독립적으로 진행한다. cleanup deadline 실패 시 직접 실행 CLI는 nonzero code로 프로세스를 종료한다.

## CLI 설정과 credentials

```text
npm run harness -- --db /path/state.sqlite --artifacts /path/artifacts
npm run harness -- --provider openai-compatible --base-url http://127.0.0.1:PORT/v1 --model fixture
npm run harness -- --config /path/user.json --workspace-config /path/workspace.json
npm run harness -- --provider openai-responses --base-url http://127.0.0.1:PORT/v1 --model fixture
```

flags와 설정 파일이 없으면 `scripted`/`local`/`plan`, `.moodcode/engine.sqlite`, `.moodcode/artifacts`다. `--db :memory:`도 지원한다. `--config`는 userConfigPath, `--workspace-config`는 workspaceConfigPath를 명시하며 자동으로 다른 파일을 탐색하지 않는다.

우선순위는 engine 기본값 < user 파일 < workspace 파일 < 명시 CLI provider/model/baseURL < incoming `run.submit.config`다. CLI parser는 provider/model/baseURL이 실제 명시됐는지 기록하므로 flag 없이 parsed default scripted/local이 파일의 선택을 덮지 않는다. `--model local`처럼 기본값과 같은 값도 명시됐다면 파일보다 우선한다. 파일 mode/limits는 CLI에서 보존하고 partial limits는 lower layer의 다른 필드를 유지한다. 실제 CLI는 resolved runConfig를 `EngineOptions.defaults`에 전달하여 facade가 요청에서 부재한 필드만 채우게 한다. `engine.getCapabilities {}`에서 이 defaults·provider IDs·tools를 확인할 수 있다.

예시 설정은 다음과 같다. API key 원문 대신 환경변수 이름만 둔다.

```json
{
  "providerId": "openai-responses",
  "modelId": "fixture-model",
  "mode": "plan",
  "limits": {"maxTurns": 4},
  "providers": {
    "openai-responses": {
      "baseURL": "http://127.0.0.1:8080/v1",
      "apiKeyEnv": "MOODCODE_FIXTURE_KEY"
    }
  }
}
```

harness는 scripted/openai-compatible/openai-responses만 지원하며 불명확한 custom provider ID/metadata는 transport를 추측하지 않고 generic 오류로 거절한다. selected remote는 startup에서 구성한다. 파일에 등록된 다른 known remote는 해당 provider를 incoming run이 실제 선택할 때만 lazy 초기화하므로 scripted 시작 자체는 HTTP 호출이나 다른 key 조회를 만들지 않는다. 명시 baseURL은 selected provider에만 적용되고 다른 provider의 파일 endpoint를 바꾸지 않는다.

remote base URL/model은 CLI 또는 설정에서 받아야 한다. `providers[id].apiKeyEnv`가 있으면 정확히 그 환경변수의 own string 값만 참조하며, 없거나 비어 있으면 conventional key가 있어도 실패한다. 이름이 없을 때만 기존 `MOODCODE_API_KEY` → `OPENAI_API_KEY` fallback을 유지한다. API key CLI 인자와 credentials/query/fragment가 들어간 base URL은 거절한다. 실제 주입한 key는 stdout 문자열과 오류·진단에서도 마스킹한다. lazy provider가 뒤늦게 초기화돼도 같은 redaction 목록이 갱신된다. key는 run defaults나 capabilities에 넣지 않는다. 오류 details는 외부 입력/credential을 포함할 수 있어 transport error에서는 생략한다.

exported `withSubmitDefaults(engine, providerId, modelId)`의 valid 기존 API는 유지했다. 새 `withSubmitDefaults(engine, RunConfigInput)` overload는 mode/partial limits까지 채우되 명시된 null/array/invalid 값과 unknown fields를 수정하지 않아 facade validation을 우회하지 않는다. 실제 CLI는 facade defaults를 직접 사용한다.

실제 API 키를 탐색하거나 실제 공급자에 호출하지 않았다. Chat Completions와 native Responses integration은 알려진 가짜 bearer와 127.0.0.1 HTTP fixture만 사용한다.

## Electron command smoke

Electron main은 임시 Git workspace, DB, artifact directory를 만들고 utility process를 실행한다. utility의 scripted 첫 turn은 `run_command`에 정확한 명령 `printf 'moodcode-electron-command\n'`과 timeout 5,000ms를 전달한다. config는 build이며 두 번째 turn은 기존 `EXPECTED_REPLY` text를 반환한다.

자동 승인은 이 임시 smoke fixture 안에만 있다. utility는 journal의 `approval.requested`를 받은 뒤 event session/run, toolName/status/approvalId/fingerprint, preview의 exact command/cwd/timeout/workspaceId/runId/toolCallId/termination과 durable pending ApprovalRecord·ToolCallRecord를 대조한다. 모두 맞을 때 한 번만 `approval.decide({approvalId,decision:'allow',fingerprint})`를 호출한다. 일반 harness나 engine의 승인 정책은 바꾸지 않았다.

완료 snapshot의 command tool은 completed이고 오류가 없어야 하며 실제 stdout marker와 `cleanupConfirmed=true` 문구를 포함해야 한다. 재생한 `tool.completed` event에는 같은 tool binding/output, `isError=false`, `truncated=false`, `cleanupConfirmed=true`가 있어야 한다. `review.getDiff`에는 이 tool의 command checkpoint 하나가 있고 `incomplete=false`, files/diff가 비어 있어야 한다. `workspace.changed` event가 동일 checkpoint를 참조하는지도 검사한다. DB 재개방 후 allowed approval/completed tool/checkpoint와 persisted command completion event를 다시 읽어 비교한다.

parent는 기존 utility runtime/SQLite 검사에 더해 command 관련 8개 evidence check가 모두 true인지 확인한다. flag가 누락되거나 false면 `UTILITY_COMMAND_UNVERIFIED`로 실패한다. report에는 정확한 command, marker, approval/tool/checkpoint ID와 cleanupConfirmed를 남긴다.

## 실제 실행 결과

1. `npm run test:electron` — **PASS / exit 0 / ok=true**. 요청에 따라 이 명령의 공통 build와 실제 Electron 실행까지 완료했다. **Electron 44.5.1 / Chromium 152.0.7977.130 / Node 24.21.0 / darwin arm64**의 utility에서 approved command가 실행됐고 report의 19개 check가 전부 true였다. 출력 marker, `tool.completed.cleanupConfirmed=true`, 완전한 command checkpoint, journal replay **15개**, SQLite·text·snapshot·close·재개방 후 command 증거 보존까지 통과했다. `windowsCreated=0`, `windowCount=0`, `utilityExitCode=0`, `fixtureRemoved=true`.
2. `node --test apps/engine-harness/dist/protocol.test.js apps/engine-harness/dist/config.test.js apps/engine-harness/dist/cli.integration.test.js apps/engine-harness/dist/responses.integration.test.js apps/engine-harness/dist/electron-smoke.test.js` — **100/100 PASS**, fail/skipped/cancelled 0. transport 15개, config 단위 26개, 기존 CLI integration 6개, Responses CLI integration 7개, Electron fixture·회귀 사례 46개다.
3. 동일한 5개 source 테스트를 `node_modules/.bin/tsx --test`로 실행 — **100/100 PASS**. source에서도 기존 승인 후 실제 patch·review diff 검증까지 통과했다.
4. Responses CLI integration **7/7 PASS**, 단독 strict NodeNext typecheck **PASS**. file-only 선택, user/workspace metadata와 partial limits 병합, explicit CLI provider/model/base override, final request provider/model/mode/limits, scripted에서 lazy Responses 활성화, exclusive env missing·unknown provider·key args 거절을 확인했다. native `/v1/responses` POST input/tools/store:false/stream:true와 Bearer를 fixture에서 검사하고 SSE의 text 완료를 snapshot/replay로 검증했다. fixture가 key를 분할 delta로 반사해도 stdout/stderr·live SQLite/WAL·close 이후 SQLite/WAL에 key 원문이 없었다.
5. config helper **26/26 PASS**. 입력 readonly/frozen 값을 수정하지 않고 계층을 해석한다. named env 선택 시 fallback getter를 읽지 않고 invalid 환경변수 이름도 읽기 전에 거절한다. legacy 3arg/default overload가 명시 invalid null/array/unknown 값을 보존하는 것도 확인했다.
6. Electron fixture **46/46 PASS**. 변조된 command/cwd/timeout/scope/fingerprint/pending 상태에는 allow를 호출하지 않는다. 출력 marker·cleanup event·완전한 checkpoint가 없으면 실패하며 재개방 후 approved/tool/checkpoint/cleanup event 손실도 검출한다. parent report의 누락/false command check도 검출한다.
7. `node_modules/.bin/tsc -p apps/engine-harness/tsconfig.json --noEmit --pretty false`, 공통 build, Electron tests standalone strict NodeNext typecheck — **PASS**.
8. `node --check scripts/electron-smoke.cjs` 및 `node --check scripts/electron-engine-child.cjs` — **PASS**.
9. 최신 `node_modules/.bin/tsx apps/engine-harness/src/index.ts --help` — **PASS**, 신규 config/Responses/capabilities 사용법을 engine startup 없이 출력한다. 초기 compiled entry 부재는 ERR_MODULE_NOT_FOUND/engine.import/exit 1로 드러났으며 compiled 모듈 생성 후 해결됐다.

## 해결된 초기 연결 오류와 검증 범위

초기 runner는 prepare 결과를 `structuredClone`하여 patch 도구의 WeakMap identity를 끊었고, 승인 후 `INVALID_PREPARED_PATCH`로 실패했다. 통합 담당자는 원본 PreparedTool identity를 보존하고 승인 대기 중 binding 변경을 검증하도록 수정했다. 실제 CLI subprocess에서 승인 전 파일 부재, 승인 후 completed tool·파일 생성·정확한 Run별 diff를 재검증하여 통과했다. 이전 **30/31 PASS**는 과거 실행 기록이며 현재 미해결 실패가 아니다. 승인 없는 실행이나 재준비로 테스트를 우회하지 않았다.

재실행 명령은 다음과 같다. package.json 수정이나 신규 dependency는 필요하지 않았다.

```text
npm run test:electron
node --test apps/engine-harness/dist/protocol.test.js apps/engine-harness/dist/config.test.js apps/engine-harness/dist/cli.integration.test.js apps/engine-harness/dist/responses.integration.test.js apps/engine-harness/dist/electron-smoke.test.js
```

CLI integration 6개는 scripted 실행의 durable 결과·EOF/restart/duplicate receipt/afterSeq, 열린 local SSE 중 run.cancel, 진행 중 EOF와 SIGTERM cleanup, SIGKILL 후 interrupted recovery와 provider 재호출 방지, build run의 approval.decide → 실제 patch 적용 → run별 review diff를 확인한다. 모두 통과했다.

Responses transport의 local fixture 성공은 실제 supplier 계정·model capability·인증·요금 검증을 뜻하지 않는다. 실제 공급자 인증/비용 호출, packaged Electron app, OS credential 저장 adapter, GUI IPC/preload는 이번 담당 범위가 아니다. Electron command 검증은 이 darwin arm64 설치본의 POSIX supervisor·프로세스 정리 경로에 대한 결과다. 다른 OS/Electron 버전에 SQLite나 command 지원이 있다고 가정하지 않는다. config는 명시한 파일에만 적용되며 각 workspace를 열 때 자동 설정 탐색/credential 이동을 하지 않는다. 추가 고정 schema/API 변경 제안은 없다.
