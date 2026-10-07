# OpenHands 앱(Agent Canvas) 엔진·기능 정적 분석

2026-10-07. 이 HEAD의 `OpenHands/OpenHands`는 **Agent Canvas의 연결·실행 서비스 조율 계층**이다. Python 모델·도구 루프는 별도 SDK/Agent Server, 예약·webhook dispatch는 별도 automation 저장소가 소유한다. 따라서 이 앱을 독립적인 Python 코딩 엔진으로 집계하지 않는다. Moodcode 후속 후보는 다중 backend의 실행 binding, host automation 입장 계약, client 효과의 완료 확인으로 좁힌다.

## 고정 원본과 구현 경계

| 항목 | 기준 |
|---|---|
| 저장소 | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) |
| full HEAD | `7ea83bab4fe71149b88b5a8a6b9efe9042cb362d` |
| 원본 checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/openhands-app` |
| 분석 모드 | `static-source-review`; 원본 실행 없음 |
| 비교 기준 | Moodcode 문서 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 `464812f7d1af24466f57070663131f5979aeca51` |
| 언어·package | TypeScript/React·React Router frontend, Node ESM launcher·ingress, Electron shell. root package는 `@openhands/agent-canvas` `1.25.0`, Node `>=24`; `@openhands/typescript-client` `1.53.0`, `@openhands/extensions` `0.29.0` 의존성을 선언한다. 소량의 Python compatibility tool이 모델 루프 전체를 소유하지 않는다. |
| 유지보수 관측 | 고정 HEAD 마지막 커밋은 `2026-10-07 02:24:41 +0000`, daily verification 지원·CLI 수정이다. README의 beta 표기와 테스트·CI 파일 존재를 확인했다. 현재 release·issue·Cloud 운영 상태는 조사하지 않았다. |

README의 책임 표는 앱 → TypeScript client → SDK의 Agent Server API를 명시하고, automation이 실행 시점을 결정한다고 설명한다. 이번에는 그 설명을 launcher와 실제 API 호출로 확인했다. Cloud의 App API·runtime sandbox와 Claude Code/Codex/Gemini의 실제 코어는 이 checkout에 있는 구현으로 취급하지 않는다. [A02, A04–A06, A08–A10]

| 소유 계층 | 이 분석에서 확인한 역할 |
|---|---|
| Agent Canvas | backend 선택, profile/설정의 시작 payload, REST/WebSocket publication 소비, local stack lifecycle. |
| `@openhands/typescript-client` | typed `ConversationClient`, `RemoteEventsList`, `RemoteWorkspace`, 각 feature client의 외부 package 경계. 이 앱 checkout에서 package 내부 구현을 실행·검증하지 않았다. |
| SDK/Agent Server | 모델 호출·도구 executor·conversation persistence·실행 상태·소유권 lease. [별도 SDK 분석](openhands-sdk.md)이 native loop의 근거를 갖는다. 앱의 payload를 SDK 전체 보장으로 확대하지 않는다. |
| automation | automation 정의·trigger·run history·dispatch API. scheduler·worker queue·DB transaction·job lease 본체는 별도 저장소이며 이번 담당 범위에서 확인하지 않았다. |
| Cloud·ACP 공급자 | Cloud App API가 sandbox provisioning task를 반환하고 앱이 runtime endpoint에 연결한다. ACP 설정은 SDK에 전달되며 실제 외부 CLI의 모델·편집·기억·도구 정책은 별도 구현이다. |

## 대표 소스 근거

링크는 모두 full SHA에 고정했다. 본문의 `[Axx]`는 다음 표와 [근거 JSON](openhands-app.evidence.json)의 ID다. 대표 범위 20개는 각각 160줄 이하며 파일·범위 SHA-256과 HEAD 소속을 정적으로 검사했다. 아래 범위 외의 보조 함수는 본문에 같은 checkout의 경로·줄을 적었다.

| ID | 고정 구현·함수 | 확인 동작 |
|---|---|---|
| A01 | [root LICENSE](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/LICENSE#L1-L21) | 2025 contributors의 MIT 고지·보존 조건. |
| A02 | [Architecture / Repository boundaries](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/README.md#L145-L172) | SDK Agent Server, 앱, client, automation의 책임을 분리하는 저장소 설명. |
| A03 | [shared defaults](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/config/defaults.json#L1-L36) | Agent Server `1.53.0`, automation `1.19.0`, package·port·persistence 경로 기본값. |
| A04 | [main service startup](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/scripts/dev-with-automation.mjs#L1597-L1663) | 서버 readiness→secret seeding→automation→frontend→ingress 시작 순서. |
| A05 | [buildAgentServerCommand](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/scripts/dev-safe.mjs#L429-L528) | local checkout/Git ref/PyPI 선택과 SDK companion package의 버전 정렬. |
| A06 | [startAutomationBackend](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/scripts/dev-with-automation.mjs#L993-L1091) | 별도 Python automation 서비스의 Agent Server URL·key·DB·workspace 경로 연결. |
| A07 | [applySessionKeyPolicy](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/scripts/bind-host.mjs#L50-L78) | off-loopback에서 HTML key 주입 제거; 명시적 LAN opt-in 예외. |
| A08 | [sendMessage / createConversation](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/api/conversation-service/agent-server-conversation-service.api.ts#L441-L585) | runtime에 `sendEvent(run:true)`, Cloud App API 분기, local workspace·encrypted settings 기반 conversation 생성. |
| A09 | [buildConfiguredAcpAgentSettings](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/api/agent-server-adapter.ts#L936-L1032) | `agent_kind=acp`, provider command/model 기본값, MCP forwarding·deprecated credential env 제외. |
| A10 | [start conversation payload](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/api/agent-server-adapter.ts#L1314-L1448) | profile와 inline agent의 배타 선택, client tools·confirmation·worktree·plugins/hooks·LookupSecret 연결. |
| A11 | [pause / goal / resume mutations](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/hooks/mutation/conversation-mutation-utils.ts#L36-L123) | local interrupt, Cloud sandbox pause, goal loop의 start/stop/resume와 conversation run 호출 구분. |
| A12 | [EventService](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/api/event-service/event-service.api.ts#L39-L153) | confirmation 응답·count·paged history, Cloud history와 live runtime endpoint 분리. |
| A13 | [main WebSocket options](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/contexts/conversation-websocket-context.tsx#L1100-L1151) | 최신 관측 seq로 재접속하며 replay되지 않는 progress slot을 버리고 durable event를 기다린다. |
| A14 | [resolveNewConversationWorkspace](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/api/conversation-workspace.ts#L18-L108) | successful server-info의 Docker runtime만 `/workspace` 격리로 선택; host hooks 경로를 분리한다. |
| A15 | [buildCustomSecrets](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/api/agent-server-adapter.ts#L1234-L1262) | secret 이름·설명과 backend auth를 LookupSecret 참조로 보내며 서버가 값을 해석하도록 한다. |
| A16 | [claimToolCall / launchLocalChild](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/services/child-conversation-launch.ts#L211-L352) | browser ledger로 replay를 줄이고 worktree child 요청 실패·scratch directory에서 shared로 fallback한다. |
| A17 | [reportLaunchResult / handleLaunchChildConversationAction](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/services/child-conversation-launch.ts#L480-L562) | 서버가 먼저 client tool을 acknowledge한 뒤 browser가 실행하고 결과를 parent user message로 보내는 경계. |
| A18 | [create / dispatch / cancel automation](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/src/api/automation-service/automation-service.api.ts#L352-L496) | import의 backend pin·비활성화/cleanup, dispatch와 run cancel API. |
| A19 | [releaseStaleConversationLeases](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/scripts/dev-safe.mjs#L1170-L1217) | caller가 backend port 비사용을 확인한 뒤 conversation의 lease 파일을 제거하는 개발 launcher helper. |
| A20 | [signalProcessTree / killWindowsProcessTree](https://github.com/OpenHands/OpenHands/blob/7ea83bab4fe71149b88b5a8a6b9efe9042cb362d/scripts/dev-process-utils.mjs#L85-L129) | POSIX process group signal, Windows `taskkill /t /f`, 종료 상태 확인 후 tree cleanup. |

## 진입점부터 실행·저장·종료까지

1. npm 진입점 `bin/agent-canvas.mjs:155–171`은 `dev-with-automation.main()`을 static mode로 호출한다. Electron `electron/main.mjs:643–665`도 같은 함수를 호출하며 readiness timeout을 10분으로 지정한다. 기본 backend는 앱 안의 모델 루프가 아니라 `uvx`로 시작하는 Agent Server다. local source→Git ref→명시 version→released default의 선택을 코드에서 확인했으며 실제 다운로드·설치는 하지 않았다. [A03–A05]
2. launcher는 Agent Server `/server_info` readiness를 기다린 뒤 automation API key를 server secret으로 seed하고 automation·frontend·ingress를 시작한다. `startAgentServer():936–990`는 backend listener를 IPv4 loopback으로 지정하며 API key를 환경으로 전달한다. frontend-only/backend-only와 source/version override는 옵션 경로이며 모든 모드에서 같은 서비스를 띄우는 것은 아니다. [A04–A07]
3. local `createConversation()`은 settings/profiles를 읽고 UUID·workspace·hooks root를 정한 다음 typed client에 payload를 보낸다. profile ID가 있으면 서버가 profile을 해석하도록 하며 inline `agent_settings`와 동시에 보내지 않는다. Cloud는 flat App API request를 반환하고 provisioning task를 통해 READY에 도달한다. Cloud backend의 실제 scheduler/provisioner는 이 코드에 포함되지 않는다. [A08, A10, A14]
4. 메시지는 typed `sendEvent(...,{run:true})`를 호출한다. WebSocket 연결 시에도 같은 `run:true` 메시지를 보낸다 (`conversation-websocket-context.tsx:1299–1351`); 연결이 없으면 REST로 넘기고 앱은 queued 결과를 표시한다. 여기의 queued 표현만으로 durable admission·request idempotency·workspace 공정성까지 확인한 것으로 취급하지 않는다. [A08]
5. 모델 sampling, 문맥 축약, tool action/observation 실행, 승인 대기와 terminal 판정은 SDK/Agent Server에 위임한다. ACP 설정이면 SDK가 외부 agent process를 다루도록 payload를 보낸다. 이 앱의 source에는 Claude Code/Codex/Gemini의 자체 모델·도구 loop를 구현했다고 볼 근거가 없다. [A02, A09–A10; 별도 SDK 문서 S04–S07, S17, S19]
6. 앱은 count·REST page와 session WebSocket을 통해 durable events/state를 소비한다. `use-conversation-history.ts:55–96`는 count를 먼저 읽고 `count-1`을 시작 cursor로 정하며 초기 page와 겹치는 이벤트를 ID로 중복 제거한다. socket은 가장 최근 관측한 `after_seq`로 재접속한다. `conversation-websocket-context.tsx:640–653`는 이미 본 event의 UI/client side effect도 건너뛴다. server persistence와 client projection은 별도 소유이며 Cloud history는 App API, live confirmation/count는 runtime host를 사용한다. [A12–A13]
7. 정상 완료·error·waiting·paused 표시는 server state의 projection이다. 앱이 terminal journal을 직접 쓰거나 model completion을 재판정하는 경로로 해석하지 않는다. 명시적 local stop은 `interruptConversation`, resume는 `runConversation`; Cloud stop은 sandbox pause다. API 호출 성공과 실제 tool/process cleanup 확정은 별개다. [A11–A12]

## 주요 기능과 한계

| 범주 | 정적으로 확인한 동작 | 구현 경계·Moodcode 비교 |
|---|---|---|
| 문맥·skills·기억 | `agent-server-adapter.ts:824–933`는 build-time public skill catalog를 선택적으로 payload에 합치고 SDK의 public clone을 끈다. user/project skills와 disabled 목록·runtime suffix를 전달한다. `condenseConversation():933–953`는 서버 축약 API를 호출한다. | keyword activation·condenser·memory load 본체는 SDK다. 앱의 catalog 전달을 의미 검색·자동 학습으로 해석하지 않는다. Moodcode에는 bounded context·semantic memory·local skill/reference 읽기가 이미 있다. |
| 편집·명령·검증 | `AgentServerRuntimeService`는 외부 `RemoteWorkspace.executeCommand`와 `FileClient.downloadFile`에 runtime URL/key를 전달한다. profile/inline agent의 tools와 hooks/plugins를 payload로 전달한다. [A10] | tool editor·terminal·테스트 실행·LSP 및 실제 approval enforcement는 서버/agent의 책임이다. 모든 작업에 자동 검증을 강제하는 구현은 앱에서 입증하지 않았다. Moodcode의 exact edit·command supervisor·checkpoint·검증 도구는 기구현이다. |
| 승인 | `agent-server-adapter.ts:734–758`에서 confirmation_mode가 true가 아니면 NeverConfirm, LLM analyzer면 HIGH/unknown의 ConfirmRisky, 나머지는 AlwaysConfirm으로 만든다. 앱은 confirmation 응답을 runtime API로 보낸다. [A10, A12] | 이 설정 mapping을 Moodcode의 exact prepare/fingerprint/approval/effect와 같은 binding으로 취급하지 않는다. ACP 외부 agent의 자체 승인 정책도 여기서 확인한 server policy와 구분한다. |
| 재접속·취소 | socket close/open 때 transient progress slot을 비우고 durable event replay로 복원한다. 페이지 background disconnect는 cancel API가 아니다 (`:1264–1297`). local interrupt와 Cloud pause, goal stop과 in-flight turn stop을 나눈다. [A11, A13] | Moodcode에 local utility RPC·snapshot/replay·reload detach·cancel 정산이 이미 있다. 새 transport의 연결 수명·실행 수명 binding은 추가 범위다. |
| 저장·복구·fork | 앱 metadata/cache는 server event store가 아니다. local fork는 `/fork`에 from_event_id를 보내고 client metadata를 복사하며 Cloud 분기는 거절한다 (`conversation-service:1050–1084`). | 대화 branch 본체는 SDK 분석의 OHSDK-C1과 중복하므로 새 후보로 집계하지 않는다. 파일 checkpoint 복원·worktree와 문맥 fork는 별개다. |
| workspace | `conversation_runtime=docker` 관측 때만 isolated workspace를 고르고 host hooks를 넣지 않는다. `execution_runtime=docker`의 payload는 DockerExecutionWorkspace이며 worktree=false다. [A10, A14] | 두 runtime metadata 축을 같은 sandbox 보장으로 뭉치지 않는다. 실제 container isolation·mount·Cloud VM은 실행 검증하지 않았다. host path probe 실패시 host workspace로 fallback하는 동작은 capability 확인과 구분해야 한다. |
| process ownership | launcher는 shell:false·POSIX detached group을 쓰고 종료에서 TERM 후 3초 뒤 살아 있는 tree에 KILL을 보낸다 (`dev-process-utils:34–39`, `dev-with-automation:1100–1122`). Windows tree kill 구현도 있다. [A20] | OS별 성공은 미실측이다. process group cleanup과 durable per-tool ownership journal은 같은 계약이 아니다. Moodcode의 unknown cleanup 격리를 보존한다. |
| lease helper | `dev-static.mjs:620–639`만 port probe 후 dev_conversations lease 파일 제거를 호출한다. 기본 npm/Electron의 `dev-with-automation.main()` 경로와 다르다. [A04, A19] | port가 비었다는 사실만으로 모든 동일 storage의 owner가 종료됐다는 증명은 되지 않는다. 이 helper를 보편적인 safe recovery 또는 Moodcode owner generation 대체로 제안하지 않는다. |

## automation·jobs·queue

launcher는 `openhands-automation`을 별도 process로 시작하고 Agent Server dispatch URL/key, automation SQLite URL, callback base URL, workspace base, KV secret을 환경으로 넘긴다. 기본값 `1.19.0`과 local/Git/PyPI override는 `buildAutomationCommand():324–387`에서 확인했다. 자동화의 저장 위치를 정하는 연결 코드이며 앱이 직접 job DB를 관리한다는 근거가 아니다. [A03, A06]

`AutomationService`는 cron/timezone·event source/filter를 API payload로 만들고 create/update/dispatch/cancel/run history를 호출한다. import는 먼저 unique placeholder event로 만들고 실제 trigger와 enabled=false를 함께 patch한다. 이 두 단계와 cleanup은 시작 backend에 pin한다. patch 실패시 DELETE를 시도하고 cleanup도 실패하면 AggregateError로 둘 다 표시한다. 이는 client compensating action이며 서버의 원자 transaction·effect exactly-once 보장은 아니다. [A18; 보조 `automation-service:152–219, 223–238, 498–527`]

앱에서 cron evaluator, webhook ingestion worker, queue claim/CAS, duplicate trigger dedupe, scheduler leadership·lease renewal·failed run retry 본체를 확인하지 않았다. README가 별도 automation의 소유로 명시하고 actual client도 `/api/automation`에 위임한다. API의 pending/running cancel은 관측 가능한 요청 경로다. 실제 작업 cancellation/cleanup 결과는 외부 backend의 계약과 실행 검증이 필요하다. Moodcode의 durable input queue·steer·pause/resume·workspace fairness와 recurring trigger scheduler는 다른 기능이다. [A02, A06, A11, A18]

## profile·ACP·credential·확장·child 경계

inline OpenHands agent는 LLM stream=true와 tools·agent_context를 구성한다 (`adapter:1034–1073`). ACP는 `agent_kind=acp`와 provider default command/model, MCP 설정을 보내고 legacy `acp_env`를 제외한다. shared data dir isolation은 현재 adapter의 TODO로 남아 있으므로 모든 병렬 ACP 세션이 credential·data를 격리한다는 주장을 하지 않는다. 선택한 provider registry와 CLI status probe는 공급자 코어를 분석한 것이 아니다. `acp-service:87–106`은 Agent Server BashClient를 통해 local CLI의 auth 상태를 분류하고 알 수 없는 값은 unknown으로 남긴다. [A09]

profile launch는 `agent_profile_id` 하나를 보내며, adapter 주석은 실행 tools·public skill·global memory preference 복원을 server의 책임으로 설명한다. client-owned suffix는 launch additions로 별도 전달한다. profile ID가 inline settings와 배타인 구조는 확인했지만 이 앱 payload만으로 복원 성공·불변 revision·authorization·server-side storage binding을 모두 증명하지 않는다. Moodcode는 per-Run profile의 model/tools/config identity를 이미 고정한다. [A10]

local custom secret은 시작 요청에 이름·설명·LookupSecret endpoint 참조로 보내고 server가 값을 해석한다. settings round-trip의 encrypted payload와 ACP MCP exception을 코드에서 확인했다. 그러나 **browser에 credential이 전혀 없다는 뜻은 아니다**. backend API key는 `backend-registry/storage.ts:24–39, 95–101`의 backend 객체로 localStorage에 저장되며, `SecretsService.updateSecret():106–115`는 새 value를 주지 않은 local 편집에서 기존 secret 값을 읽어 upsert한다. Cloud bearer/cookie와 runtime X-Session-API-Key도 다른 인증 경계다 (`backend-registry/auth.ts:9–17`, `cloud/client.ts:33–54`). launcher의 automation key 공유·agent command env 전달 역시 의도된 연결 동작이다. Moodcode에서는 host-only credential reference/audience 계약을 유지해야 한다. [A06–A08, A15]

SDK plugin/MCP/hook payload와 Canvas UI extension은 구분한다. `canvas-extensions-service.ts:79–105,119–174`는 local backend만 허용하고 server capability/ingress origin을 검사하여 app-view session을 만든다. API client·extension package 내부, 설치되는 plugin·service는 root 앱 source의 license·동작으로 자동 포함되지 않는다. OpenHands inline/profile start는 UI 제어와 child launch client tool을 등록하며 ACP start는 빈 client tool 목록을 보낸다. Python `tools/canvas_ui_tool.py`는 legacy compatibility·Finish registration 역할을 하며 현재 native model loop가 아니다. [A10]

앱의 child launch는 SDK의 `TaskManager` 도구 delegation과 다른 경로다. browser가 local/cloud **새 conversation**을 만든다. local은 worktree를 기본 요청하되 scratch workspace 또는 요청 실패에서 shared로 fallback하고 그 결과를 표시한다. parent link 지원은 server version에 의존한다. browser ledger는 tool call을 network 전에 기록하지만 storage 실패를 허용하므로 durable exactly-once가 아니며 완료 확인도 아니다. 서버가 client tool을 먼저 acknowledge한 뒤 실제 child를 시작하고, 결과는 parent의 user message로 보낸다. active goal이면 그 메시지가 goal을 멈추지 않도록 생략한다. 이 경로에서 Moodcode와 같은 전체 tree budget/cancel 상속·영구 mailbox·자동 통합까지 입증하지 않았다. [A16–A17]

## Moodcode 후속 독립 구현 후보

기존 SDK 문서의 OHSDK-C1~C4(대화 fork·자원 잠금·완료 gate·원격 transport)는 재집계하지 않는다. 아래는 앱의 조율 계약에서 얻은 추가 후보다. source·prompt·fixture를 가져오는 구현이 아니며 이번 변경에는 분석만 포함한다. P1은 우선 검토, P2는 후속 검토; M은 여러 모듈 변경, L은 저장·host·복구 경계를 함께 바꾸는 비용이다.

### OHAPP-C1 · backend capability와 시작 요청의 고정 binding — P1 / M–L

**기존 상태.** engine/host 분리, getCapabilities, host provider 등록, exact profile revision, credential audience와 local utility RPC는 기구현이다. 여러 local/remote backend를 선택한 상태에서 장시간 시작·승인·후속 요청 전체를 같은 실행 identity에 묶는 control-plane registry는 추가 범위다.

**독립 계약.** host가 backend ID·connection revision·정규화 endpoint audience·capability revision을 관리한다. conversation/session 시작에서 이 tuple, workspace/runtime 종류, immutable profile revision과 credential reference를 고정하여 저장한다. backend 선택을 바꿔도 이미 시작한 request·승인·cancel·cleanup은 원 tuple을 사용한다. remote capability unknown은 격리·도구·승인 지원을 추정하지 않고 필요한 기능의 시작을 보류한다. inline config/profile 선택은 배타이며 immutable config digest를 같은 binding에 넣는다. credential 값은 renderer·event·settings metadata에 저장하지 않는다. 구체적인 원격 transport 구현은 OHSDK-C4와 공유할 수 있으나 이 후보는 선택/launch semantics를 정의한다.

**관련 Moodcode 경로.** `apps/desktop/src/main/host.ts`, `apps/desktop/src/main/settings.ts`, `packages/engine/src/engine.ts`, `packages/engine/src/ports.ts`, `packages/engine/src/agents/index.ts`, `packages/engine/src/credentials/index.ts`. 참고: A07–A10, A14–A15.

**검증.** start 중 backend/key/profile 변경에도 후속 mutation이 원 target을 유지함; 이전 connection revision 응답과 승인 재사용은 거절됨; capability unknown·metadata 축 혼동·workspace 변환은 fail closed; 동시 backend의 같은 session ID가 충돌하지 않고 renderer/event에 credential 값이 없음.

### OHAPP-C2 · recurring trigger를 기존 durable inbox에 연결하는 host 계약 — P2 / L

**기존 상태.** queue/steer·pause/resume·FIFO·workspace 공정성·request dedupe·owner recovery는 기구현이다. 시간대가 있는 반복 예약·webhook trigger·job occurrence 이력·scheduler leadership는 추가 host 계층이다. 앱 source에서 외부 scheduler 본체를 검증한 후보가 아니다.

**독립 계약.** host가 고정 automation revision과 trigger occurrence identity를 저장하고 occurrence를 stable request ID로 기존 input.accept에 연결한다. schedule definition과 enabled 상태를 원자 갱신하며 import draft는 기본 비활성으로 만든다. webhook body는 bounded untrusted input이고 secret reference/target capability/profile/workspace 상한을 고정한다. queue admission 전 scheduler owner generation·timezone/misfire policy·concurrency limit을 확인한다. occurrence의 accepted/promoted/terminal을 Run과 분리해 관측하며 재시작은 receipt를 reconcile하고 uncertain effect를 재실행하지 않는다. job disable/cancel과 running Run cancel을 명시적으로 구분하고 external notification은 별도 승인된 host integration으로 제한한다.

**관련 Moodcode 경로.** `packages/engine/src/engine.ts`, `packages/engine/src/runner/input-scheduler.ts`, `packages/engine/src/storage/native.ts`, `packages/engine/src/ports.ts`, `packages/engine/src/recovery/index.ts`, `packages/engine/src/credentials/index.ts`. 참고: A02, A06, A11, A18.

**검증.** duplicate webhook·clock rollback·DST 중복·missed trigger가 policy 아래 하나의 occurrence/receipt로 정산됨; 두 scheduler owner의 경합에서 중복 promotion이 없음; disabled/import draft는 입장하지 않음; pause backlog와 workspace fairness를 보존함; pending job cancel과 running tool cleanup unknown을 구별하고 restart에서 원 효과를 자동 재전송하지 않음.

### OHAPP-C3 · client 효과의 durable 요청·완료 확인 — P1 / L

**기존 상태.** host plugin prepared/settled metadata, 승인된 read-only child delegation, host write child·worktree owner·budget/cancel 상속, terminal 결과 inbox는 기구현이다. renderer 또는 원격 extension이 처리하는 effect를 단순 publication/ack와 실제 완료로 나누는 공개 계약은 추가 범위다.

**독립 계약.** engine/host가 client 요청을 immutable action ID·fingerprint·capability revision과 원 session/Run/owner에 결합해 저장한다. received/dispatched/completed/failed/uncertain을 분리하고 renderer 연결 ack는 completed가 아니다. child 생성은 기존 engine-owned child admission·approval·worktree·예산 경로로만 위임한다. replay는 동일 request receipt를 반환하며 browser storage만으로 effect dedupe를 맡기지 않는다. 필요한 isolated workspace 실패는 typed failure로 종료하고 shared fallback은 새 명시적 선택·승인으로만 가능하다. 결과 feedback은 typed host/tool observation으로 넣고 user 지시로 승격하지 않는다. 모델 Turn terminal과 늦은 client 완료를 별도 event 소유 범위로 기록한다.

**관련 Moodcode 경로.** `packages/engine/src/plugins/index.ts`, `packages/engine/src/ports.ts`, `packages/engine/src/child-tasks/index.ts`, `packages/engine/src/child-tasks/delegation.ts`, `packages/engine/src/storage/native.ts`, `packages/engine/src/storage/execution-uncertainty.ts`, `apps/desktop/src/main/host.ts`. 참고: A10, A13, A16–A17, A20.

**검증.** publication replay·renderer reload·동시 client에서 child/effect는 한 번만 admission됨; ack 뒤 browser crash는 성공으로 표시되지 않고 uncertain receipt로 복원됨; stale revision/잘못된 owner completion을 거절함; worktree failure가 shared write child로 자동 강등되지 않음; 취소·parent terminal·예산 소진 이후 늦은 완료가 원 권한을 재활성화하거나 user instruction이 되지 않음.

## 라이선스·정적 검증·미확인 범위

root `LICENSE`는 2025 OpenHands contributors의 **MIT**이며 copyright/permission 고지 보존 조건을 갖는다. package manifest의 MIT 표기도 일치한다. checkout의 tracked 파일명에서 별도 하위 LICENSE/NOTICE/COPYING 파일은 발견하지 않았다. 이는 dependency·npm/PyPI package·Docker image·public skill catalog·설치 extension 전체의 license audit를 의미하지 않는다. SDK license는 [별도 문서](openhands-sdk.md), automation·third-party ACP CLI·Cloud와 모델 API는 각 저장소/서비스 계약을 따라야 하며 앱 root MIT로 포괄하지 않는다. [A01–A03]

README의 always-on team·어느 모델/agent든 지원·Cloud/VM/Docker 지원은 제품 설명이며, 여기서는 pinned launcher·payload·client 경계만 소스로 확인했다. 현재 HEAD의 Agent Canvas를 과거 OpenHands Python monolith와 동일한 엔진으로 설명하지 않는다. Cloud/private App API, automation scheduler/queue/worker lease, 외부 ACP 코어, TypeScript-client 배포물 내부, extensions catalog·LFS/submodule 외부 내용, 실제 OS/process cleanup·container isolation·provider/API/account 동작은 미확인이다.

원본 설치·setup·test·build·benchmark·모델 호출·계정 연결·API 서비스·GUI를 실행하지 않았고 원본 HEAD/파일을 변경하지 않았다. 20개 근거의 파일 존재·유효 줄 범위·whole/range SHA-256·HEAD blob 동일성과 후보 경로를 정적으로 검사했다. 이 검사와 Moodcode의 기존 2,594 pass·GUI/live 기록은 이번 upstream 실행 결과가 아니다. 기존 1차 종료·열린 OS/provider/CI 항목은 [현재 구현 상태](../moodcode/implementation-status.md)를 보존한다. source를 직접 읽은 분석이므로 clean-room 절차라고 주장하지 않는다.
