# Kimi Code CLI TypeScript 엔진 분석

분석일: 2026-10-07. 분석 모드는 `static-source-review`다. 이 보고서는 신규 [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)의 TypeScript 엔진을 다루며, 별도 Python `kimi-cli` 분석과 합치지 않는다. 원본을 실행한 결과나 새 Moodcode 기능 구현 결과가 아니다.

| 기준 | 값 |
|---|---|
| 고정 HEAD | `21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3` |
| 원본 checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/kimi-code` |
| 마지막 고정 commit | 2026-09-30 15:23:40 +08:00, completion token cap 기본값 수정 (#4091) |
| package 경계 | `apps/kimi-code` CLI/TUI (2.1.1), `packages/agent-core-v2` DI/상태 머신 엔진 (0.4.3), `node-sdk`·`klient` host façade, `acp-server`·`kap-server` transport, `transcript`·`minidb`·`oauth` 지원 계층 |
| 언어·환경 선언 | TypeScript/ESM, Node ≥24.15.0, pnpm 10.33.0. 실행·지원 OS 실측은 하지 않음 |
| Moodcode 비교 | engine source `464812f7d1af24466f57070663131f5979aeca51`, 문서 기준 `3065fdd03649df393f4170b38a2f049a1e52d2f3` |
| 상세 근거·제안 | [kimi-code.evidence.json](kimi-code.evidence.json), [분석 기준](analysis-protocol.md), [기존 구현 기준](moodcode-baseline.md) |

고정 commit과 다수의 엔진·package 경계에서 수정 흔적을 확인했다. 이는 해당 시점에 개발되는 저장소라는 근거이며, 현재 배포 안정성이나 유지보수 지속성의 보장은 아니다.

## 대표 소스 근거

아래 링크는 모두 위 full SHA에 고정했다. 본문에서는 같은 URL을 반복하지 않고 근거 ID를 인용한다.

| ID | 고정 permalink·줄 | 확인한 내용 |
|---|---|---|
| K01 | [`LICENSE:1–21`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/LICENSE#L1-L21) | root MIT 고지와 Moonshot AI 저작권, 고지 보존 조건. |
| K02 | [`README.md:53–126`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/README.md#L53-L126) | video, MCP, plugin, subagent, lifecycle hook, ACP 주장과 pi-tui UI 기반 acknowledgment; 실행 성능·호환성 실측 근거는 아니다. |
| K03 | [`apps/kimi-code/src/cli/v2/run-v2-print.ts:471–584`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/apps/kimi-code/src/cli/v2/run-v2-print.ts#L471-L584) | native v2 session/main agent 생성, print auto 권한 설정, loop.submit→promptHandle.launched→turn.result 경로. |
| K04 | [`packages/agent-core-v2/src/agent/loop/machine/engine.ts:286–343`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/loop/machine/engine.ts#L286-L343) | MachineRequester와 MachineTools를 journal-backed event store, createTurnMachine/createToolMachine에 결합; credential recovery 포함. |
| K05 | [`packages/agent-core-v2/src/human/agent/turn.ts:572–619`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/human/agent/turn.ts#L572-L619) | model 응답에 toolCalls가 있으면 acting 전환, 빈 응답 오류, 도구 없는 응답의 done 종료. |
| K06 | [`packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts:334–439`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/llmRequester/llmRequesterService.ts#L334-L439) | tool-selected history→context projector→media resolver→requester.request; stream part와 usage 경로 및 media 생략 경고. |
| K07 | [`packages/agent-core-v2/src/llm-adapter/protocol/protocolAdapterRegistry.ts:37–135`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/llm-adapter/protocol/protocolAdapterRegistry.ts#L37-L135) | Kimi file upload contribution 및 OpenAI Chat/Responses, Anthropic, Google GenAI/Vertex adapter route. |
| K08 | [`packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts:617–775`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/fullCompaction/fullCompactionService.ts#L617-L775) | 별도 full_compaction 모델 요청, input-window 사전 축소, bounded retry/overflow shrink, history 안정성 검사 후 summary와 wire recovery pointer 활성화. |
| K09 | [`packages/agent-core-v2/src/agent/profile/context.ts:137–195`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/profile/context.ts#L137-L195) | brand/global .agents 및 project root→cwd 지침을 중복 제거하며 읽음; 32 KiB는 권장 초과 경고이지 hard cap이 아니다. |
| K10 | [`packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts:348–426`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycleService.ts#L348-L426) | session resume 병합과 workspace index binding, session materialization/main agent 복원, close drain 경로. |
| K11 | [`packages/agent-core-v2/src/agent/undo/undoService.ts:107–148`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/undo/undoService.ts#L107-L148) | quiescence와 compaction/restore 상태를 검사한 conversation branch undo, replay, engine reset; 파일 효과 복원 근거가 아니다. |
| K12 | [`packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts:40–85`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/permissionGate/permissionGateService.ts#L40-L85) | 도구 실행 전 policy 평가 후 ask/approve/veto 분기와 approval service 호출. |
| K13 | [`packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:185–287`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts#L185-L287) | runtime lease 아래 Bash spawn, bounded output accumulator, foreground/background task 등록, timeout 또는 사용자 detach 후 background 결과 반환. |
| K14 | [`packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts:112–168`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts#L112-L168) | POSIX process group signal, Windows taskkill /T /F 및 5초 대기, EPERM fallback; crash 후 효과 소멸 인증은 별도 미확인. |
| K15 | [`packages/agent-core-v2/src/session/subagent/subagentService.ts:148–206`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/session/subagent/subagentService.ts#L148-L206) | profile/model binding으로 subagent 생성, caller runtime 사용, permission mode와 user tools 상속; experimental fork와 일반 생성 분기. |
| K16 | [`packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts:160–272`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts#L160-L272) | PreToolUse veto/PostToolUse, PermissionRequest/Result, prompt block, turn notifications, Stop continuation 및 compaction hooks. |
| K17 | [`packages/agent-core-v2/src/app/plugin/pluginService.ts:216–251`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/app/plugin/pluginService.ts#L216-L251) | plugin agent roots/session-start/system prompts/MCP servers/hooks를 engine 소비 경계로 제공. |
| K18 | [`packages/agent-core-v2/src/mcpCore/connection-manager.ts:430–505`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/mcpCore/connection-manager.ts#L430-L505) | MCP stdio runtime binding과 HTTP/SSE/OAuth/timeout 경계, connect→listTools→schema 검증. |
| K19 | [`packages/agent-core-v2/src/agent/media/mediaResolverService.ts:398–498`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/agent-core-v2/src/agent/media/mediaResolverService.ts#L398-L498) | video capability gate, provider/protocol/endpoint/account 별 cache key, persisted uploaded file ID, MIME sniff와 upload/inline/path fallback. |
| K20 | [`packages/acp-server/src/start.ts:135–183`](https://github.com/MoonshotAI/kimi-code/blob/21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3/packages/acp-server/src/start.ts#L135-L183) | ACP client connection 및 runtime provider 등록, session 별 runtime binding/해제, session media originals 경로. |

## 실제 진입·모델·도구·종료 경로

`apps/kimi-code/src/main.ts:61`의 `handleMainCommand`는 options 검증·update preflight 이후 print 또는 shell host로 분기한다. `cli/run-prompt.ts:40`의 `runPrompt`는 `runV2Print`를 직접 import한다. 그 함수는 `agent-core-v2.bootstrap`으로 app scope를 만든 뒤 session/main agent를 얻는다. 새 print session에는 `auto` permission mode를 설정한다. 이것을 모든 host의 고정 기본 권한이라고 일반화하지 않는다. 실행은 `IAgentLoopService.submit` → prompt handle launch → `turn.result`로 이어진다. [K03]

TUI는 `runShell` → SDK `createKimiHarness` → `SDKRpcClientV2` → v2 bootstrap을 사용한다. `packages/node-sdk/src/sdk-rpc-client-v2.ts:2800`은 harness factory가 V2 client를 실제 생성함을 보여준다. SDK에 남은 v1 설명과 `packages/migration-legacy`는 호환·이전 자료 경계다. 별도 Python 저장소를 TypeScript 엔진의 runtime으로 보지 않는다.

`AgentLoopService.engineOptions`는 context, LLM requester, tool executor/registry, retry 상한, wire journal, gate, steer signal, event projection을 상태 머신에 넘긴다. `machineEngineAttachBundle`은 journal-backed event store와 `human/agent/turn.createTurnMachine`, `human/tool/machine.createToolMachine`을 결합한다. requester는 실제 agent LLM service에 위임하고 credential recovery도 연결한다. [K04]

모델 한 step은 선택한 tools/history를 projector로 정리하고 media reference를 resolve한 뒤 `ModelRequester.request`에서 part·usage·finish를 받는다. 도구 ID normalizer와 request trace가 별도로 있다. 응답에 toolCalls가 있으면 turn machine은 `acting`으로 이동하고, 빈 응답 오류를 구별하며, 도구 없는 답변은 `done`으로 종료한다. `human/agent/turn.ts:731` 이후는 tool 결과를 모아 draining 상태로 연결한다. ToolExecutor는 execution resolution → before-execute veto/approval → execution scheduling → result normalization/후속 hooks로 진행한다. 파일 접근 충돌 scheduling이 모든 OS 부작용의 isolation을 보장하는 것은 아니다. [K05, K06, K12]

README는 `pi-tui` 위에 TUI를 만들었다고 명시한다. 실제 import도 `apps/kimi-code/src/tui/components/editor/custom-editor.ts`, `media/image-thumbnail.ts`, migration screen 등에 집중되어 있으며 `agent-core-v2`와 `node-sdk` 소스에서 pi-tui engine import는 발견하지 않았다. v2 engine manifest는 xstate, provider SDK, MCP, minidb 등을 의존한다. 이 근거는 **pi의 agent engine 재사용**이라는 결론을 지지하지 않는다. [K02, K04]

## 문맥·지침·기억·복구

- **문맥 선택과 요약:** tool-selected history와 projection 후 모델 요청을 만든다. full compaction은 별도 `full_compaction` 요청을 보내며, 출력 token cap과 입력 window에 맞춰 사전 축소한다. overflow에는 오래된 이력을 추가 축소하고 제한된 횟수로 재요청한다. 요약 도중 이력이 바뀌면 적용을 취소하고, 안전성 확인 후 summary와 wire-line recovery pointer를 적용한다. 요약에 사용하지 못한 메시지 수를 기록한다. [K06, K08]
- **지침:** brand home, `~/.agents`, Git project root에서 cwd까지의 `.kimi-code/AGENTS.md`와 대소문자 AGENTS 파일을 순서대로 읽고 경로 중복을 제거한다. 32 KiB는 초과 경고 기준이며 hard byte bound라고 해석하면 안 된다. `workspaceInstructionsService`에는 재읽기/watch 경로가 있다. [K09]
- **기억 범위:** durable conversation과 요약, agent profile, 로컬 skill/plugin 지침을 재사용한다. 이번 조사에서 cross-project 자동 학습 기억이나 의미 저장소 색인의 완전한 구현 계약을 확보하지 못했다. `contextMemory`라는 이름만으로 embedding 기반 semantic memory라고 판단하지 않는다.
- **저장·재개:** wire/event journal과 replayable state, session index·append log·blob/query store가 분리되어 있다. session resume은 동시 호출을 합치고 workspace index를 검사한 다음 session과 main agent를 materialize한다. 종료에는 agent/log/metadata/index drain이 있다. `loopService.ts:234`의 restore hook은 journal을 다시 fold하고 queue waiter를 재구축한다. [K04, K10]
- **중단된 task:** `taskService.ts:259`의 replay 후 disk/wire reconciliation과 `:931`의 loaded nonterminal task→`lost` 전환을 읽었다. 과거 task 기록 유지와 실제 process 연결 복구는 별개다. source-level 경로가 존재해도 SIGKILL 및 효과 중복 방지 실험을 통과했다고 쓰지 않는다.
- **undo/checkpoint:** 확인한 `AgentConversationUndoService`는 quiescence·compaction·restore 상태를 확인하고 wire branch를 전환한 뒤 replay/engine reset과 참여자 reconciliation을 한다. 이는 대화 분기 undo다. 선택한 소스에서는 Moodcode처럼 파일 hash와 journal에 binding된 파일 효과 restore 계약을 확인하지 못했으며, 제품 전체의 부재를 단정하지 않는다. [K11]

Moodcode에는 이미 bounded context·semantic memory·지침 cache·tools 없는 summary와 복구 proof·active-prefix checkpoint·history paging이 있다. Kimi의 요약 호출이나 session resume을 새 기능 누락으로 표시하지 않는다. 참고할 부분은 별도 요약 요청의 실패 유형·dropped-history 표시·원본 이력 위치를 함께 전달하는 계약이다. 관련 경로는 `packages/engine/src/context/service.ts`, `semantic-memory.ts`, `summary-stream.ts`, `runner/input-scheduler.ts`다.

## 편집·명령·승인·취소

`tools/edit/editTool.ts`는 경로 접근을 해결하고 replacement 정보를 preview로 제공한 뒤 runtime generation을 재확인하고 editor service에 넘긴다. `tools/os/write/writeTool.ts`는 같은 runtime guard 아래 append/overwrite를 실행한다. 이 두 tool에서 확인한 path-based permission rule은 Moodcode의 exact prepared fingerprint·expected hash·effect receipt와 같은 계약으로 간주하지 않는다. 코드 검색·웹 검색·FetchURL·Bash 결과를 후속 모델 step에서 검증 재료로 사용할 수 있지만, 도구 존재만으로 성공 검증을 강제한다고 판단하지 않는다.

권한 gate는 실행 전 policy 평가를 수행하고 ask이면 approval service, approve이면 execution metadata, deny이면 veto로 전달한다. `permissionPolicy/policies`에는 user deny/ask/allow, mode, 민감한 경로·명령 등의 정책이 나뉜다. 취소는 loop의 prompt ID/turn ID를 구분하며 active controller와 machine abort를 연결한다(`loopService.ts:727`, `:826`). 실제 취소 신호와 승인을 확인했지만, 제품별 trust/auto/yolo 설정이나 모든 policy의 안전성은 이번 비교의 인증 범위가 아니다. [K12]

Bash는 runtime lease를 가진 process를 task로 등록하고 output accumulator와 큰 출력 persistence를 연결한다. foreground 실행은 사용자의 detach 또는 설정된 timeout에서 background로 전환할 수 있다. background 도구 집합이 없으면 이 경로를 제한한다. task와 command의 timeout/cancel 의미가 서로 연결되어 있으므로 단순히 timeout=kill로 설명하면 틀리다. [K13]

Node process backend는 POSIX에서 음수 PID로 process group signal을 보내고, Windows에서는 `taskkill /T /F`를 호출한다. EPERM 처리에는 직접 child kill fallback이 있다. 이 소스는 process-tree 정리 시도를 증명하며, engine crash 뒤 모든 effects가 사라졌다는 durable 인증을 증명하지 않는다. Moodcode의 별도 supervisor·effect marker·unknown cleanup 격리·restore lease를 유지해야 한다. [K14]

## 하위 에이전트와 확장 경계

기본 profile 등록(`session/agentLifecycle/profile/profiles.ts:46`)에는 coder의 Write/Edit/Bash, explore의 Read/Grep/Glob/**Bash**, main의 subagent allowlist가 있다. explore의 읽기 전용 설명은 prompt enforced라고 명시되어 있으므로 shell이 없는 policy sandbox로 설명하지 않는다. `features/plan/profile/plan.ts:8`의 plan 목록은 shell·edit/write를 제외한다. 모델/도구/지침 profile 분리와 권한 강제 수준을 구분해야 한다.

`SubagentService.spawn`은 profile/model/thinking을 선택해 독립 agent scope를 생성하고 caller runtime을 연결하며 permission mode와 user tools를 상속한다. 일반 생성과 experimental fork가 분기된다. `AgentLifecycleService.fork:409`는 부모 context snapshot을 복사하며 열린 tool exchange를 닫는다. “isolated contexts”는 이 문맥 분리를 지지하고 **별도 worktree filesystem 격리**를 증명하지 않는다. 같은 child 재개, background task, 결과 handoff 경로가 있으며 `runAgentTurn.ts:34`는 child loop와 cancel을 연결하고 최종 assistant summary가 없으면 오류를 낸다. [K15]

Moodcode의 profiles·read-only delegate_task·host write child·실제 worktree와 별도 DB·budget/deny/cancel 상속·root terminal 결과 중복 제거는 이미 구현되어 있다. 추가할 여지가 있는 부분은 기존 owner binding을 보존하는 같은 child의 승인된 다음 turn과 역할별 handoff다. upstream의 같은 runtime 접근을 그대로 도입하는 제안이 아니다.

외부 lifecycle hooks는 PreToolUse veto, prompt submit block, post-tool/permission/turn 관측, Stop continuation, pre/post compaction에 실제 등록된다. local command runner에는 shell spawn·timeout·cancel·kill escalation 경로가 있다. 소스의 hook 지원은 shell command를 무조건 신뢰해도 된다는 근거가 아니다. Moodcode의 현재 plugin hooks는 prepared/settled metadata 관측이므로 새 lifecycle surface와 효과를 만드는 hook은 별도 계약으로 설계한다. [K16]

Plugin service는 agent roots, session-start/system prompt, MCP server, hook contribution을 제공하며 설치/reload와 소비를 분리한다. MCP는 stdio에 runtime identity를 요구하고 HTTP/SSE에 timeout/OAuth 경계를 갖는다. connect/listTools/schema 확인 후 registry에 연결한다. `mcpCore/client-stdio.ts:116`, `client-http.ts:108`에서 tool call에 signal/timeout을 전달하는 것을 읽었다. workspace-trust로 project MCP가 제외될 수 있다(K03). Marketplace 신뢰 표시와 전체 supply-chain 검증은 다르다. Moodcode에는 이미 scoped host plugin·MCP stdio/HTTP·resource·catalog·typed execution receipt/recovery가 있다. [K17, K18]

ACP는 stdio client connection을 바인딩하고 session마다 ACP runtime을 등록/전환/해제한다. 파일 IO 일부를 client에 위임하는 runtime 경계와 기존 engine session을 연결한다. `acp-server/src/session.ts:641`은 agent prompt를 구동하고 `:980`은 cancel을 전달한다. 이는 실제 editor 설치·모든 client capability 호환 실측이 아니다. Moodcode engine/host 분리는 재사용할 수 있지만 ACP adapter는 별도 host 구현 범위다. [K20]

Swarm/Tower/goal/cron 관련 feature 등록과 도구도 저장소에 있지만 이번 보고서는 이 실험·고급 기능의 모든 gate, 분산 runtime, 장기 실행 readiness를 추적하지 않았다. 특히 fork는 experimental flag 조건을 갖는다.

## 미디어·공급자·외부 서비스

모델 protocol registry는 OpenAI Chat/Responses, Anthropic, Google GenAI/Vertex를 분기한다. Kimi OAuth catalog 모델에는 별도 Kimi file-upload contribution을 붙인다. 실제 provider 계정 권한과 모든 모델 capability의 일치는 실행하지 않았다. [K07]

video는 daemon/session reference를 model capability로 gate하고, upload cache를 file ID/provider/protocol/endpoint/account로 구분하며 persisted remote file ID를 사용한다. MIME sniff 후 Kimi upload, protocol에 따른 inline fallback, 또는 저장 경로 tag로 반환한다. upload auth 오류는 숨기지 않고 전달한다. 별도로 `mediaResolverService.ts:172`는 inline image/video 요청 budget 20 MiB를 넘으면 오래된 항목부터 10 MiB까지 줄이고 omission warning을 기록한다. 이 byte 정책이 remote-file video의 token 또는 시간/frame budget까지 인증하는 것은 아니다. [K06, K19]

Moodcode에는 이미 session-owned image 입력과 bounded PDF import/Responses, image/document history anchor, token unknown opt-in, archive/recovery 검증이 있다. video/audio 입력·media 출력과 실제 원격 PDF 인식은 열린 범위다. 따라서 후보는 “media 지원 추가”가 아니라 **video 전용 입력·upload/cache·예산 계약**이다. 이번 Kimi 조사도 image/video 입력 경로를 확인했으며 PDF/audio 입력이나 media 생성 전체의 지원 여부는 단정하지 않는다.

외부 경계는 provider API/OAuth/catalog·Kimi media upload, remote MCP/OAuth, plugin marketplace/GitHub 다운로드, telemetry다. root 소스 license와 원격 서비스 이용 조건·모델 접근 권한·업로드 보관/삭제 조건은 별개이며 이번에 연결하거나 검증하지 않았다.

## Moodcode 독립 구현 후보

우선순위는 후속 검토 순서이며 이 분석에서 구현 승인을 받거나 구현한 항목이 아니다. 비용 M/L은 기존 계약 확장 대비 상대 규모다. JSON에 같은 후보의 실제 Moodcode 경로·contract·validation을 기록했다.

| 후보 | 우선순위·비용 | 이미 있는 것 | 추가 계약·통과 조건 |
|---|---|---|---|
| kimi-code-C1: lifecycle hook | P1 · M | host plugin, prepared/settled metadata hook, exact approval | prompt/turn/summary metadata 및 제한된 pre-effect veto. 승인 fingerprint 불변, bounded timeout/cancel, post-effect 실패에서 재실행 없음. [K12, K16, K17] |
| kimi-code-C2: command background 전환 | P2 · L | command supervisor, PTY, tasks, queue/steer, recovery marker | opt-in/user detach로 같은 소유 process를 task로 전환. 새 spawn·추가 효과 없음, root cancel/예산·workspace lease 유지, completion 중복 제거 및 orphan uncertainty. [K03, K13, K14] |
| kimi-code-C3: 역할별 child 재개 | P2 · L | profiles, worktree child, 읽기 전용 delegation, 예산/취소 상속, terminal delivery | 새 parent Run의 승인·reservation으로 기존 child owner/session을 재사용. 실제 read-only 정책, bounded 구조 handoff, lost 효과 자동 redo 금지. [K10, K15] |
| kimi-code-C4: video 입력 | P3 · L | bounded image/PDF, history anchors, token 정책, archive | 별도 video ingest limits·capability·upload receipt/expiry·account별 cache. oversize/위장/타세션 입력 사전 차단, cancel/timeout/계정 전환/복구 후 cache 검증. [K06, K07, K19] |

C1 관련 경로는 `packages/engine/src/plugins/index.ts`, `runner/index.ts`, `runner/turn-executor.ts`, `permission/index.ts`, `context/summary-stream.ts`다. C2는 `tools/command/{index,supervisor,execution-lock}.ts`, `terminals/index.ts`, `runner/input-scheduler.ts`, `session-state/index.ts`다. C3는 `agents/index.ts`, `child-tasks/{delegation,engine-host,index,storage-binding}.ts`다. C4는 `media/{store,validation,provider}.ts`, `documents/provider.ts`, `context/media-history.ts`, `ports.ts`다. 각 경로의 존재와 관련 구현을 읽고 비교했다.

## 라이선스·확인 한계

root `LICENSE`는 MIT, Copyright 2026 Moonshot AI다. 별도 tracked 고지는 `packages/pi-tui/LICENSE`의 MIT·2025 Mario Zechner와 `apps/vscode/LICENSE`의 Apache-2.0이다. root MIT를 이 하위 고지의 대체로 쓰지 않는다. 배포 전이 의존성/native artifact/미디어 전체 audit 또는 법률 검토는 수행하지 않았다. [K01]

분석 산출물은 이 보고서와 evidence JSON뿐이다. 원본 source·prompt·tool description·fixture·미디어를 Moodcode로 복사하지 않았고 runtime 의존성을 추가하지 않았다. 원본을 읽었으므로 clean-room 절차라고 표현하지 않는다. 원본 checkout·HEAD를 변경하지 않았다.

근거 파일·줄 범위·고정 commit 소속·SHA-256 확인은 **정적 증거 검사**다. 설치·테스트·build·upstream runtime·GUI·모델/계정·성능 benchmark는 실행하지 않았다. Moodcode의 기존 pass 기록은 [구현 상태](../moodcode/implementation-status.md)의 이전 검증이며 Kimi 실행 결과로 대체하지 않는다.
