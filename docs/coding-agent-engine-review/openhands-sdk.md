# OpenHands Software Agent SDK 엔진·기능 정적 분석

2026-10-07. OpenHands SDK는 대화 상태, 모델 호출, typed action/observation, 도구·확장과 원격 실행 API를 제공하는 Python 엔진이다. Moodcode에는 그 기본 요소가 이미 있으므로 후속 후보는 **대화 분기, prepared 자원 잠금, 완료 검증 gate, 원격 host 재접속**의 새 계약에 한정한다. 이 문서는 구현이나 upstream 실행 결과가 아니다.

## 고정 원본과 제품 경계

| 항목 | 기준 |
|---|---|
| 저장소 | [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) |
| full HEAD | `608a102c637d8d8a999f49d7b04846524bd8bd1c` |
| 로컬 checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/openhands-sdk` |
| 모드 | `static-source-review`; upstream 실행 없음 |
| 비교 기준 | Moodcode 문서 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 `464812f7d1af24466f57070663131f5979aeca51` |
| 언어·package | Python `openhands-sdk`, `openhands-tools`, `openhands-workspace`, `openhands-agent-server`; 각 pyproject는 버전 `1.53.0`, Python `>=3.12`. `clients/typescript`는 browser-compatible typed API client이며 별도 Python 엔진을 구현하는 것으로 취급하지 않는다. |
| 유지보수 관측 | 고정 HEAD 마지막 커밋은 `2026-10-06 22:17:37 -0400`, 모델 vision 직렬화 수정. README·예제·tests·CI 구성의 존재를 읽었고 원격 release·issue·서비스 상태를 조사하지 않았다. |

README가 명시한 소유 경계는 SDK/Agent Server → OpenAPI → TypeScript client → OpenHands 앱의 Agent Canvas다. 별도 `OpenHands/automation`은 스케줄·webhook·dispatch lifecycle 소유자로 설명된다. SDK가 Cloud와 CLI의 엔진이라는 README 주장과 앱 UI·상품의 실제 지원 범위는 구분한다. 이번 파일은 SDK 및 같은 저장소 companion package를 다루며 앱은 별도 분석 대상이다. [S02]

## 대표 소스 근거

아래 링크는 모두 full SHA에 고정했다. 본문의 `[Sxx]`는 아래 ID를 뜻한다. 보조 읽기 경로·함수도 동일 HEAD에서 확인했으며, JSON의 20개 대표 범위는 각각 160줄 이하다.

| ID | 고정 구현·함수 | 확인 동작 |
|---|---|---|
| S01 | [MIT License](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/LICENSE#L1-L21) | root MIT 고지의 보존 조건과 무보증 범위. |
| S02 | [Repository boundaries](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/README.md#L83-L87) | SDK/Agent Server/TypeScript client가 실행과 API를 소유하고 OpenHands 앱은 Agent Canvas UI를 소비한다는 저장소의 명시적 경계. |
| S03 | [Conversation.__new__](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/conversation/conversation.py#L153-L234) | RemoteWorkspace이면 RemoteConversation을 구성하며 나머지는 LocalConversation으로 분기한다. |
| S04 | [LocalConversation._run](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L1932-L2046) | state lock 아래 step을 반복하고 stop hook feedback, 승인 대기, 예산·반복 한도에 따라 종료한다. |
| S05 | [Agent._step](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/agent/agent.py#L740-L896) | route-aware metadata와 condenser로 model context를 만들고 generate 호출·context 오류 회복·응답 분류를 수행한다. |
| S06 | [ResponseDispatchMixin._handle_tool_calls](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/agent/response_dispatch.py#L145-L192) | 모델 tool call을 ActionEvent로 만들고 confirmation 판정 뒤 실행 batch로 보낸다. |
| S07 | [Agent._execute_action_event](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/agent/agent.py#L1468-L1530) | 등록된 ToolDefinition을 실행하며 observation을 원 action과 tool call ID에 연결해 반환한다. |
| S08 | [ConversationState._save_base_state/create](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/conversation/state.py#L430-L568) | base-state 직렬화, cipher 없는 secret redaction, FileStore 선택과 동일 ID의 EventLog 복원·view 재구축을 수행한다. |
| S09 | [LocalConversation.fork/navigate_to](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L846-L958) | source lock 아래 전체 또는 특정 event의 조상 경로를 복사하고 별도 state를 만들며 workspace는 공유한다. navigate는 이력을 지우지 않고 HEAD와 view를 바꾼다. |
| S10 | [LocalConversation.reject_pending_actions/pause/interrupt](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L2649-L2777) | 거절 observation과 orphan error를 기록하며 pause는 step 경계, interrupt는 cancellation token과 async task 취소를 사용한다. |
| S11 | [ParallelToolExecutor._run_safe/_resolve_lock_keys](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/agent/parallel_executor.py#L275-L357) | 도구별 resource key로 실행을 잠그고 미선언 도구는 tool name mutex를 사용하며 미시작 취소는 합성 error로 돌려준다. |
| S12 | [LLMSummarizingCondenser._get_forgotten_events](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/context/condenser/llm_summarizing_condenser.py#L278-L352) | request/event/token 압력에서 보존 suffix를 계산하고 system prefix 및 atomic exchange 경계를 보호한다. |
| S13 | [TaskManager._create_task/_get_conversation](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-tools/openhands/tools/task/manager.py#L249-L336) | agent factory에서 worker를 만들고 iteration·budget 설정을 선택하여 부모 작업 디렉터리의 별도 LocalConversation을 구성한다. |
| S14 | [TaskManager._run_task/_run_until_finished](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-tools/openhands/tools/task/manager.py#L402-L500) | 동기 delegated conversation의 완료/partial 오류를 구분하고 승인 handler·부모 policy·누적 child metrics를 처리한다. |
| S15 | [LocalConversation._ensure_plugins_loaded](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/conversation/impl/local_conversation.py#L1080-L1209) | 명시적/ambient plugin에서 skills·MCP·hooks·agent definitions를 모으고 프로젝트 skills와 persistent memory를 로드한다. |
| S16 | [MCPToolExecutor.call_tool/__call__](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/mcp/tool.py#L118-L209) | 연결이 끊긴 MCP client의 재연결, typed call 결과, per-conversation secret 참조 확장·출력 masking·timeout 처리를 연결한다. |
| S17 | [LLM.generate/agenerate](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/llm/llm.py#L1684-L1746) | 동기/비동기 generate가 configured API mode에 따라 Responses 또는 Chat Completion 경로를 선택한다. |
| S18 | [RemoteEventsList._do_full_sync/reconcile](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-sdk/openhands/sdk/conversation/impl/remote_conversation.py#L339-L422) | REST의 100개 단위 페이지를 모으고 event ID로 합쳐 WebSocket/REST 사이 누락·중복을 조정한다. |
| S19 | [EventService.start](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-agent-server/openhands/agent_server/event_service.py#L1259-L1319) | 원격 서버가 persistent LocalConversation을 만들고 policy·analyzer·lease write guard·state publication을 연결한다. |
| S20 | [DockerWorkspace._start_container](https://github.com/OpenHands/software-agent-sdk/blob/608a102c637d8d8a999f49d7b04846524bd8bd1c/openhands-workspace/openhands/workspace/docker/workspace.py#L231-L287) | pre-built Agent Server container를 시작하고 host endpoint·session key를 정한 뒤 health와 RemoteWorkspace를 초기화한다. |

## 진입점부터 종료까지

1. `Conversation.__new__`는 `RemoteWorkspace`이면 `RemoteConversation`, 문자열·Path·local workspace이면 `LocalConversation`을 만든다. remote에서는 client의 `persistence_dir` 지정이 거절되므로 저장 책임을 서버와 혼동하지 않는다. [S03]
2. local의 `send_message()` (`impl/local_conversation.py:1807–1869`)는 user `MessageEvent`에 sender·활성 skill 정보를 더해 callback으로 보낸다. 기본 callback (`:424–447`)은 state/event 저장을 caller callback보다 먼저 수행한다. 모델 입력으로 event를 사용하는 구조와 구독 publication 순서를 읽었으며, 이 순서만으로 모든 crash의 원자성을 보장한다고 판정하지 않았다. [S08, S19]
3. `LocalConversation._run()`는 FIFO state lock 아래 `agent.step()`을 반복한다. pause/stuck, 승인 대기, 예산·iteration 한도, 완료를 확인한다. 완료 시 Stop hook이 deny하면 environment feedback을 기록하고 RUNNING으로 돌아간다. sync와 별도 `arun()` 경로가 존재한다. [S04]
4. native `Agent._step()`은 미완료 action이 있으면 새 모델 샘플 전에 그 action을 실행한다 (`agent.py:706–722`). 그 다음 route-aware 모델 metadata를 정하고 cached `state.view`에서 condenser를 거쳐 메시지를 준비한다. condensation event가 나오면 먼저 저장하고 다음 step으로 넘어간다. `LLM.generate(messages, tools, store=False, call_context)` 결과는 tool_calls/content/reasoning-only/empty로 분류한다. [S05]
5. tool call handler는 argument를 typed action으로 변환해 `ActionEvent`를 기록한 후 confirmation을 판정한다. 실제 정책 (`agent.py:1130–1171`)은 security analyzer의 위험도와 state의 confirmation policy를 사용하며 단일 Finish/Think는 예외다. 승인 필요시 WAITING_FOR_CONFIRMATION에서 run이 반환한다. 다시 `run()`을 호출하면 기다리던 action을 처리하는 방식이다. **Moodcode의 exact prepared fingerprint 승인과 같은 계약이라고 볼 수 없다.** [S04, S06]
6. `Agent._execute_action_event()`는 현재 `tools_map`의 executor를 실행하고 `ObservationEvent`에 action ID와 tool call ID를 붙인다. batch 결과가 event/context에 반영되어 다음 모델 호출로 돌아간다. `ParallelToolExecutor.execute_batch()` (`parallel_executor.py:67–126`)는 worker pool로 실행하되 반환 결과는 입력 순서로 정렬한다. [S07, S11]
7. 일반 text content handler (`response_dispatch.py:248–270`)는 message event를 기록하고 FINISHED로 전환한다. Finish 도구가 있는 batch도 종료로 연결하며 finish 이후 call은 잘라낸다 (`agent.py:241–266, 380–411`). 오류·stuck·pause·budget을 정상 완료와 구분하는 run 상태가 있다. 최종 완료는 Stop hook에서 다시 판단될 수 있다. [S04, S06]

## 문맥·기억·검색

`state.view`는 이력의 활성 branch를 기반으로 유지되는 모델용 projection이다. `ConversationState.active_branch/append_event()` (`state.py:295–337`)는 parent ID를 찍고 HEAD를 이동한다. 따라서 navigate 이후 abandoned branch를 pending action·stuck 검사·다음 모델 context에 포함시키지 않는 설계다. 이벤트 전체를 삭제하는 동작은 아니다. [S08, S09]

`LLMSummarizingCondenser`는 명시적 request, event 수, token 압력을 판별하고, configured cap와 agent model의 effective input cap 중 작은 한도를 쓴다 (`llm_summarizing_condenser.py:112–203`). system prefix와 atomic tool exchange 경계를 보존한 범위를 고른다. 별도 요약 LLM 호출은 tools를 전달하지 않으며, 결과 `Condensation`에는 forgotten event ID와 summary offset·LLM response ID가 담긴다 (`:224–276`). 요약할 범위가 없거나 minimum progress가 부족하면 실패를 구분한다 (`:408–439`). provider가 context 초과 또는 malformed history를 반환하면 native Agent가 condensation request로 회복을 시도한다. 이력 요약 기능 자체는 Moodcode에 이미 있다. [S05, S12]

프로젝트 skill은 workspace가 알려진 시점에 로드하고 같은 이름이면 project 항목이 우선한다. memory는 user와 project의 `.openhands/memory/MEMORY.md` index를 읽어 prompt text로 합치는 방식이며 기본 6,000 character 예산과 행 단위 tail 보존을 사용한다 (`context/memory.py:1–108`). 날짜별 log는 자동으로 넣지 않고 agent가 필요할 때 읽는다. 이 코드에서 memory load를 확인했지만 의미 검색 색인·프로젝트 간 자동 학습·승인된 memory publication까지 입증하지 않는다. Moodcode의 semantic memory는 자체 source binding과 요약 publication을 이미 갖는다. [S15]

편집·검색·검증은 tools package에 분리돼 있다. `FileEditorExecutor.__call__()` (`tools/file_editor/impl.py:37–73`)는 view/create/replace/insert 호출을 editor에 위임하고 선택한 파일 편집 제한을 검사한다. `FileEditorTool.declared_resources()` (`definition.py:198–208`)는 view와 write 모두 canonical 파일 자원 잠금을 선언한다. glob/grep·apply_patch 도구도 같은 package에 있다. `TerminalExecutor.__call__/interrupt/close()` (`tools/terminal/impl.py:541–604`)는 single-session 또는 tmux pool 경로와 Ctrl+C·close를 제공한다. command 결과를 observation으로 돌려 검증에 사용할 수 있지만 모든 과업에 자동 테스트를 강제한다는 근거는 아니다. [S07, S11]

## 승인·취소·저장·복구·fork

| 범위 | 정적 확인 | Moodcode와 구분 |
|---|---|---|
| 승인·거절 | Always/Never/ConfirmRisky 정책(`security/confirmation_policy.py:27–61`), action batch 대기, 거절 observation. [S06, S10] | 위험도 중심 policy를 exact prepared 승인으로 대체한다고 제안하지 않는다. 기존 Moodcode 승인·grant·철회를 유지한다. |
| pause·interrupt | pause는 다음 step 경계이며 진행 중 sync LLM을 즉시 취소하지 않는다. interrupt는 token을 먼저 취소하고 async task에 cancel을 보낸다. orphan tool call에는 합성 오류를 넣어 provider 이력을 정합화한다. [S10] | 합성 오류는 외부 효과가 없었다거나 프로세스가 정리됐다는 증거가 아니다. Moodcode ownership/cleanup uncertainty를 유지해야 한다. |
| 저장·resume | FileStore에 base state와 EventLog가 분리된다. persisted ID 확인·view rebuild·supplied agent의 tool compatibility 검증 후 workspace를 붙인다. cipher가 없으면 secret은 redaction되고 복원에서 잃는다. [S08] | Moodcode SQLite journal·recovery ledger를 새 file store로 교체할 필요가 없다. |
| 이벤트 기록 | `conversation/event_store.py:188–244`는 filesystem lock, ID/parent 검사, event write 후 인덱스·length marker 갱신을 수행한다. | state snapshot과 event file이 모두 하나의 DB transaction이라는 의미는 아니다. 실행 효과의 exactly-once나 복구 성공은 실행 검증하지 않았다. |
| fork·navigate | 특정 event의 조상 경로 또는 전체 log를 복사하고 별도 state·metrics를 갖는다. 원 workspace를 공유하며 navigate는 HEAD/view만 바꾼다. [S09] | 파일 checkpoint restore, Git worktree 생성, child delegation과 다른 문맥 계보 기능이다. 과거 파일 상태로 자동 되돌아가지 않는다. |

일반 도구의 병렬 실행은 declared resource key를 잠근다. 선언이 없으면 tool 이름별 mutex로 돌아가고, 명시한 빈 자원 집합이면 잠금 없이 실행한다. **미선언 도구의 tool-name 잠금은 서로 다른 shell·file·MCP 도구가 공유하는 모든 효과를 포괄하는 workspace 잠금이라고 볼 수 없다.** 도입 후보에서는 이 fall back을 더 보수적으로 정의한다. [S11]

## delegation·확장·공급자

`TaskExecutor` (`tools/task/impl.py:26–66`) → `TaskManager`는 registry/factory에서 subagent를 만들고 별도 conversation ID·persistence를 부여한다. 정의의 iteration/budget 값 또는 부모 값을 선택하고, worker는 부모의 **같은 작업 디렉터리**를 사용한다. 이 native Task 경로는 Moodcode의 격리 worktree child와 다르다. parent budget 값 사용이 Moodcode의 전체 tree에 대한 예약·소모 상한과 동일하다고 판정하지 않는다. [S13]

Task 실행은 동기 run이며 최종 FINISHED와 실패·중단의 partial result를 구분한다. approval handler가 없거나 true이면 대기 action을 run으로 진행하고, false이면 거절을 기록한 뒤 계속한다. 결과를 parent tool observation으로 반환하고 child metrics는 누적 값을 대체한다. 이 경로는 살아 있는 agent 간 영구 mailbox·팀 task board를 입증하지 않는다. Moodcode에는 모델의 승인된 read-only delegation, host write child, nested budget/cancel, terminal 결과 inbox가 이미 있으므로 단순 delegation 후보를 추가하지 않았다. [S13, S14]

명시적 plugin은 skills·MCP config·hook·agent definition을 합치며 ambient installed/user/project plugin은 현재 디스크에서 다시 발견한다. ambient plugin에 pinned commit이 없고 explicit attachment와 같은 resolved provenance로 기록하지 않는다는 차이가 소스에 명시된다. hook은 Pre/PostToolUse·UserPromptSubmit·SessionStart/End·Stop 종류를 갖는다 (`hooks/types.py:9–17`). plugin hook의 실제 결합은 `local_conversation.py:1254–1286`이다. Moodcode에는 host가 명시적으로 등록하는 plugin과 metadata hooks가 이미 있으며, 저장소 script 자동 실행이나 marketplace 자동 설치를 이번 제안에 넣지 않는다. [S04, S15]

MCP executor는 끊긴 client를 호출 전에 재연결하려 하고, per-conversation secret registry의 참조를 argument에 확장한 뒤 typed 결과와 masking·timeout 오류로 반환한다. 이 pre-call reconnect를 uncertain effect의 자동 재시도로 일반화하지 않는다. Moodcode의 typed MCP receipt·owner·dispatch/outcome·restart quarantine은 이미 있으므로 MCP 지원 자체는 후보가 아니다. [S16]

`LLM.generate/agenerate`는 Responses와 Chat Completion을 고르고, Chat transport의 `_transport_call/_atransport_call` (`llm.py:2521–2587`)는 LiteLLM completion/acompletion 및 streaming callback을 사용한다. 따라서 provider 폭은 라이브러리와 설정·credential·모델 feature metadata에 의존한다. `switch_llm/switch_profile` (`local_conversation.py:1647–1721`)는 registry usage ID·condenser·persisted agent를 갱신한다. Moodcode의 per-Run 고정 profile identity와 provider adapter는 이미 있으므로 이 모델 변경을 동일 retry처럼 다루지 않아야 한다. [S08, S17]

`agent/acp_agent.py`에는 native LLM/tool loop와 별도로 subprocess-backed ACP agent가 존재한다. 이번 핵심 추적은 native `Agent`이며, ACP의 모든 process/auth/model bridge를 같은 구현으로 해석하거나 기능 동등성으로 주장하지 않는다.

## local·remote·container 경계

`RemoteConversation.send_message/run()` (`impl/remote_conversation.py:1270–1346`)는 `/events`와 `/run` API를 호출하고 state/status로 완료를 관측한다. `RemoteEventsList`는 REST 100개 단위 페이지를 전부 모아 local cache에 둔 후 event ID로 reconcile한다. client reconnect는 server conversation의 실행·저장과 다른 수명이다. [S03, S18]

Agent Server의 `EventService.start()`는 persistent `LocalConversation`에 callbacks, policy/analyzer, secrets/cipher, lease write guard를 연결한다. server run dispatch (`event_service.py:1507–1543`)는 native `arun()` override가 있으면 await하고, 없으면 executor의 sync `run()`을 shield한다. sync waiter 취소가 실행 thread 종료를 의미하지 않는다는 처리가 있다. 그 결과 remote client 쪽에 모델·도구 executor가 필요한 것으로 오해해서는 안 된다. [S19]

`DockerWorkspace`는 pre-built agent-server image를 시작하고 local HTTP endpoint와 session key를 정한 뒤 health를 기다리는 remote workspace factory다. Docker 자체에 모델 loop를 별도로 구현한 구조가 아니다. 코드의 volume·network·환경 설정과 lifecycle만 읽었으며 이미지 내용, container 격리 강도, Apptainer/Kubernetes/cloud 운영 성공은 미확인이다. OpenHands 앱 UI·로그인·Cloud 상품의 runtime provisioning 전체는 별도 범위다. [S20]

## Moodcode 후속 독립 구현 후보

아래는 참고 동작으로부터 새로 명세한 계약이다. 기존 source·prompt·tool description을 가져오는 구현을 뜻하지 않는다. P1은 우선 검토, P2는 후속 검토이며 비용 M은 여러 engine module, L은 저장·복구·host 경계를 함께 바꾸는 범위를 뜻한다. 후보의 상세 수용 조건은 [근거 JSON](openhands-sdk.evidence.json)의 `validation`에 있다.

### OHSDK-C1 · 실행 효과와 분리된 대화 분기·fork — P1 / L

**기존 상태.** checkpoint restore·archive·새 session 생성·격리 child는 기구현. 특정 대화 지점에서 별도 문맥 계보를 만드는 공개 계약은 확인한 기준 소스에서 찾지 못했다.

**독립 계약.** host가 sourceSessionId와 고정 source cursor를 지정해 새 session의 parent lineage와 완전한 exchange를 원자적으로 기록한다. 원본은 불변이며 fork는 기본 idle이다. branch 기준은 terminal 또는 완전한 tool exchange 경계로 제한하고 summary/image/document/artifact의 역사 출처를 검증해 재binding한다. 승인은 복사하지 않고 pending action·실행 효과를 재생하지 않는다. 대화 분기 자체는 파일 복원이나 worktree 복제가 아니며 현재 파일을 다시 읽어야 한다. 별도 worktree가 필요하면 기존 child/worktree 계약을 명시적으로 연결한다.

**관련 Moodcode 경로.** `packages/engine/src/engine.ts`, `packages/engine/src/ports.ts`, `packages/engine/src/storage/native.ts`, `packages/engine/src/context/service.ts`, `packages/engine/src/review/index.ts`, `packages/engine/src/child-tasks/index.ts`. 참고 근거: S08, S09.

**검증 조건.** source cursor 이후 이벤트가 fork 문맥에 유입되지 않고 원본 이력이 동일함; tool-call/result 중간 및 불확실한 source 분기는 거절됨; crash 재요청은 하나의 fork ID와 lineage만 반환함; 문서·이미지·summary 출처와 credential 비복사, 원 승인 비재사용을 확인함.

### OHSDK-C2 · prepared 자원 집합을 사용하는 도구 병렬 실행 — P2 / L

**기존 상태.** runner.executeCalls는 effectClass=read인 연속 도구를 maxReadConcurrency 아래 이미 병렬 실행하고 그 밖의 호출은 순차 실행한다. 범용 파일·terminal·외부 자원 충돌 scheduler는 추가 범위다.

**독립 계약.** host가 등록한 도구만 prepare 단계에서 canonical resource set과 read/write mode를 선언한다. 그 집합과 tool revision은 exact fingerprint의 일부로 고정한다. 미선언 또는 외부 효과가 불명확한 호출은 workspace 단위 직렬 경로로 유지한다. 자원 잠금은 정렬해 deadlock을 피하고 effect 직전에 원 owner·승인·현재 hash를 다시 검사한다. 불충돌 도구만 제한 동시성 아래 실행하며 모델용 observation 순서는 원 call 순서로 보존한다. workspace lease·checkpoint·도구 cleanup journal은 병렬 완료와 취소를 독립적으로 추적한다.

**관련 Moodcode 경로.** `packages/engine/src/runner/index.ts`, `packages/engine/src/ports.ts`, `packages/engine/src/tools/runtime/index.ts`, `packages/engine/src/plugins/index.ts`, `packages/engine/src/storage/tool-recovery-frontier.ts`. 참고 근거: S07, S11.

**검증 조건.** 같은 파일 read/write 및 rename의 양쪽 경로는 충돌하고 별도 파일은 허용된 동시성으로 실행됨; 미선언 shell/MCP는 직렬이며 확장 자원 선언으로 자동 권한 상승하지 않음; 잠금 대기 취소·부분 실패·강제 종료에서 미확정 effect가 재실행되지 않음; prepared resource 변경·외부 파일 변경은 effect 전에 stale로 차단됨.

### OHSDK-C3 · terminal 기록 전 완료 검증 gate — P1 / M–L

**기존 상태.** plugin prepared/settled metadata hook, session steer boundary, 일반 retry·coding 검증 도구는 기구현. 완료 판정에서 bounded feedback으로 추가 turn을 요청하는 host gate는 별도 계약이다.

**독립 계약.** 모델의 완료 응답 후 Run terminal을 쓰기 전에 host가 고정 revision의 completion policy를 실행한다. 결과는 allow, continue와 bounded untrusted feedback, 또는 fail로 제한한다. 검증 비용·추가 turn 한도·취소 신호를 기존 Run 예산에 포함하고 동일 완료 시도 ID에 대한 gate 결과를 durable하게 기록한다. 검증 명령이나 파일 효과는 기존 approved tool 경로로만 실행한다. feedback은 user 지시로 승격하지 않으며 기존 exact approval·prepared request를 수정하지 않는다. terminal 이후 추가 이벤트를 쓰지 않는다.

**관련 Moodcode 경로.** `packages/engine/src/runner/index.ts`, `packages/engine/src/runner/input-scheduler.ts`, `packages/engine/src/plugins/index.ts`, `packages/engine/src/runner/turn-executor.ts`. 참고 근거: S04, S15.

**검증 조건.** 실패한 검증 feedback은 terminal 전 다음 turn에서 한 번만 관측됨; 재시작·중복 completion 제안에서 gate side effect와 terminal이 중복되지 않음; gate timeout·취소·반복 거절은 예산 아래 종료됨; 기존 prepared/settled 관측 hook과 steer·pending approval 회귀를 확인함.

### OHSDK-C4 · 원격 engine host의 재접속·상태 조정 — P2 / L

**기존 상태.** engine/host 분리, local utility RPC, snapshot/replay·bounded history, durable owner·uncertainty·취소는 기구현. 인증된 REST/WebSocket 또는 동등한 원격 transport와 container workspace 운용은 확인한 host에서 별도 범위다.

**독립 계약.** 원격 host는 동일 engine command와 sequence cursor를 인증된 transport로 노출하고 engine·process owner는 서버에 남긴다. client 연결 종료와 Run cancel을 별개 요청으로 기록한다. 재접속은 snapshot cursor 이후 bounded page와 event ID/seq로 조정하며 client 메모리에 전체 history를 적재하지 않는다. admission·approval·cancel은 원 request identity로 중복 제거하고 lease generation이 다른 응답을 거절한다. container 생성·종료·credential 전달은 host만 수행한다. transport timeout 뒤 재연결은 관측을 복구하며 uncertain tool effect의 자동 재전송을 허용하지 않는다.

**관련 Moodcode 경로.** `apps/desktop/src/main/host.ts`, `packages/engine/src/engine.ts`, `packages/engine/src/ports.ts`, `packages/engine/src/storage/native.ts`, `packages/engine/src/storage/execution-uncertainty.ts`, `packages/engine/src/recovery/index.ts`. 참고 근거: S03, S18, S19, S20.

**검증 조건.** REST sync/stream 경합·재접속에서 누락·중복·순서 역전이 projection에 반영되지 않음; 연결 종료 중 서버 Run은 계속되고 명시 cancel은 동일 owner에서 terminal까지 추적됨; 늦은 이전 lease 응답·중복 run request·승인 binding 변경이 차단됨; container crash 및 서버 restart는 기존 uncertainty ledger를 보존하고 credential이 client/event/log로 전달되지 않음.


## 라이선스·확인 한계

root `LICENSE`는 2026 OpenHands contributors의 **MIT**이며 고지 보존 조건이 있다. `clients/typescript/LICENSE`도 별도 MIT 고지를 포함한다. 네 Python package 아래에서 독립 LICENSE 파일은 발견하지 않았고 root 고지를 기준으로 기록한다. test fixture plugin에는 별도 LICENSE 파일이 존재하며 전체 dependency·fixture·container image·third-party notice audit를 했다고 주장하지 않는다. extension marketplace 자료, 모델 API·OpenHands Cloud와 외부 공급자 서비스 약관·credential 계약은 root MIT가 자동으로 포괄하지 않는다. SDK license를 별도 OpenHands 앱 저장소의 모든 코드·서비스에 적용하지 않는다. [S01, S02]

README의 Cloud/CLI 엔진·Python/TypeScript/REST 지원 설명은 저장소 주장으로 표시했고, 대표 native loop와 동봉 server/client 경계를 소스로 확인했다. benchmark 숫자·모든 provider 지원·production readiness·제품 전체 동등성은 검증하지 않았다. upstream 설치·setup·tests·build·model/API·계정·GUI·benchmark를 실행하지 않았다. 원본 HEAD·원본 파일을 변경하지 않았으며 담당 산출물은 이 보고서와 evidence JSON뿐이다. 줄 범위·해시·commit 소속의 정적 검사는 upstream 테스트 통과와 다르다.

Moodcode의 기존 2,594 pass·GUI/live/provider 결과는 [현재 구현 상태](../moodcode/implementation-status.md)의 기존 기록으로 보존하며 이번 upstream 결과로 재사용하지 않는다. LFS/submodule 외부 자료와 실제 서비스를 확인하지 않았고, 소스에 못 찾은 기능은 제품 전체에 없다고 단정하지 않는다. 이 분석은 공개 소스를 읽었으므로 clean-room 절차가 아니다.
