# Moodcode 엔진 host API

2026-10-08 기준. GUI를 열지 않는 TypeScript/Node 엔진 연결 명세다. `@moodcode/engine`은 Electron·React 없이 실행한다. Node 24 이상과 Git을 요구하며 최신 실제 gate는 macOS arm64 / Node 26.9.0이다. Linux/Windows·다른 ABI 지원은 [CI 범위](engine-ci.md)와 [TODO](../../TODO.md)를 확인한다.

## 구성과 공개 연결

`createEngine(options)`는 DB owner, Run coordinator, scheduler, context, 도구 runtime, 승인·질문·세션 tasks, MCP/plugin, PTY, child, LSP, formatter, workspace 관찰을 소유한다. 기본 fixture 공급자는 scripted/local이며 실제 provider는 host가 주입하고 defaults에서 선택한다. `CodexProvider`는 기존 로컬 Codex 인증 port를 사용하고, `AnthropicProvider`는 host가 지정한 API key와 model을 사용한다. API key나 credential을 command/config/session document에 넣지 않는다.

주요 `EngineOptions`는 `dbPath`, `artifactDir`, `providers`, `tools`, `defaults`, `toolPolicy`, `toolDiscoveryPolicy`, `modelSpecs`, `agentProfiles`, `allowedToolNames`, `worktreeDirectory`, `configureChild`, `mediaHistoryPolicy`, `documentHistoryPolicy`, `allowUnknownDocumentTokenCost`다. `allowedToolNames`는 초기 catalog뿐 아니라 이후 등록한 handler의 광고·실행에도 유지되는 host 상한이다. profile·Plan 정책·resource deny가 이 상한을 더 좁힐 수 있다. 기본 도구를 `tools`로 교체하면 실제 제공한 handler만 사용할 수 있다. `toolDiscoveryPolicy: DEFAULT_TOOL_DISCOVERY_POLICY`는 필요한 도구를 일반 discover_tools로 찾아 다음 모델 경계에서 선택한 schema만 광고하는 host opt-in이다. `action: 'replace'`로 selected noncore 집합을 명시적으로 교체하고 no-match로 비울 수 있다. 생략하면 기존 add를 유지한다. 현재 profile/policy/allowlist·승인·child 상한을 유지하며 [query/action/count/bytes·retry·정확한 예약 계약](engine-tool-discovery.md)을 따른다. 기본 eager/getCapabilities 동작은 유지한다.

G1-29의 기본 eager도 같은 capture의 예약·ContextPlan·실제 request·handler를 사용한다. Async registry/policy·normal turn·steer 변경은 bounded replan이며 동일 Turn overflow는 고정 capture를 유지한다. `context.prepared`의 예약·실제 tools SHA·이름 감사는 eager/discovery 양쪽에 기록하고, 각 Attempt에 detached 요청을 전달한다. DB9/metrics6과 기존 metrics context shape는 유지한다. Empty catalogue/current API와 static Coordinator 호환은 [기본 도구 문맥 계약](engine-eager-catalogue-context.md)을 따른다.

| 경로 | 용도 |
|---|---|
| `dispatch(command)` | 기존 schemaVersion 1 command, workspace/session·즉시 Run·승인·review |
| `dispatchSession(command)` | schemaVersion 2 inbox·session control·native records·tasks/questions/context/diagnostics |
| `subscribe(sessionId, afterSeq, signal?)` | v1 Run event journal |
| `subscribeSession(sessionId, afterSeq, signal?)` | 별도 v2 session event journal |
| `waitForRun(runId)` | 지정한 실제 Run의 terminal 정산 대기 |
| `getCapabilities()` | 연결된 provider/tool/command 및 기본값; 실행에 적용한 host 상한 반영 |
| `importImage(sessionId, bytes, mimeType, signal?)` | 세션 소유의 제한된 이미지 blob을 저장하고 immutable 참조 반환 |
| `importDocument(sessionId, bytes, signal?)` | 세션 소유 bounded PDF blob을 저장하고 이미지와 별도 immutable 문서 참조 반환 |
| `getStorageUsage({signal?, limits?})` | 주 DB 이미지·문서 index와 engine-owned artifact/DB 경로의 bounded 읽기 전용 진단; 모델 턴에서 자동 실행하지 않음 |
| `getExecutionObservations({workspaceId, runId, afterOrdinal?, throughOrdinal?, limit?, maxBytes?})` | 실제 원본 실행 경계의 source·effect epoch·outcome을 최대 100행·1MiB로 조회 |
| `getCodingEvidence(runId, options?)` | 같은 primary read snapshot의 Run·journal·native 실행 증거, 최대 64KiB; 선택 요약은 추가 모델 호출 없는 metadata 추출 |
| `getStallObservation(trajectoryOptions, limits?)` | 원래 실행 당시의 source·result·effect epoch를 사용하는 advisory 조회; 자동 재시도·취소·작업 성공 권한 없음 |
| `inspectToolRegistration(toolName, scopeId?)` | 현재 정확한 등록의 revision·schema/description hash만 조회; producer callback 호출 없음 |
| `getChildDocumentStorageUsage({sessionId, sourceRunId, taskIds, signal?, limits?})` | 정확한 root owner·storage binding·확인된 close에 연결된 selected child document index 관측; 별도 공유 예산·partial/null·비삭제 계약 |
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

## 검증 제어와 저장소 지식

`lifecycleHooks` 또는 `lifecycleHookRegistry`는 host가 명시적으로 등록한 callback 정책이다. `tool-prepare`의 hash-bound 입력 변환은 sole prepare 전에 적용하고 최종 입력의 exact approval을 유지한다. `model-context`의 bounded JSON DATA는 `lifecycleContextSlotBytes`(기본8192, 128~16384)를 필수 문맥과 공유 예약한 뒤 최종 ContextRevision에 포함한다. `lifecycleContinuation: true`는 실제 native verification pass receipt에 결속한 same-Run 추가 Turn 최대1회만 허용한다. retry/current source/profile/ledger 검증과 오류 정책은 [lifecycle 연결 명세](engine-phase-two-lifecycle-transforms.md)를 따른다.

`verificationTools: true`는 host가 등록한 `verify_changes`를 노출한다. 기본 core 도구를 사용하는 설정에서만 지원하며, custom `tools`와 함께 지정하면 초기화 전에 거절한다. `registerVerificationCheck(check)`로 실제 command/cwd/profile/source revision을 등록하고 `configureVerificationSession(sessionId, expectedRevision, policy)`로 idle workspace lease 아래 검사 목록·예산·최대2단계 repair를 고정한다. `getVerificationConfiguration`과 `getVerificationState`는 저장된 설정과 정확한 Run의 계획/receipt를 조회한다.

`getVerificationCompletion(sessionId, runId)`는 별도 controller snapshot을 반환한다. `completion.decision.taskVerified`는 당시 native stop boundary에서 current source·required pass·확정 cleanup을 검사한 결과다. `Run.completed`는 loop 종료 상태다. controller는 부족/실패/stale 검사를 같은 Run의 남은 예산 안에서 한 번씩 소비하고, denied/cancelled/unsupported/unknown 결과는 차단한다. 조회·restart·import는 명령을 자동 실행하지 않는다. [검증 제어](engine-verification-controller.md)와 [통합 범위](engine-phase-two-w3.md)를 따른다.

저장소 지식 API는 host 전용이다. DB10의 pending plan·trust 위에 실제 tools-free generation과 승인된 문서·파일 게시 경로를 연결한다.

| API | 현재 동작 |
|---|---|
| `previewWorkspaceTrust(workspaceId, paths)` | 실제 root/storage와 선택한 지침 파일 hash에 결속한 원본 승인 preview |
| `setWorkspaceTrust(input)` | 원본 preview·revision CAS·dedupe·철회·expiry를 idle workspace lease에서 저장 |
| `captureWorkspaceKnowledgeSources(workspaceId, selection)` | 명시적으로 선택한 파일/완료 대화의 bounded text와 원본 opaque projection |
| `releaseWorkspaceKnowledgeSources(projection)` | capture 수명 해제 |
| `captureWorkspaceKnowledgeTarget(workspaceId, path)` | 실제 absent 파일 preimage; `knowledgeFilePublication:true`에서는 기존 파일·철회된 파일의 native revision과 SHA/identity를 함께 캡처 |
| `prepareWorkspaceKnowledgeGeneration(input)` | 원본 projection·현재 trust/source/target을 다시 검사해 pending plan 저장 |

위 계획 저장은 모델 호출이 아니다. `knowledgeGeneration:true`에서 원본 projection의 실제 tools-free 생성·usage·cleanup·immutable candidate를 기록한다. 문서 게시와 문맥은 [generation](engine-phase-two-knowledge-generation.md)·[publication](engine-phase-two-knowledge-publication.md)·[context](engine-phase-two-knowledge-context.md) 계약을, 물리 파일 게시와 recovery는 [파일 게시](engine-phase-two-file-publication.md) 계약을 따른다. 아카이브로 가져온 SQL 문서의 명시적 복구·현재 결속·문맥 활성화는 [import recovery](engine-phase-two-import-recovery.md) 계약을 따른다.

`knowledgeImportRecovery:true`에서 `previewWorkspaceKnowledgeImportAcknowledgment`와 `acknowledgeWorkspaceKnowledgeImport`, `previewWorkspaceKnowledgeImportRecovery`와 `resumeWorkspaceKnowledgeImport`를 별도로 호출한다. 현재 결속에 대한 새 workspace trust를 설정한 뒤 `previewWorkspaceKnowledgeImportActivation({workspaceId,documentKey})`와 `activateWorkspaceKnowledgeImport`로 정확한 SQL 문서 하나를 활성화한다. 해제는 `previewWorkspaceKnowledgeImportDeactivation`과 `deactivateWorkspaceKnowledgeImport`다. 모든 mutation은 `{workspaceId,requestId,approved:true,preview,reason?,signal?}`를 받으며 원래 preview 객체가 필요하다. 사용하지 않는 preview는 `releaseWorkspaceKnowledgeImportPreview`로 해제한다. `getWorkspaceKnowledgeImportFrontier`와 `getWorkspaceKnowledgeImportActivation`은 읽기 전용이다. Resume는 문서 활성화나 기존 session/inbox 재개를 수행하지 않는다. 원래 workspace의 canonical root와 device/inode가 같은 새 DB/artifact 결속만 지원한다.

## 미적용 변경안과 모델 문맥

`proposals: true`에서 `createProposalSet({workspaceId,requestId,proposalId?,expectedRevision?,changes,signal?})`은 실제 source capture를 검증하고 native ProposalSet·revision·전용 BLOB을 같은 SQL 트랜잭션에 저장한다. `changes`는 `{path,expectedHash,content}` full-content 항목이고 최대128파일·파일당1MiB·before/after 합산8MiB다. `expectedRevision`은 현재 head CAS이며 초기값0이다. 동일 요청은 원본 revision과 현재 head를 반환하며 파일을 다시 읽거나 head를 과거로 되돌리지 않는다.

`getProposalSet(workspaceId,proposalId)`, `listProposalSets({workspaceId,cursor?,limit?,maxBytes?})`, `getProposalDiff({workspaceId,proposalId,revisionId?,cursor?,limit?,maxBytes?,signal?})`는 authoring opt-in과 독립적인 읽기 전용 API다. diff는 저장된 원본 before/after와 현재 source freshness를 구분하고 완전한 파일 단위로 생략한다. row64·전체 JSON64KiB paging 한도를 적용한다.

`proposalContextPolicy: {proposalIds,slotBytes,profiles?}`는 최대8개 exact pending proposal을 실제 ContextPlan에 선택한다. `slotBytes`는 필수이며 최대32KiB다. 필수 문맥·output·repository·knowledge 예약 뒤 남은 공유 예산에 한 quoted assistant DATA entry를 넣고 head/revision/source/binding/BLOB lineage를 실제 ContextRevision/Attempt에 고정한다. 같은 Turn retry는 원본 요청을 유지하며 source/head 변화는 추가 dispatch를 거부한다. child는 선택을 상속하지 않는다. import는 head를 paused로 보존한다. diff는 `state: captured-history`와 실제 현재 `proposalStatus`를 함께 반환한다. [저장·문맥 범위](engine-phase-two-proposals.md)를 따른다.

## 변경안 승인·실제 파일 적용

`proposalApply: true`는 `proposals`와 별도의 host opt-in이다. `previewProposalApply({workspaceId,proposalId,revisionId?,expiresAt?,signal?})`는 현재 idle workspace와 원본 source·head·binding·실제 파일/parent identity를 확인하고 original preview를 반환한다. 기본 만료는60초, 최대90초다. `applyProposal({workspaceId,requestId,approved,preview,signal?})`는 같은 원본 객체의 `approved: true`만 실행한다. 복사한 preview, 거부, 취소, stale source/head/root는 새 효과 승인이 되지 않는다. 사용하지 않는 preview는 `releaseProposalApplyPreview`로 해제한다.

실제 적용은 whole proposal32파일·파일당1MiB·before/desired-after 합산4MiB 이하다. 큰 저장 proposal은 미리보기 단계에서 거부하며 자동 분할하지 않는다. 기존 `apply_patch`와 같은 실제 파일 실행기를 사용하되 host apply owner·checkpoint·BLOB·receipt는 별도 native ID로 소유한다. 가짜 Session/Run/tool/Checkpoint를 만들지 않는다. 원본 실행 잠금 의도→잠금 획득→전체 source 재검사→durable dispatch→파일 효과→actual checkpoint→원본 정리·잠금 해제→receipt/head CAS 순서다. 부분 효과와 unknown postimage를 구분하여 보존하고 재적용하지 않는다.

`getProposalApply(workspaceId,ownerId)`와 `getProposalApplyRequest(workspaceId,requestId)`는 mutation opt-in과 독립적인 역사 조회다. 원본 승인 요청의 동일 재전송은 과거 owner/checkpoint/receipt만 반환한다. 재시작 후 저장 JSON은 새 승인 권한이 되지 않는다. `previewProposalApplyRecovery(workspaceId)`의 원본 frontier로 비동기 `acknowledgeProposalApplyRecovery({workspaceId,requestId,preview,reason})`를 수행하고, 새 frontier의 `resumeProposalApplyRecovery`를 별도로 호출한다. 원래 uncertain/cleanup=false를 유지하며 exact known stopped marker만 명시적으로 정리한다. 효과 재실행·큐 자동 재개·foreign marker 삭제는 수행하지 않는다.

적용된 head는 content revision을 만들지 않고 CAS version을 진전시킨다. 이번 경로에서는 terminal head의 같은 ProposalSet에 새 revision을 추가하지 않으며 새 ProposalSet을 명시적으로 만든다. 활성 effects marker가 있는 archive export는 기존 `ARCHIVE_EFFECT_ACTIVE`로 거부한다. 성공 영수증 archive/import는 원래 증거를 유지하고 현재 head를 paused로 둔다. host 효과의 변경 허브 attribution과 캐시 진단 갱신은 별도 보강 대상이다. 네이티브 TypeScript navigation/format/context는 실제 파일·프로젝트 SHA를 다시 확인하지만 cached diagnostics getter는 query/update/watch 전의 관측을 반환할 수 있다. [적용·복구 계약](engine-phase-two-proposal-apply.md)을 따른다.

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

DB4는 기존 DB3 `attempt_usage`에 별도 `summary_attempts`/`summary_usage`를 추가한다. 일반 `attemptUsage`, 요약 `summaryAttemptUsage`, 기존 v1 `providerUsage` event sum과 최근 journal `summary`는 별도 지표다. 사용량 누락은 null이며 과금량은 알 수 없다. active Run은 초기 목표·최근 user/steer·최근 완전한 exchange를 필수로 유지하고 나머지 group을 모델 byte 한도 안에서 선택한다. DB omission과 provider projection omission을 각각 표시한다.

세션의 최신 image user는 이전 Run에 있어도 indexed header→exact message/Run owner를 bounded SQL로 조회해 필수로 보존한다. 완료 이력 memory의 cutoff 위로 원문 user와 refs를 복원하며 이미지가 없어진 새 text Run도 같은 pixels를 전송한다. 필수 이미지·현재 입력·complete exchange가 count/byte cap에 들어가지 않으면 typed failure를 반환한다. `ContextDiagnostics.sessionImageAnchor`는 세션 이미지 owner를, `activeWindow`는 현재 Run의 선택 범위만 표시한다. 최종 전체 snapshot/context의 hard cap을 따로 검사한다. 이미지 token 비용은 미확인 범위다.

host의 `getSummaryAttempt(sessionId, summaryAttemptId)`와 `getSummaryUsage(sessionId, summaryAttemptId)`는 payload를 읽기 전에 지정 session owner를 확인한다. `listSummaryAttempts(sessionId, {afterId?, runId?, limit?})`는 최대 100개·1MiB 반환 JSON을 제한하고 `{attempts, nextCursor}`를 반환한다. usage 행이 없는 요청은 null을 반환한다. 기록은 별도 요약 요청이며 일반 model Attempt 조회 API와 섞지 않는다. unresolved 요약은 재시작 뒤 새 Run·workspace maintenance·같은 workspace의 resume를 차단한다. 기존 exact request retry 조회는 유지한다. [요약 저장·복구 명세](engine-summary-attempts.md)를 따른다. 신규 summary 조회와 이미지 진단을 GUI에 노출했다고 간주하지 않는다.

DB5의 `getSummaryRecoveryPreview(sessionId, summaryAttemptId)`와 비동기 `acknowledgeSummaryRecovery({sessionId, summaryAttemptId, requestId, fingerprint, acknowledged: true})`는 부팅 전 불확실 요약에만 별도의 host 결정을 연결한다. 이 결정은 원본 uncertainty/usage/context/pause/inbox를 보존하며 다른 명령·복원·일반 실행 격리를 해제하지 않는다. 정확한 decision retry는 기존 receipt를 반환한다. 자동 provider 재시도·후보 activation·session resume 없이 명시적 새 작업만 이어갈 수 있다. [fingerprint·물리 저장소·적용 범위](engine-summary-recovery.md)를 따른다.

DB6의 `getAttemptCleanup(sessionId, attemptId)`는 지정 session의 일반 provider 종료 증거를 조회한다. `confirmed`와 ordinary outcome은 별개이며 native metrics schema 6의 `attemptCleanup`도 raw 상태 수만 반환한다. 정확한 failed ordinary overflow와 그 unknown summary가 결합된 경우에는 cleanup proof/source SHA를 host 결정에 포함한다. 원래 실패/불확실 상태를 보존하고 독립적인 ordinary uncertainty는 계속 차단한다. [상태·요청 projection·crash origin·한도](engine-attempt-cleanup.md)를 따른다. host 조회이며 모델 도구·GUI에 노출하지 않았다.

DB7의 `getProviderRecoveryPreview(sessionId, attemptId)`와 비동기 `acknowledgeProviderRecovery({sessionId, attemptId, requestId, fingerprint, acknowledged: true})`는 실제 cleanup이 확인된 일반 uncertain dispatch에만 별도 결정을 저장한다. 정상 취소의 확정 interrupted 호출은 대상이 아니다. 부분 출력·완성된 미실행 도구 제안·usage·원래 상태·control/inbox를 보존하며, 원래 호출 retry/activation/resume 없이 명시적 새 작업만 이어갈 수 있다. unknown cleanup·독립 효과·다른 후보는 계속 차단한다. [source·pins·물리 저장소·한도](engine-provider-recovery.md)를 따른다.

DB7의 summary proof V2는 불변 pin 목록의 SHA와 원래 boot frontier까지 fingerprint에 결합한다. 기존 DB5/V1 결정은 원래 body/scope와 정확한 역사 retry를 보존하지만 새 admission 근거로 사용하지 않는다. 필요한 새 V2 결정은 host가 새 preview/requestId로 명시적으로 내려야 한다. 엔진은 프로젝트의 기존 결정을 자동 재승인하지 않는다.

SQLite store의 `hasUncertainWorkspace(workspaceId)`는 summary와 ordinary 실행의 증거를 같은 read transaction에서 검사한다. runner는 이 통합 port로 admission/resume/maintenance를 확인하며 custom store에 port가 없으면 기존 두 predicates를 사용한다. 공통 선택 본문 8MiB 초과는 CLEANUP_PENDING을 유지한다. [cache 수명·변경 감지·원본 크기·호환](engine-recovery-evidence-read.md)을 따른다.

## LSP·formatter·변경 관찰

`registerLanguageServer(serverId, factory, languageForPath)`는 host가 선택한 factory와 경로→language selector를 등록한다. `StdioLspConnection`의 executable/args는 신뢰하는 host가 지정한다. 모델이 경로에서 LSP 서버를 자동 설치하거나 실행하지 않는다. `formatters.register(id, formatter)`는 현재 content를 받아 제한된 UTF-8 결과를 반환하는 host callback을 등록하고 해제 함수를 제공한다.

`format_file`과 `lsp_format_file`은 format 결과를 제안한 뒤 정상 patch 승인·hash·checkpoint 경로로 적용한다. 등록한 서비스가 없으면 unavailable을 반환하고 효과를 성공으로 표시하지 않는다. host callback은 formatter port 계약에 따라 텍스트 제안을 생성해야 하며 이 port 자체가 외부 프로세스의 sandbox를 제공하지 않는다.

`watchWorkspace(workspaceId)` 또는 최초 tool checkpoint가 [WorkspaceChangeHub](engine-workspace-changes.md)를 시작한다. 실제 변경 hash·documentVersion과 callback 완료를 다음 모델 turn 경계에 연결한다. 도구 선행/외부 관찰 선행·늦은 poll·review.restore가 같은 변경을 이중 알림하지 않는다. 관찰 실패는 원래 파일 효과 결과를 바꾸지 않고 diagnostics에 제한된 원인을 표시한다. Hub 상태는 프로세스의 bounded baseline이며 durable 원본 증거는 immutable checkpoint다.

child는 root의 살아 있는 LSP/MCP 연결을 묵시적으로 빌리지 않는다. 필요한 host adapter는 `configureChild(engine, task)`에서 명시적으로 등록한다. 이 callback은 동기식이며 child admission 전에 실행한다. 기본 child tool 상한을 넓히지 않는다.

## 외부 자원·관측·백업

`activatePlugin/deactivatePlugin`, `connectMcp/disconnectMcp`는 scope 등록·해제와 owned 연결 수명을 다룬다. stdio 및 지원 HTTP transport를 제공하고 unknown remote 효과는 runtime 승인 경로를 거친다. credential은 [host reference port](../../packages/engine/src/credentials/index.ts)를 사용한다. `terminals`는 user authority의 PTY API이며 모델 `run_command`의 승인과 구별한다. 실제 shell은 사용자 OS 권한이고 파일·네트워크 격리 sandbox를 제공한다고 광고하지 않는다.

DB9의 `getMcpExecution(sessionId, toolCallId)`는 정확한 승인/native owner·논리 RPC/연결/catalogue·dispatch/outcome/로컬 cleanup을 가진 bounded receipt를 조회한다. 최종 응답 없이 timeout/disconnect/cancel로 결과가 불확실해진 호출과 미확인 로컬 정리는 모델 continuation·새 실행·재시작 뒤에도 차단한다. 원래 provider cleanup/usage와 proposal/승인은 보존하고 기존 provider/summary ACK를 MCP 해제로 재사용하지 않는다. 조회는 retry/recovery authority를 부여하지 않으며 MCP 전용 ACK API는 아직 없다. [MCP 호출 계약](engine-mcp-execution.md)을 따른다.

MCP receipt 없는 native tool도 원래 running intent가 있으면 startup에서 tool_effect 격리를 유지한다. Session event paging의 `tool.recovery_frontier`는 원래 owner/record SHA와 callbackEntry=unverified/effectOutcome=unknown인 audit다. `tool.recovery_frontier.unchecked`는 native owner 없는 진짜 v1 기록의 미검증 coverage다. 새 getter/ACK는 추가하지 않았으며 조회로 실행을 허용하지 않는다. [일반 도구 재시작 계약](engine-tool-recovery-frontier.md)을 따른다.

`session.getDiagnostics`는 session owner의 SQL metrics·context 상태·workspace 관찰을 반환한다. [metric 의미](engine-native-metrics.md)에 따라 전체 primary count와 최근 matching 이벤트 창·unknown/null을 구별한다. 토큰 합계는 관측 값이며 청구 API의 확정 금액이 아니다. `read_artifact`는 현재 session에 속한 과거 Run/internal-tool/선택적 Turn·Attempt identity와 hash를 검증한 page를 반환한다. 원본 tool 결과와 provider replay는 보존한다.

`exportEngineArchive/validateEngineArchive/importEngineArchive`는 primary/review/recovery ledger/artifact manifest를 보존한다. import는 살아 있는 engine의 DB를 교체하지 않으며, 복원 뒤 중단한 효과를 자동 실행하지 않는다. [archive](engine-archive.md)·[저장 성능](engine-storage-performance.md)·[process/PTY](engine-process-terminals.md)의 지원 한계를 따른다.

`inspectArchivedChildDocumentStorage({directory,expectedManifestSha256,sessionId,sourceRunId,taskIds,signal?,limits?})`는 standalone historical host 조회다. Exact manifest와 root lineage를 확인하고 전체 archive proof 중 이미 검증한 selected index를 같은 frame에서 재사용한다. 반환값은 bounded document metadata samples·counts·partial/unknown이며 현재 엔진·원본 파일·provider·ACK·새 physical authority를 활성화하지 않는다. 선택 cap과 전체 proof·표시 예산의 차이는 [historical 문서 조회](engine-archive-child-document-inspection.md)를 따른다.

`getChildDocumentStorageUsage`는 기본 8개·최대 32개 exact managed child만 선택한다. source index 관측은 blob hash 검증이나 orphan 판정이 아니며 incomplete 총량은 null이다. 내부 verified child의 archive는 별도 owner read lease와 standalone snapshot·document refs/hash·manifest allowlist를 검사하고 import에서도 session을 pause한다. 원래 mirror·ACK·물리 binding을 새 실행 권한으로 다시 발급하지 않는다. Legacy/external/복원된 typed child의 coverage와 재보관 제한은 [child 문서 저장 계약](engine-child-document-storage.md)을 따른다.

## 검증과 남은 조건

기본 도구 21종 및 host가 실제 등록한 도구를 제공한다. child 실행/merge, LSP formatting/restore, MCP 승인, 큰 결과의 artifact 재조회는 실제 headless 엔진과 임시 Git/process fixture로 연결을 확인했다. 현재 Codex `gpt-6.1-sol` 계정의 read→approved patch→approved command도 별도로 통과했다. 실제 Anthropic 계정·추가 media 형식·Windows native backend·전체 GUI 노출·공개 배포는 별도 검증 대상이다. [지속 개선 목표](engine-improvement-goal.md)와 [열린 TODO](../../TODO.md)가 정확한 범위다.

## 문서 입력

`importDocument`의 참조는 v1/v2 입력의 별도 `documents` 배열에 넣는다. 표준 Responses의 `pdfModelIds`와 exact modelSpecs의 `inputFileTypes`를 모두 명시해야 한다. 알 수 없는 PDF token 비용은 기본 거절이며 엔진과 provider에 각각 `allowUnknownDocumentTokenCost: true`를 지정한 host만 이 제한을 수락한다. 실제 model window fit은 검증했다고 표시하지 않는다. `documentHistoryPolicy`는 오래된 원본 전송을 줄이되 user text와 exact refs의 별도 provenance를 보호하는 opt-in이다. Codex PDF와 GUI 입력은 노출하지 않았다. 저장·전송·요약·archive의 상한과 coverage는 [PDF 입력 명세](engine-input-documents.md)를 따른다.

## 승인한 실제 파일·skill 게시

`knowledgeFilePublication:true`에서 `previewWorkspaceKnowledgeFilePublication` / `previewWorkspaceKnowledgeFileRevocation`의 원본 preview를 `publishWorkspaceKnowledgeFile` / `revokeWorkspaceKnowledgeFile`에 `approved:true`와 함께 전달한다. 일반 파일과 정확한 skill 경로의 실제 처리, native revision/CAS, 영수증 중복 제거, 불확실 상태·원본 작업 종료 대기와 별도 ACK/resume를 제공한다. 각 API와 16 KiB 지원 범위, 공통 잠금·외부 writer의 한계는 [파일 게시 계약](engine-phase-two-file-publication.md)을 따른다. Import의 역사적 조회는 파일 적용 권한을 복원하지 않는다.

`diagnosticObservations: true`는 실제 원본 도구 실행의 물리 source 관측과 DB14 실행 이력을 활성화한다. 기본값은 off이며 `diagnosticSourceLimits`는 한도를 낮추기만 한다. 조회는 과거의 bounded 증거를 반환하며 현재 파일·남은 live budget·복구·작업 성공의 권한을 발급하지 않는다. `getCodingEvidence(..., {includeSummary:true})`의 요약은 결정적인 metadata 추출로 provider/tool/token 비용이 0이며 LLM distillation은 구현하지 않았다. 기존 `getAttemptManifest`의 host-declared source 계약은 유지한다. [실제 진단 경계와 API](engine-phase-two-native-diagnostics.md)를 따른다.

## 팀 membership·메일박스·작업 board

`teams:true`에서 host는 `createTeam`, 원본 `previewTeamMember` → `joinTeamMember({approved:true})`, `retireTeamMember`를 사용한다. 실제 root/child owner·member revision/generation·선택 역할·권한·expiry를 native 저장과 대조한다. child 엔진에는 팀 생성 권한을 상속하지 않는다.

`sendAgentMessage`는 메시지와 중복 제거 영수증을 먼저 저장한다. `readAgentMailbox`의 원본 페이지를 `claimAgentMailbox`에 전달하면 cursor CAS와 claim 영수증을 저장한다. `resumeChildTurn({approved:true,page,expectedCursorRevision,...})`은 원본 페이지를 실제 살아 있는 child의 현재 Run에 steer 입력으로 수락하고 root delivery 영수증을 남긴다. 승인 대기 효과·동일 Turn retry는 바뀌지 않으며 종료된 child의 새 Run 생성과 예산 갱신은 제공하지 않는다. DB 사이의 crash는 uncertain으로 보존하고 자동 재전송하지 않는다.

`putTeamTask`, `claimTeamTask`, `completeTeamTask`는 정확한 역할·의존성·작업 owner와 head CAS를 사용한다. 효과 기능이 꺼져 있어도 `getTeam`, `getTeamMember`, `listTeamMembers`, `getTeamTask`, `listTeamTasks`, `getTeamDelivery`로 bounded 이력을 조회할 수 있다. Import는 paused-import 이력만 보존한다. 메시지4KiB·전체 페이지64KiB·팀당32멤버/128작업, 실제 child-input archive 증명과 미지원 범위는 [팀 엔진 계약](engine-phase-two-teams.md)을 따른다. Terminal 상주 재개는 후속 구현이다.

`teams:true, teamModelTools:true`는 모델용 `send_agent_message`, `read_agent_mailbox`, `claim_team_task`, `complete_team_task`를 처음부터 고정 catalogue에 등록한다. Host가 `bindTeamModelTools({rootSessionId,teamId,memberId,generation,childTaskId?,recipientAliases?})`로 실제 현재 root/child 멤버를 별도로 선택해야 한다. 실행당 선택은 하나이며 수신 별칭 기본 허용 목록은 비어 있다. 원본 binding을 `releaseTeamModelTools`로 해제하면 이미 준비된 요청도 그 권한을 재사용하지 못한다. 모델은 actor/team/member/generation을 지정할 수 없다.

쓰기3종은 exact native 승인을 사용하고 읽기는 기존 readonly 정책을 따른다. 실제 원본 ToolContext·Run/Turn/Attempt·멤버 역할과 parent profile을 함께 검사한다. Child에는 root가 명시한 handler/선택 멤버만 전달하며 팀 생성 권한을 상속하지 않는다. 읽기는 cursor를 바꾸지 않으며 기본4개/명시1~64개, 전체 모델 JSON32KiB와 최소 남은 출력1KiB 제한을 적용한다. Child 첫 provider 호출은 실제 task running/Run ID 저장 뒤 시작하고 취소된 admission 대기는 종료한다. [모델 팀 도구 계약](engine-phase-two-team-model-tools.md)을 따른다.

## 역할 workflow·recipe

`workflows:true`에서 `registerWorkflow`, 원본 `previewWorkflowStart` → `startWorkflow({approved:true})`, 명시적 `startWorkflowStage({approved:true})`와 `observeWorkflowStage`를 사용한다. 실제 live parent·profile/model/catalogue·예산·관리 worktree를 고정하고, 기존 child admission을 통해 별도 readonly planner/advisory-reviewer를 실행한다. 관찰 취소는 child를 재실행하지 않으며 나중에 원본 결과를 다시 관찰할 수 있다.

`getWorkflow`와 `inspectWorkflow`는 기능이 꺼져 있어도 bounded 이력을 조회한다. DB19 revision/head/receipt와 stage join은 native CAS를 사용한다. 재시작은 unfinished stage를 uncertain으로, import는 paused-import로 보존하며 자동 dispatch·parent delivery·승인 merge를 수행하지 않는다. Editor/validator 효과 실행과 role/model escalation은 후속 구현이다. [워크플로 계약과 검증 범위](engine-phase-two-workflows.md)를 따른다.
