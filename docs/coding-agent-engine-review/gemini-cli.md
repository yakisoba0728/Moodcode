# Gemini CLI 엔진 정적 소스 분석

분석일: 2026-10-07. 원본은 [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli), full HEAD는 `ef59c532f07fbb3a58dd68bac024ae217e9c73ce`, checkout은 `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/gemini-cli`다. 분석 모드는 `static-source-review`다.

Moodcode 비교 기준은 문서 HEAD `3065fdd03649df393f4170b38a2f049a1e52d2f3`, engine source `464812f7d1af24466f57070663131f5979aeca51`다. [분석 기준](./analysis-protocol.md), [기존 구현 상태](../moodcode/implementation-status.md), [독립 구현 기준](../opencode-engine-review/05-license-and-provenance.md)을 확인했다. upstream 설치·실행·테스트·계정 연결은 하지 않았다.

핵심 구조는 **GeminiClient → Turn → GeminiChat → ContentGenerator의 모델 스트림**과 **별도 Scheduler의 도구 lifecycle**이다. 참고 가치가 큰 차이는 세션 간 기억 후보 검토, 개별 큰 도구 결과 요약, 모델 경계 hook, 실제 OS 격리 capability의 추가 계약이다. Moodcode의 요약·승인·MCP·child·plugin tool hook은 기존 구현으로 인정한다.

## 저장소·package·유지보수 경계

TypeScript ESM monorepo이며 package manifest는 Node ≥20을 선언한다. `packages/cli`는 executable·설정·인증·Ink/React TUI·headless 출력·ACP 경계를, `packages/core`는 chat/model·scheduler·도구·정책·context·기억·subagent·MCP를 소유한다. A2A server, VS Code IDE companion, devtools, test-utils 등도 별도 package다.

로컬 HEAD는 `0.65.0-nightly.20261006.gfb972b2f8` release bump이고 commit 시간은 2026-10-06T22:11:30Z다. 직전 두 commit도 같은 날의 CLI 화면 수정과 OAuth callback validation 수정이다. 이는 해당 시점의 최근 유지보수 정황이며 미래 지원·stable 품질 보증은 아니다. core manifest의 GenAI/MCP/A2A/PTY/Chrome/telemetry dependency는 외부 실행 경계를 보여 준다.

## 실제 entry·모델·도구·완료 경로

1. `packages/cli/index.ts::run`은 가벼운 parent에서 child를 relaunch하거나 heavy child에서 `gemini.tsx::main`을 import한다. `main`은 interactive 분기와 초기화 뒤 headless에서 auth validation·refresh를 하고 `runNonInteractive`를 호출한다. 종료 때 cleanup 후 exit한다(G01).
2. `runNonInteractive`는 최초 user input 또는 이후 functionResponse를 `GeminiClient.sendMessageStream`에 보낸다. turn 제한과 AbortSignal을 검사하고 text/thought/functionCall/error 이벤트를 소비한다. tool request가 있으면 `Scheduler.schedule`로 넘긴다(G02). completed tool metadata를 기록한 다음 response parts를 다음 user-role 메시지로 전달한다. tool request가 없으면 success/error 최종 result를 내고 return한다.
3. `GeminiClient.processTurn`은 context manager 또는 legacy compression을 선택한다(G03). 그 뒤 token overflow, IDE context, model routing·loop detection을 관리한다. functionCall 뒤 아직 functionResponse가 오기 전에는 IDE context를 끼우지 않는다. 이 제한은 완전 tool exchange를 보존하기 위한 구현이다.
4. `Turn.run`은 `GeminiChat.sendMessageStream`을 소비해 text/functionCall/citation/finishReason/usage를 typed 이벤트로 바꾼다(G04). 따라서 provider `Finished`는 한 응답의 끝이며 CLI 전체 도구 loop의 완료와 구분된다. `GeminiChat`은 이전 send Promise를 기다려 chat send를 직렬화하고 새 user input 전에 미응답 tool-response turn을 닫는다. 최종 request를 generator에 전달한다(G05).
5. interactive도 `useGeminiStream`과 `useToolScheduler`를 통해 core 모델 스트림·Scheduler를 사용하지만, checkpoint 저장·UI 상태 투영은 TUI 쪽 계약이다. 모든 ACP/A2A/headless 경로의 기능 동등성을 이번 조사로 확정하지 않는다.

[heavy child entry](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/cli/index.ts#L143-L166), [headless 다음 turn·최종 완료](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/cli/src/nonInteractiveCli.ts#L589-L629), [overflow·tool exchange](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/core/client.ts#L710-L748), [TUI Scheduler](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/cli/src/ui/hooks/useToolScheduler.ts#L105-L116).

## 도구·승인·취소·편집·검증

Scheduler는 validating → approval → scheduled → executing → terminal 상태를 관리한다. BeforeTool이 입력을 바꾸면 request args와 invocation을 다시 구성한 뒤 policy 및 tainted/build-file 위험을 검사한다(G06). 해당 위험은 allow여도 interactive ask/headless deny로 강화할 수 있다. 승인 결과는 correlation ID가 일치하는 MessageBus 응답에서 받으며 scope 정책을 갱신한다. 거절은 해당 호출과 queued batch를 취소한다(G07). headless에서 confirmation이 필요한 정책은 오류로 처리한다.

연속된 parallelizable 호출은 validation을 같이 거치고 모두 ready일 때 실행한다. edit/topic update 등은 직렬 예외이고 `wait_for_previous`를 반영한다. `cancelAll`은 active/queued state를 취소하며 executor는 invocation에 signal을 전달한다. 이는 상태 lifecycle의 근거이며 모든 subprocess·remote 효과의 종료를 실증한 결과는 아니다.

파일 edit는 exact → flexible → regex → fuzzy 대체 전략을 구현하며 이 HEAD의 fuzzy recovery flag는 true다. 실제 적용은 path lock 안에서 현재 내용으로 재계산한 뒤 filesystem service에 쓰고 line ending·diff를 처리한다. Moodcode의 expected hash/exact-edit와 같은 계약이 아니다. fuzzy 자동 편집을 새 후보로 삼지 않았다.

shell은 PTY를 시도하고 사용할 수 없으면 child_process를 사용한다. program/args/env/cwd는 sandbox manager가 준비한다. 도구로 테스트 명령을 실행할 수 있는 경로와 모든 편집 후 테스트 성공을 강제하는 엔진 invariant는 다르다. 이번 조사에서는 후자를 확인했다고 주장하지 않는다.

[batch ready barrier](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/scheduler/scheduler.ts#L488-L542), [parallel 예외](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/scheduler/scheduler.ts#L574-L593), [cancelAll](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/scheduler/scheduler.ts#L278-L303), [대체 전략](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/tools/edit.ts#L303-L347), [path lock·현재 파일 적용](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/tools/edit.ts#L932-L998), [PTY/fallback](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/services/shellExecutionService.ts#L454-L487).

## context·지침·기억·검색

legacy 압축은 기본 모델 token limit의 0.5 임계값에서 시작하고 최근 suffix를 보존한다. `findCompressSplitPoint`는 일반 user message 경계 또는 pending tool call이 없는 model 응답 끝을 사용한다. 요약을 생성·검증한 후 새 token count가 오히려 커지거나 요약이 비면 활성화하지 않는다(G09). 이전 요약 실패 뒤 truncation만 사용하는 fallback도 있다. 모델별 token metadata·추정과 의미 보존을 실측한 품질 평가는 수행하지 않았다.

추가 Context Management 경로는 durable history를 node graph에 동기화하고 pending request를 별도 preview로 처리한 뒤 pipeline barrier·관리 trigger·최종 render를 수행한다. distillation/masking/truncation/rolling summary processor를 등록한다. core config의 enabled 기본값은 false다. 따라서 G03의 분기를 모든 실행의 기본 동작으로 표현하지 않는다.

개별 tool output distillation은 큰 원본을 temp 파일에 보존하고 구조적 축약을 한다. 설정된 요약 threshold 이상이면서 최대 1,000,000 characters 이내면 보조 모델 호출로 요약을 시도한다(G08). `read_file`/`read_many_files`는 이 distillation의 예외이며 보조 모델 요청에는 15초 timeout이 있다. legacy의 shell output offload, 도구 출력 요약, 과거 대화 압축은 서로 다른 기능이다.

지침은 global·extension·project·user-project memory로 분류한다. project discovery는 trusted folder에 제한되고, 접근 경로의 JIT context는 trusted roots 아래에서 파일 identity를 추적하며 중복을 막는다(G10). system memory는 chat 시작 시 system instruction에 들어간다. 이 기능과 tool로 수행하는 파일/코드 검색을 구분한다. 전체 vector/semantic retrieval 시스템을 이 근거로 확인했다고 주장하지 않는다.

experimental auto-memory도 기본 false다. TUI startup의 activation gate가 켜져야 background service를 시작한다. service는 lock·throttle·세션 version state를 사용하고 local extraction agent가 실제 읽은 세션을 추적한다. memory inbox 패치는 검증 후 자동 적용하지 않는 review 후보로 남긴다(G11). service는 새 skill 생성과 기존 skill update patch도 구분하므로 모든 생성물이 동일한 승인 경로라고 단정하지 않는다.

[안전한 압축 split](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/context/chatCompressionService.ts#L282-L321), [ContextManager.renderHistory](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/context/contextManager.ts#L90-L169), [auto-memory/context 기본값](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/config/config.ts#L1200-L1219), [auto-memory activation gate](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/cli/src/utils/autoMemory.ts#L13-L21).

## 저장·resume·checkpoint·복구

`ChatRecordingService`는 user/model/tool/usage 등을 JSONL append로 저장한다(G12). resume 때 legacy JSON을 JSONL로 옮기는 경로, `$patch` 및 `$rewindTo` 기록이 있고, unreadable 파일은 보존하고 temp + rename으로 다시 쓴다. ENOSPC면 저장 경로를 해제하고 대화를 계속할 수 있는 경고 경로가 있다. 이러한 소스의 존재를 fsync/SQLite transaction 또는 crash recovery 인증으로 해석하지 않는다.

checkpoint는 TUI에서 checkpointing이 켜지고 edit tool이 awaiting approval 상태일 때 생성된다. shadow Git commit, UI/model history, 원래 tool request를 저장한다(G13). `performRestore`는 history load action을 내고 snapshot에서 프로젝트 파일을 복원한다. shadow Git restore는 snapshot 후 untracked 파일을 clean할 수 있다. conversation resume, checkpoint 되돌리기, 취소된 외부 효과 회복을 같은 기능으로 취급하지 않는다.

Moodcode의 current hash/preview fingerprint, maintenance lease, durable restore audit와 uncertainty 차단은 기존 계약으로 보존해야 한다. Gemini CLI의 snapshot 복원을 이 안전 계약의 대체품으로 삼지 않았다.

[unreadable 보존·atomic rewrite](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/services/chatRecordingService.ts#L965-L1017), [TUI checkpoint 조건](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/cli/src/ui/hooks/useGeminiStream.ts#L2221-L2259), [performRestore](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/commands/restore.ts#L11-L55), [shadow Git snapshot·restore](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/services/gitService.ts#L198-L234).

## subagent·MCP·extension·hook·provider·sandbox 경계

| 경계 | 소스로 확인한 동작 | 해석·한계 |
|---|---|---|
| Local agent | 정의별 registry와 model loop, turns/time/abort 상한, mandatory complete_task로 GOAL 종료(G15) | tool subset 미지정이면 parent available tools가 기본이다. registry 격리를 Moodcode의 별도 Git worktree·DB child 격리와 같다고 보지 않는다. |
| Remote agent | A2A client manager·auth provider·confirmation을 가진 별도 invocation | 전송·계정·remote side effect 및 전체 resume/cancel을 실제 실행하지 않았다. |
| MCP | stdio/SSE/streamable HTTP SDK transport·OAuth 및 tool/prompt/resource registries. tool 호출과 signal을 경합시킨다(G14) | G14는 로컬 wait 중단과 listener 정리 근거다. remote 효과 취소·receipt·cleanup 증명이 아니다. Moodcode DB9 논리 RPC/dispatch/outcome/native owner/receipt와 uncertainty 차단은 이미 있다. |
| Extension·skill | context files/MCP/excluded tools/hooks/skills/agents/policy/checker를 extension 묶음으로 활성화. skill은 builtin→extension→user→trusted workspace 우선순위(G16) | 설치·환경 변수·신뢰 surface가 Moodcode의 explicit host factory 및 bounded local reference와 다르다. |
| Hook | Session/Agent/Model/Tool/ToolSelection/PreCompress lifecycle. request/tools/input 변경 및 stop/block 경로(G05/G06), subprocess timeout(G17) | project hook trust gate가 있다. 모든 descendant 종료 증명은 확인하지 않았다. Moodcode의 metadata-only prepared/settled hooks도 이미 있다. |
| Provider | Code Assist OAuth/ADC 경로 및 GoogleGenAI Gemini/Vertex/gateway 모델을 logging/model mapping wrapper로 감싼다(G18) | Google backend·quota·feature flags·OAuth/API key·base URL은 local 공개 코드 밖 운영 경계다. 모든 타사 provider adapter 동등성 근거는 아니다. |
| Sandbox | enabled면 OS별 manager, disabled면 Noop(G19). macOS sandbox-exec, Linux bwrap/seccomp, Windows native helper preparation | 실제 OS 보장과 도구 승인은 다르다. 필요한 helper/OS 구성과 격리 효과를 이번에 실행하지 않았다. |
| Sandbox expansion | denial을 additional filesystem/network permission 승인으로 변환하고 invocation/args를 다시 상태에 반영(G20), 승인 후 실행 재시도 | 이미 일부 효과 후 denial이면 재실행이 안전하다고 단정할 수 없다. Moodcode 후보는 tool-effect recovery와 결합해야 한다. |

[agent tool registry](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/agents/local-executor.ts#L250-L282), [agent 공통 Scheduler](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/agents/agent-scheduler.ts#L67-L91), [remote auth·confirmation](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/agents/remote-invocation.ts#L92-L127), [MCP discovery](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/tools/mcp-client.ts#L232-L275), [extension surface](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/cli/src/config/extension-manager.ts#L971-L992), [sandbox 확장 후 재실행](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/scheduler/scheduler.ts#L952-L966).

## Moodcode 기존 기능과 독립 구현 후보

실제 비교한 Moodcode 소스는 `context/semantic-memory.ts`의 tools 없는 summary lifecycle 및 원자 활성화, `context/sources.ts`의 nested instruction baseline, `artifacts/result.ts`의 display/model/data budgets, `tools/session/skills.ts`의 bounded reference 읽기, `plugins/index.ts`의 host factory·metadata-only hook, `child-tasks/engine-host.ts`의 실제 child, command backend 및 permission policy다. 특히 backend는 `isolation: host-user`, `fileIsolation: false`, `networkIsolation: false`를 명시한다.

[기존 semantic memory](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/semantic-memory.ts:16), [기존 plugin hooks](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/plugins/index.ts:58), [현재 command capability](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/command/backends.ts:4). 새 engine surface의 GUI 노출은 engine 기능 추가와 별도다.

비용 M/L/XL은 상대 구현 범위 추정이며 실행·측정 결과가 아니다. 모든 후보의 실제 Moodcode 경로, 추가 계약, 검증 조건은 [evidence JSON](./gemini-cli.evidence.json)에 있다.

| 후보·근거 | 우선순위·비용 | 기존 기능 위의 추가 계약 | 검증 조건 |
|---|---|---|---|
| gemini-memory-inbox · G11/G12/G15/G16 | P1·L | 기존 세션 summary·documents·skill 읽기 위에 세션 간 candidate inbox. 완료 세션 source ID/hash, workspace 경계, tools 없는 bounded 추출. 생성과 활성화를 분리하고 exact revision 승인으로 승격. | 타 workspace/archived 제외, stale 수락 거절, 후보 생성만으로 지침 변화 없음, duplicate/crash 수락 방지. |
| gemini-artifact-distillation · G08/G09/G03 | P1·M | 기존 artifacts·model projection·read_artifact 위에 개별 큰 결과 summary. immutable 원본/hash/toolCall/attempt 결합, 별도 usage/cleanup lifecycle, complete 응답만 원자 적용. | exit/outcome 원본 보존, tools 없는 summary, overflow/cancel/crash fallback, producer 재실행 금지. |
| gemini-model-lifecycle-hooks · G05/G06/G07/G17 | P2·M | 기존 metadata tool hook 위에 host-only model/session/summary observation·veto. frozen request digest와 retry snapshot, bounded metadata, credential 배제, terminal callback 금지. | hook 변경/해제 중 dispatch, veto/timeout/abort/retry, mutation 격리. 입력/schema를 바꿀 경우 새 reservation/fingerprint/승인. |
| gemini-os-sandbox · G19/G20/G07 | P2·XL | 기존 grants·POSIX cleanup 위에 실제 filesystem/network enforcement. OS 한 개 explicit factory부터 capability·policy revision·deny/child 상한. partial-effect denial 자동 재실행 금지. | 지원 OS 실제 접근/네트워크 격리, stale/revoke/child 상한, denial/cancel/crash recovery 증거. |

단순히 코드를 찾지 못했다는 이유로 제품 전체에서 해당 기능이 없다고 단정하지 않는다. 후보는 위에서 확인한 Moodcode 경계의 구체적인 추가 계약이다. 이번 분석은 후보 구현을 포함하지 않는다.

## 라이선스·외부 서비스·독립 구현

Git tracked license inventory는 세 파일이다.

- [root LICENSE](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/LICENSE#L2-L12): Apache-2.0.
- [VS Code IDE companion LICENSE](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/vscode-ide-companion/LICENSE#L2-L12): Apache-2.0.
- [third_party/get-ripgrep LICENSE](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/third_party/get-ripgrep/LICENSE#L1-L19): MIT, Lvce Editor 2023.

개별 TypeScript의 Google LLC SPDX Apache-2.0 고지도 확인했다. root Apache-2.0은 Google/Vertex/Code Assist 서비스 약관·OAuth/계정·외부 MCP/A2A server·Chrome·sandbox helper/컨테이너 이미지·PTY native binary의 권리와 운영 조건까지 대체하지 않는다. 선언된 GenAI/auth/MCP/A2A/PTY/tree-sitter/telemetry 의존성의 전이 license 및 실제 배포 artifact 전체 audit는 별도다. 법률 검토를 수행하지 않았다.

원본은 Moodcode 밖에 보존했고 이번 변경에는 source·prompt·tool description·fixture·미디어를 복사하거나 runtime dependency로 추가하지 않았다. 분석·출처·독립 동작 계약만 저장한다. 원본을 읽었으므로 clean-room 절차를 수행했다고 주장하지 않는다.

## 고정 소스 근거

본문 G01~G20은 아래 전체 HEAD permalink 및 함수·좁은 1-based range에 대응한다. JSON에는 같은 ID/path/range/claim과 파일 SHA-256을 기록했다. 보조 링크도 같은 full HEAD다.

| ID | 함수·고정 소스 | 확인한 계약 |
|---|---|---|
| G01 | [main](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/cli/src/gemini.tsx#L979-L1002) · L979–L1002 | 비대화형 인증 refresh 뒤 runNonInteractive를 호출하고 종료 cleanup을 수행한다. |
| G02 | [runNonInteractive](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/cli/src/nonInteractiveCli.ts#L482-L488) · L482–L488 | 수집한 모델 tool request를 Scheduler.schedule로 넘긴다. |
| G03 | [GeminiClient.processTurn](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/core/client.ts#L657-L705) · L657–L705 | context management renderHistory 또는 legacy compression을 설정으로 선택한다. |
| G04 | [Turn.run](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/core/turn.ts#L375-L414) · L375–L414 | text/functionCall/citation/finishReason와 usage를 typed 이벤트로 변환한다. |
| G05 | [GeminiChat.makeApiCallAndProcessStream](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/core/geminiChat.ts#L990-L1090) · L990–L1090 | BeforeModel/BeforeToolSelection hook 뒤 최종 contents·model·tools를 ContentGenerator.generateContentStream에 전달한다. |
| G06 | [Scheduler._processToolCall](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/scheduler/scheduler.ts#L628-L684) · L628–L684 | BeforeTool 수정 입력을 재구성한 뒤 policy 및 tainted/build-file 위험을 검사한다. |
| G07 | [Scheduler._processToolCall](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/scheduler/scheduler.ts#L715-L754) · L715–L754 | 승인 결과와 정책 갱신을 처리하고 거절이면 대기 batch까지 취소한다. |
| G08 | [ToolOutputDistillationService.performDistillation](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/context/toolDistillationService.ts#L116-L177) · L116–L177 | 큰 원본을 파일에 보존하고 설정된 임계값에서 선택적 모델 요약 및 구조적 축약을 수행한다. |
| G09 | [ChatCompressionService.compress](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/context/chatCompressionService.ts#L665-L716) · L665–L716 | 요약과 보존 suffix의 token count를 다시 계산하며 오히려 커지면 새 이력을 활성화하지 않는다. |
| G10 | [MemoryContextManager.discoverContext](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/context/memoryContextManager.ts#L141-L171) · L141–L171 | trusted folder/roots 아래의 접근 경로 지침을 JIT 로드하고 파일 identity 중복을 추적한다. |
| G11 | [startMemoryService](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/services/memoryService.ts#L1369-L1406) · L1369–L1406 | memory inbox 패치를 검증하며 자동 적용하지 않는 후보와 실제 처리한 세션 version을 기록한다. |
| G12 | [ChatRecordingService.appendRecord](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/services/chatRecordingService.ts#L942-L957) · L942–L957 | JSONL 대화 record를 append하고 ENOSPC면 기록 경로를 해제하며 경고한다. |
| G13 | [processRestorableToolCalls](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/utils/checkpointUtils.ts#L98-L142) · L98–L142 | Git snapshot commit·UI/model history·원래 도구 요청을 checkpoint JSON으로 묶는다. |
| G14 | [DiscoveredMCPToolInvocation.execute](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/tools/mcp-tool.ts#L415-L453) · L415–L453 | MCP 호출 Promise와 AbortSignal을 경합시켜 로컬 대기를 취소하고 listener를 정리한다. |
| G15 | [LocalAgentExecutor.executeTurn](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/agents/local-executor.ts#L373-L411) · L373–L411 | complete_task 없이 도구 호출이 끝나면 protocol error, completion tool 결과면 GOAL로 종료한다. |
| G16 | [SkillManager.discoverSkills](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/skills/skillManager.ts#L54-L99) · L54–L99 | builtin/extension/user/workspace skill을 우선순위로 구성하고 workspace skill은 trust 확인 뒤 로드한다. |
| G17 | [HookRunner.executeCommandHook](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/hooks/hookRunner.ts#L358-L399) · L358–L399 | command hook은 subprocess로 실행되고 timeout 후 종료 요청과 추가 강제 종료 시도를 수행한다. |
| G18 | [createContentGenerator](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/core/contentGenerator.ts#L375-L419) · L375–L419 | GoogleGenAI를 생성하고 logging/model mapping 경계로 감싼다. |
| G19 | [createSandboxManager](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/services/sandboxManagerFactory.ts#L22-L43) · L22–L43 | sandbox enabled면 OS별 manager, disabled면 NoopSandboxManager를 반환한다. |
| G20 | [Scheduler._execute](https://github.com/google-gemini/gemini-cli/blob/ef59c532f07fbb3a58dd68bac024ae217e9c73ce/packages/core/src/scheduler/scheduler.ts#L880-L932) · L880–L932 | sandbox denial을 추가 권한 승인으로 변환하고 변경된 invocation/args를 상태에 반영한다. |

## 확인 범위와 한계

- 고정 HEAD 정적 소스 분석이며 upstream install/setup/build/test/model/account/GUI/benchmark 실행은 수행하지 않았다.
- 주요 CLI legacy loop와 설정된 context-management 경로를 조사했다. 모든 ACP/A2A server/browser/voice/IDE/extension/policy mode의 동등성은 확인하지 않았다.
- Core context-management 및 experimentalAutoMemory 기본값은 false이며 설정/원격 feature flag에 따라 실제 경로가 달라질 수 있다.
- MCP abort 경합은 로컬 대기 중단의 근거다. 원격 효과 취소·receipt·remote cleanup 증명이 아니다.
- JSONL append/atomic rewrite 및 Git checkpoint 코드는 crash durability나 파일 외부 효과 rollback의 실증 결과가 아니다.
- LFS smudge 및 재귀 submodule 초기화 없이 clone했다. native helper/binary, Google backend, MCP/A2A/Chrome 및 OS enforcement를 실행·검증하지 않았다.
- root 및 tracked 하위 LICENSE를 확인했으나 전이 의존성/배포 artifact 전체 license audit나 법률 검토는 수행하지 않았다.
- Moodcode 비교는 문서3065fdd03649df393f4170b38a2f049a1e52d2f3와 엔진464812f7d1af24466f57070663131f5979aeca51 기준이다. scoped 미발견을 제품 전체 부재로 단정하지 않는다.

이번에 검증한 것은 JSON 형식, source 파일·줄 범위·고정 Git blob/파일 hash 일치, candidate가 가리키는 Moodcode 경로의 존재다. upstream 테스트 통과나 OS 격리·provider 성공을 실행으로 검증했다는 의미는 아니다. 기존 Moodcode 검증 기록도 이번 upstream 실행 결과와 구분한다.
