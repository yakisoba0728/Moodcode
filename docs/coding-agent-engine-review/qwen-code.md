# Qwen Code 엔진 정적 분석

2026-10-07. Qwen Code는 현재 고정 소스에서 provider-neutral 모델 루프, 같은 scheduler를 통한 도구 실행, 상주 background agent와 팀 조정, 자동 기억·skill 작업을 연결한다. Moodcode에는 child·profiles·skill 읽기·semantic summary·plugin tool hooks가 이미 있으므로 추가 후보는 이 기능들의 후속 입력·팀 소유권·지속 발행·조합 실행 계약에 한정한다. 이번 작업은 분석이며 기능 구현이나 upstream 실행 검증이 아니다.

## 원본과 범위

| 항목 | 확인 결과 |
|---|---|
| 저장소 | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) |
| 전체 HEAD | `d0ddd020c8a64279e290538f84b152fe843ed9d4` |
| 원본 checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/qwen-code` |
| 고정 소스의 최근 commit | `2026-10-07T09:08:48Z`, daemon event schema 문서 형식 수정. 로컬 git log 단서이며 원격 유지보수 전체 조사 결과가 아니다. |
| 언어·package 경계 | TypeScript/ESM 중심. root/core package version은 0.25.0이며 root Node 요구는 >=22. core·CLI·SDK·IDE·browser/CUA·channels·web 관련 workspace가 있다. desktop/live-host/mobile-shell은 root workspace 목록에서 제외된다. [root package](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/package.json#L1-L29), [core exports](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/package.json#L1-L96) |
| Moodcode 기준 | 문서 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 `464812f7d1af24466f57070663131f5979aeca51`. [baseline](moodcode-baseline.md)과 [현재 구현 상태](../moodcode/implementation-status.md)를 읽고 비교했다. |
| 방식 | static-source-review. 원본 설치·test·setup·실제 모델·계정·GUI·공유 build·commit을 수행하지 않았다. LFS/submodule 외부 자료에 의존하는 기능은 미확인 범위다. |

README는 Gemini CLI v0.8.2를 기반으로 시작했으며 v0.1부터 upstream sync를 멈췄다고 밝힌다(R01). 이는 저장소의 설명이다. 현재 소스에서 확인한 독립 변경은 provider 선택(R07), resident continuation/revive(R12/R13), team 메시지·board(R14/R15), managed memory/skill review(R09–R11), code-mode(R08/R16), typed hooks(R17)다. 이 파일들만으로 Google 기원 코드의 전체 계보나 독립 변경률을 수치화하지 않는다.

`core/geminiChat.ts`는 deprecated `llm-chat.js` re-export다. `subagent-runtime.ts`는 AgentCore/AgentHeadless/실행 타입·이벤트의 공개 facade이고, `board.ts`도 team board task/ask를 내보내는 facade다. 이름을 엔진 구현 자체로 오해하지 않고 실제 호출부를 아래 근거에 선정했다. [chat facade](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/geminiChat.ts#L1-L8), [subagent facade](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/subagent-runtime.ts#L7-L54), [board facade](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/board.ts#L7-L27)

## 진입점부터 종료까지

1. CLI bootstrap은 route별 fast path를 고른 후 `llm.js.main`으로 진입한다. headless main은 `runNonInteractive`를 호출하고 finally에서 exit cleanup을 기다린 후 반환 exit code로 종료한다. [bootstrap](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/cli/src/cli.ts#L564-L608), [headless entry/exit](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/cli/src/llm.tsx#L1649-L1668)
2. `LlmClient.initialize`는 session restore runtime 또는 JSONL conversation을 API history로 재구성한다. completed tool IDs·token provenance·loaded skill 상태를 복원한다. [client initialize](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/client.ts#L602-L669)
3. headless caller가 `LlmClient.sendMessageStream`에 입력·abort signal·prompt ID·모델 override를 넘긴다(R03). client는 `Turn`을 만들고 IDE·날짜·각종 reminder/recall을 현재 요청에 조립한다. `Turn.run` 소비 전에 input carrier 수락 지점을 관리한다(R04). [Turn 생성/IDE 조립](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/client.ts#L4490-L4509), [recall 주입](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/client.ts#L4582-L4594)
4. `Turn.run` → `LlmChat.sendMessageStream`이 모델 이벤트를 content/thought/function request로 변환한다. retry/fallback 때 쌓인 pending tool/citation/finish 상태를 비운다(R05). 실제 transport 호출은 `makeApiCallAndProcessStream`에서 `ContentGenerator.generateContentStream`으로 이어진다. [실제 모델 호출/transport retry](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/llm-chat.ts#L5206-L5254)
5. headless는 tool request를 모아 `processToolCallBatch`로 처리하고 결과를 다음 모델 입력으로 돌린다(R03). 그 내부 `executeToolCall`은 새 `CoreToolScheduler`의 `schedule`을 호출한다. TUI 역시 같은 scheduler를 사용한다. [headless 실행 호출](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/cli/src/nonInteractiveCli.ts#L2107-L2134), [공통 scheduler 연결](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/nonInteractiveToolExecutor.ts#L28-L56), [TUI scheduler](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/cli/src/ui/hooks/useReactToolScheduler.ts#L226-L239)
6. scheduler는 registry/permission/승인 경계를 거쳐 실행하고 invocation 바로 앞에서 executing/span을 시작한다(R08). tool result는 PostToolUse/PostToolBatch와 결과 budget을 거쳐 caller로 돌아간다. 승인 대기·PreToolUse ask bounce·사용자 cancel·not_started와 실제 시작 후 실패를 나누는 소스 경로가 있다. [PreToolUse/ask 처리](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/coreToolScheduler.ts#L5480-L5638), [완료 batch/결과 처리](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/coreToolScheduler.ts#L7200-L7368)
7. 도구 없는 model completion에서 Stop hook, queued/steer 입력, goal permit 및 next-speaker 경로가 종료/계속을 결정한다. 승인된 goal 종료 전에는 recorder flush를 기다리고, 일반 완료에서는 cache-safe params를 잡은 뒤 기억 작업을 예약한다. [Stop hook](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/client.ts#L5178-L5264), [완료/기억 예약](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/client.ts#L5447-L5487)
8. 실제 기록은 순서화된 JSONL/lease/Managed sink(R19)이며 `flush`가 queued write와 첫 실패를 확인한다. close는 정상 종료와 handoff/seal을 구분한다. 모델 finish·UI 완료·도구 effect 종료·durable write 완료를 하나의 성공으로 합치지 않는다. [flush/기록 읽기](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/services/chatRecordingService.ts#L1979-L2005), [close/handoff](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/services/chatRecordingService.ts#L2091-L2132)

## 주요 engine feature inventory

| 범주 | 소스에서 확인한 동작 | 의미와 확인 한계 |
|---|---|---|
| 모델·공급자 | AuthType별 Chat Completions/Responses/Qwen OAuth/Anthropic/Gemini·Vertex factory, lazy wrapper(R07). | 공통 Content/Part 구조에는 Gemini 기원 타입이 남는다. README의 임의 provider/local model 호환성을 실측한 것은 아니다. |
| stream·재시도 | Turn이 retry/fallback/압축/모델 content/tool call을 통일 이벤트로 투영(R05). chat에 transport retry·continuation과 reactive overflow 경로가 있다. | 재시도 전체 조합·partial reasoning/native signature 호환성은 실행 검증하지 않았다. 재전송이 도구 효과를 자동으로 되돌리는 계약은 아니다. |
| 문맥 governance | 직전 API prompt/output usage 또는 첫 요청 char 기반 추정으로 pre-send compression/hard rescue; 실패 시 history/count rollback과 compression checkpoint 지연(R06). | 소스 주석도 restore/inherited history 추정의 undercount와 reactive fallback을 인정한다. 모든 provider에 대한 정확한 token hard cap 증명으로 해석하지 않는다. |
| 자동 기억 | 완료 경로가 configured auto-memory extraction/dream을 비동기 예약하며 종료 중에는 신규 작업을 멈춘다(R09). recall은 현재 입력에 넣고 실제 모델 수락 뒤 resident memory 상태를 정합화한다(R04). | session compaction과 별도 지속 기억 시스템이다. 자동 지식이 현재 파일 상태나 사용자의 새 승인을 증명하지 않는다. |
| 기억 검색 | structured recall mode의 도구 caller가 trustedProject/teamMemory 설정과 per-call coverage 사본을 전달한다. 구현은 scope/category/keyword scoring·rarity bonus, ref fetch, snapshot/버전/aggregate budget/turn별 exhaustion(R10). | legacy protocol에서는 이 도구가 unavailable이다. 이 확인 경로는 keyword 검색이며 모든 memory retrieval을 embedding/vector 의미 검색이라고 부르지 않는다. |
| 자동 skill | tool-call threshold·skills-modified·동시 실행·memory pressure gate, 별도 review agent, 옵션 confirmBeforePersist staging(R09/R11). | 신규 skill stage와 기존 skill 수정의 취급이 다르다. 신규 후보도 agent가 파일을 만든 뒤 이동하는 순서다. 승인 전 staging만 쓰는 Moodcode 후보와 구분한다. |
| skill 읽기·활성화 | runtime load·중복 context body 방지·model override; project trust와 workspace-agent gate를 통과해야 allowedTools/hooks를 적용한다. | Moodcode의 skill_read보다 권한·hook side effect가 넓다. body 읽기와 실행 가능한 설정 활성화를 같은 기능으로 간주하지 않는다. |
| 편집·검증 도구 | edit은 literal replacement·prior read/freshness·diff/승인·file history를 연결한다. shell은 출력·PID·foreground/background promotion을 scheduler에 제공한다(R08). | file history backup은 best-effort이고 stat→write race 한계가 소스에 명시되어 있다. 일반 shell을 통한 test는 가능하나 전체 자율 검증 workflow 효과는 이번 범위에서 실측하지 않았다. |
| 권한·취소 | 도구 allow/deny/ask·승인 mode/AUTO decision, PreToolUse ask 후 재실행, abort 기반 not_started/execution/cancel 분기. | hook 실행 오류의 허용형 처리와 Moodcode exact approval 계약은 다르다. 안전 정책 동등성을 주장하지 않는다. |
| runtime sandbox | shell policy가 있으면 cwd·sanitized env를 확인해 executeSandbox → bwrap/Landlock로 보내며 없으면 일반 ShellExecutionService로 간다. | 선택적 OS 실행 경계다. QuickJS code-mode 격리와 구분한다. 모든 도구/OS/container가 기본 격리라는 주장은 하지 않는다. |
| code-mode | 별도 host process·QuickJS memory/stack/CPU cap, bounded source/output, JS binding→현재 도구 dispatch, 미완료 nested call cancel(R16). scheduler가 parent/allowed tool identity를 부여한다(R08). | nested 효과는 원 scheduler에서 실행한다. JS guest를 sandboxing했다는 사실만으로 nested 외부 효과까지 무해하거나 rollback 가능하지는 않다. |
| 하위 agent | facade 뒤 AgentHeadless → AgentCore reasoning loop. external input을 tool response와 함께 전달하거나 도구 없는 round에서 idle wait한다. | 상주 agent의 task 완료와 runtime dispose가 별개다. Moodcode의 terminal child 결과 delivery와 상태 모델이 다르다. |
| resident/revive | completed agent를 동일 runtime/new AbortController로 직렬 계속하거나(R13), transcript·meta·capacity로 cold revive(R12). | container/executionBackend 기록은 이 revive 경로에서 차단된다. 모델 continuation 성공이나 리소스 정리 품질은 실행 검증하지 않았다. |
| 팀·board | leader durable inbox와 teammate bounded priority queue/idle flush(R14), 별도 board item lock·owner claim/complete·atomic write(R15), team task expected owner/status와 dependency 저장. | board CLI의 개별 task와 agent team task list는 서로 다른 모듈이다. team membership과 task claim은 파일 효과 승인과 분리해야 한다. |
| hooks·확장 | command/HTTP/function/prompt/async command dispatch(R17), model message display(R04), Pre/Post tool/batch/Stop lifecycle. | command hook은 실제 외부 code 실행 경계다. 오류가 non-blocking_error인 곳과 deny/stop인 곳을 구분한다. |
| MCP | direct SDK 또는 wrapper invocation, progress·idle/whole timeout·parent abort race·invocation metadata와 MCP App 결과 분기(R18). | 취소 응답은 서버 효과 부재 증명이 아니다. discovery/pool/resource/OAuth 전체 구현·모든 외부 서버는 감사하지 않았다. |
| 저장·복구 | write queue·lease·Managed sink·strict/fire-and-forget·첫 실패 이후 recorder 중지(R19). history gap, interrupted prompt/tool turn을 별도 복구 계획으로 만든다(R20). | failed synthetic tool response는 대화 pairing 보정이며 실제 효과 rollback/재실행 안전성의 증거가 아니다. Managed authority 전체는 미확인이다. |
| 추가 엔진 범위 | goal permit·workflow/arena·Omni/media·daemon/ACP·SDK·채널·browser/CUA 모듈이 현재 트리에 있다. | 이 보고서는 해당 전체 실행 흐름·배포·OS/provider 조합을 확인한 보고서가 아니다. 표의 핵심 호출부에 등장한 경계만 확인했다. |

inventory의 추가 좁은 근거:

| 확인 항목 | 실제 source permalink |
|---|---|
| skill load/중복 body/model override | [skill invocation](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/tools/skill.ts#L911-L959) |
| project trust·workspace-agent side-effect gate | [skill side effects](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/tools/skill-utils.ts#L468-L511) |
| 신규 stage와 기존 skill 직접 수정 구분 | [pending skill 처리](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/memory/pending-skills.ts#L72-L150) |
| edit backup·freshness·race 한계 | [edit 경계](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/tools/edit.ts#L522-L581) |
| shell sandbox의 실제 caller | [shell 도구](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/tools/shell.ts#L2779-L2808) |
| 정책 없는 일반 shell / 정책 있는 sandbox | [runtime shell](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/sandbox/runtime-shell.ts#L22-L75) |
| 선택한 OS sandbox backend | [sandbox dispatcher](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/sandbox/execute-sandbox.ts#L20-L52) |
| exec 도구에서 code-mode 호출 | [exec invocation](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/tools/exec.ts#L130-L182) |
| QuickJS memory/stack/CPU 경계 | [QuickJS host](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/code-mode/host.ts#L196-L236) |
| send_message에서 hot→cold continuation 선택 | [후속 메시지 caller](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/tools/send-message.ts#L273-L363) |
| AgentCore external input drain·idle wait | [agent reasoning loop](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/agents/runtime/agent-core.ts#L1383-L1425) |
| AgentHeadless의 실제 reasoning loop 호출 | [headless caller](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/agents/runtime/agent-headless.ts#L399-L420) |
| search_memory의 실제 구현 호출 | [memory search invocation](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/tools/search-memory.ts#L41-L110) |
| team task lock 안 expected owner/status 확인 | [team task update](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/agents/team/tasks.ts#L409-L472) |
| board facade의 CLI caller | [board task commands](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/cli/src/commands/board.ts#L131-L174) |

## Moodcode와의 비교

Moodcode `ChildTaskManager.deliver`는 이미 completed/failed/cancelled outcome만 안정된 requestId로 root inbox에 넘기고 durable receipt로 중복을 막는다. `AgentProfiles`는 model/tools/instructions와 immutable revision을 결속한다. `LocalReferenceService`는 제한된 skill/reference 읽기와 source hash를 제공한다. `SemanticMemoryService`는 session history에서 tools 없는 완료된 요약만 provenance와 함께 활성화한다. `PluginToolHooks`는 prepared/settled metadata를 관측하고 fingerprint를 바꾸지 못한다. 관련 실제 경로는 아래 후보마다 기록했다.

따라서 Qwen의 README 기능 이름만 보고 child·profiles·skills·memory·hooks가 Moodcode에 없다고 분류하지 않는다. 다음 후보는 기존 엔진 불변 조건을 유지하면서 늘리는 계약이다. 비용 M은 여러 모듈 계약/진단 확장, L은 storage·scheduler·승인·복구까지 관통하는 변경으로 추정했으며 실제 성능/가치 검증 전 견적이다.

### QWEN-C01 같은 child 세션에 후속 입력을 보내는 상주 실행 계약

우선순위 **P1**, 비용 **L**. 참고 근거: QWEN-R12, QWEN-R13, QWEN-R14, QWEN-R20.

기존 상태: 격리 child/worktree·예산/deny/cancel 상속·terminal 결과 root inbox delivery·queue/steer·pause/resume는 이미 있다. 후보는 child terminal 결과 통지를 대체하지 않고 같은 agent identity의 여러 Run과 살아 있는 입력 mailbox를 연결한다.

관련 Moodcode 경로: `packages/engine/src/child-tasks/index.ts`, `packages/engine/src/child-tasks/engine-host.ts`, `packages/engine/src/child-tasks/storage-binding.ts`, `packages/engine/src/runner/input-scheduler.ts`, `packages/engine/src/agents/index.ts`.

독립 구현 계약:

- host opt-in으로 residentAgentId·workspace/child storage binding·profile revision·policy revision·수명·총 예산과 Run 목록을 저장한다. 이미 terminal인 Run을 다시 running으로 바꾸지 않고 후속 입력마다 새 Run을 만든다.
- 후속 입력은 sender/recipient·messageId·payload hash·sequence·bounded bytes와 durable accepted/delivered/consumed receipt를 가진다. 실행 중에는 안전한 다음 모델 경계에 전달하고 idle에서는 새 Run을 시작한다. 동일 요청 재전송은 같은 receipt를 돌려준다.
- hot reuse는 runtime/catalogue/profile/credential reference/owner lease 일치 시만 허용한다. 재시작 뒤에는 durable transcript와 현재 host 등록을 검사한 cold continuation을 사용하고 이전 prepared 승인/함수 객체를 재사용하지 않는다.
- finishing의 final drain 이후에는 신규 입력을 다음 Run으로 결속하거나 명시적으로 거절한다. archive·parent cancel·revoked grant·storage uncertainty·capacity 부족은 별도 상태로 기록하고 추가 실행을 막는다.
- 상주 시간과 실행 시간을 구분하고 명시적 idle expiry·dispose receipt를 둔다. root의 기존 terminal child-result dedup는 Run별로 유지한다.

검증 조건:

- running→queued input→safe consumption, completed→new Run, idle expiry→cold continuation에서 입력/결과가 정확히 한 owner에 귀속됨.
- final drain과 동시 입력, 이중 follow-up, cancel/archiving, 재시작·DB 실패·lease 변경·profile/registry 변경에서 유실/이중 실행/terminal Run 변경이 없음.
- parent와 nested child의 budget/deny 상한, capacity와 idle cleanup deadline을 유지하고 미확정 cleanup은 다음 실행을 차단함.

### QWEN-C02 여러 agent의 팀 mailbox와 task owner·의존 관계

우선순위 **P2**, 비용 **L**. 참고 근거: QWEN-R14, QWEN-R15, QWEN-R13.

기존 상태: agent profiles, session task CAS, 실제 child와 root 결과 delivery는 구현되어 있다. 후보는 팀 membership·recipient mailbox·task owner/의존성·leader 활동 대기를 추가하는 계층이다.

관련 Moodcode 경로: `packages/engine/src/agents/index.ts`, `packages/engine/src/session-state/index.ts`, `packages/engine/src/child-tasks/index.ts`, `packages/engine/src/runner/input-scheduler.ts`.

독립 구현 계약:

- teamId/membership revision에 leader·agent identity·profile·정책 상한을 host가 등록한다. team 메시지 내용 자체로 agent 생성·모델 교체·권한 승인을 수행하지 않는다.
- bounded per-recipient inbox에 우선순위·sender·messageId·delivery receipt를 기록한다. 없는/terminal recipient, backlog full, team 삭제는 구분된 오류이며 broadcast는 recipient별 성공/실패 receipt를 반환한다.
- 기존 session tasks를 expected revision/owner/status 비교를 갖는 claim/complete 계약으로 확장한다. task dependency edge는 유효한 동일 team ID만 받으며 cycle과 완료 전 unblock을 막는다.
- task claim은 권한·파일 소유권 승인이 아니다. write child는 현재 host의 격리 worktree와 기존 변경 통합 승인에 의존한다.
- leader wait는 message/terminal/timeout/cancel을 분리하고 idle member만 남아 있는 경우를 명시한다. shutdown 요청과 실제 process/runtime 종료 receipt를 별도로 저장한다.

검증 조건:

- 동시 두 agent claim에서 한 owner만 승리하고 stale complete/다른 owner 변경을 거절함.
- sender 위조·recipient 종료·broadcast partial failure·backpressure·동시 team 삭제·재시작에서 receipt와 membership 귀속이 유지됨.
- 의존성 cycle·missing task·owner cancellation·idle 대기·shutdown 거절/timeout이 false completion 또는 무한 대기를 만들지 않음.

### QWEN-C03 이력에서 제안한 프로젝트 기억·skill의 승인된 발행

우선순위 **P1**, 비용 **L**. 참고 근거: QWEN-R09, QWEN-R10, QWEN-R11, QWEN-R19.

기존 상태: bounded context·completed-history semantic summary·active-prefix checkpoint·skill_list/skill_read/reference_read는 이미 있다. 후보는 session 요약과 별개인 프로젝트/사용자 지속 기억 및 신규·기존 skill 변경의 publication 계약이다.

관련 Moodcode 경로: `packages/engine/src/context/semantic-memory.ts`, `packages/engine/src/context/service.ts`, `packages/engine/src/tools/session/skills.ts`, `packages/engine/src/session-state/index.ts`, `packages/engine/src/agents/index.ts`.

독립 구현 계약:

- host opt-in과 독립 budget으로 settled history에서 tools 없는 bounded 제안을 만든다. 기억/skill 후보에 source message IDs·source hash·scope·내용 hash·생성 provider/profile·보존 기간을 저장한다. live instruction이나 승인 규칙으로 자동 승격하지 않는다.
- 신규와 기존 skill 수정 모두 staging에 보관하며 preview와 matching approval 이후 expected old hash/revision을 다시 검사해 발행한다. 이전 skill 직접 수정 후 나중에 stage하는 순서를 가져오지 않는다.
- 기억 tree/search/fetch는 허용 scope와 provenance·버전·aggregate bytes·per-ref coverage를 반환한다. recall의 selected/injected/accepted provenance를 구분하고 ContextPlan의 다른 예약과 함께 실제 상한을 지킨다.
- 통합·forget은 원본 기록을 보존하는 파생 revision이다. secret/민감정보 분류와 사용자가 고른 저장 범위·삭제 정책을 적용하며 프로젝트 간 전이는 명시적 선택을 요구한다.
- shutdown·취소·stage 충돌·publication crash는 published 성공으로 표시하지 않는다. skill body 발행은 allowed tools/hooks를 자동 활성화하지 않으며 기존 host 승인 경계를 유지한다.

검증 조건:

- 동일 이력 재처리와 동시 curator에서 후보 중복을 막고 신규/기존 skill 모두 승인 전 runtime listing에 노출되지 않음.
- approve 뒤 stale preimage·취소·write failure·crash·중복 요청에서 atomic publication receipt와 이전 버전이 보존됨.
- secret fixture·scope 혼선·malicious history·큰 memory tree·반복 fetch·기억 파일 교체·summary eviction에서 예산/provenance와 trust 경계가 유지됨.

### QWEN-C04 제한된 JavaScript로 기존 도구를 조합하는 선택적 code-mode

우선순위 **P2**, 비용 **L**. 참고 근거: QWEN-R08, QWEN-R16, QWEN-R18.

기존 상태: scoped tool runtime·same capture와 ContextPlan·discover_tools·exact prepare/approval/effect·출력 artifact·MCP/PTY/cancel은 이미 있다. 후보는 그 계약 위에서 실행되는 제한된 orchestration 언어다.

관련 Moodcode 경로: `packages/engine/src/tools/runtime/index.ts`, `packages/engine/src/tools/runtime/discovery.ts`, `packages/engine/src/runner/index.ts`, `packages/engine/src/artifacts/result.ts`, `packages/engine/src/ports.ts`.

독립 구현 계약:

- host opt-in의 별도 격리 worker에서 새 실행마다 JS context를 만들고 source/CPU/stack/memory/wall/output cap을 둔다. Node·filesystem·network 접근은 제공하지 않고 고정 도구 binding ID와 schema revision만 노출한다.
- nested call은 같은 host tool runtime에 parentCallId·nestedCallId·snapshot revision으로 접수한다. 각 호출이 기존 prepare/approval/revalidation/effect journal을 통과하며 outer exec 승인으로 내부 모든 도구가 승인되지 않는다.
- read-only independent 호출만 정책이 정한 concurrency에서 병렬화한다. mutation·approval·dependent call은 순서화하며 settlement와 일부 실패는 호출별 artifact/receipt를 유지한다.
- 취소·worker exit·script 완료 후 미완료 promise는 abort하고 실제 cleanup을 확인한다. nested mutation 효과가 미확정이면 outer 성공을 기록하지 않으며 recovery frontier를 유지한다.
- 프로그램 결과가 출력되지 않아 모델에 도달하지 않은 skill/memory payload를 이미 context에 들어갔다고 표시하지 않는다. 출력 budget과 context reservation을 실제 전송 값에 적용한다.

검증 조건:

- read 병렬 조합·mutation 직렬 조합과 일부 promise rejection에서 독자 tool fixture의 승인/효과/receipt 순서가 보존됨.
- 무한 루프·과다 memory/output·unknown binding·registry 변경·Plan·revoked approval·recursive exec·미await 호출이 상한 또는 policy 우회를 만들지 않음.
- worker crash·cancel·MCP timeout·성공 효과 이후 출력 실패에서 미확정 상태를 보존하고 동일 nested request의 재실행을 막음.

### QWEN-C05 승인 binding을 유지하는 lifecycle hook 추가 계약

우선순위 **P2**, 비용 **M**. 참고 근거: QWEN-R04, QWEN-R17, QWEN-R08, QWEN-R19.

기존 상태: host plugin activation/disposal과 prepared/settled metadata 관측 hooks가 이미 있다. 후보는 prompt/session/context/terminal lifecycle 관측과 제한된 다음-turn 제안이다.

관련 Moodcode 경로: `packages/engine/src/plugins/index.ts`, `packages/engine/src/runner/index.ts`, `packages/engine/src/runner/input-scheduler.ts`, `packages/engine/src/context/service.ts`, `packages/engine/src/tools/runtime/index.ts`.

독립 구현 계약:

- host가 event type/version·plugin identity/revision·allowed metadata·budget·cancel/dispose를 사전 등록한다. 기본 동작은 관측이며 local skill 경로를 executable hook으로 자동 실행하지 않는다.
- prompt/context/terminal event의 immutable identity와 delivered receipt를 저장한다. async observer failure는 이미 완료된 producer 효과를 뒤집지 않고 diagnostics로 남긴다.
- 추가 문맥이나 계속 실행 제안은 bounded untrusted payload로 다음 입력/ContextPlan 경계에 접수한다. hook은 prepared arguments·fingerprint·policy·승인된 효과를 바꾸거나 approve 결정을 덮어쓰지 못한다.
- terminal 이후 계속 실행 요청은 새 Run이므로 기존 Run terminal 불변을 유지한다. 연속 제안 횟수·중복 이유·총 예산 cap과 사용자 cancel 우선순위를 둔다.
- command/HTTP/prompt hook이 꼭 필요하면 별도 host executor와 credential reference, process ownership/timeout/network allowlist 계약을 준비한다. upstream의 non-blocking_error 또는 allow-on-hook-failure는 Moodcode 권한 허가로 해석하지 않는다.

검증 조건:

- metadata observer가 prepared fingerprint를 변경할 수 없고 observer throw 뒤 producer 결과/효과가 유지됨.
- 동일 event 재전송·async callback 지연·terminal 경합·cancel/close·registry revoke에서 receipt 소유권과 cleanup이 유지됨.
- 반복 continuation·과다 context·hook failure/timeout·prompt injection이 승인 우회나 무한 Run 생성으로 이어지지 않음.

## 라이선스·서비스 경계

root 실제 LICENSE는 Apache-2.0(R02)이다. 별도 하위 파일은 [VS Code: Apache-2.0](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/vscode-ide-companion/LICENSE#L1-L15), [Zed: MIT](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/zed-extension/LICENSE#L1-L15), [mobile-mcp: Apache-2.0](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/mobile-mcp/LICENSE#L1-L15), [Java SDK: Apache-2.0](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/sdk-java/qwencode/LICENSE#L1-L15)로 확인했다. Google/Qwen의 source header는 각 근거 범위에 남아 있으므로 root license 하나로 출처가 모두 같다고 표시하지 않는다.

선택한 auth/provider에 따라 Qwen·Alibaba Cloud·API provider·Vertex 서비스 약관/개인정보 정책이 별도로 적용된다고 저장소 문서는 설명한다. 브라우저 결과가 모델 provider로 전달되거나 로컬 기록에 남을 수 있다는 설명도 별도다. 이는 고정 문서의 설명이며 각 원격 약관의 현재 효력·모델 가중치 license·서비스 데이터 흐름 전체를 조사한 결과는 아니다. [auth/service 문서](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/docs/users/support/tos-privacy.md#L3-L21), [browser data 문서](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/docs/users/support/tos-privacy.md#L63-L83)

이 변경에는 분석·출처·독립 동작 계약만 포함했다. upstream source/prompt/tool description/fixture/미디어를 복사하거나 runtime 의존성으로 추가하지 않았다. 원본을 읽었으므로 clean-room 절차를 수행했다고 주장하지 않는다. 배포 의존성 전체 audit·법률 검토도 아니다.

## 대표 고정 소스 근거

아래 20개는 [evidence JSON](qwen-code.evidence.json)의 references와 일치한다. 모두 전체 SHA를 고정한 source permalink이며 범위는 각각 160줄 이하이다. 추가 inventory 링크도 같은 SHA를 사용한다.

| ID/고정 소스 | 파일·줄 | 뒷받침하는 주장 |
|---|---|---|
| [QWEN-R01](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/README.md#L212-L214) | README.md:212–214 | README는 Gemini CLI v0.8.2 기원을 밝히고 v0.1부터 upstream sync를 중단한 독립 개발이라고 주장한다. |
| [QWEN-R02](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/LICENSE#L1-L23) | LICENSE:1–23 | 실제 root LICENSE는 Apache License 2.0이다. 하위 Zed의 별도 MIT와 서비스 약관은 보고서에서 구분한다. |
| [QWEN-R03](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/cli/src/nonInteractiveCli.ts#L2534-L2693) | packages/cli/src/nonInteractiveCli.ts:2534–2693 | headless caller가 LlmClient.sendMessageStream의 도구 요청을 수집하고 processToolCallBatch를 호출한다. structured_output 성공은 별도 종료 경로다. |
| [QWEN-R04](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/client.ts#L4833-L4905) | packages/core/src/core/client.ts:4833–4905 | LlmClient가 MessageDisplay dispatcher를 구성하고 Turn.run을 소비한다. 모델 입력 수락 뒤 기억의 resident body와 steer 수락 상태를 갱신한다. |
| [QWEN-R05](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/turn.ts#L714-L859) | packages/core/src/core/turn.ts:714–859 | Turn.run은 LlmChat.sendMessageStream에 abortSignal을 넘기고 retry/fallback 상태 초기화, 압축 이벤트, text/thought/function-call 요청을 변환한다. |
| [QWEN-R06](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/llm-chat.ts#L3127-L3280) | packages/core/src/core/llm-chat.ts:3127–3280 | 전체 window와 추정/직전 API usage를 기반으로 사전 압축·hard rescue를 수행한다. 압축 뒤에도 상한을 넘으면 이전 history/count를 복구하며 JSONL checkpoint 기록을 미룬다. |
| [QWEN-R07](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/contentGenerator.ts#L530-L630) | packages/core/src/core/contentGenerator.ts:530–630 | 검증한 authType에 따라 OpenAI Chat/Responses, Qwen OAuth, Anthropic, Gemini/Vertex 구현을 lazy loading하고 LoggingContentGenerator로 감싼다. |
| [QWEN-R08](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/coreToolScheduler.ts#L5813-L5931) | packages/core/src/core/coreToolScheduler.ts:5813–5931 | 도구 invocation 실행 직전 executing 상태와 span을 시작한다. exec/tool_search에 parentCallId·허용 도구 목록과 nested scheduler dispatch를 제공한다. |
| [QWEN-R09](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/client.ts#L3052-L3206) | packages/core/src/core/client.ts:3052–3206 | 종료 중에는 background 기억을 시작하지 않으며 autoSkill 임계치·변경 여부·확인 설정을 scheduleSkillReview에 전달한다. managed memory가 켜진 UserQuery 경로는 extraction/dream을 예약한다. |
| [QWEN-R10](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/memory/search-memory.ts#L908-L1067) | packages/core/src/memory/search-memory.ts:908–1067 | search_memory는 scope/category/keyword 검색과 ref fetch를 분리하고 snapshot·버전/coverage·turn별 ref 소진·aggregate body budget·취소를 확인한다. 검색은 keyword scoring과 rarity bonus다. |
| [QWEN-R11](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/memory/manager.ts#L1363-L1474) | packages/core/src/memory/manager.ts:1363–1474 | skill review는 enabled/변경/임계치/중복 실행/메모리 압력 gate를 거친다. confirmBeforePersist일 때 사전 skill directory 집합과 변경 파일을 사용해 pending skill을 stage한다. |
| [QWEN-R12](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/agents/background-agent-resume.ts#L690-L832) | packages/core/src/agents/background-agent-resume.ts:690–832 | 완료된 background agent의 cold revive는 registry/기록/metadata·capacity를 확인한다. container/executionBackend 기록은 차단하고 completed snapshot을 보존해 resume 실패 시 되돌린다. |
| [QWEN-R13](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/agents/background-agent-resume.ts#L1494-L1575) | packages/core/src/agents/background-agent-resume.ts:1494–1575 | resident continuation은 runtime 수명·auto permission lease·capacity를 확인하고 새 AbortController로 직전 turn 뒤에 새 turn을 직렬 연결한다. 조건에 따라 fallback/capacity_wait/continued를 반환한다. |
| [QWEN-R14](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/agents/team/TeamManager.ts#L784-L897) | packages/core/src/agents/team/TeamManager.ts:784–897 | team sendMessage는 leader inbox와 teammate queue를 구분하며 shutdown 응답·recipient·종료·pending cap을 처리한다. 살아 있는 idle teammate는 메시지를 즉시 flush한다. |
| [QWEN-R15](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/agents/team/board-tasks.ts#L178-L237) | packages/core/src/agents/team/board-tasks.ts:178–237 | 독립 board task의 mutate는 item lock 안에서 상태를 읽고 mode0600 atomic write한다. claim은 다른 owner의 선점을 막고 complete는 본인 소유 in_progress를 요구한다. |
| [QWEN-R16](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/code-mode/host-client.ts#L116-L273) | packages/core/src/code-mode/host-client.ts:116–273 | code-mode는 source/time/output cap과 별도 host process를 사용한다. JS 이름을 고정 도구 이름에 매핑하고 runtime dispatch로 요청하며 abort/완료 시 미완료 nested 호출을 취소한다. |
| [QWEN-R17](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/hooks/hookRunner.ts#L675-L788) | packages/core/src/hooks/hookRunner.ts:675–788 | HookRunner는 command/HTTP/function/prompt 및 async command 실행으로 분기한다. 사전 abort는 cancelled, 실행 오류는 non_blocking_error 결과로 반환한다. |
| [QWEN-R18](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/tools/mcp-tool.ts#L617-L752) | packages/core/src/tools/mcp-tool.ts:617–752 | MCP invocation은 direct SDK client 또는 callable wrapper를 사용한다. direct call은 progress, 전체/idle timeout, parent abort race, invocation metadata와 MCP App 결과 경계를 처리한다. |
| [QWEN-R19](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/services/chatRecordingService.ts#L1594-L1730) | packages/core/src/services/chatRecordingService.ts:1594–1730 | 기록은 operationTail로 순서화하고 Managed sink/lease append/legacy JSONL 중 하나에 쓴다. 첫 write failure는 recorder를 중지하며 strict append와 fire-and-forget의 실패 계약이 다르다. |
| [QWEN-R20](https://github.com/QwenLM/qwen-code/blob/d0ddd020c8a64279e290538f84b152fe843ed9d4/packages/core/src/core/session-recovery.ts#L137-L247) | packages/core/src/core/session-recovery.ts:137–247 | 세션 복구는 원 history와 clone을 분리하고 orphan 도구 결과·중복 결과를 수리한다. missing-parent history는 자동 계속을 차단하고 interrupted tool turn은 사용자 확인을 요구한다. |

## 확인하지 못한 범위

- upstream 설치·setup·테스트·벤치마크·GUI·계정/credential 연결·실제 모델/서비스 호출은 수행하지 않았다. 소스 경로 확인은 실행 성공·성능·모델 품질의 증명이 아니다.
- 로컬 full HEAD와 마지막 commit 날짜만 유지보수 단서로 확인했다. 원격 최신 release·issue 대응·외부 서비스 availability를 실측하지 않았다.
- README의 zero setup, any provider/local model, desktop/IDE/chat 통합과 Qwen 모델 open-source 주장은 전체 구현/모델 license audit 또는 호환성 검증을 뜻하지 않는다.
- core client/chat/scheduler, resident background agent/team/board, auto memory/skills, code-mode/hook/MCP 및 기록/복구를 중심으로 읽었다. daemon/Managed session authority·workflow/arena·Omni media·채널·CUA·SDK의 전체 경로와 전이 의존성은 감사하지 않았다.
- shell sandbox는 선택적 policy 경로와 bwrap/Landlock dispatcher 호출부를 확인했다. 정책이 없으면 일반 ShellExecutionService로 가며 실제 OS 격리 보장·remote/container cleanup을 실행 검증하지 않았다.
- 세션 recovery의 synthetic failed tool result는 history pairing 보정이다. 실제 파일·외부 서비스 효과가 없었다는 증명이나 재실행 안전성 증명으로 취급하지 않았다.
- root Apache-2.0과 별도 하위 LICENSE 파일을 읽었다. 서비스 이용 약관/모델 가중치/전체 의존성 license audit·법률 검토는 수행하지 않았다.
- Moodcode production code·원본 checkout을 수정하지 않았다. 담당 두 문서만 만들고 upstream source/prompt/tool description/fixture/미디어를 복사하거나 runtime 의존성으로 추가하지 않았다. 원본을 읽었으므로 clean-room 분석이라고 주장하지 않는다.
