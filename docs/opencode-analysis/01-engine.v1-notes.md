# V1 엔진 조사 메모

기준 커밋: `907b3bc518fa48e90e8ec24dd327d13eee71c36c`. 아래 구현 설명은 고정 커밋의 **정적 사실**이다. 실행 확인은 격리된 원본 Runner 25개 테스트에 한정하며, 전체 세션 통합 테스트나 실제 원격 provider 실행을 의미하지 않는다. 원본 저장소는 읽기 전용으로 조사했다.

## 3.1 실제 진입점과 입력 저장

V1 HTTP 핸들러는 `SessionPrompt.Service`의 `prompt`, `loop`, `command`, `shell`, `cancel`을 직접 호출한다. `prompt`는 세션 조회와 revert cleanup 후 사용자 메시지를 만들고 touch한 다음 `loop`를 호출한다. `createUserMessage`는 agent/model 선택을 먼저 세션에 반영하고 입력 part를 해석한 뒤 `chat.message` hook, 이미지 정규화, 메시지 저장, 각 part 저장을 순서대로 수행한다. `noReply`면 저장한 사용자 메시지를 반환한다. 동기 HTTP prompt는 최종 `WithParts` 결과를 JSON stream으로 반환하고, `promptAsync`는 전체 prompt effect를 handler Scope에 fork하고 NoContent를 반환한다. 따라서 async 응답 자체가 사용자 메시지와 모든 part의 원자적 durable admission을 확인하는 시점은 아니다. [handlers/session.ts:275–329](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L275-L329) [prompt.ts:635–699](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L635-L699) [prompt.ts:995–1071](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L995-L1071)

`loop`는 `SessionRunState.ensureRunning(sessionID, lastAssistant, runLoop)`에 들어간다. 이미 같은 runner가 Running이면 새 work를 실행하지 않고 기존 run의 Deferred 결과에 합류한다. 새 prompt의 사용자 메시지는 이 합류 **전에** 이미 저장되므로, 실행 중 새 입력은 다음 반복의 transcript 조회에서 관찰된다. 이는 durable inbox에 별도 `queue`/`steer` delivery를 admission하는 V2 계약과 구별된다. V1 `PromptInput`에 delivery/resume/queue/steer 필드는 없고 `noReply`만 있다. Slash command는 template·shell expansion과 agent/model 선택 뒤 prompt로 들어가며, subagent command는 `subtask` part를 만든다. CLI `run`은 legacy SDK의 session.prompt/command를 호출한다. [prompt.ts:1343–1481](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L1343-L1481) [prompt.ts:1499–1520](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L1499-L1520) [runner.ts:115–138](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/effect/runner.ts#L115-L138) [cli/cmd/run.ts:828–878](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/cli/cmd/run.ts#L828-L878)

## 3.2 history reload와 loop 종료

`runLoop`는 세션 객체를 입장 시 한 번 읽고 `step=0`을 둔다. 매 반복 busy 상태를 내보내고 DB projection에서 `MessageV2.filterCompactedEffect`로 현재 활성 history를 다시 읽는다. `latest`는 compaction 후 배열 재배치에도 생성시각과 ID로 최신 user/assistant/finished를 찾는다. 종료는 최신 assistant의 finish가 `tool-calls`/`unknown` 외의 값이고, provider가 자체 실행한 도구나 interrupted orphan을 제외한 로컬 tool part가 없으며, assistant.parentID가 최신 user.id와 같을 때다. 따라서 provider가 `stop`과 로컬 tool call을 함께 보내면 다음 LLM 호출로 tool 결과를 회신하고, 도중 저장된 새 user가 있으면 이전 assistant의 stop으로 끝나지 않는다. pending/running transcript tool은 model-message 변환 시 interrupted 오류로 표현하며 도구를 그대로 재실행하는 복구 루프는 아니다. [prompt.ts:1081–1179](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L1081-L1179) [message-v2.ts:525–609](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/message-v2.ts#L525-L609) [message-v2.ts:297–360](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/message-v2.ts#L297-L360)

`step++`는 subtask/compaction dispatch보다 먼저 수행되며 새 사용자 입력이나 compaction 후에 초기화되지 않는다. tasks.pop으로 subtask를 처리하거나 compaction.process를 실행한 뒤 continue하고, 마지막 완료 응답의 사용량이 overflow면 compaction marker를 생성한다. 일반 turn은 assistant 메시지를 먼저 저장하고 Processor handle을 만든 다음 tool과 system/history를 구성한다. 첫 step의 title 생성 및 snapshot summary 계산, 끝의 prune는 service Scope의 별도 fiber에 fork되고 오류는 ignore한다. title은 첫 실제 사용자 입력의 기본 이름인 root 세션만 대상으로 별도 title agent와 small model을 사용한다. `SessionSummary.summarize`는 파일 snapshot diff 계산이며 LLM 대화 요약은 `SessionCompaction.process`의 일이다. [prompt.ts:193–253](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L193-L253) [prompt.ts:1132–1255](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L1132-L1255) [prompt.ts:1319–1341](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L1319-L1341) [summary.ts:82–129](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/summary.ts#L82-L129)

## 3.3 Processor의 part·tool·실패·retry 계약

Processor는 AI SDK/normalized LLM event를 받아 text/reasoning part, pending→running→completed/error tool part, step-start/finish, snapshot patch 및 사용량을 저장한다. `create`는 stream이 도구를 실행하기 전에 snapshot을 먼저 잡는다. text/reasoning delta는 live delta event로 발행하고 end/cleanup에서 전체 part를 저장한다. Tool resolve 경계는 EffectBridge로 instance/workspace context를 유지한 채 plugin before→실제 tool→plugin after를 Promise execute에 감싼다. 실제 도구 실행과 abortSignal은 기본 경로에서 AI SDK가 소유하고 Processor는 event·metadata·결과를 영속 transcript로 연결한다. Permission/Question 거절은 기본 설정에서 blocked로 다음 loop를 정지시키고, 일반 tool 오류는 tool-error part로 남아 다음 model turn에서 보일 수 있다. Doom-loop 검사는 현재 assistant의 마지막 3개 part에서 동일 도구/input을 확인한다. [processor.ts:98–253](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/processor.ts#L98-L253) [processor.ts:331–497](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/processor.ts#L331-L497) [processor.ts:500–550](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/processor.ts#L500-L550) [tools.ts:41–134](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/tools.ts#L41-L134)

`process`의 외부 retry는 동일 assistant handle과 동일 streamInput을 다시 사용하며 매 retry에 currentText/reasoningMap을 초기화한다. retry 정책은 context overflow를 제외하고 retryable/API 5xx/알려진 transient 메시지를 분류하며 최대 retry 5와 retry-after 또는 지수 backoff·jitter를 사용한다. retry 상태에는 attempt/message/next를 내보낸다. overflow는 compact로, blocked/assistant.error는 stop으로, 그 외는 continue로 반환한다. interruption은 AbortError를 기록하고 cleanup을 실행한다. cleanup은 남은 snapshot/text/reasoning을 마무리하고 tool Deferred 완료를 최대 **250ms** 기다린 뒤 미완료 tool을 `Tool execution aborted`, `metadata.interrupted=true` 오류로 닫으며 assistant.completed를 저장한다. 이 grace는 도구의 durable exactly-once나 crash 후 실행 재개 계약이 아니다. [processor.ts:553–611](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/processor.ts#L553-L611) [processor.ts:613–695](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/processor.ts#L613-L695) [retry.ts:26–86](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/retry.ts#L26-L86) [retry.ts:183–207](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/retry.ts#L183-L207)

## 3.4 Runner 상태·동시성·취소

Runner의 `SynchronizedRef` 상태는 아래 네 가지다. SessionRunState는 `InstanceState.make` 내부의 sessionID→Runner Map을 사용하고 InstanceState cache key는 `InstanceRef.directory`다. 따라서 동일 service runtime/instance(directory) 안에서 세션별 실행이 직렬화되고 서로 다른 sessionID는 별도 runner를 얻는다. 여러 directory/runtime 전체에 대한 전역 session lock으로 일반화할 수 없다. status 또한 InstanceState Map으로 busy/retry를 유지하고 idle이면 항목을 삭제한다. [runner.ts:33–138](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/effect/runner.ts#L33-L138) [run-state.ts:35–105](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/run-state.ts#L35-L105) [instance-state.ts:26–50](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/effect/instance-state.ts#L26-L50) [status.ts:26–48](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/status.ts#L26-L48)

| 상태 | 입장/전이 계약 |
|---|---|
| Idle | ensureRunning은 instance Scope에 run을 fork; startShell은 shell을 시작 |
| Running | ensureRunning 호출자는 동일 run Deferred에 합류; startShell은 Busy |
| Shell | ensureRunning은 단 하나의 대기 run을 만들어 ShellThenRun으로; 추가 shell은 Busy |
| ShellThenRun | 추가 ensureRunning은 대기 run에 합류; shell 완료 후 그 run을 시작 |

취소는 synchronized state를 먼저 Idle로 바꾼 다음 이전 fiber interruption/cleanup을 기다린다. 이전 run의 finish는 현재 run id가 같은 경우에만 idle 전이를 수행하므로, interruption cleanup이 아직 끝나기 전에 시작된 replacement를 이전 완료가 지우지 않는다. Shell 취소는 transcript setup의 ready latch를 기다리고 실제 child process를 중단한다. 부모 취소는 background job의 sessionId/parentSessionId 연결을 재귀적으로 찾아 취소한다. 실행 중 waiter의 수와 저장 사용자 입력 수가 각각 독립적이므로 테스트의 “queued callers”를 사용자 turn FIFO inbox로 읽으면 안 된다. 원본 runner.ts를 변경 없이 복사하고 원본 runner.test.ts의 두 import만 격리 경로로 바꿔 실행한 결과 **25 pass, 0 fail, 60 expect**였다(Bun 1.3.14, effect 4.0.0-beta.83). 이는 Runner 동시성/취소 단위 검증이며 V1 전체 통합 실행은 아니다. [runner.ts:70–113](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/effect/runner.ts#L70-L113) [runner.ts:140–202](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/effect/runner.ts#L140-L202) [run-state.ts:111–143](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/run-state.ts#L111-L143) [runner.test.ts:206–249](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/test/effect/runner.test.ts#L206-L249)

## 3.5 task child·background와 compaction

TaskTool은 promptOps를 주입받아 child 세션에서 다시 `SessionPrompt.prompt`를 호출한다. task_id가 있으면 기존 child transcript에 새 user를 추가하여 재사용하고 조회 실패면 child를 새로 만든다. 새 child의 parentID는 호출 세션이며 parent chain에 대한 subagent_depth(기본 1) 한계를 검사한다. parent session의 external_directory 규칙과 명시적 deny를 상속하고, child agent 자체의 permission 및 task/todowrite 제한과 합친다. parent agent의 모든 permission을 복사하는 방식은 아니다. explicit agent mention/slash subtask의 bypassAgentCheck는 task agent 선택 확인을 건너뛰지만 depth 검사까지 제거하지 않는다. foreground task는 부모 abort→child cancel을 연결하고, background start/extend/promotion은 같은 child 세션을 이어가며 완료 내용을 부모의 synthetic prompt로 알린다. legacy BackgroundJob wrapper는 instance scoped이며 core registry 자체도 메모리 Map/Scope여서 process restart 복구를 약속하지 않는다. [task.ts:104–224](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/tool/task.ts#L104-L224) [task.ts:227–355](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/tool/task.ts#L227-L355) [subagent-permissions.ts:1–27](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/agent/subagent-permissions.ts#L1-L27) [background/job.ts:18–35](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/background/job.ts#L18-L35) [core/background-job.ts:112–135](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/background-job.ts#L112-L135)

V1 compaction은 user compaction marker→hidden compaction agent의 summary assistant→성공한 summary의 `tail_start_id` 및 history 재배치라는 transcript 방식이다. 수동 summarize HTTP는 marker를 만들고 prompt.loop를 실행한다. 선택기는 token 추정값과 preserve budget으로 최근 user turn을 보존하고, 큰 turn의 뒤 message suffix도 보존할 수 있다. head는 text/reasoning/tool을 plain transcript로 serialize하여 tools={}로 summary LLM에 보낸다. 성공한 summary만 이전 history를 잘라내는 기준이며 재조회에서는 marker, summary, retained tail 순서로 재배치한다. auto compaction은 원래 user의 내용·format·system을 복사해 replay하거나 synthetic continue user를 생성하고, overflow면 실패 원인이 된 최근 turn을 summary에서 제외해 replay하려 시도한다. prune는 최근 tool output 약 40k token을 보호하고 20k 초과 제거 가능할 때 완료 tool의 time.compacted만 기록한다(skill 제외); 저장 output을 삭제하지 않고 model replay에서 placeholder로 치환한다. [compaction.ts:115–265](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/compaction.ts#L115-L265) [compaction.ts:273–314](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/compaction.ts#L273-L314) [compaction.ts:319–554](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/compaction.ts#L319-L554) [message-v2.ts:525–576](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/message-v2.ts#L525-L576) [handlers/session.ts:275–293](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L275-L293)

## 3.6 structured output·maxSteps·영속 상태와 V2 경계

JSON schema format이면 일반 도구 집합에 `StructuredOutput` 도구를 추가하고 toolChoice=required를 지정한다. execute callback이 캡처한 output을 processor 종료 후 assistant.structured에 저장하고 loop를 끝낸다. 정상 종료했는데 output이 없으면 StructuredOutputError(retries:0)를 기록한다. format.retryCount는 schema와 저장 테스트에 존재하지만 이 loop의 구조화 출력 repair/retry 제어에는 사용되지 않는다. “한 번 호출”은 system prompt 지시이며 execute 자체의 중복 호출 차단은 없다. agent.steps(설정 maxSteps가 정규화된 필드)는 step>=steps 때 MAX_STEPS_PROMPT를 append할 뿐 도구를 제거하거나 강제 종료하지 않는다. 기본 LLM 경계는 `streamText`에 tools/toolChoice/abortSignal/maxRetries를 넘기고 normalized fullStream을 Processor가 읽는다. legacy LLM의 native runtime flag는 provider transport 경로 선택이며 SessionPrompt/Processor/Runner를 V2 Runner로 전환하는 스위치가 아니다. [prompt.ts:1178–1286](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L1178-L1286) [prompt.ts:1288–1316](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L1288-L1316) [prompt.ts:1565–1590](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/prompt.ts#L1565-L1590) [llm.ts:224–381](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/llm.ts#L224-L381)

`MessageV2`라는 legacy 파일명이나 `EventV2Bridge`라는 공통 이벤트 전달 이름은 V2 orchestration 실행의 증거가 아니다. V1의 message.updated/part.updated는 sessionID aggregate의 durable v1 event이며, core Event는 **각 이벤트 단위**로 projector·event sequence·event row를 한 DB transaction에 commit한 뒤 알린다. Session.updateMessage/updatePart는 이를 await하므로 다음 history 조회에서 projection을 읽지만 사용자 메시지와 여러 part 전체를 한 admission transaction으로 묶지 않는다. 델타는 live-only이며 전체 part snapshot으로 최종 보존된다. Runner/status/provider attempt/BackgroundJob 소유권은 메모리 상태다. system은 turn마다 env/instruction/skill/MCP 정보로 구성하고 session.permission은 run 입장 시 읽은 session 객체를 사용한다. V2의 durable inbox, Context Epoch, attempt identity, tool turn closure, recovery ownership 계약을 이 경로에 그대로 적용해서는 안 된다. [session.ts:629–647](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/session.ts#L629-L647) [schema/v1/session.ts:502–506](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/schema/src/v1/session.ts#L502-L506) [schema/v1/session.ts:596–638](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/schema/src/v1/session.ts#L596-L638) [core/event.ts:237–366](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/event.ts#L237-L366) [event-v2-bridge.ts:19–63](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/event-v2-bridge.ts#L19-L63) [prompt.test.ts:583–632](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/test/session/prompt.test.ts#L583-L632)

## 조사 범위 JSON

```json
{
  "commit": "907b3bc518fa48e90e8ec24dd327d13eee71c36c",
  "reviewed": [
    "AGENTS.md",
    "packages/opencode/AGENTS.md",
    "packages/opencode/test/AGENTS.md",
    "packages/opencode/src/server/routes/instance/httpapi/AGENTS.md",
    "packages/opencode/src/session/prompt.ts",
    "packages/opencode/src/session/processor.ts",
    "packages/opencode/src/session/run-state.ts",
    "packages/opencode/src/session/status.ts",
    "packages/opencode/src/session/compaction.ts",
    "packages/opencode/src/session/overflow.ts",
    "packages/opencode/src/session/retry.ts",
    "packages/opencode/src/session/revert.ts",
    "packages/opencode/src/session/summary.ts",
    "packages/opencode/src/session/system.ts",
    "packages/opencode/src/session/instruction.ts",
    "packages/opencode/src/session/reminders.ts",
    "packages/opencode/src/session/llm.ts",
    "packages/opencode/src/effect/runner.ts",
    "packages/opencode/src/effect/run-service.ts",
    "packages/opencode/src/effect/instance-state.ts",
    "packages/opencode/src/effect/app-runtime.ts",
    "packages/opencode/src/effect/app-node-builder-v1.ts",
    "packages/opencode/src/effect/bootstrap-runtime.ts",
    "packages/opencode/src/effect/bridge.ts",
    "packages/opencode/src/agent/agent.ts",
    "packages/opencode/src/agent/subagent-permissions.ts",
    "packages/opencode/src/tool/task.ts",
    "packages/opencode/src/background/job.ts",
    "packages/opencode/src/event-v2-bridge.ts",
    "packages/opencode/test/effect/runner.test.ts",
    "packages/opencode/test/lib/effect.ts",
    "packages/opencode/test/session/structured-output-integration.test.ts",
    "packages/opencode/test/agent/plan-mode-subagent-bypass.test.ts"
  ],
  "sampled": [
    {
      "path": "packages/opencode/src/session/session.ts",
      "ranges": [
        "430-915"
      ]
    },
    {
      "path": "packages/opencode/src/session/message-v2.ts",
      "ranges": [
        "1-605",
        "640-741"
      ]
    },
    {
      "path": "packages/opencode/src/session/tools.ts",
      "ranges": [
        "1-185",
        "260-385"
      ]
    },
    {
      "path": "packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts",
      "ranges": [
        "35-442"
      ]
    },
    {
      "path": "packages/opencode/src/server/routes/instance/httpapi/groups/session.ts",
      "ranges": [
        "SessionPaths and prompt/abort/command/shell/summarize definitions"
      ]
    },
    {
      "path": "packages/opencode/src/cli/cmd/run.ts",
      "ranges": [
        "828-878"
      ]
    },
    {
      "path": "packages/opencode/src/cli/cmd/github.handler.ts",
      "ranges": [
        "378-388",
        "897-935"
      ]
    },
    {
      "path": "packages/core/src/session/projector.ts",
      "ranges": [
        "legacy SessionV1 projector registrations 210-335",
        "455 node dependencies"
      ]
    },
    {
      "path": "packages/core/src/event.ts",
      "ranges": [
        "217-419",
        "615 project registration",
        "638 global node"
      ]
    },
    {
      "path": "packages/core/src/background-job.ts",
      "ranges": [
        "1-210"
      ]
    },
    {
      "path": "packages/core/src/v1/session.ts",
      "ranges": [
        "type reexports/errors"
      ]
    },
    {
      "path": "packages/schema/src/v1/session.ts",
      "ranges": [
        "502-506",
        "596-638"
      ]
    },
    {
      "path": "packages/opencode/test/session/prompt.test.ts",
      "ranges": [
        "447-1499",
        "1539-1987",
        "2058-2169",
        "2386-2470",
        "remaining test names"
      ]
    },
    {
      "path": "packages/opencode/test/session/processor-effect.test.ts",
      "ranges": [
        "240-1171",
        "setup/test names"
      ]
    },
    {
      "path": "packages/opencode/test/session/compaction.test.ts",
      "ranges": [
        "382-1663",
        "setup/test names"
      ]
    },
    {
      "path": "packages/opencode/test/session/structured-output.test.ts",
      "ranges": [
        "1-298",
        "remaining test names"
      ]
    },
    {
      "path": "packages/opencode/test/session/snapshot-tool-race.test.ts",
      "ranges": [
        "126-189"
      ]
    },
    {
      "path": "packages/opencode/test/agent/agent.test.ts",
      "ranges": [
        "config/mode/permission tests and steps/maxSteps normalization",
        "remaining test names"
      ]
    },
    {
      "path": "packages/opencode/test/tool/task.test.ts",
      "ranges": [
        "1-275",
        "all test names"
      ]
    }
  ],
  "excluded": [
    {
      "path": "packages/opencode/src/session/llm/*",
      "reason": "provider transport/internal request details: 03-models; only outer llm.ts engine seam reviewed"
    },
    {
      "path": "packages/opencode/src/session/prompt/*.txt",
      "reason": "model-family prompt content: 03-models; selection/system assembly reviewed"
    },
    {
      "path": "packages/opencode/src/session/todo.ts",
      "reason": "leaf task-state implementation: 02-tools/05-data-api"
    },
    {
      "path": "packages/opencode/src/session/message.ts",
      "reason": "legacy compatibility details outside runtime control seam"
    },
    {
      "path": "packages/opencode/src/session/schema.ts",
      "reason": "reexport/typed schema details: 05-data-api; engine use sampled indirectly"
    },
    {
      "path": "packages/opencode/src/session/message-error.ts",
      "reason": "small shared error schema read; not central engine implementation"
    },
    {
      "path": "packages/opencode/src/provider/*",
      "reason": "03-models"
    },
    {
      "path": "packages/opencode/src/tool/* except task.ts",
      "reason": "02-tools; registry/execute boundary only"
    },
    {
      "path": "packages/opencode/src/mcp/* and lsp/*",
      "reason": "06-extensions; engine attachment/tool seams only"
    },
    {
      "path": "packages/tui/*",
      "reason": "04-tui/07-clients; root independently checked legacy SDK input call"
    },
    {
      "path": "specs/effect/migration.md",
      "reason": "referenced by package AGENTS but absent in fixed checkout"
    }
  ],
  "tests": {
    "executed": {
      "file": "packages/opencode/test/effect/runner.test.ts",
      "result": "25 pass, 0 fail, 60 expect",
      "runner_source": "unchanged copy",
      "test_changes": "only two import paths",
      "harness": "minimal original isolatedRun/it.live TestConsole scoped helper",
      "environment": "Bun 1.3.14 / effect@4.0.0-beta.83",
      "directory": "/var/folders/zr/vy43gthn00q9wntc4xvs_k8h0000gn/T/opencode-01-engine-7z3udhu2/v1-runner",
      "command": "../node_modules/.bin/bun test runner.test.ts --timeout 30000"
    },
    "executed_names": [
      "ensureRunning starts work and returns result",
      "ensureRunning propagates work failures",
      "concurrent callers share the same run",
      "concurrent callers all receive same error",
      "ensureRunning can be called again after previous run completes",
      "second ensureRunning ignores new work if already running",
      "cancel interrupts running work",
      "cancel on idle is a no-op",
      "cancel with onInterrupt resolves callers gracefully",
      "cancel with queued callers resolves all",
      "work can be started after cancel",
      "cancel does not deadlock when replacement work starts before interrupted run exits",
      "shell runs exclusively",
      "shell rejects when run is active",
      "shell rejects when another shell is running",
      "cancel interrupts shell",
      "cancel does not mask shell defects",
      "ensureRunning queues behind shell then runs after",
      "multiple ensureRunning callers share the queued run behind shell",
      "cancel during shell_then_run cancels both",
      "onIdle fires when returning to idle from running",
      "onIdle fires on cancel",
      "onBusy fires when shell starts",
      "busy is true during run",
      "busy is true during shell"
    ],
    "static_only": [
      "prompt.test.ts: legacy events; stop/unknown/tool-calls; stop with local tools; concurrent callers and active new user; cancellation before processor creation; subtask and slash-child cancel; shell→loop; missing/read-attachment/order cases",
      "processor-effect.test.ts: text/reasoning lifecycle; usage overflow; retry states; midstream/network errors; tool completion; 250ms orphan cleanup; interruption",
      "compaction.test.ts: preserve tail/budget/suffix; overflow replay; previous summary anchoring; plugin context/auto continue; prune/skill; cancellation/summary no tools",
      "structured-output.test.ts: schema defaults/storage/tool construction; tests titled AI SDK validation only inspect schema and do not execute invalid inputs",
      "structured-output-integration.test.ts: ANTHROPIC_API_KEY gated live tests; not executed; retryCount test checks persisted format only",
      "agent.test.ts: maxSteps→steps normalization/config; not hard stop behavior",
      "plan-mode-subagent-bypass.test.ts: child own agent permissions and inherited session deny ceiling",
      "tool/task.test.ts: task resume/errors/depth/permissions; abort; background promotion/extend/delete/cancel; promptOps mocked, so not full child LLM integration",
      "snapshot-tool-race.test.ts: snapshot captured before real local bash tool execution; not executed"
    ],
    "cautions": [
      "prompt.test.ts v2 prompted/synthetic test and compaction.test.ts v2 projection test are skipped; they are not evidence of current V1 emitting V2 orchestration events",
      "some overflow tests retain BUG comments while assertions and source implement reserved input headroom; comment text is not current fact",
      "no complete package suite or remote provider run"
    ]
  }
}
```
