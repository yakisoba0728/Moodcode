# Continue: 유지보수 종료 스냅샷의 엔진과 기능

2026-10-07 정적 소스 검토. Continue는 **CLI와 IDE에 서로 다른 orchestration이 있는 TypeScript 코딩 에이전트**다. 이 보고서는 유지보수 종료 선언이 있는 고정 소스의 분석이며 설치·모델·GUI·서비스 실행 결과가 아니다.

| 항목 | 기준 |
|---|---|
| 원본 | [continuedev/continue](https://github.com/continuedev/continue) |
| full HEAD | `5522c6f44ca0ac3528b37244818fbfa39b5af470` |
| checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/continue` |
| 언어·package | `core` TypeScript IDE backend, `gui` React/Redux, `extensions/cli` TypeScript/Ink, `extensions/vscode` host, `extensions/intellij` Kotlin, `packages/config-yaml` 설정, `packages/openai-adapters` CLI provider |
| 유지보수 | README: 더 이상 적극 유지보수하지 않고 모든 사용자에게 읽기 전용·최종2.0.0 선언. manifest GitHub API: **`archived=false`**, `disabled=false`, 관측2026-10-07 09:28:57 UTC. 서로 다른 값을 그대로 보존한다. |
| Moodcode 비교 | 문서 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 `464812f7d1af24466f57070663131f5979aeca51`; [baseline](moodcode-baseline.md), [현재 구현](../moodcode/implementation-status.md) |

## 대표 근거

모든 링크는 full SHA에 고정했다. 본문은 ID로 인용하며 파일·범위 SHA-256은 [evidence](continue.evidence.json)에 있다. 대표20개 범위는 각각160줄 이하다. 추가로 읽은 경로는 `reviewedSupplementaryPaths`에 기록했다.

| ID | permalink | 소스 확인 |
|---|---|---|
| CT01 | [README.md:17–43](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/README.md#L17-L43) | README는 CLI·VS Code·JetBrains coding agent, 최종2.0.0, 유지보수 종료·읽기 전용을 선언한다. GitHub archived flag는 별도 관측값이다. |
| CT02 | [LICENSE:1–23](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/LICENSE#L1-L23) | root LICENSE는 Apache License 2.0이며 하위 고지와 외부 모델·서비스 조건을 대체하지 않는다. |
| CT03 | [extensions/cli/src/commands/chat.ts:436–578](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/commands/chat.ts#L436-L578) | CLI는 headless/TUI를 나누고 services·model/API·resume history를 준비한다. headless는 processMessage 후 종료하며 새 입력 없는 resume/fork는 즉시 종료한다. |
| CT04 | [extensions/cli/src/stream/streamChatResponse.ts:259–416](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/stream/streamChatResponse.ts#L259-L416) | CLI는 model/messages/tools와 abort signal로 backoff stream을 소비한다. content/tool delta·usage를 모으고 AbortError는 도구 없이 종료, tool call 유무로 continuation을 정한다. |
| CT05 | [extensions/cli/src/stream/streamChatResponse.ts:443–581](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/stream/streamChatResponse.ts#L443-L581) | CLI main loop는 매 반복 history·mode별 system·tools를 읽고 compaction 전후에 LLM·tool 실행을 반복한다. 도구가 없으면 종료하되 compaction 뒤 continuation을 추가할 수 있다. |
| CT06 | [extensions/cli/src/stream/streamChatResponse.helpers.ts:495–638](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/stream/streamChatResponse.helpers.ts#L495-L638) | 도구별 permission을 순서대로 검사하고 승인된 호출은 즉시 execution promise를 시작한다. 거절 항목은 canceled 결과로 기록하며 다음 항목은 독립 처리한다. Promise.all로 종료를 기다린다. |
| CT07 | [extensions/cli/src/permissions/defaultPolicies.ts:7–71](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/permissions/defaultPolicies.ts#L7-L71) | CLI 기본은 writes ask, interactive Bash/MCP ask, headless Bash/wildcard allow다. Plan은 named writes exclude지만 Bash·MCP allow, Auto는 wildcard allow다. |
| CT08 | [extensions/cli/src/tools/runTerminalCommand.ts:180–336](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/tools/runTerminalCommand.ts#L180-L336) | Bash는 병렬 수로 출력 한도를 나누고 shell을 spawn한다. background 요청은 process를 job service에 넘긴다. timeout은 출력마다 재설정되며 child.kill 후 결과를 반환한다. |
| CT09 | [extensions/cli/src/compaction.ts:81–161](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/compaction.ts#L81-L161) | compaction은 output/system 예약을 빼고 구조 유지 prune 후 같은 streamChatResponse에 isCompacting=true를 넘긴다. summary 표식과 system/summary history를 만든다. |
| CT10 | [extensions/cli/src/session.ts:279–331](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/session.ts#L279-L331) | CLI persistence snapshot을 HistoryManager에 저장하고 resume은 JSON mtime으로 최신 파일을 골라 로드한다. 실행 효과 재개 journal의 증거는 아니다. |
| CT11 | [gui/src/redux/thunks/streamNormalInput.ts:196–332](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/gui/src/redux/thunks/streamNormalInput.ts#L196-L332) | IDE Redux thunk는 compiled messages를 core로 stream하며 tool 상태를 갱신한다. 종료 후 preprocess·policy evaluation을 순서대로 수행하고 승인 필요/자동 허용을 나눈다. |
| CT12 | [core/llm/streamChat.ts:114–142](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/llm/streamChat.ts#L114-L142) | IDE core는 selected chat model.streamChat을 호출하고 abort signal을 검사하며 chunks와 PromptLog를 반환한다. tool-loop 소유자는 함수 바깥 GUI다. |
| CT13 | [gui/src/redux/thunks/callToolById.ts:23–149](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/gui/src/redux/thunks/callToolById.ts#L23-L149) | IDE는 generated 도구를 calling으로 바꾸고 client/core 구현을 분기한다. core tools/call 결과를 저장한 뒤 streamResponseAfterToolCall로 continuation을 요청한다. |
| CT14 | [core/context/retrieval/pipelines/NoRerankerRetrievalPipeline.ts:11–88](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/context/retrieval/pipelines/NoRerankerRetrievalPipeline.ts#L11-L88) | IDE codebase retrieval은 최근 편집·FTS·embedding·repo-map을 합치거나 experimental tool-only retrieval을 사용하며 directory filter와 dedup을 적용한다. |
| CT15 | [core/indexing/CodebaseIndexer.ts:146–208](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/indexing/CodebaseIndexer.ts#L146-L208) | embed 모델이 없으면 새 indexes를 만들지 않는다. provider dependsOnIndexing에 따라 chunk·snippet·FTS·LanceDB를 순차 생성한다. |
| CT16 | [extensions/cli/src/services/ConfigService.ts:253–307](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/services/ConfigService.ts#L253-L307) | CLI는 configuration·주입/추가 블록·agent file을 병합하고 Markdown rules를 내용으로 dedup한 뒤 default chat model을 추가해 상태에 저장한다. |
| CT17 | [extensions/cli/src/services/MCPService.ts:180–316](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/services/MCPService.ts#L180-L316) | CLI MCP는 server catalogue에서 이름으로 도구를 골라 callTool을 실행하고 capability별 prompts/tools를 수집한다. unresolved secret은 headless error 또는 interactive warning이다. |
| CT18 | [extensions/cli/src/tools/skills.ts:29–82](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/tools/skills.ts#L29-L82) | Skills는 name/description 목록을 설명에 넣고 요청한 skill 본문·동반 파일 목록을 반환한다. 보조 파일은 Read로 요청하도록 안내한다. |
| CT19 | [extensions/cli/src/subagent/executor.ts:58–200](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/extensions/cli/src/subagent/executor.ts#L58-L200) | beta subagent는 전역 permission을 wildcard allow로 바꾸고 system/history service를 임시 교체해 같은 stream loop를 실행한다. Escape abort와 finally 복원이 있다. |
| CT20 | [core/core.ts:1373–1426](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/core/core.ts#L1373-L1426) | IDE context-provider API는 provider에 chat/embed/rerank·IDE·selected code·global request options를 extras로 전달하고 반환 자료에 provider ID/UUID를 붙인다. |

## 실제 engine 흐름

**CLI:** `index.ts`의 command action → `chat()` → headless `runHeadlessMode()`/`processMessage()` 또는 Ink TUI → `streamChatResponse()`다. service container는 config·model/API·MCP·permission·history·system message를 준비한다. resume/fork history를 로드하며 headless 새 입력이 없으면 모델 호출 없이 성공 종료한다(CT03). 보조 `chat.ts`의 `processMessage()`는 user message를 서비스 이력에 넣고 `getStreamingResponse()`를 호출한 뒤 출력·세션 저장을 수행한다.

1. 매 반복 history, permission mode에 맞는 system message, request tools와 model overrides를 재계산하고 호출 전 compaction·context 검사를 수행한다(CT05).
2. unified history를 OpenAI형 messages로 변환하고 CLI `BaseLlmApi`에 model/messages/tools·abort signal을 넘긴다. backoff stream에서 text·tool delta·usage를 모으며 AbortError는 text를 보존하고 도구 없이 종료한다. tool call 유무가 continuation을 정한다(CT04).
3. 보조 `handleToolCalls()`는 assistant/tool 상태를 저장하고 args·preprocess를 검사한다. 실행 helper는 permission을 순서대로 확인하면서 **승인한 실행 promise를 즉시 시작**한다. 뒤 승인 대기 중 앞 도구가 실행될 수 있다. 거절은 해당 항목의 canceled 결과이며 다음 항목은 독립 처리한다. “나머지 취소” 주석과 달리 실제 branch는 `continue`다(CT06). headless rejection은 helper 결과를 받아 이르게 반환할 수 있다.
4. 도구 결과 뒤 context 검증·보통80% threshold compaction을 거친다. 도구가 없으면 종료하며 이번 turn의 compaction이 있으면 continuation을 한 번 넣을 수 있다. 반환/CLI 종료를 Moodcode durable Run/Turn/Attempt terminal과 같은 계약으로 인증하지 않는다(CT05).

**IDE:** editor → `streamResponseThunk()`의 selected context/code 해석 → Redux history → `streamNormalInput()`의 rules/system/tools 구성·`llm/compileChat` → messenger `llm/streamChat` → core selected chat model `streamChat()`다(CT11·CT12; 보조 `streamResponse.ts`, `core/core.ts`). native tool 미지원 모델에는 system-message tool framework 분기가 있다. GUI는 stream 뒤 preprocess·policy를 평가한다. `callToolById()`는 client-side 도구 또는 core `tools/call`을 선택하고 결과를 저장한 뒤 continuation thunk를 호출한다(CT13). 보조 `streamResponseAfterToolCall()`은 해당 assistant의 모든 도구가 done/errored, 설정에 따라 canceled일 때 tool message를 넣고 다시 `streamNormalInput()`을 dispatch한다. 도구가 없으면 inactive가 된다. **GUI가 agent-loop 재호출·승인 상태를 소유하고 core 모델 함수는 단일 stream을 처리한다.**

IDE autocomplete는 보조 `core/core.ts`의 별도 `autocomplete/complete` → `CompletionProvider.provideInlineCompletionItems`, accept/cancel registry다. `nextEdit` 역시 다른 입력·모델 역할의 경로다. 이 기능과 indexing의 존재를 CLI coding-agent loop 또는 headless engine의 같은 기능으로 합치지 않는다.

## context·검색·기억

IDE context-provider API는 config의 이름으로 provider를 찾고 query/full input/selected code와 chat/embed/rerank, IDE, fetch를 넘긴다. provider fetch는 LLM과 별도의 global request options를 사용한다. result는 provider title/item UUID로 표시한다(CT20). editor의 명시 선택과 default context·rules를 조합하므로 모든 파일이 항상 들어가는 구조는 아니다.

`CodebaseContextProvider`는 chunk·FTS·embedding indexes에 의존한다. non-reranker pipeline은 최근 편집·FTS·vector·repo-map을 합치거나 experimental tool-only retrieval을 선택하고 directory filter·dedup을 수행한다(CT14). 보조 `retrieval.ts`는 workspace/branch tags, nFinal/nRetrieve, reranker와 파일/줄 표기를 구성한다. indexer는 embed 모델이 없으면 **새 index 목록을 빈 값으로 반환**한다. provider가 요구하는 chunk/snippet/FTS/LanceDB만 SQLite 경합 회피를 위해 순차 생성한다(CT15). retrieval의 embedding 없는 분기만으로 최초 FTS-only indexing이 보장된다고 하지 않는다. native CPU/LanceDB·embedding 품질·reranker 효과는 실측하지 않았다.

CLI `Search`는 별도 ripgrep 도구이며 path/file pattern과 결과 한도를 사용한다. 보조 `tools/index.tsx`는 ripgrep availability·model capability·headless·beta flag·MCP로 catalogue를 정한다. `FileIndexService`의 fuzzy file 선택과 IDE vector retrieval은 다른 기능이다. 탐지 코드를 읽었을 뿐 upstream 탐지 함수를 실행하지 않았다.

CLI compaction은 output/system 예약을 빼고 tool exchange 구조를 유지하도록 history를 prune한 뒤 동일 stream loop에 `isCompacting=true`를 넘긴다. `conversationSummary`와 system/summary를 만든다(CT09). CT05 루프는 여전히 tools를 구성하므로 이 인자만으로 tools 없는 요약을 보장한다고 읽지 않는다. 보조 `ChatHistoryService.compact()`는 history/index를 갱신한다. 대화 압축이며, Moodcode의 source digest·tool-free summary attempt·원자 publication·crash 복구 proof와 동등한 계약은 확인하지 못했다. 독립 project knowledge의 자동 학습/검색 서비스도 검토 범위에서 확인되지 않았으며 제품 전체 memory 부재로 단정하지 않는다.

## 도구·승인·취소·저장

| 범주 | 확인한 동작·계약 차이 |
|---|---|
| 편집/검증 | CLI schema/preprocess/run 경계. 보조 `edit.ts`는 validation→old/new content·diff preview→preprocessed content 쓰기이고 `run()`에는 승인 이후 현재 hash 재검사가 보이지 않는다. IDE는 client/core 구현 분기(CT13). verification은 Bash 명령 경로이며 실제 test gate 성공을 측정하지 않았다. Moodcode exact prepare/approval/revalidate/effect와 동등하게 보지 않는다. |
| 승인 | interactive writes/Bash/MCP ask, headless writes ask·Bash/wildcard allow. Plan은 named writes exclude지만 Bash/MCP allow, Auto는 모두 allow(CT07). 보조 permission helper의 headless ask는 policy deny, interactive는 manager request ID·preview. Plan을 OS/effect sandbox로 해석하지 않는다. IDE는 policy와 generated/calling 상태로 관리(CT11·CT13). |
| 병렬/출력 | 승인한 CLI 도구는 즉시 병렬 실행하고 모두 완료를 기다림(CT06). Bash/Read는 parallel count로 출력 cap 배분. **Moodcode에도 read-only 제한 병렬과 batch 폭에 따른 출력 예산 배분이 이미 있다.** mutating 도구 병렬을 새 계약으로 가져오지 않는다. |
| command/env | Bash shell spawn은 기본 부모 env를 상속한다. 보조 shell 선택은 Unix login shell·Windows PowerShell/WSL. timeout 기본180초·입력상한600초는 출력마다 재설정되는 무출력 timeout이며 `child.kill()` 후 결과 반환(CT08). PTY/process-group 전체 종료 proof는 이 경로에서 미확인. |
| background | CT08의 기존 process 이동과 handle 반환. 보조 BackgroundJobService는 process/job Map·최대5 running jobs·최근1,000줄. process Map을 durable restart 보장으로 읽지 않는다. |
| cancel | 모델 signal 전달·검사(CT04·CT12), TUI Escape abort. CLI ToolRunContext는 call ID·parallel count를 전달하므로 모델 abort가 Bash/MCP 효과 중단·종료 proof까지 연결된 보장은 검토 경로에서 미확인. GUI stream/pending/tool 취소 thunk와 전 제품 동등성도 별도. |
| persistence/resume | snapshot을 shared HistoryManager에 저장하며 JSON mtime으로 최신 세션 로드(CT10). shared history는 session JSON·목록 파일 쓰기, IDE도 core history handlers 사용. 대화 resume/fork와 command/approval/tool-effect의 crash-safe 재개를 구분. |
| checkpoint/restore | 선택 Git AI tracking은 도구 전후 외부 `git-ai checkpoint`를 호출하고 실패 시 계속할 수 있음. attribution 연동이며 자체 exact rollback/effect journal 증거가 아니다. GUI/IDE undo도 Moodcode review.restore의 hash/conflict·durable audit와 다른 범위. |

## 설정·확장·공급자

CLI ConfigService는 configuration·주입/추가 블록·agent file·Markdown rules를 병합하고 rule 내용으로 dedup한다(CT16). 보조 ModelService는 chat role 모델을 골라 `createLlmApi()`에서 provider/model/apiKey/apiBase/requestOptions/env를 `packages/openai-adapters`에 넘긴다. IDE는 core YAML 설정/provider classes 및 selected chat/embed/rerank 등 roles를 사용한다. adapter 파일/필드의 존재는 모든 모델의 native tools·usage·reasoning·retry/cancel 호환성 실측이 아니다.

MCP는 connected server catalogue에서 tool 이름을 찾아 callTool하며 capabilities별 tools/prompts를 수집한다. unresolved secret은 headless error/interactive warning, 이 스냅샷의 `withTokenRefresh`는 실제 refresh 없이 operation을 실행한다(CT17). 보조 `mcpTransports.ts`의 stdio/SSE/Streamable HTTP와 stdio env의 부모 환경 보충을 확인했다. 외부 실행 파일/서비스 권한은 별도이며 Moodcode MCP native owner·dispatch/outcome·cleanup uncertainty·archive blocker의 동등성을 인증하지 않는다.

Skills는 name/description catalogue에서 본문·동반 파일 목록을 선택 제공한다(CT18). 보조 loader는 `.continue/skills`, `.claude/skills`, Continue user directory와 frontmatter를 사용한다. Moodcode의 bounded skill/reference list/read와 목적이 겹치지만 roots·trust/provenance·한도는 별도 계약이다. 원본 skill 본문·prompt·tool description을 복사하지 않았다.

beta subagent는 별도 worktree/process/DB 대신 같은 stream loop를 local history·model/API로 실행하면서 전역 services를 임시 교체한다. executor는 wildcard allow·Escape abort·finally 복원이다(CT19). 노출은 보조 catalogue의 beta flag로 제한한다. Moodcode의 실제 child worktree/DB·budget/deny/cancel 상속과 구별하며 전역 allow 교체를 이식하지 않는다.

hooks 선언·HookService·`fireHook` helpers는 있으나 보조 `executeToolCall()`의 main 경로는 Git AI pre/post tracking을 호출했다. 일반 `firePreToolUse`/`firePostToolUse`의 main-loop wiring은 확인되지 않았다. helper 존재와 실행 연결을 구분한다. README의 authentication 제거 선언(CT01)도 compatibility type/SDK/reference 전체 부재를 뜻하지 않는다. Hub/background agent·HTTP/command hooks·외부 서비스의 현재 동작은 미확인이다.

## Moodcode 비교·독립 구현 후보

| Moodcode에 이미 있는 계약 | 추가 검토 범위 |
|---|---|
| bounded ContextPlan·semantic memory·완전 tool exchange | repository index와 retrieval score/source 선택을 별도 자원으로 결합 |
| LSP·workspace observer·bounded 검색 | recent-file/FTS/vector/repo-map 합성; LSP 진단과 index generation 분리 |
| typed scopes·exact approval·deny/Plan·읽기 병렬/출력 배분 | 상태 표시를 참고하되 headless/Plan wildcard 권한과 mutating 병렬은 이식하지 않음 |
| MCP·skills/reference·profile revision | 선택한 context source manifest; executable/credential 자동 실행을 추가하지 않음 |
| worktree child·별도 DB·budget/deny/cancel 상속 | 역할별 모델 참고 가능; 전역 services/allow 임시 교체와 구분 |
| user-owned PTY·journal/replay·durable inbox | background handle 표시·완료 delivery 연결 |
| checkpoint/review.restore·unknown cleanup 격리 | JSON history나 git-ai attribution을 crash recovery로 취급하지 않음 |

다음은 기능 구현이 아닌 후속 계약 제안이다. actual Moodcode 경로와 validation은 evidence에도 동일하게 기록했다.

### CONTINUE-C01 · workspace/index generation에 결합한 혼합 저장소 검색

**P1 · 비용 높음**. bounded context·semantic session memory·정규식 검색·LSP·workspace observer는 구현됨. branch/worktree와 embed identity별 repository index 및 FTS/vector/recent-file 조합은 별도 후보. 참고: CT14, CT15, CT20.

관련 경로: `packages/engine/src/context/service.ts` · `packages/engine/src/context/plan.ts` · `packages/engine/src/context/semantic-memory.ts` · `packages/engine/src/tools/search/index.ts` · `packages/engine/src/lsp/index.ts` · `packages/engine/src/workspace/observer.ts`.

독립 계약: host가 명시 등록한 repository-index service에 workspace/worktree root·content hash·index generation·embedding provider/model/schema revision을 결합한다. ignore·파일/총 bytes 한도와 delete/rename invalidation을 강제하고 FTS/vector/recent-file score·source provenance를 반환한다. dedup/rerank 결과를 ContextPlan 예약 안에서 선택한다. 외부 embed/rerank 전송은 host opt-in과 credential reference 정책을 따른다. index 미지원/stale fallback을 표시하고 session semantic memory와 분리한다.

검증 조건:

- branch 전환·분리 worktree에서 index 혼합을 막는 synthetic corpus 검사
- 수정/삭제/rename/ignore 변경 후 stale snippet 제거와 원문 hash 확인
- embed 미등록·native index 불가·rerank 실패의 FTS/read fallback 및 degraded 표시
- source/result/context UTF-8 hard cap·cancel·provenance와 ContextPlan digest 일치

### CONTINUE-C02 · 선택한 context provider의 bounded source manifest

**P1 · 비용 중간**. host provider·MCP resources·LSP·nested instructions·skill/reference bounded read·ContextPlan은 구현됨. 사용자 선택 provider/query를 단일 provenance manifest로 capture하는 host 계약이 추가 후보. 참고: CT20, CT14, CT16, CT18.

관련 경로: `packages/engine/src/ports.ts` · `packages/engine/src/context/service.ts` · `packages/engine/src/context/plan.ts` · `packages/engine/src/context/sources.ts` · `packages/engine/src/mcp/index.ts` · `packages/engine/src/lsp/index.ts` · `packages/engine/src/tools/session/skills.ts` · `packages/engine/src/agents/index.ts`.

독립 계약: host registry의 versioned provider에 workspace/session·query·selected ranges·AbortSignal·bytes/tokens 예약을 전달한다. result는 provider/source ID·revision/hash·URI/range·trust origin·omission/degraded 사유를 반환하고 하나의 ContextPlan에 capture한다. 사용자 선택과 profile default를 구분한다. 결과 본문은 지침 권한을 추가하지 않는 자료이며 provider/query가 executable·credential·MCP scope를 늘리지 못한다. source 변경은 다음 모델 경계에서 재계획하며 진행 중 Attempt에는 frozen manifest를 유지한다.

검증 조건:

- provider/query/source 순서와 무관한 deterministic manifest digest
- stale range/hash·revision 변경·timeout/cancel·result bytes 초과의 bounded 실패와 omission
- skill/LSP/MCP 선택 후에도 deny/Plan/approval/scope 유지
- 미등록·부분 실패·동일 Attempt retry에서 source/provenance 혼합 방지

### CONTINUE-C03 · 기존 user-owned PTY의 background 표시와 완료 전달

**P2 · 비용 중간~높음**. user authority PTY·durable terminal journal·attach/replay/cancel/resize·cleanup과 durable inbox는 구현됨. 모델 Bash를 무조건 background로 넘기지 않는다. host 사용자가 시작한 job의 read-only status handle과 완료 delivery 연결이 추가 후보. 참고: CT08, CT10, CT06.

관련 경로: `packages/engine/src/terminals/service.ts` · `packages/engine/src/terminals/types.ts` · `packages/engine/src/terminals/journal.ts` · `packages/engine/src/runner/input-scheduler.ts` · `packages/engine/src/storage/index.ts` · `packages/engine/src/tools/command/index.ts` · `packages/engine/src/tools/command/process-control.ts`.

독립 계약: host가 승인한 user-owned job만 workspace/session·owner generation·process receipt에 결합한 status handle로 등록한다. attach/background 표시 변경은 ownership/effect/수명 한도를 바꾸지 않고 모델은 bounded status/output paging만 읽는다. 완료·실패·cleanup uncertain 확정 뒤 dedup key로 inbox에 한 번 전달하며 terminal Run에는 이벤트를 덧붙이지 않는다. 모델이 executable/env/authority를 지정하거나 올리지 못한다. crash 후 OS owner receipt 재관측 없이 running을 복구하지 않고 interrupted/uncertain을 유지한다.

검증 조건:

- detach/reload와 완료가 겹쳐도 journal·receipt·inbox 정확히 한 번
- cancel/timeout/cleanup 실패/crash에서 process 부재 proof와 uncertain 차단 유지
- 다른 workspace/session handle 거절 및 output/backpressure 한도
- 정상 완료·비정상 exit·검증 결과를 구분 전달하고 원래 effect/approval binding 불변

## 라이선스·출처와 한계

root `LICENSE`는 Apache-2.0(CT02), `extensions/vscode/LICENSE.txt`는 Apache 고지, vendored `@xenova/transformers/LICENSE`는 Apache-2.0, `gui/public/fonts/Inter/LICENSE.txt`는 SIL Open Font License1.1이다. 하위 고지와 model weights·SDK·embedding/rerank API·MCP 서버·git-ai·Hub 서비스 조건은 별도다. 전체 배포 의존성 audit나 법률 검토가 아니며 root 고지로 외부 자료 권리를 일반화하지 않는다.

고정 source와 README만 읽고 upstream install/build/test/runtime·실제 LLM/계정·IDE GUI·외부 서비스·benchmark는 실행하지 않았다. JetBrains/SDK/모든 provider/UI 경로의 동등성·외부 자료에 의존하는 기능은 미확인이다. README 유지보수·최종 release는 선언, manifest archived flag는 API 관측, loop/정책은 소스 확인, 후보 우선순위·설계는 분석자의 판단이다.

정적 확인은 대표20개 범위의 파일/줄수·전체 SHA/내용 hash·candidate 실제 경로를 대상으로 한다. 기존 Moodcode의 검증을 upstream 실행 결과로 표시하지 않는다. 이번 변경은 `continue.md`와 `continue.evidence.json`이며 source/prompt/fixture/media/runtime dependency를 복사하지 않았다. 원본을 읽었으므로 clean-room 절차를 주장하지 않는다.
