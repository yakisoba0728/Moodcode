# 엔진 병렬 구현 작업 계약

2026-10-04. 사용자가 넓은 범위를 작은 작업으로 나눠 이전처럼 별도 세션에서 병렬 구현하도록 요청했다. 이번 범위는 GUI 없는 E0~E4 엔진과 창 없는 Electron runtime 검증이다. 각 세션은 GPT 6.1 Sol / Ultra를 사용한다. 실제 공급자 계정 호출과 공개 배포는 이번 검증에 포함하지 않는다.

## 공유 계약과 작업 방식

공통 타입은 `packages/contracts/src/index.ts`, engine 모듈 간 인터페이스는 `packages/engine/src/ports.ts`에 고정했다. 이 두 파일과 package.json·tsconfig·lockfile·root scripts/test.mjs·엔진 facade/index는 통합 세션이 소유한다. 담당 세션은 아래 경로만 수정하고, 계약 변경 제안은 자기 보고서에 적는다. 필요한 최소 조정은 통합 담당자가 반영한다.

같은 local checkout에서 작업하므로 git checkout/reset/clean/stash/commit, branch 생성·전체 stage를 수행하지 않는다. 의존성 설치와 공통 빌드 설정 변경도 통합 세션에 맡긴다. OpenCode clone은 읽기 참고만 사용한다. 담당 모듈은 stub이나 계획이 아닌 실제 구현과 의미 있는 테스트로 완성한다. 다른 모듈이 아직 없으면 정해진 port의 fake를 사용해 테스트하고, 자신의 구현을 그 port에 연결한다.

외부 실행/입력은 한도·AbortSignal·오류를 처리한다. 모델 adapter는 한 turn을 반환하며 agent loop는 runner가 소유한다. 승인 전 파일 쓰기·명령 실행을 하지 않는다. filesystem/process 효과가 DB와 원자적이라고 가정하지 않는다. 같은 workspace는 활성 Run 하나이고 중복 request ID 검사는 busy 검사보다 앞선다. recovery는 기록된 실행을 interrupted로 마감하며 효과를 자동 재실행하지 않는다.

각 담당자는 `docs/moodcode/implementation-reports/NN-name.md`에 구현 파일, export API, 실제 실행한 검증과 결과, 검증 못 한 범위·제약을 적는다. 다른 사용자 채팅에 메시지를 보내거나 새 채팅을 만들지 않는다. 최종 결과는 본인 세션과 보고서에 남긴다. 통합 세션이 파일과 상태를 읽어 확인한다.

## 담당 범위

| 번호 | 세션 | 수정 경로 | 고정할 export |
|---|---|---|---|
| 01 | 계약 검증·context | contracts/src/validation.ts 및 validation.test.ts; engine/src/context/** | validateCommand, normalizeSubmitInput; buildContext |
| 02 | SQLite·journal·복구 | engine/src/storage/** | SqliteStore implements EngineStore, constructor(dbPath: string) |
| 03 | Run coordinator·agent loop | engine/src/runner/** | RunCoordinator implements CoordinatorPort, constructor(CoordinatorOptions) |
| 04 | 모델 adapters | engine/src/provider/** | ScriptedProvider; OpenAICompatibleProvider |
| 05 | workspace·경로·Git | engine/src/workspace/** | openWorkspace(path), resolveWorkspacePath(workspace, relative, allowMissing?), getGitStatus(workspace), captureWorkspace(workspace, options?) |
| 06 | 읽기·검색 도구 | engine/src/tools/read/** | createReadTools(): ToolDefinition[] |
| 07 | patch·checkpoint·diff | engine/src/tools/patch/**; engine/src/review/** | createPatchTool(): ToolDefinition; getReviewDiff(store, runId); restoreCheckpoint(store, workspace, checkpointId) |
| 08 | 승인·정책 | engine/src/permission/** | ApprovalManager implements ApprovalPort, constructor(store: EngineStore) |
| 09 | 명령 실행·출력·중지 | engine/src/tools/command/** | createCommandTool(): ToolDefinition |
| 10 | harness·Electron smoke | apps/engine-harness/src/**; scripts/electron-smoke.cjs; scripts/electron-engine-child.cjs | JSONL commands/results/events; windowless utility runtime smoke |

통합 담당: root scaffold·ports·engine facade·public exports·package 설정·통합 테스트·문서 및 전체 검증. 세션 결과를 순차 통합하지만 각 모듈 구현은 병렬로 진행한다.

## 모듈 연결 기준

- 모든 engine module은 contracts와 `../ports.js` 등의 상대 import를 사용한다. 같은 모듈 내 index.ts를 export entry로 둔다. 다른 담당 디렉터리에 index.ts가 아직 없어도 새 API를 임의 생성하지 않는다.
- Tool prepare는 입력 검증과 preview/fingerprint 생성만 수행한다. execute는 승인된 PreparedTool을 받고 대상·hash/cwd를 다시 확인한다. 같은 준비된 요청의 execute를 자동 재시도하지 않는다.
- patch 도구 입력은 `{changes: [{path, expectedHash: string|null, content: string|null}]}`이다. content=null은 삭제, expectedHash=null은 파일 부재를 뜻한다. read_file 결과는 sha256을 제공한다. 변경 수·전체 byte를 제한한다.
- run_command 입력은 `{command: string, cwd?: string, timeoutMs?: number}`다. workspace 경로 정책과 제한된 출력을 적용한다. arbitrary 명령 전체의 rollback을 약속하지 않는다.
- 통합 과정에서 `ToolContext.executionLockPath`와 `CoordinatorOptions.executionLockPath`를 추가했다. facade는 영속 SQLite 실행 marker를 확인하고 경로를 전달한다. patch와 command supervisor가 같은 잠금을 사용하며, 불확실한 효과는 재시작을 차단한다. supervisor는 READY/START와 IPC disconnect 정리를 사용한다.
- `ContextRequest.reservedBytes`는 provider에 함께 보내는 tool schema와 JSON framing의 byte를 예약한다. context builder는 원래 config를 변경하지 않고 나머지 용량에서 메시지와 프로젝트 지침을 구성한다.
- list_files 입력은 `{path?: string, limit?: number}`, read_file은 `{path: string, startLine?: number, endLine?: number}`, search_files는 `{query: string, path?: string, limit?: number}`다. 첫 검색은 literal substring으로 고정한다.
- scripted provider의 `id`는 `scripted`, 기본 응답은 마지막 사용자 prompt를 확인한 짧은 텍스트다. constructor는 선택적인 `ScriptedTurn[]`를 받으며 turn은 `{events: ProviderEvent[], delayMs?: number, error?: string}`다. request.turnIndex로 시나리오를 선택한다.
- OpenAI-compatible adapter는 configurable baseURL/API key, Chat Completions SSE 한 turn을 처리한다. model ID는 호출자가 제공한다. 기본 API model을 추정하지 않는다. 외부 key 호출 대신 local HTTP fixture로 transport를 검증한다.
- workspace capture export는 `Promise<{files: Map<string, {content:string; hash:string}>, warnings:string[]}>`를 반환한다. 기본 최대 파일 수·전체 byte와 binary 제외를 적용한다. .git/node_modules는 제외한다.
- restoreCheckpoint는 직접 engine command에 노출하지 않는다. service/test 단계에서 hash 검증과 충돌 처리를 검증하고 이후 사용자 확인 흐름을 붙인다.
- harness는 `createEngine({dbPath, artifactDir?, providers?})`를 import한다. engine은 dispatch(envelope), subscribe(sessionId, afterSeq, signal), waitForRun(runId), close()를 제공한다. submit config 미지정 시 scripted/local, mode=plan과 DEFAULT_LIMITS로 normalize한다.
- harness command는 workspace.open, session.create/list/getSnapshot, run.submit/cancel, approval.decide, review.getDiff, events.subscribe이다. stdin EOF 시 진행 중 Run을 정리하고 종료한다. signal 종료와 subprocess restart 테스트를 포함한다.

## 통합 완료 목표

단위·모듈 테스트와 함께 작은 임시 Git 저장소에서 scripted tool-call → 읽기 → patch 승인 → 변경 → 명령 승인 → 검증 → 최종 응답을 연결한다. 별도로 요청 재전송·busy·승인 거절·취소·replay·process crash/restart를 검증한다. 실제 공급자 성공과 최종 배포 앱 검증은 별도 상태로 남긴다.

## 추가 병렬 작업

첫 엔진을 통합하는 동안 다른 구현·검증·수정도 진행하라는 사용자 요청에 따라 같은 10개 세션을 재활용한다.

| 세션 | 추가 범위 |
|---|---|
| 01 | layered 설정 파일, 검증, credential 환경변수 이름 참조 |
| 02 | SQLite 무결성 검사와 일관된 백업 |
| 03 | 실제 모듈을 연결한 Run lifecycle·동시성·취소 경합 검증 |
| 04 | native Responses HTTP/SSE 모델 adapter |
| 05 | 제한된 workspace 변경 관찰 service |
| 06 | runtime·SQLite·Git·workspace 진단과 doctor CLI |
| 07 | 복원 preview, 실행 잠금, 활성 실행·외부 편집·취소 검증 |
| 08 | 실제 SQLite와 프로세스 손실을 포함한 approval 경합 검증 |
| 09 | 실행 marker 읽기 전용 진단 |
| 10 | 설정·Responses를 JSONL harness에 연결 |

통합 세션은 설정 기본값과 `engine.getCapabilities` 조회, 공개 export, 문서와 최종 통합 검증을 담당한다. 추가 모듈의 개별 테스트 성공을 전체 제품 검증으로 취급하지 않는다.
