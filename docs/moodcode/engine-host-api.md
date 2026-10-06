# Moodcode 엔진 host API

2026-10-07 기준. GUI를 열지 않는 TypeScript/Node 엔진 연결 명세다. `@moodcode/engine`은 Electron·React 없이 실행한다. Node 24 이상과 Git을 요구하며 최신 실제 gate는 macOS arm64 / Node 26.9.0이다. Linux/Windows·다른 ABI 지원은 [CI 범위](engine-ci.md)와 [TODO](../../TODO.md)를 확인한다.

## 구성과 공개 연결

`createEngine(options)`는 DB owner, Run coordinator, scheduler, context, 도구 runtime, 승인·질문·세션 tasks, MCP/plugin, PTY, child, LSP, formatter, workspace 관찰을 소유한다. 기본 fixture 공급자는 scripted/local이며 실제 provider는 host가 주입하고 defaults에서 선택한다. `CodexProvider`는 기존 로컬 Codex 인증 port를 사용하고, `AnthropicProvider`는 host가 지정한 API key와 model을 사용한다. API key나 credential을 command/config/session document에 넣지 않는다.

주요 `EngineOptions`는 `dbPath`, `artifactDir`, `providers`, `tools`, `defaults`, `toolPolicy`, `modelSpecs`, `agentProfiles`, `allowedToolNames`, `worktreeDirectory`, `configureChild`, `mediaHistoryPolicy`다. `allowedToolNames`는 초기 catalog뿐 아니라 이후 등록한 handler의 광고·실행에도 유지되는 host 상한이다. profile·Plan 정책·resource deny가 이 상한을 더 좁힐 수 있다. 기본 도구를 `tools`로 교체하면 실제 제공한 handler만 사용할 수 있다.

| 경로 | 용도 |
|---|---|
| `dispatch(command)` | 기존 schemaVersion 1 command, workspace/session·즉시 Run·승인·review |
| `dispatchSession(command)` | schemaVersion 2 inbox·session control·native records·tasks/questions/context/diagnostics |
| `subscribe(sessionId, afterSeq, signal?)` | v1 Run event journal |
| `subscribeSession(sessionId, afterSeq, signal?)` | 별도 v2 session event journal |
| `waitForRun(runId)` | 지정한 실제 Run의 terminal 정산 대기 |
| `getCapabilities()` | 연결된 provider/tool/command 및 기본값; 실행에 적용한 host 상한 반영 |
| `importImage(sessionId, bytes, mimeType, signal?)` | 세션 소유의 제한된 이미지 blob을 저장하고 immutable 참조 반환 |
| `getStorageUsage({signal?, limits?})` | 주 DB 이미지 index와 engine-owned artifact/DB 경로의 bounded 읽기 전용 진단; 모델 턴에서 자동 실행하지 않음 |
| `close()` | admission 중지와 owned Run·child·MCP/plugin·PTY·watcher·LSP·DB 종료 정산 |

v2 command envelope에는 `schemaVersion`, `commandId`, `type`, `payload`만 둔다. `stream:'session-v2'`는 event/cursor에 있는 구분자이며 command 필드가 아니다. 두 journal의 seq는 교환하지 않는다. 추가 command는 [v2 명세](engine-contracts-v2.md)를 따른다.

```json
{"schemaVersion":2,"commandId":"queue-1","type":"input.accept","payload":{"sessionId":"SESSION_ID","requestId":"REQUEST_ID","prompt":"검사 결과를 확인해줘","delivery":"queue"}}
```

위 명령의 receipt는 입력 접수 결과다. scheduler가 실제 Run에 promotion하기 전에는 pending 입력을 user transcript나 가짜 Run으로 표시하지 않는다. queue는 FIFO, steer는 다음 안전 turn 경계에만 반영된다. Run cancel은 session을 pause하며 저장된 queue를 자동 실행하지 않는다. 새 작업을 이어가려면 명시적 resume을 사용한다. legacy `run.submit`은 즉시 접수·workspace busy·exact retry 의미를 보존한다.

`mediaHistoryPolicy`는 host가 생성 시 선택·검증하는 opt-in이다. `{kind:'reference-only-older-images',version:1}`은 오래된 픽셀 전송을 줄이되 최신 픽셀·원문 user anchors·완전한 최근 tool exchange·별도 provenance notice를 필수로 유지한다. 원본 records/replay를 수정하거나 active-prefix 의미 요약을 생성하지 않는다. default 동작과 상한·실패 계약은 [이미지 경계](engine-input-media.md), storage 관측 시점·비삭제·전체 JSON cap과 close 대기는 [디스크 진단](engine-storage-usage.md)을 따른다.

`activePrefixPolicy: {kind:'active-prefix-semantic',version:1}`은 별도의 host opt-in이다. 진행 중인 Run의 exact text/tool observations만 complete exchange 단위로 tools 없는 요약 요청에 전달한다. 실제 ContextPlan이 들어간 뒤 source/frontier/CAS를 다시 확인해 `context.active_memory`와 provider context를 원자 활성화한다. 원문 goal/latest steer·image user·최근 묶음은 필수로 남으며 pixels·opaque replay는 요약 사실로 변환하지 않는다. 공유 Run 예산, 실패·overflow·조회 상한과 diagnostics는 [active-prefix 명세](engine-active-prefix.md)를 따른다. 최신 active Run의 중간 image user는 이후 text steer가 와도 bounded DB window에서 별도 anchor로 유지한다.

SQLite 연결에서는 유지보수 입장·중복 요청·승인 생성/취소·자식 pending 승인과 terminal assistant 결과를 owner 범위 SQL로 읽는다. `hasRunRequest`는 실제 primary Run 요청만 인정하며 queue pending과 promoted steer는 제외한다. `listPendingRunApprovals`는 모든 pending을 최대 64개/512KiB 안에서 반환하고 초과하면 부분 목록 대신 `APPROVAL_READ_LIMIT`다. `getLastRunAssistantContent`는 exact Run의 최신 assistant content만 output byte budget 안에서 반환하고 replay/tool JSON을 불러오지 않는다. 해당 optional port가 없는 custom legacy store의 coordinator/ApprovalManager는 기존 snapshot 경로를 유지한다.

Instruction source cache는 최대 128개이며 idle entry를 교체한다. 진행 중인 observe는 lease로 보호하고 모든 실패·취소 후 lease를 반환한다. 캐시에서 빠진 baseline은 session document의 workspace/scope/hash 검증을 거쳐 다시 읽는다. 오래된 세션 수가 128개를 넘었다는 이유만으로 이후 실행을 막지 않는다.

## child 작업과 Git workspace

`createWorktree(sessionId, requestId, reference?)`는 root workspace maintenance lease를 사용해 관리용 detached worktree를 준비한다. nested 기반이 필요하면 `prepareChildWorktree(sessionId, parentWorktreeId, requestId, reference?)`를 부모 Run 및 worktree owner가 생기기 전에 호출한다. 살아 있는 root Run과 동시에 이 API로 Git 준비를 시작할 수 없다. dirty 파일·무시된 파일·Git HEAD 이동·unknown owner를 덮어써서 정리하지 않는다.

살아 있는 부모 Run에서 host가 다음 구조로 `startChildTask`를 호출한다. 도구 목록은 실제 부모 catalog/profile/host 상한의 부분집합이며, 할당량은 부모의 실제 남은 전체 예산과 deadline 이하다.

```ts
const task = await engine.startChildTask({
  sessionId,
  requestId: 'review-child-1',
  parentRunId,
  worktreeId: preparedWorktree.id,
  prompt: '이 격리된 저장소에서 현재 파일을 읽고 결과를 설명해줘.',
  tools: ['read_file'],
  allocation: { turns: 2, toolCalls: 1, outputBytes: 4096, durationMs: 10_000 },
});
const terminal = await engine.children.tasks.wait(sessionId, task.id);
await engine.children.tasks.deliver(sessionId, terminal.id);
```

반환한 task는 starting/running일 수 있다. 각 child는 독립 MoodcodeEngine·DB·artifact 저장소에서 실제 Run 하나를 실행한다. 부모 profile·mode·현재 deny policy·context/producer/attempt 상한을 상속하며 grant는 별도로 소유한다. root→child 예약은 root에서, child→grandchild 예약은 즉시 부모인 child에서 차감하여 root에 두 번 청구하지 않는다. 실패한 사전 검증은 부모 예산을 차감하지 않으며 dispatch 뒤 예약은 자동 환급하지 않는다. 현재 depth 3·engine admission 32개 상한과 양수 tool/output allocation을 요구한다.

nested 요청은 `parentTaskId`와 실제 childRunId인 `parentRunId`를 함께 사용한다. host는 running task record에 childRunId가 기록된 뒤 이를 읽는다. 종료한 child를 live parent로 재사용할 수 없다. parent waitForRun만으로 child cleanup이 완료됐다고 판단하지 않고 task wait 또는 전체 engine.close를 기다린다. 재시작 이후 task 상태를 읽기 전에 `children.recover(sessionId)`를 호출한다. 기존 task dispatch나 효과를 자동 재개하지 않는다.

`children.approvals(sessionId, childTaskId)`는 실제 child의 pending 승인만 반환하고 `children.decide(sessionId, childTaskId, approvalId, fingerprint, 'allow'|'deny')`는 그 실행의 정확한 승인을 처리한다. delivery는 `child-result:<taskId>`의 durable root inbox 중복 제거를 사용한다. nested parent가 닫힌 뒤에도 root session에 관측 결과를 전달할 수 있다. 모델 출력은 관측 JSON이며 새 권한이나 현재 파일의 증거로 해석하지 않는다.

`merge_child_changes`는 완료한 실제 immediate child의 변경을 부모 workspace에 제안한다. 미리보기·fingerprint·현재 preimage 검증을 거쳐 승인 후 적용하며 checkpoint/review를 남긴다. grandchild→child와 child→root는 각각 승인한다. UTF-8 일반 파일 32개·총 preimage/content 1 MiB 범위를 지원하고 Git commit을 만들지 않는다. `cleanupWorktree`는 owner가 해제된 깨끗한 관리 worktree만 정리한다. [세부 계약](../../packages/engine/src/child-tasks/README.md)을 따른다.

`delegate_task`는 Build의 모델 도구다. 실제 부모 Run의 matching approval 이후 pinned Git commit의 worktree를 만들고 별도 읽기 전용 child를 실행한다. 부모의 잔여 turn/tool/output/time 안에서 예산을 예약한다. configured allow나 scoped grant가 이 요청별 승인을 생략하지 못한다. 입력은 requestId/prompt/allocation/tools이며 provider/model/권한 override를 받지 않는다. 커밋되지 않은 작업 파일은 복사하지 않는다. exact retry는 기존 child 관측을 반환하고 결과를 자동 inbox에 넣거나 변경을 병합하지 않는다.

archive import는 관리 worktree 경로를 복원 tree의 역사 기록으로 옮기며 기존 inode/device/owner를 새 파일 소유권으로 재인증하지 않는다. 복원 worktree는 uncertain이고 verify/start/merge/cleanup이 거부된다. 완료 child의 exact retry 조회와 새 worktree를 사용하는 fresh 작업은 가능하다. custom artifact tree 밖 worktree는 현재 import rebinding 범위에 없다. `configureChild`는 동기 setup 계약이며 Promise/thenable 반환은 child provider 접수 전에 거부한다.

## 이미지 입력과 긴 실행

host는 `importImage`에서 받은 refs를 v1 `run.submit` 또는 v2 `input.accept`의 `attachments`에 전달한다. command에는 URL·파일 경로·base64를 넣지 않는다. 실제 bytes는 `artifactDir/input-media`에 보관하고, inbox/message/context revision에는 refs만 저장한다. dispatch 직전에 session/run 소유권·hash·bytes를 다시 검사한 뒤 Responses/Codex/Anthropic/ChatCompletions payload로 변환한다. exact retry 조회는 기존 receipt를 우선하며 새로운 요청은 media를 검증한다. [미디어 한도와 encoding](engine-input-media.md)을 따른다.

DB3의 `attempt_usage`는 attempt당 최신 관측 snapshot을 보존한다. session diagnostics의 `attemptUsage`와 기존 v1 `providerUsage` event sum은 별도 지표다. active Run은 초기 목표·최근 user/steer·최근 완전한 exchange를 필수로 유지하고 나머지 group을 모델 byte 한도 안에서 선택한다. DB omission과 provider projection omission을 각각 표시한다. 이미지가 있는 snapshot block은 text-only 요약으로 대체하지 않으며 보존할 수 없으면 명시적 오류를 반환한다. 이미지 token 비용과 DB 밖 이미지 이력은 미확인 범위다.

## LSP·formatter·변경 관찰

`registerLanguageServer(serverId, factory, languageForPath)`는 host가 선택한 factory와 경로→language selector를 등록한다. `StdioLspConnection`의 executable/args는 신뢰하는 host가 지정한다. 모델이 경로에서 LSP 서버를 자동 설치하거나 실행하지 않는다. `formatters.register(id, formatter)`는 현재 content를 받아 제한된 UTF-8 결과를 반환하는 host callback을 등록하고 해제 함수를 제공한다.

`format_file`과 `lsp_format_file`은 format 결과를 제안한 뒤 정상 patch 승인·hash·checkpoint 경로로 적용한다. 등록한 서비스가 없으면 unavailable을 반환하고 효과를 성공으로 표시하지 않는다. host callback은 formatter port 계약에 따라 텍스트 제안을 생성해야 하며 이 port 자체가 외부 프로세스의 sandbox를 제공하지 않는다.

`watchWorkspace(workspaceId)` 또는 최초 tool checkpoint가 [WorkspaceChangeHub](engine-workspace-changes.md)를 시작한다. 실제 변경 hash·documentVersion과 callback 완료를 다음 모델 turn 경계에 연결한다. 도구 선행/외부 관찰 선행·늦은 poll·review.restore가 같은 변경을 이중 알림하지 않는다. 관찰 실패는 원래 파일 효과 결과를 바꾸지 않고 diagnostics에 제한된 원인을 표시한다. Hub 상태는 프로세스의 bounded baseline이며 durable 원본 증거는 immutable checkpoint다.

child는 root의 살아 있는 LSP/MCP 연결을 묵시적으로 빌리지 않는다. 필요한 host adapter는 `configureChild(engine, task)`에서 명시적으로 등록한다. 이 callback은 동기식이며 child admission 전에 실행한다. 기본 child tool 상한을 넓히지 않는다.

## 외부 자원·관측·백업

`activatePlugin/deactivatePlugin`, `connectMcp/disconnectMcp`는 scope 등록·해제와 owned 연결 수명을 다룬다. stdio 및 지원 HTTP transport를 제공하고 unknown remote 효과는 runtime 승인 경로를 거친다. credential은 [host reference port](../../packages/engine/src/credentials/index.ts)를 사용한다. `terminals`는 user authority의 PTY API이며 모델 `run_command`의 승인과 구별한다. 실제 shell은 사용자 OS 권한이고 파일·네트워크 격리 sandbox를 제공한다고 광고하지 않는다.

`session.getDiagnostics`는 session owner의 SQL metrics·context 상태·workspace 관찰을 반환한다. [metric 의미](engine-native-metrics.md)에 따라 전체 primary count와 최근 matching 이벤트 창·unknown/null을 구별한다. 토큰 합계는 관측 값이며 청구 API의 확정 금액이 아니다. `read_artifact`는 현재 session에 속한 과거 Run/internal-tool/선택적 Turn·Attempt identity와 hash를 검증한 page를 반환한다. 원본 tool 결과와 provider replay는 보존한다.

`exportEngineArchive/validateEngineArchive/importEngineArchive`는 primary/review/recovery ledger/artifact manifest를 보존한다. import는 살아 있는 engine의 DB를 교체하지 않으며, 복원 뒤 중단한 효과를 자동 실행하지 않는다. [archive](engine-archive.md)·[저장 성능](engine-storage-performance.md)·[process/PTY](engine-process-terminals.md)의 지원 한계를 따른다.

## 검증과 남은 조건

기본 도구 21종 및 host가 실제 등록한 도구를 제공한다. child 실행/merge, LSP formatting/restore, MCP 승인, 큰 결과의 artifact 재조회는 실제 headless 엔진과 임시 Git/process fixture로 연결을 확인했다. 현재 Codex `gpt-6.1-sol` 계정의 read→approved patch→approved command도 별도로 통과했다. 실제 Anthropic 계정·추가 media 형식·Windows native backend·전체 GUI 노출·공개 배포는 별도 검증 대상이다. [지속 개선 목표](engine-improvement-goal.md)와 [열린 TODO](../../TODO.md)가 정확한 범위다.
