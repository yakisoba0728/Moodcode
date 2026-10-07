# Roo Code 엔진 정적 분석

분석일: 2026-10-07. `analysisMode: static-source-review`.

Roo Code는 보관된 VS Code extension 엔진의 역사적 참고점이다. 의미 코드 검색, mode별 파일 범위, 부모를 닫고 child를 수행한 뒤 이력으로 다시 여는 위임, todo·도구 실패에 따른 완료 gate를 확인했다. Moodcode의 profiles·격리 worktree child·durable inbox·exact 승인·MCP discovery·semantic history memory와 비교해 추가 계약 네 가지를 제안한다. 이번 작업은 분석이며 기능 구현이나 upstream 실행은 포함하지 않는다.

## 원본·유지보수·package·license

- 저장소: [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code). 고정 HEAD: `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16`.
- checkout: `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/roo-code`. full-history clone이며 HEAD를 변경하지 않았다. manifest의 commit 시각은 `2026-05-15T14:04:45-04:00`이다.
- [source manifest](source-manifest.json)의 2026-10-07 GitHub API 관측은 `archived=true`다. 고정 README는 extension이 May 15에 종료되었다고 안내하고 Zoo community fork와 Cline을 대안으로 연결한다(R01). README 문장 자체에는 연도가 없다. 보관된 Roo 제품과 2026-10-07 commit이 확인된 Zoo fork를 별도 대상으로 다룬다. 미래 유지보수·release 상태를 보장하지 않는다.
- TypeScript 중심 pnpm workspace다. `src/`가 VS Code extension과 Task/provider/tools/services, `webview-ui/`는 React UI, `apps/cli/`는 CLI/TUI, `packages/vscode-shim/`은 adapter, `packages/types/`는 공유 계약, `packages/core/`는 custom tools·message/task-history·worktree 등의 공유 유틸리티다. `@roo-code/core`의 이름만으로 Task loop가 platform-agnostic package에 분리되어 있다고 판단하지 않았다.
- 실제 root `LICENSE`는 Apache-2.0(R02), `apps/docs/LICENSE:1–12`도 Apache-2.0다. tracked license/notice 파일명에서는 두 license를 확인했다. 하위 문서 license와 root license를 구분했으며 의존성·WASM/parser·원격 모델·embedding·MCP·Qdrant·cloud/telemetry 서비스 전체의 license·약관 audit이나 법률 검토는 하지 않았다.

## 대표 고정 소스 근거

[evidence JSON](roo-code.evidence.json)에 20개 범위의 ID·path·1-based line·파일/범위 SHA-256을 기록했다. 각 범위는 160줄 이하다. 본문의 보조 경로도 같은 고정 HEAD에서 읽었으며 source·prompt·tool description·fixture를 복사하지 않았다.

| ID | 고정 소스 | 확인한 범위 |
|---|---|---|
| R01 | [README.md:35–77](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/README.md#L35-L77) | README의 modes/MCP 주장과 May 15 extension 종료·Zoo/Cline 대안 안내 |
| R02 | [LICENSE:1–12](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/LICENSE#L1-L12) | root 실제 Apache License 2.0 |
| R03 | [src/core/webview/ClineProvider.ts:2536–2627](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/webview/ClineProvider.ts#L2536-L2627) | top-level 단일 active task 교체·Task 구성·stack 등록 뒤 직접 start |
| R04 | [src/core/task/Task.ts:2427–2501](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts#L2427-L2501) | abort 조건의 Task loop와 후속 요청·retry를 관리하는 명시적 stack |
| R05 | [src/core/task/Task.ts:4103–4197](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts#L4103-L4197) | native/MCP tools·Gemini allowedFunctionNames 구성·provider createMessage·첫 chunk 취소 race |
| R06 | [src/core/task/Task.ts:2802–2890](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts#L2802-L2890) | scope 인자 없는 native streamed tool parser와 같은 Task의 call ID 중복 억제 |
| R07 | [src/core/assistant-message/presentAssistantMessage.ts:491–609](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/assistant-message/presentAssistantMessage.ts#L491-L609) | UI/auto-approved ask 응답을 도구 승인으로 처리하고 완성된 tool block의 mode/model을 실행 전 검증 |
| R08 | [src/core/task/Task.ts:2212–2330](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts#L2212-L2330) | abort flag·동기 dispose·terminal release·비동기 artifact cleanup/diff reversion·메시지 저장 |
| R09 | [src/core/task/Task.ts:1956–2115](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task/Task.ts#L1956-L2115) | 이력 재개 질문·summary 보존·미완료 native tool exchange에 interrupted 결과 보충 |
| R10 | [src/core/context-management/index.ts:285–371](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/context-management/index.ts#L285-L371) | profile threshold 기반 요약과 sliding-window truncation fallback |
| R11 | [src/core/webview/ClineProvider.ts:2775–2913](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/webview/ClineProvider.ts#L2775-L2913) | 부모 tool-result 저장 시도·부모 종료·child mode 설정·위임 metadata 저장 시도 후 child 직접 시작 |
| R12 | [src/core/webview/ClineProvider.ts:2950–3104](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/webview/ClineProvider.ts#L2950-L3104) | child 결과를 parent UI/API 이력에 주입하고 child/parent 상태를 순차 저장한 뒤 parent 자동 재개 |
| R13 | [src/core/tools/AttemptCompletionTool.ts:38–135](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/tools/AttemptCompletionTool.ts#L38-L135) | 같은 turn 도구 실패·설정된 미완료 todo 완료 gate와 child 상태 확인·사용자 완료 수락 |
| R14 | [src/services/checkpoints/ShadowCheckpointService.ts:295–371](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/services/checkpoints/ShadowCheckpointService.ts#L295-L371) | shadow Git checkpoint stage/commit과 clean/hard-reset 복원 |
| R15 | [src/core/tools/validateToolUse.ts:120–238](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/tools/validateToolUse.ts#L120-L238) | mode tool group·disabled 우선·edit fileRegex/patch 파일 검사·custom tool와 dynamic MCP 예외 |
| R16 | [src/core/tools/UseMcpToolTool.ts:29–80](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/tools/UseMcpToolTool.ts#L29-L80) | MCP 매개변수·tool 존재 확인·승인 후 실행 경로 |
| R17 | [src/core/tools/CodebaseSearchTool.ts:21–128](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/tools/CodebaseSearchTool.ts#L21-L128) | cwd 산출 뒤 cwd 없이 manager 선택·설정 검사·승인된 path/line/score/chunk 검색 결과 반환 |
| R18 | [src/services/code-index/search-service.ts:27–63](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/services/code-index/search-service.ts#L27-L63) | Indexed/Indexing readiness·query embedding·prefix/score/top-k vector 검색·오류 재발행 |
| R19 | [src/core/task-persistence/TaskHistoryStore.ts:155–289](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/src/core/task-persistence/TaskHistoryStore.ts#L155-L289) | per-task source-of-truth 저장·memory lock·debounced index·disk/cache 누락 reconcile |
| R20 | [apps/cli/src/agent/extension-host.ts:368–436](https://github.com/RooCodeInc/Roo-Code/blob/b867ec9145750d0ae1ff7f02d35406e9bf2a0b16/apps/cli/src/agent/extension-host.ts#L368-L436) | CLI의 VS Code shim·module resolver 설치·동일 extension.js load와 activate |

## 진입·모델·stream·도구·완료

`src/extension.ts:110,169`의 `activate()`가 `ClineProvider`를 만들고 `src/core/webview/webviewMessageHandler.ts:601–607`의 `newTask`가 `createTask()`로 연결된다. provider는 설정·organization profile 제한을 읽고 top-level task이면 현재 Task를 닫는다. Task를 `startTask:false`로 구성해 stack에 넣은 뒤 `task.start()`를 직접 호출한다(R03). `Task.ts:481`의 생성자에서 `buildApiHandler()`를 사용한다. `src/api/index.ts:111–181`는 Anthropic, OpenAI compatible/native/Codex, Gemini, OpenRouter, Bedrock/Vertex, Ollama/LMStudio 등을 선택하고 retired provider를 거절한다. Roo Router 종료도 이 factory에서 별도 안내한다. factory 분기가 있다는 사실은 provider별 실제 capability 동등성의 증거가 아니다.

`initiateTaskLoop()`는 checkpoint 초기화를 시작하고 abort까지 `recursivelyMakeClineRequests()`를 호출한다. 이름과 달리 후속 요청·retry는 명시적 stack으로 처리한다(R04). `Task.ts:2566–2599`에서 mention/slash-command 처리를 마친 user content에 workspace·terminal·진단 환경을 더해 API 이력에 저장한다. `src/core/prompts/system.ts:72–107`은 mode 지침·skills·rules·custom instructions를 포함하고 도구 catalogue는 native API schema로 따로 보낸다. 모델이 도구를 쓰지 않으면 후속 도구/완료 요청을 넣으며, `Task.ts:3477–3515`는 tool result가 준비된 뒤 후속 stack을 만든다.

요청 구성은 model info와 현재 mode를 바탕으로 native/MCP tools를 만들며 Gemini는 전체 schema와 `allowedFunctionNames`를 함께 받는다. metadata에는 mode·Task ID·tools·`parallelToolCalls:true`가 들어간다(R05). `src/core/task/build-tools.ts:82–168`은 task cwd의 index manager, native/mode/model filtering, dynamic MCP와 experiment custom tools를 조립한다. `createMessage(systemPrompt, history, metadata)`의 async stream에서 reasoning·usage·grounding·tool delta를 처리한다. **Roo의 이 계약에는 Task AbortSignal 전달 인자가 없다.** Task는 첫 chunk와 취소를 race하고 stream 읽기에도 abort 대기를 두지만 원격 provider HTTP 종료 보장과는 구분한다.

native partial tool call은 index·ID·name·arguments를 parser에 전달하고 같은 Task의 중복 ID를 억제한다(R06). 이 호출에는 Zoo의 parser scope 인자가 없다. `presentAssistantMessage.ts:60–82`의 lock과 content index가 block을 순서대로 처리한다. 완성된 block은 mode/model/disabled 도구를 검증(R07)하고 같은 파일 `:651–823`에서 read/search/edit/command/MCP/question/mode/new_task/completion 등의 handler를 await한다. 여러 tool call을 모델 응답에 허용하는 설정은 여러 효과나 child의 실제 병렬 실행과 별개다. `Task.ts:3408–3457`은 `new_task` 뒤 도구를 잘라 미실행 결과를 넣고 assistant history를 저장한 뒤 실행을 진행한다.

`EditTool.ts:104–143`은 exact old string과 uniqueness/replace-all을 검사해 변경안을 만든다. `:153–218`은 diff 표시·승인·diff-view 또는 직접 저장, `:228–238`은 쓰기 결과와 queued input 처리로 이어진다. `ExecuteCommandTool.ts:55–139`는 canonical command의 ignore 검사와 승인 후 terminal에 보내며 timeout·shell integration fallback을 지원한다. 승인한 명령 실행과 테스트 결과를 관측할 수 있지만 별도 test/reviewer agent가 자동으로 완료를 인증하는 계약으로 해석하지 않았다.

`AttemptCompletionTool.execute()`는 같은 turn의 tool 실패가 있으면 완료를 막는다. `preventCompletionWithOpenTodos`를 켠 경우 미완료 todo도 막고, child 상태를 확인해 부모 반환을 수행하거나 사용자의 완료 수락/피드백을 기다린다(R13). todo의 completed 표시는 독립적인 테스트 통과 proof가 아니다. Task loop의 모든 종료를 자동 성공으로 보는 설계도 아니다.

## 승인·입력 queue·취소·저장·재개

presenter의 `askApproval()`은 `Task.ask()`의 응답을 기다리고 거절/피드백을 도구 결과로 돌린다(R07). `src/core/auto-approval/index.ts:92–179`은 MCP tool별 항상 허용, read/write/outside/protected 파일, command allow/deny, mode·subtask 설정을 구분한다. Moodcode의 hash/fingerprint-bound prepare/approval/effect와 동일한 durable 승인 계약으로 인증한 것은 아니다.

입력 queue는 `src/core/message-queue/MessageQueueService.ts:17–97`의 메모리 배열·UUID·enqueue/dequeue·dispose 구조다. `Task.ts:1318–1421`은 auto-approval 후 queued 입력을 소비하며 tool/command/MCP 승인 ask에는 queued message를 `yesButtonClicked`와 feedback으로 연결하는 경로도 있다. **일반 queued steering과 명시적 effect 승인의 의미가 섞이는 경계**다. Moodcode는 이미 영구 queue/steer CAS·exact 승인·pause/resume를 갖추었으므로 이 동작을 새 inbox 기능 또는 안전한 승인 대체로 제안하지 않았다.

`abortTask()`는 abort flag·usage·event를 기록하고 `dispose():void`를 호출한 뒤 메시지를 저장한다(R08). dispose는 현재 request·listeners·message queue·terminal ownership·file tracker를 정리하며 artifact cleanup과 진행 중 diff reversion은 비동기로 시작한다. Zoo의 abort/dispose promise 재사용과 await 기반 정리를 이 Roo HEAD에 적용하지 않았다. 여기의 terminal release, task 대기 중단, diff reversion은 OS process tree 종료·daemon 정리·원격 MCP/명령 effect rollback의 실측 증거가 아니다.

API history와 UI messages는 `Task.ts:1100–1203`에서 별도 task 파일로 저장한다. metadata는 해당 Task의 mode/profile을 사용한다. `TaskHistoryStore`는 per-task `history_item.json`을 source of truth로 쓰고 memory lock·cache·debounced index를 관리한다. reconcile는 disk/cache에 없는 task를 더하거나 지우는 경로다(R19). 이는 Zoo의 delegated child 상태 repair/pair update와 다르며 파일 간 transaction을 입증하지 않는다.

history 재개는 이전 resume UI/불완전 request 표시를 정리하고 API history를 읽은 뒤 사용자에게 resume/completed-resume를 묻는다. summary metadata는 보존하고 마지막 assistant tool-use나 미완료 user exchange에는 interrupted 결과를 채운다(R09). 대화 프로토콜을 재구성하는 복구이며 이미 발생한 command/MCP effect의 정확한 outcome·cleanup을 확인한 receipt로 취급하지 않았다. Moodcode의 recovery frontier·unknown cleanup 격리·archive audit를 대체할 계약은 확보하지 않았다.

## 문맥·요약·checkpoint·기억

context management는 profile별 threshold와 global fallback을 적용해 provider 요약을 시도하고, 필요하면 sliding-window truncation으로 fallback한다(R10). `Task.ts:4004–4089`는 조정한 history를 저장하고 effective history를 API 입력으로 투영한다. `src/core/task-persistence/apiMessages.ts:12–37`의 summary/condenseParent/truncationParent metadata는 원본을 숨기되 rewind를 위해 유지하는 구조다. 이력 요약, 로컬 rules/skills/reference 주입, 파일 기반 코드 색인은 서로 다른 기능이다. Moodcode에 이미 bounded context·summary provenance·semantic checkpoint·복구 proof가 있어 일반 요약을 신규 기능으로 세지 않았다. 프로젝트 간 지속 semantic memory의 동등한 계약은 이 검토로 확인하지 못했다.

checkpoint는 shadow Git repo에 stage/commit하고 복원 시 clean과 hard reset을 수행한다(R14). presenter에서 파일 effect와 `new_task` 앞에 checkpoint를 요청한다. 현재 파일 hash와 preview binding, 외부 변경 보존, durable restore audit가 있는 Moodcode의 복원 계약과 비교해야 한다. Roo 방식은 workspace 파일 복원이며 command/MCP의 저장소 밖 효과 rollback을 뜻하지 않는다.

## modes·parent/child continuation·확장

mode는 지침과 tool group, edit fileRegex를 정한다. `isToolAllowedForMode()`는 disabled를 먼저 검사하고 alias·model included tools·group을 해석한다. edit path 및 patch의 파일 marker를 fileRegex와 대조한다(R15). `packages/types/src/mode.ts:177`에는 Markdown 편집 범위 예시가 있다. raw path regex에 대한 검사이므로 canonical workspace scope와 모든 rename/effect 대상에 대한 Moodcode 수준 binding을 인증하지 않는다. experiment custom tools는 현재 모든 mode에서 허용하는 예외(R15)가 있고 `build-tools.ts:134–140`이 cwd별 `.roo` tool directory를 읽는다. extension/plugin 신뢰 범위와 model tool 권한을 별도로 유지할 필요가 있다.

`NewTaskTool.ts:91–121`은 대상 mode를 확인하고 승인 후 `delegateParentAndOpenChild()`를 호출한다. provider는 parent tool results를 먼저 flush/retry하고 부모를 닫으며 child mode로 바꾼 뒤 child를 멈춘 상태로 생성한다. 위임 metadata 저장을 시도하고 child를 시작한다(R11). flush·부모 정리·mode 변경·metadata 저장의 일부 실패는 log하고 계속한다. 저장 성공이 child 시작을 반드시 막는 barrier라고 표현하지 않았다. task mode/profile metadata를 저장하는 구현은 확인했지만 Zoo의 강화된 위임 profile snapshot·scheduler를 그대로 가정하지 않았다.

child가 완료되면 parent UI에 결과를 넣고 native `new_task` call ID에 맞는 tool result를 채우거나 text fallback을 사용한다. parent API history 저장 후 child를 닫고 child completed·parent active 상태를 순차 저장한다. parent를 이력에서 새 instance로 만들고 history를 주입해 `resumeAfterDelegation()`으로 자동 계속한다(R12). 이미 completed인 child의 중복 반환을 막는 검사도 있다(R13). **이 스냅샷의 위임은 single-open parent→child→parent 흐름**이다. 여러 agent가 동시에 활동하는 mailbox, fan-out barrier, 작업별 격리 worktree, crash-atomic 결과/continuation을 이 경로만으로 확인했다고 하지 않는다.

MCP는 `McpHub.ts:6–8,698–832`의 stdio/SSE/Streamable HTTP transport와 global/project 설정을 사용한다. dynamic native MCP 이름도 공통 handler로 변환되며 `UseMcpToolTool`은 tool 존재와 arguments를 검사하고 승인 후 실행한다(R16). `McpHub.ts:1711–1768`은 connected/disabled 상태와 timeout을 확인해 resource read/tool call을 보낸다. Roo의 `filter-tools-for-mode.ts:437–455`는 mode에 MCP group이 있으면 dynamic tools를 허용하는 범주 단위 판정이다. Zoo의 mode별 server/resource allowlist를 Roo 구현으로 표시하지 않았다. 긴 catalogue를 model이 선택하는 Moodcode의 bounded discover_tools·same-capture/context 계약도 이미 있는 비교 기준이다.

## 의미 코드 검색·embedding·CLI 공유 경계

`codebase_search`는 query와 path를 받고 승인 후 manager의 enabled/configured 상태를 확인하며 path·line·score·chunk 결과를 반환한다(R17). `CodeIndexSearchService`는 Indexed/Indexing 상태에서 query embedding을 만들고 directory prefix·score·max-results로 vector store를 검색하며 오류는 재발행한다(R18). `service-factory.ts:41–108,226–261`은 OpenAI/Ollama/compatible/Gemini/Mistral/Vercel Gateway/Bedrock/OpenRouter embedder와 parser/scanner/watcher/vector store를 조립한다. `qdrant-client.ts:399–466`은 path segment filter, metadata 제외, score/top-k query를 사용한다. 이 Roo HEAD의 파이프라인에서 Semble 경로는 확인하지 못했다.

검색 workspace 경계에는 주의할 차이가 있다. tool은 `task.cwd`를 산출하지만 실제 manager 호출은 `getInstance(context)`로 cwd를 넘기지 않는다(R17). 반면 schema 구성과 system prompt는 `getInstance(context,cwd)`를 사용한다. manager의 `:32–67` 기본 선택은 active editor workspace, 없으면 첫 workspace다. 따라서 multi-root에서 tool 노출과 검색 namespace가 task cwd와 일치한다고 인증하지 않는다. C1은 이 경계를 명시적으로 고정하고 검색 결과 freshness를 증거로 남기는 독립 계약이다. remote embedding 코드 전송·Qdrant namespace·watcher freshness·ignore 완전성·검색 품질은 실행 검증하지 않았다.

CLI는 `apps/cli/src/commands/cli/run.ts:330`에서 ExtensionHost를 만들고, host는 VS Code shim·module resolver를 준비해 `extension.js`를 load한 뒤 실제 extension `activate()`를 호출한다(R20). client/ask-dispatcher가 같은 webview message 계약을 연결한다. `packages/core/src/cli.ts:1–7`의 export는 debug-log/message-utils/task-history 유틸리티다. **CLI의 Task loop 공유 경로는 extension bundle + shim**이며 독립된 platform-agnostic loop export로 읽지 않는다. CLI/TUI 설치·실행·build로 동작을 검증하지 않았다.

## Zoo와 같은 범주를 비교한 결과

[Zoo 분석](zoo-code.md)은 별도 HEAD `842b37e76d296a6381c182f2dad7822da08b9cbb`의 자료다. 이번 Roo 보고서는 각 동작을 Roo 소스에서 다시 읽었다. 기능의 최초 도입 시점이나 모든 과거 commit을 비교한 결과는 아니다.

| 범주 | Roo 고정 HEAD에서 확인한 경계 | Zoo 분석과 혼동하지 않을 부분 |
|---|---|---|
| Task admission | stack 등록 후 직접 `Task.start()`, single-open 위임 | Zoo의 기본 concurrency 1 scheduler를 Roo에 있다고 표시하지 않는다. |
| stream cancellation/parser | Task abort race, scope 없이 parser 호출 | Zoo의 provider AbortSignal·parser scope 인자를 역적용하지 않는다. |
| 위임 persistence | 순차 파일 저장·일부 실패 후 계속·history 재생성 | Zoo의 child repair/pair update/stale continuation guard와 동일한 복구라고 부르지 않는다. |
| mode/MCP | tool group·fileRegex·MCP group 판정 | Zoo의 mode별 MCP server/resource 제한을 Roo에 있다고 표시하지 않는다. |
| 코드 검색 | embedding/Qdrant, tool의 cwd 전달 누락 경계 | Zoo의 cwd manager·Semble/provider 경로와 구분한다. |
| 명령 판정 | command ignore·승인·allow/deny·terminal fallback | Zoo의 외부 DCG preflight는 Roo의 읽은 경로에서 확인되지 않았다. |
| license·제품 상태 | root와 docs Apache-2.0, archived·extension 종료 | 활성 변경이 확인된 fork의 상태를 보관된 Roo에 적용하지 않는다. |

## Moodcode에 더할 계약 후보

Moodcode engine source `464812f7d1af24466f57070663131f5979aeca51`, [baseline](moodcode-baseline.md), [현재 구현 상태](../moodcode/implementation-status.md)를 비교 기준으로 사용했다. JSON의 후보별 경로는 실제 파일과 고정 Moodcode commit에 존재하는지 확인했다. `P1`은 후속 우선 검토, `P2`는 선택적 확장; `M/L`은 중간/큰 구현 비용이다. 후보는 upstream source/prompt/fixture 복사 없이 별도 명세로 구현해야 하며 clean-room 절차를 수행했다고 주장하지 않는다.

| 후보 | 이미 있는 기능에 더할 계약 | 우선순위·비용 | 근거 |
|---|---|---|---|
| roo-code-C1: workspace 의미 코드 검색 | 기존 context·semantic history memory·LSP·discovery에 workspace/source/index identity, stale 판정과 bounded 검색 관측을 더한다. | P1 / L | R05, R17, R18 |
| roo-code-C2: 역할 workflow child continuation | 기존 profiles·격리 child·root inbox·pause/resume에 stage와 awaited child 결과를 묶은 durable 재개 admission을 더한다. | P2 / L | R03, R11, R12, R19 |
| roo-code-C3: profile 파일 effect 범위 | 기존 path resource policy·deny·Plan/Build·exact 편집 승인에 role/profile revision에 묶인 모든 effect 대상 검사를 더한다. | P2 / M | R07, R15 |
| roo-code-C4: 완료 evidence gate | 기존 durable tasks·structured result·Run terminal에 required task revision과 source-bound verification receipt를 묶은 success admission을 더한다. | P2 / M | R04, R13 |

C1은 `packages/engine/src/context/*`, runtime/discovery/ports, C2는 `agents`, `child-tasks`, `runner/input-scheduler`, `session-state`를 연결한다. C3는 `agents`, permission policy, runtime/edit/runner의 기존 scope·exact 승인과 교차해야 한다. C4는 `session-state`, session tools, runner/turn-executor와 artifacts를 연결한다. 각 계약과 crash/cancel/stale·예산 검증 조건은 evidence JSON에 기록했다. 기존 일반 lifecycle hook·MCP·queue·checkpoint·summary를 신규 기능으로 다시 세지 않았다.

## 정적 검사와 확인 한계

두 산출물의 JSON 구조·20개 source 범위·각 160줄 이하·tracked HEAD 소속·파일/범위 SHA-256·후보 네 개의 reference ID 및 Moodcode 경로 존재를 정적 검사했다. 원본 HEAD는 동일하다. 이 결과는 upstream test/build/benchmark 실행 결과가 아니다. upstream 설치·test·runtime·모델·계정·GUI·CLI/TUI·공유 build·commit을 수행하지 않았다. 원본 source/prompt/fixture를 Moodcode에 복사하거나 runtime dependency로 추가하지 않았다.

실제 provider별 capability·usage·retry·원격 cancellation, OS terminal/process cleanup, GUI/CLI, embedding/Qdrant/MCP 서비스, index 신선도·성능, LFS/submodule·release assets, 전체 의존성/서비스 audit와 완전한 Roo/Zoo 역사 diff는 미확인이다. README의 code generation/refactor/debug/modes/MCP 주장을 대응하는 개별 소스 존재로 확인했으며 제품 품질이나 종료 이후 지원을 실측했다고 표시하지 않았다. Moodcode의 기존 테스트 통과 기록은 이번 Roo 분석 실행 결과와 분리했다.
