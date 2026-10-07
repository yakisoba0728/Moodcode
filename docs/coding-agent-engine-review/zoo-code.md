# Zoo Code 엔진 정적 분석

분석일: 2026-10-07. `analysisMode: static-source-review`.

Zoo Code의 직접 참고 가치는 workspace 의미 코드 검색, 역할별 도구 정책, child 완료와 parent 재개 사이의 저장·스케줄링 경계에 있다. Moodcode의 profiles, 격리 worktree child, MCP, permissions, discovery, recovery, LSP 및 semantic history memory를 이미 구현된 기준으로 비교했다. 아래 후보는 기존 기능에 더할 계약이며 이번 작업에서 구현하지 않았다.

## 원본·경계·출처

- 저장소: [Zoo-Code-Org/Zoo-Code](https://github.com/Zoo-Code-Org/Zoo-Code). 고정 HEAD: `842b37e76d296a6381c182f2dad7822da08b9cbb`.
- 읽은 checkout: `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/zoo-code`. 최신 고정 commit의 시각은 `2026-10-07T04:33:59Z`; 메시지는 webview의 마지막 active chat으로 code action을 라우팅하는 수정이다. 저장소가 이 시점에 변경되고 있다는 근거이며 이후 유지보수·릴리스 빈도를 보장하지 않는다.
- TypeScript 중심 pnpm workspace다. `src/`는 VS Code extension 엔진과 provider·tools·services, `webview-ui/`는 React UI, `apps/cli/`는 CLI/TUI, `packages/vscode-shim/`는 VS Code adapter, `packages/types/`는 공통 타입, `packages/core/`는 message/task-history/custom-tools/worktree 등의 공유 유틸리티다. package identity에는 `roo-code`와 `@roo-code/*`가 남아 있다. 읽은 `src/package.json`의 version은 `3.86.0`, CLI는 `0.1.17`이다.
- README는 Roo active 개발 이후 이어받았다는 설명과 Semble, 강해진 Orchestrator, DCG, provider·MCP 제어 등 추가 기능을 주장한다(Z01). 이 보고서는 고정 HEAD에 구현이 있는지 확인한 결과다. 현재 소스만으로 각 기능이 Zoo에서 처음 도입되었다고 판정하지 않는다. Roo와의 정확한 역사 비교는 별도 분석 범위다.
- root 실제 `LICENSE`는 Apache-2.0다(Z02). `git ls-tree`로 확인한 tracked license/notice/copying 파일명 목록에서는 root `LICENSE`만 있었다. 하위 package가 이름에 Roo를 유지한다고 다른 license를 추정하지 않았다. 의존성 전체·다운로드 binary·서비스 약관 audit이나 법률 검토는 하지 않았다.

## 대표 고정 근거

JSON에 같은 ID, 경로, 줄 범위와 파일·범위 SHA-256을 기록했다. 아래 20개 범위는 각각 160줄 이하다. 보조 호출 경로는 본문에 파일과 함수·줄을 적었으며 원본 코드를 복사하지 않았다.

| ID | 고정 소스 | 확인한 범위 |
|---|---|---|
| Z01 | [README.md:18–64](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/README.md#L18-L64) | Roo 이후 유지보수와 Zoo 추가 기능·v3.86.0의 README 주장 |
| Z02 | [LICENSE:1–12](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/LICENSE#L1-L12) | root 실제 라이선스는 Apache License 2.0 |
| Z03 | [src/core/task/Task.ts:3516–3573](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/task/Task.ts#L3516-L3573) | abort 조건의 Task loop와 명시적 요청 stack |
| Z04 | [src/core/task/Task.ts:5434–5505](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/task/Task.ts#L5434-L5505) | 같은 request model-info로 native/MCP 도구 구성 후 AbortSignal과 함께 provider createMessage 호출 |
| Z05 | [src/core/task/Task.ts:3923–4009](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/task/Task.ts#L3923-L4009) | scope를 전달하는 native streamed tool parser와 call ID 중복 억제 |
| Z06 | [src/core/tools/ExecuteCommandTool.ts:114–191](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/tools/ExecuteCommandTool.ts#L114-L191) | 명령 구문 검사·외부 DCG verdict·명령 승인 흐름 |
| Z07 | [src/core/task/Task.ts:3261–3418](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/task/Task.ts#L3261-L3418) | abort/dispose promise 재사용·HTTP 취소·terminal 해제·diff reversion·최종 저장 |
| Z08 | [src/core/task-persistence/TaskHistoryStore.ts:434–514](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/task-persistence/TaskHistoryStore.ts#L434-L514) | 시작 시 orphan delegated/active/completed child 상태 재조정 |
| Z09 | [src/core/context-management/index.ts:314–425](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/context-management/index.ts#L314-L425) | profile threshold 기반 요약과 sliding-window truncation fallback |
| Z10 | [src/services/checkpoints/ShadowCheckpointService.ts:331–407](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/services/checkpoints/ShadowCheckpointService.ts#L331-L407) | shadow Git checkpoint 저장과 clean/reset 기반 복원 |
| Z11 | [src/core/webview/ClineProvider.ts:3829–3961](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/webview/ClineProvider.ts#L3829-L3961) | 위임 시 mode/profile 선택·부모 tool-result flush·부모 종료·child 실행 전 metadata 저장 |
| Z12 | [src/core/webview/ClineProvider.ts:4234–4377](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/webview/ClineProvider.ts#L4234-L4377) | child 완료·parent 활성화 쌍 업데이트 후 stale continuation 검사와 scheduler 재개 |
| Z13 | [src/core/task/TaskScheduler.ts:1–52](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/task/TaskScheduler.ts#L1-L52) | 기본 동시성 1인 semaphore Task gate와 대기 취소 |
| Z14 | [src/core/prompts/tools/effective-tool-policy.ts:236–338](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/prompts/tools/effective-tool-policy.ts#L236-L338) | 모델 제외·준비된 code index·도구 비활성화·mode MCP 서버 조건으로 도구 노출 결정 |
| Z15 | [src/core/tools/UseMcpToolTool.ts:45–108](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/tools/UseMcpToolTool.ts#L45-L108) | MCP tool 존재·mode server 허용 확인 후 승인과 호출 |
| Z16 | [src/core/tools/CodebaseSearchTool.ts:25–134](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/core/tools/CodebaseSearchTool.ts#L25-L134) | task cwd의 index manager readiness 검사와 승인된 검색 결과의 path/line/score 반환 |
| Z17 | [src/services/code-index/manager.ts:340–437](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/services/code-index/manager.ts#L340-L437) | Semble와 외부 embedder/vector store/scanner/watcher 파이프라인 분기 |
| Z18 | [src/services/code-index/vector-store/qdrant-client.ts:399–467](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/services/code-index/vector-store/qdrant-client.ts#L399-L467) | Qdrant path segment 필터·metadata 제외·score/top-k 제한의 query 호출 |
| Z19 | [src/services/code-index/semble/provider.ts:167–286](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/src/services/code-index/semble/provider.ts#L167-L286) | Semble 전체 workspace 검색·directory prefix 후처리·외부 경로 거절과 결과 변환 |
| Z20 | [apps/cli/src/agent/extension-host.ts:368–451](https://github.com/Zoo-Code-Org/Zoo-Code/blob/842b37e76d296a6381c182f2dad7822da08b9cbb/apps/cli/src/agent/extension-host.ts#L368-L451) | CLI의 VS Code shim 설치·extension.js require·동일 extension activate 호출 |

## 실행·provider·native 도구

실제 extension 진입은 `src/extension.ts:232`에서 `ClineProvider`를 만들고, webview `newTask` 메시지는 `src/core/webview/webviewMessageHandler.ts:691`에서 `provider.createTask()`로 연결된다. `ClineProvider.createTask():3391–3439`는 실행 설정을 읽고 top-level Task를 교체하며, `startTask:false`로 Task를 만든 뒤 registry에 등록하고 scheduler에 넣는다. `Task` 생성자는 `src/core/task/Task.ts:675`에서 `buildApiHandler()`를 호출하며 `src/api/index.ts:161`의 provider factory가 adapter를 선택한다. 이는 공유 유틸리티 package에서 별도 agent loop를 만드는 구조와 구분된다.

`Task.initiateTaskLoop()`는 checkpoint 초기화를 시작하고 `abort`까지 `recursivelyMakeClineRequests()`를 반복한다. 요청 함수는 명시적인 stack으로 후속 요청·retry를 관리하고, 사용 도구가 없으면 완료 또는 다음 도구 사용을 요구하는 입력으로 계속된다(Z03). 문맥 조립은 mention/slash-command 처리, 읽은 파일 추적, workspace·terminal·진단 environment details와 system prompt를 포함한다. `Task.ts:3651–3675`의 실제 호출을 확인했다. repository symbol index는 이 문맥 처리와 별도의 서비스다.

요청 경계는 model-info snapshot을 native/MCP 도구 구성에 사용한다. provider별로 현재 mode의 도구를 필터링하며 Gemini에는 전체 선언과 `allowedFunctionNames`를 함께 주는 예외가 있다. 같은 요청 metadata에 Task ID, mode, tools와 AbortSignal을 넣어 `api.createMessage()`의 async stream을 소비한다(Z04). 모든 provider가 같은 reasoning·usage·retry·취소 capability를 구현하거나 실제 모델에서 동등하게 작동한다는 의미는 아니다.

stream의 `tool_call_partial`은 parser scope와 index/ID를 전달해 partial tool block을 갱신하고 중복 call ID를 억제한다(Z05). `presentAssistantMessage()`는 `src/core/assistant-message/presentAssistantMessage.ts:89`의 lock과 `currentStreamingContentIndex`로 block을 순서대로 처리한다. 완성된 block의 mode/model 도구 사용을 `validateToolUse()`로 검증한 뒤 같은 파일 `:919–984`에서 명령·MCP·질문·mode switch·위임·완료 handler로 dispatch한다. **모델에 `parallelToolCalls:true`를 보내는 것과 여러 도구 또는 여러 Task 효과를 실제 병렬 실행하는 것은 별개다.**

편집 도구의 실제 경로도 확인했다. `EditTool.execute():153–215`는 diff를 준비하고 승인 후 diff-view 또는 직접 저장으로 이어지고, `WriteToFileTool`은 쓰기 결과와 진단을 반환한다. `ExecuteCommandTool`은 native terminal 명령과 결과를 도구 응답으로 돌려주는 경로다. `AttemptCompletionTool.execute():52–77`는 같은 turn의 도구 실패를 검사하고, 설정을 켰을 때 미완료 todo로 완료 선언을 막는다. 자동으로 별도의 reviewer/test agent를 실행하는 성공 판정 계약을 확인한 것은 아니다.

## 승인·취소·저장·문맥·checkpoint

승인은 presenter의 `askApproval()`과 `Task.ask()`가 UI 응답 또는 auto-approval 결정을 기다리는 구조다. file/tool/command/MCP별 허용 설정을 지원한다. 명령은 구문 분석을 먼저 하고, DCG를 켠 경우 host storage의 외부 binary를 확보해 exact command와 cwd를 검사한 뒤 판정에 따라 auto-approval 또는 사용자 질문으로 이어진다(Z06). `src/core/auto-approval/index.ts:254–351`에서 명령 자동 승인과 DCG가 모두 켜진 경우 command allow/deny 목록보다 DCG verdict를 우선하고, blanket deny 여부에 따라 거절 또는 보호된 질문으로 분기하는 것을 확인했다. 따라서 README의 위험 명령 차단을 항상 무조건 거절하는 의미로 읽지 않는다. Moodcode는 현재의 deny 우선·exact 승인 규칙을 유지해야 한다.

`abortTask()`와 `dispose()`는 promise를 재사용해 정리를 중복 실행하지 않는다. abort flag를 세운 뒤 HTTP/metadata 대기를 취소하고, message queue·listener·terminal ownership·output artifact·파일 추적기를 정리하며 진행 중 diff를 되돌린다. abort 마지막에는 메시지를 저장한다(Z07). release·revert 오류를 일부 기록하고 계속하는 경로이므로 모든 OS에서 효과 cleanup이 증명되었다고 인증하지 않는다. provider stream cancellation, shell process-tree 종료, arbitrary external effect rollback은 서로 다른 계약이다.

API history와 UI 메시지는 Task별 파일로 저장되고, 재개 시 읽고 tool-result exchange를 정리한다(`Task.ts:1320–1690`, `:2870`의 호출 경로). `TaskHistoryStore`는 상태 전이·cache·per-file 저장을 관리한다. 시작 시 missing child, persistent active child, 이미 completed인 child를 구분해 delegated parent를 조정한다(Z08). `TaskHistoryStore.ts:532–585`의 repair-intent replay는 guard 불일치를 quarantine하고 완료 후 intent를 지운다. 다만 `atomicUpdatePair():1010–1073`는 하나의 memory lock에서 child 파일과 parent 파일을 **순차 저장**한다. 첫 파일 저장 후 두 번째가 실패하는 경로도 명시되어 있어 이를 crash-atomic DB transaction으로 부르지 않는다.

문맥 압축은 profile별 threshold와 응답 token reserve를 계산해 provider summary를 시도하고, 실패·비활성화 시 필요한 경우 sliding-window truncation으로 fallback한다(Z09). `Task.ts:5331–5419`에서 새 history를 저장한 뒤 effective history를 provider 입력으로 투영한다. `src/core/condense/index.ts:451–487`은 summary ID와 `condenseParent` tagging으로 원본 메시지를 보존한다. 이는 rewind를 지원하는 세션 이력 압축이며 프로젝트 간 장기 기억이나 의미 코드 색인과는 다르다. Moodcode에는 이미 원본·summary provenance, active-prefix checkpoint, bounded context와 복구 proof가 있으므로 일반 요약을 신규 후보로 제안하지 않았다.

checkpoint는 `getCheckpointService()`가 Task별 shadow repository를 만들고 Git 가용성·timeout을 처리한다. 서비스는 파일을 stage해 commit하고 복원 시 `git clean`과 hard reset을 수행한다(Z10). 도구 실행·사용자 메시지 경계에서 checkpoint를 잡는 호출이 있다. 이것은 파일 workspace 복원이며 command/MCP의 저장소 밖 효과를 되돌린다는 보장이 아니다. Moodcode의 hash-bound restore preview·journal·충돌 보존을 이 방식으로 대체할 이유는 확보하지 않았다.

## modes·Orchestrator·parent/child와 병렬성

built-in/custom mode는 tool group, edit 범위, 지침, MCP 서버 허용 범위를 결정한다. `effective-tool-policy`는 mode group에서 시작해 model excluded/included tools, indexing readiness, 비활성 도구, MCP 서버별 tool/resource 가용성을 반영한다(Z14). prompt-visible 제한을 실행 시에도 확인하는 경로가 있으며, MCP는 `UseMcpToolTool.execute()`에서 서버·도구 존재와 mode allowlist를 확인한 뒤 승인하고 호출한다(Z15).

보조 소스 `src/core/tools/mcpServerRestriction.ts:16–50`에서 allowlist 미설정은 전체 허용, 빈 배열은 전체 차단이다. provider/mode 조회가 불가능하거나 실패하면 `undefined`로 돌아가 unrestricted로 처리한다. 요청 도구 노출과 effect 실행은 다른 시점에 상태를 조회할 수 있으므로 이 구조 자체를 immutable policy snapshot 또는 모든 실패에서 fail-closed라고 단정하지 않는다. 같은 Task의 request model-info 사용(Z04)과 execution-time mode 재조회는 별도 보장이다.

`NewTaskTool.execute():91–132`는 mode 존재를 검사하고 native tool call ID에서 pending action ID를 만든 뒤 승인된 위임을 수행한다. provider 위임은 parent의 local mode·API profile을 snapshot하고 mode-specific saved profile 정책을 적용한다. parent tool 결과를 저장한 다음 부모를 닫고, child를 멈춘 상태로 만들고, delegation metadata를 저장한 뒤 시작하는 순서다(Z11). 이 경로가 parent/child profile isolation의 실제 근거다. flush·부모 정리 실패를 경고 후 계속하는 경우도 있어 저장 성공을 엄격한 barrier로 보장했다고 표현하지 않았다.

child 완료 시 parent API history에 결과를 저장하고 child instance를 닫은 뒤 상태 쌍을 업데이트한다. parent를 history에서 다시 만들고 history를 주입한 다음, scheduler admission 이후 parent ID·상태·completedByChildId·cancel 및 현재 instance를 다시 검사해 stale continuation을 거른다(Z12). startup reconciliation(Z08), rejected pending-action settlement 및 stale completion skip은 재개 신뢰성을 위한 구현이다. fixture 존재와 이 구현 경로를 실제 crash 실험 결과로 표시하지 않았다.

README는 병렬 조정을 추가 기능으로 소개하지만, `ClineProvider.ts:220`의 `new TaskScheduler()`는 기본 concurrency를 바꾸지 않는다. scheduler 기본은 **1**이고 코드 주석도 미래 fan-out을 위한 gate라고 설명한다(Z13). 위임은 부모를 닫고 child를 유일한 active Task로 여는 흐름이다(Z11). 따라서 이 고정 HEAD에서 여러 child가 동일 provider에서 동시에 실행되는 complete fan-out workflow를 확인했다고 하지 않는다. parser의 병렬 call 격리나 `maxConcurrency=2` 테스트가 있다는 사실은 현재 제품 경로의 동시 child admission 근거가 아니다.

## 코드 색인·embedding·외부 서비스와 CLI

`codebase_search`는 Task의 cwd를 사용해 workspace manager를 구하고 configuration loaded/enabled/configured/initialized를 확인한 뒤 `searchIndex()` 결과의 file path·line range·score·chunk를 반환한다(Z16). 모델 도구 노출도 같은 readiness 조건을 검사한다(Z14). manager는 두 경로를 분리한다(Z17).

- **Semble:** 선택하면 외부 embedder/Qdrant pipeline 대신 `SembleProvider`를 만든다. `provider.ts:80–130`에서 binary 다운로드·설치 확인을 하고, 검색마다 workspace 전체에 `semble search`를 호출한 후 directory prefix를 후처리한다. 결과 경로는 workspace 밖으로 resolve되면 제외한다(Z19). `semble-cli.ts:55–65, 99–162`에서 shell 없이 argv로 spawn하고 검색 timeout 120초와 stdout/stderr 각각 10MiB 상한을 두는 것을 확인했다. `semble-downloader.ts:15–43`은 `Zoo-Code-Org/sembleexec`의 `v0.4.1`, platform mapping, checksum과 archive 상한을 고정한다. 실제 on-demand indexing·embedding 품질·속도·binary 내부 구현과 license는 이 checkout만으로 확인하지 않았다. 오류를 정상 empty로 반환하는 경로(Z19)는 독립 구현 시 분리할 필요가 있다.
- **외부 vector 경로:** `CodeIndexServiceFactory.createServices():52–95`가 embedder, vector store, parser, scanner, watcher를 조립한다. `embedders/embedder-factory.ts:18–49`는 OpenAI/Ollama/OpenAI-compatible/Gemini/Mistral/Vercel AI Gateway/Bedrock/OpenRouter factory를 선택하고 Semble는 제외한다. `search-service.ts:43–58`이 query embedding을 만들고 vector store를 검색한다. Qdrant client는 workspace path hash의 collection을 사용하며(`qdrant-client.ts:80–83`), directory path segment 조건·metadata 제외·score/top-k 제한으로 query한다(Z18). 원격 embedding의 코드 전송, Qdrant namespace 격리, watcher freshness·ignore 완전성은 실행 검증하지 않았다.

CLI는 `apps/cli/src/commands/cli/run.ts:369,533`에서 `ExtensionHost`를 만들고 활성화한다. host는 VS Code shim과 module resolver를 준비한 뒤 실제 `extension.js` bundle을 require하고 extension의 `activate()`를 호출한다(Z20). `extension-client.ts`와 `ask-dispatcher.ts`는 같은 webview 메시지 계약을 연결한다. `@roo-code/core/cli` export는 debug-log/message-utils/task-history 유틸리티이며 Task loop 자체를 export하지 않는다. CLI가 공유 엔진을 재사용하는 실제 경로는 **동일 extension bundle + shim**이다. 설치나 CLI/TUI 실행으로 동작을 검증하지 않았다.

provider API, embedding API, Qdrant, MCP endpoint와 cloud/telemetry는 설정과 기능 선택에 따른 별도 외부 경계다. DCG(`destructive-command-guard/constants.ts`)도 별도 프로젝트의 `v0.7.7` release를 받는다. root Apache-2.0가 별도 binary·model/service·의존성의 license/약관까지 판정하지 않는다.

## Moodcode 추가 계약 후보

Moodcode 비교 기준은 engine source `464812f7d1af24466f57070663131f5979aeca51`와 [기준 문서](moodcode-baseline.md), [구현 상태](../moodcode/implementation-status.md)다. 후보의 source path는 실제 존재를 확인했다. `P1`은 후속 우선 검토, `P2`는 선택적 확장; `M/L`은 중간/큰 구현 비용이다. 정확한 계약과 검증 목록은 [evidence JSON](zoo-code.evidence.json)에 있다.

| 후보 | 기존 Moodcode와 추가 동작 | 우선순위·비용 | 근거 |
|---|---|---|---|
| zoo-code-C1: workspace 의미 코드 검색 | 기존 context·history memory·LSP에 source hash와 index/provider revision을 가진 검색 관측을 더한다. readiness/error/empty·cancel·예산과 current-file stale 판정을 명시한다. | P1 / L | Z14, Z16–Z19 |
| zoo-code-C2: 역할 workflow child barrier | 기존 profiles·worktree child·durable terminal delivery에 stage revision과 awaited child 집합을 더한다. publication 이후 exact admission, cancel/교체 시 stale 재개 차단을 보장한다. 병렬 admission은 별도로 명세한다. | P2 / L | Z08, Z11–Z13 |
| zoo-code-C3: profile MCP server/resource 정책 | 기존 scope·tool allowlist·discovery·승인에 stable server/resource identity allowlist를 더한다. prompt/discovery/resource/execute가 같은 policy snapshot으로 판단한다. | P2 / M | Z04, Z14–Z15 |
| zoo-code-C4: command preflight verdict | 기존 deny·exact approval·process recovery에 command/cwd/analyzer revision에 binding된 typed verdict와 이유를 더한다. allow가 승인을 우회하지 않으며 deny와 unavailable을 구분한다. | P2 / M | Z06–Z07 |

C1은 `context/service.ts`, `semantic-memory.ts`, tool runtime/discovery/ports를 연결하되 기억 요약과 파일 index를 별도 identity로 유지한다. C2는 `agents/index.ts`, `child-tasks/*`, `runner/input-scheduler.ts`, `session-state/index.ts`에 역할 stage를 영구화하며 crash 경계별 중복 publication/실행을 검증해야 한다. C3는 `agents/index.ts`, `mcp/registration.ts`, `mcp/client.ts`, runtime/discovery와 `permission/policy.ts`의 기존 좁혀지는 권한을 보존한다. C4는 `tools/command/index.ts`, `permission/policy.ts`, runtime/plugins/runner의 exact effect binding을 유지해야 한다. 이 경로들은 모두 `packages/engine/src/` 아래다.

## 확인 범위와 검증 결과

원본의 고정 HEAD, 선택한 20개 tracked 파일 범위, JSON 구조·후보 4개·Moodcode 연결 경로·파일 및 범위 SHA-256을 정적 검사했다. 이 검사는 upstream 테스트·benchmark 결과가 아니다. upstream 설치·build·test·모델·계정·GUI·공유 build·commit은 수행하지 않았고, 원본 source/prompt/tool description/fixture를 Moodcode로 복사하거나 runtime dependency로 추가하지 않았다. 읽은 소스를 참고한 명세이므로 clean-room 절차라고 주장하지 않는다.

확인하지 않은 범위는 실제 provider별 동작·OS별 terminal cleanup·GUI·CLI/TUI·원격 embedding/Qdrant·Semble/DCG binary 내부·LFS/submodule·release assets·성능 및 전체 의존성/서비스 audit이다. README의 장시간 자율 실행·최신 모델·신뢰성·병렬 조정 주장은 확인한 개별 소스 동작을 넘어 실측했다고 표현하지 않았다. Moodcode 기존 테스트 통과 기록도 이번 Zoo Code 실행 결과와 분리했다.
