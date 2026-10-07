# Open SWE 엔진·기능 정적 분석

분석일: 2026-10-07. Open SWE는 Deep Agents 모델·도구 루프 위에 장기 thread, sandbox, 입력 surface, PR 생성, 별도 reviewer/analyzer, CI 후속과 scheduler를 조립하는 비동기 소프트웨어 작업 시스템이다. Moodcode의 일반 실행 기능을 다시 추가하기보다 **PR revision에 연결한 feedback와 단계별 검증 증거**가 가장 직접적인 후속 후보다. 모델 중심 조사·구현·검증 흐름과 실제 강제 state-machine 계약을 구분해야 한다.

| 기준 | 고정 값 |
|---|---|
| 원본 | [langchain-ai/open-swe](https://github.com/langchain-ai/open-swe) |
| HEAD | `48a8445fc51246e739976c8bf5bdca3c43f27653` |
| checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/open-swe` |
| 분석 방식 | `static-source-review`; 설치·upstream test·model·서비스·GUI 실행 없음 |
| package | Python `open-swe-agent`/`agent`; Python ≥3.14. UI·desktop·CLI는 TypeScript 중심 pnpm/turbo 경계이며 이 보고서는 메인 engine과 integration 연결에 집중 |
| 의존성 | `deepagents==0.7.21`; LangGraph/LangChain/provider·MCP SDK, SQLAlchemy/asyncpg. 선택 sandbox providers 및 Agent Server runtime은 외부 경계 |
| Moodcode 기준 | 문서 `3065fdd03649df393f4170b38a2f049a1e52d2f3`; engine `464812f7d1af24466f57070663131f5979aeca51` |

## 대표 고정 근거

각 범위는 실제로 읽은 160줄 이하 발췌다. [근거 JSON](open-swe.evidence.json)은 file/range SHA-256, candidate 계약과 수용 조건을 포함한다. 이후 본문은 ID를 사용한다.

| ID | 고정 SHA 소스·줄 | 대표 symbol/경계 |
|---|---|---|
| OSWE-R01 | [`README.md:25–69`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/README.md#L25-L69) | README |
| OSWE-R02 | [`LICENSE:1–21`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/LICENSE#L1-L21) | root MIT license |
| OSWE-R03 | [`pyproject.toml:1–81`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/pyproject.toml#L1-L81) | Python package/dependency boundary |
| OSWE-R04 | [`langgraph.json:1–26`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/langgraph.json#L1-L26) | graph/http/checkpointer configuration |
| OSWE-R05 | [`agent/github/webhook.py:1475–1571`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/github/webhook.py#L1475-L1571) | process_github_issue |
| OSWE-R06 | [`agent/dispatch.py:290–418`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/dispatch.py#L290-L418) | create_durable_run/dispatch_agent_run |
| OSWE-R07 | [`agent/server.py:2002–2135`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/server.py#L2002-L2135) | build_agent graph assembly |
| OSWE-R08 | [`agent/server.py:1862–1906`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/server.py#L1862-L1906) | DynamicToolMiddleware/CompositeBackend routes |
| OSWE-R09 | [`agent/middleware/conversation_offloading.py:35–130`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/middleware/conversation_offloading.py#L35-L130) | ConversationOffloadingMiddleware |
| OSWE-R10 | [`agent/sandboxes/lifecycle.py:349–494`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/sandboxes/lifecycle.py#L349-L494) | ensure_sandbox_for_thread |
| OSWE-R11 | [`agent/middleware/check_message_queue.py:204–362`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/middleware/check_message_queue.py#L204-L362) | check_message_queue_before_model |
| OSWE-R12 | [`agent/tools/background_execute.py:347–497`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/tools/background_execute.py#L347-L497) | background_execute/_launch_with_callback/_launch_with_cron |
| OSWE-R13 | [`agent/scheduler.py:61–120`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/scheduler.py#L61-L120) | _launch/get_scheduler |
| OSWE-R14 | [`agent/middleware/workflow_push_guard.py:541–617`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/middleware/workflow_push_guard.py#L541-L617) | _approval_state/WorkflowPushGuardMiddleware |
| OSWE-R15 | [`agent/tools/open_pull_request.py:1023–1169`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/tools/open_pull_request.py#L1023-L1169) | _open_pull_request |
| OSWE-R16 | [`agent/reviewer.py:976–1031`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/reviewer.py#L976-L1031) | get_reviewer_agent assembly |
| OSWE-R17 | [`agent/analyzer.py:77–174`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/analyzer.py#L77-L174) | PrepareAnalyzerRunMiddleware/get_analyzer |
| OSWE-R18 | [`agent/baby_sit.py:442–595`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/baby_sit.py#L442-L595) | _evaluate_watch/handle_ci_webhook |
| OSWE-R19 | [`agent/threads/handlers.py:289–390`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/threads/handlers.py#L289-L390) | _cancel_active_thread_runs/cancel_dashboard_thread |
| OSWE-R20 | [`agent/background_tasks.py:194–288`](https://github.com/langchain-ai/open-swe/blob/48a8445fc51246e739976c8bf5bdca3c43f27653/agent/background_tasks.py#L194-L288) | _reconcile background task completion |

## 진입점부터 종료까지

1. **접수:** `langgraph.json`은 agent/reviewer/analyzer/review-scout/chat/scheduler와 `agent.webapp:app`을 등록한다. `agent/graphs/agent.py`는 `agent.server`의 factory를 재export하는 얇은 진입점이다. GitHub issue의 `process_github_issue`는 structured 입력·사용자/issue/repository identity를 구성하고 기존 thread workspace를 보존한다. 좁힌 token scope metadata 기록에 실패하면 실행을 접수하지 않는다. Slack·dashboard·Linear 등도 공통 dispatcher 계약에 연결된다. (R04–R06)
2. **지속 실행 접수:** `dispatch_agent_run` → `create_durable_run` → 외부 SDK `client.runs.create`가 흐름이다. 로컬 wrapper는 기본 `durability="sync"`, `multitask_strategy="interrupt"`, resumable stream/subgraphs·completion webhook을 전달한다. 후속 메시지가 항상 mailbox에만 쌓이는 구조는 아니다. trigger별 기본 interrupt와 background/CI의 explicit enqueue를 구분한다. 외부 Agent Server가 실제 worker·checkpoint·thread scheduling을 소유한다. (R06, R18, R20)
3. **준비·workspace:** `build_agent`와 `PrepareAgentRunMiddleware`가 thread 설정·profile/모델·권한·도구를 선택하고 sandbox를 준비한다. `ensure_sandbox_for_thread`는 metadata ID의 sandbox를 재사용한다. 새 sandbox는 초기화 후 ID를 binding하고 backend를 마지막에 publish한다. coding sandbox가 존재하나 닿지 않으면 기본적으로 실패하며, 삭제됐거나 replacement를 명시적으로 허용한 경우만 새로 만든다. reviewer처럼 checkout을 다시 만들 수 있는 경로는 교체 정책이 다르다. bridge/desktop의 사용자 디렉터리는 cloud isolation과 별도다. (R07, R10)
4. **모델·도구 루프:** factory는 model, main tools, CompositeBackend, skill sources, general-purpose subagent와 미들웨어를 `create_deep_agent`에 넘긴다. 계획·파일 읽기/편집·shell·일반 task loop의 핵심은 imported Deep Agents다. Open SWE 자체가 investigate→implement→validate를 강제하는 별도 node graph를 구현했다고 볼 근거는 이 메인 조립부에 없다. 실제 별도 workflow는 reviewer/analyzer/scheduler와 PR/CI event 연결에서 나타난다. focused validation은 모델이 사용 가능한 명령/도구를 선택해 수행하는 경로이며 항상 통과해야 PR이 생성되는 일반 gate로 확인하지 않았다. (R01, R07, R13, R15–R17)
5. **PR 전달:** `_open_pull_request`는 author 참여자/token 선택, workspace/consent, repository/base/head 접근 preflight 이후 PR API를 호출하고 telemetry/thread 관계를 기록한다. 이미 같은 head의 PR이 있는 422 응답은 기존 PR로 돌려 후속 update 작업을 가능하게 한다. PR의 성공 응답이 로컬 검증 또는 모든 shell 효과의 승인 완료를 뜻하지 않는다. (R15)
6. **검토·feedback:** 별도 reviewer는 diff/finding/update/publication/reply 도구와 subagent를 가진다. PR/push 이벤트가 reviewer run에 연결되며 메인 coding run과 역할이 분리된다. opt-in CI watch는 PR 현재 head·check runs·commit statuses·required checks를 다시 읽고, failure generation 및 webhook delivery를 중복 제거하여 같은 thread에 enqueue한다. 이어진 coding run이 failure를 진단하거나 수정한다. reviewer outcome·CI 상태·사용자 feedback가 모두 동일한 일회성 provider retry는 아니다. (R06, R16, R18)
7. **종료·중지:** model call limit, reply/CLI-result requirement, provider timeout/fallback, stable tool ordering 등이 main graph를 감싼다. 모델 종료의 상세 loop는 외부 Deep Agents다. dashboard cancel은 thread의 pending/running run을 paging하고 LangGraph interrupt 요청 및 해당 transcript settlement를 수행한다. 다른 사용자가 queue한 follow-up은 보존할 수 있다. API interrupt 확인만으로 모든 sandbox/process descendant 종료를 입증하지는 않는다. (R07, R19)

본문의 R번호는 모두 `OSWE-R` 접두사의 근거 ID다.

## 주요 기능과 경계

| 범주 | 소스로 확인한 연결 | 확인 한계·Moodcode 비교 |
|---|---|---|
| 문맥·요약 | `ConversationOffloadingMiddleware`는 외부 summary 기본값/알고리즘을 상속하고 started/failed/completed, cutoff/file_path 상태를 노출한다. 수동 compaction은 tools 없는 summary 호출 뒤 end로 간다. (R09) | 숨긴 streaming은 모델 호출 부재가 아니다. summary의 atomic exchange·crash publication·overflow 구조는 dependency 미분석이다. Moodcode에는 별도 summary attempt·provenance·원자 activation/recovery가 이미 있다. |
| 지속 기억·지침 | bundled/organization/private-user skills는 분리된 read-only virtual routes, cloud blob은 thread namespace store를 사용한다. 별도 analyzer는 repository review samples와 bootstrap/continual mode 및 style 저장 도구를 가진다. (R08, R17) | 메인 graph 조립은 범용 자동 학습 기억 시스템의 증거가 아니다. 보조 확인한 `agent/threads/recent_context.py:149–221`는 participant/audience 범위의 최근 thread metadata 선택이며 의미 검색과 구분한다. Moodcode semantic memory·로컬 skills 읽기는 기구현이다. |
| 편집·명령·검증 | Deep Agents backend와 filesystem middleware가 도구 경계를 제공하고 Open SWE의 engineering/service tools가 더해진다. background command는 sandbox `aexecute`에 연결된다. (R07, R12) | imported 파일 편집 알고리즘·shell sandbox의 실제 격리 강도는 검증하지 않았다. 별도 focused test 강제 gate도 확인하지 않았다. Moodcode exact patch·command supervisor·checkpoint·formatter/LSP가 이미 있다. |
| 하위 에이전트 | main factory는 general-purpose subagent model/tools/guards/offloading을 명시한다. reviewer도 별도 subagent가 있다. `agent/server.py:637–670`의 helper는 `mode="fork"`를 사용한다. (R07, R16) | fork는 Deep Agents의 대화 실행 mode다. wrapper만으로 모든 child의 별도 sandbox/worktree·병렬 scheduler·parent budget/cancel 상속을 보증하지 않는다. Moodcode의 승인된 read-only delegate와 host write child·worktree 통합을 기존 기능으로 보존한다. |
| 실행 중 follow-up | before-model hook이 queue snapshot을 message로 변환하고 마지막에 소비한다. sender, reply surface, 이미지 모델 정보를 유지한다. (R11) | live multi-agent mailbox나 범용 transaction queue라고 확대하지 않는다. `_consume_queued_messages`의 read/modify/write와 외부 Store 동시성은 별도 실행 검증 범위다. Moodcode queue/steer·input CAS·child terminal delivery는 이미 있다. |
| background 작업 | shell job 시작/추적, status/list/stop, 기본 cron 또는 opt-in callback. completion은 claim→enqueue→delivered이고 실패 시 unclaim한다. (R12, R20) | 부모 turn 종료 후 process 생존과 cloud provider heartbeat는 실제 실행하지 않았다. dispatch와 delivered marker 사이 crash의 exactly-once delivery 보장은 확인하지 못했다. callback은 `experimental_background_callbacks`로 표시된다. |
| retry·복구 | main task 도구 retry 최대2회·provider timeout/fallback, model-free scheduler의 transient sandbox retry와 stale-run reconcile 진입이 있다. (R07, R13) | 보조 확인한 `task_retry.py:62–84`는 transient 분류와 일부 invalid-prompt 오류 반환을 구분한다. arbitrary side effect 재실행의 안전성 또는 모든 checkpoint 복구는 입증하지 않는다. Moodcode 제한 retry·native effect frontier·uncertainty·archive/recovery가 이미 있다. |
| 승인·권한 | workflow push guard가 감지된 workflow diff의 fingerprint/base/head/repo/branch를 기록하고 approval 뒤 고정 command를 실행한다. PR 생성은 별도 consent/preflight를 쓴다. (R14, R15) | README 자체가 모든 shell/API write의 guard가 아니라고 명시한다. reviewer는 read-only 역할로 설명되나 shell/HTTP, review publish/reply 같은 도구가 있어 완전 효과 차단을 뜻하지 않는다. Moodcode 모든 exact prepare/approval/effect 계약은 약화시키지 않는다. |
| 확장·공급자 | MCP/Notion group의 dynamic tooling, CompositeBackend skills/blobs, configured model routing/fallback이 main factory에 연결된다. (R07, R08) | 보조 확인한 `agent/utils/model.py:101–167`는 provider/gateway/OAuth별 kwargs 후 외부 `init_chat_model` 또는 adapter로 넘긴다. provider 실제 API와 모든 MCP 구현은 외부다. Moodcode provider/host plugin/MCP·bounded tool discovery가 이미 있다. |
| scheduling·외부 이벤트 | scheduler는 model-free launch node로 recurring run, CI watch, background monitor, refresh, deadlines를 선택한다. issue·CI ingress에서 thread/workspace/revision을 전달한다. (R05, R13, R18) | cron/worker·signature/auth 강도·운영 availability는 소스 연결의 존재만 확인했다. 사용자 권한을 event 본문에서 만드는 Moodcode 구현은 제안하지 않는다. |

검토 선호의 실제 저장 연결도 보조로 `agent/tools/save_review_style.py:19–75`를 읽었다. repository-scoped record를 completed로 저장하고 continual cron 등록을 시도한다. 이 사실은 학습된 선호의 품질, 승인된 publication, 의미 기억의 정확성 또는 과거 모든 review 수집을 증명하지 않는다. 메인 factory·core lifecycle 근거를 20개로 제한했으므로 보조 경로는 전체 감사를 나타내지 않는다.

## Moodcode 추가 후보

아래는 구현 완료 항목이 아닌 독립 명세다. 원본 코드·prompt·fixture를 가져오지 않는다. 자세한 실제 관련 경로·contract·validation은 근거 JSON에 함께 기록했다.

| 후보 | 우선순위·비용 | 참고 동작 | 기존 Moodcode와 추가 계약 |
|---|---|---|---|
| OSWE-C1 PR revision CI·검토 feedback watch | P1 / M–L | R05, R06, R13, R15, R18 | 기존 inbox/retry/artifact/approval 위에 opt-in repository/PR/head/policy 관측을 더한다. unknown CI는 unknown으로 유지하며 event 중복 제거·head stale·예산·expiry·cancel을 고정한다. CI rerun/push/merge는 기존 exact approval을 따르는 별도 효과다. |
| OSWE-C2 역할별 단계와 검증 증거 | P1 / L | R01, R07, R15, R16 | 기존 profile/tasks/isolated child를 활용하되 todo status와 실제 검증 outcome을 분리한다. source revision·Run/child lineage·artifact hash의 CAS transition이 조사/구현/검증/검토/전달의 완료 조건이다. 이 강제 stage 계약은 분석자의 새 제안이다. |
| OSWE-C3 지속 background command job | P2 / L | R10, R12, R13, R19, R20 | command supervisor/PTY와 child delivery가 이미 있다. host job owner·lease·receipt·output artifact·expiry를 분리하고 parent Run terminal 이후 유지 정책을 명시한다. completion inbox 접수는 stable ID로 중복 제거하며 유실된 효과를 재실행하지 않는다. |
| OSWE-C4 검토 선호 초안·승인 publication | P2 / M–L | R08, R16, R17 | 기존 semantic memory/profile/skill 읽기 위에 repository review samples의 bounded derived draft를 더한다. 출처/coverage/반례/confidence·expiry와 exact publication/CAS/rollback을 요구하고 외부 review를 권한으로 승격하지 않는다. |

수용 조건의 핵심은 revision 변경 뒤 stale 처리, queue/event 중복 제거, cancel·crash 후 receipt와 uncertainty 유지, 실제 command outcome을 검증 증거로 binding, 분석/학습 결과의 승인된 활성화다. validation 배열은 후속 구현에서 실행할 조건이며 이번 upstream 테스트 결과가 아니다.

## 라이선스·유지보수와 확인 범위

실제 root `LICENSE`는 MIT이고 LangChain copyright 및 재배포 고지 조건이 있다. 확인한 하위 `ui/native/libghostty-vt/LICENSE`는 Ghostty contributors의 MIT, `ui/src/features/agents/terminal/ghostty/T3-LICENSE`는 T3 Tools의 MIT, `ui/src/features/agents/terminal/ghostty/fonts/LICENSE`는 별도 MIT 고지다. 하위 자료 고지를 root 고지만으로 대신한다고 주장하지 않는다. runtime dependency·native binary/container image·모델/클라우드의 전체 license audit은 수행하지 않았다. (R02–R03 및 JSON licenseInventory)

README는 active development, breaking change 가능성과 안정성/호환성 비보증을 명시하고 desktop을 experimental로 표시한다. 독립 thread 병렬 실행·소프트웨어 factory·CI flaky diagnosis 등은 README의 제품 설명이다. 이 보고서는 해당 설명에 대응하는 로컬 조립·dispatch·watch 코드를 확인했지만 실제 성공률·품질·성능·OS/provider 범위는 측정하지 않았다. (R01)

**외부 경계:** Deep Agents와 LangGraph는 공개 dependency지만 이번 19개 clone에서 별도 dependency source를 분석하지 않았다. planning/filesystem/shell/subagent의 내부 loop와 summarization/checkpoint semantics를 Open SWE wrapper 확인으로 전체 검증했다는 결론을 내리지 않는다. `langgraph.json`의 checkpointer TTL은 설정이다. standalone production Agent Server는 license key를 요구한다고 README와 `docs/INSTALLATION.md:48–74`가 밝힌다. server workers/Postgres/Redis·LangSmith tracing/sandbox 및 다른 provider의 실제 runtime·서비스 라이선스는 이 root MIT 소스와 별도다. 해당 설치 지침을 실행하지 않았다. (R01, R03–R04, R06, R09)

README의 권한 설명에서 member coding sandbox는 보통 GitHub App installation-wide 접근을 받으며 workspace repository binding은 routing/preloaded checkout 범위다. 사용자 개인 GitHub 권한 또는 workspace 선택만으로 sandbox credential이 좁아진다고 가정할 수 없다. MCP personal tools는 별도 private credential scope에 따라 노출되고 skill namespace도 분리되지만, 실제 계정·credential·repository 허용 범위는 연결해 시험하지 않았다. 이 trust model을 Moodcode의 로컬 workspace·exact approval에 그대로 옮기는 제안은 하지 않는다. (R01, R08)

GitHub/Slack/Linear/MCP/CI 연결은 로컬 소스를 읽었고 webhook·메시지·PR·merge·rerun 등 외부 쓰기를 수행하지 않았다. cloud sandbox/bridge/process 정리·분산 callback crash를 시험하지 않았다. Moodcode의 기존 approval/child/worktree/inbox/tasks/artifact/summary/recovery 검증은 [비교 기준](moodcode-baseline.md)과 [구현 상태](../moodcode/implementation-status.md)의 이전 결과이며 Open SWE 동등성 결과가 아니다. 원본 HEAD와 source 파일을 유지했고 담당 문서와 evidence만 작성했다. 원본을 읽었으므로 clean-room 절차라고 부르지 않는다.
