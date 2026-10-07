# Cline 공개 엔진 정적 분석

2026-10-07 · `static-source-review`. 결론은 **현재 Cline의 새 실행 루프와 공유 운영 계층을 구분하는 것이 우선**이다. `@cline/agents`의 `AgentRuntime`이 모델/도구 루프이고, `@cline/core`의 `SessionRuntime`·runtime host가 문맥·저장·팀·MCP·예약·클라이언트 경계를 구성한다. Moodcode에는 read 병렬 실행, profiles, 영구 inbox, child, 승인, 요약, checkpoint가 이미 있으므로 이를 신규 결손으로 취급하지 않는다. 유용한 후속 계약은 살아 있는 팀 mailbox, lease를 가진 예약 제출, typed lifecycle hook, 공유/원격 host다.

## 원본·범위·라이선스

- 저장소: [cline/cline](https://github.com/cline/cline), HEAD `55a133b751b66d42b8a3ffad76c731ad4f51577d`.
- checkout: `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/cline`. Moodcode 문서 기준 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 기준 `464812f7d1af24466f57070663131f5979aeca51`.
- TypeScript/Bun/Node monorepo. `@cline/sdk`는 `@cline/core`의 user-facing alias이며, `core`는 `agents`·`shared`·`llms`에 의존한다. 확인한 SDK package 버전은 0.0.91이다. Node/Bun 조건은 root package metadata이며 설치 성공을 의미하지 않는다.
- root `LICENSE`는 Apache-2.0(R02). 별도 `apps/vscode/LICENSE`도 Apache-2.0이고 `sdk/packages/ui/RADIX-COLORS-LICENSE`는 Radix MIT 고지다. root LICENSE만으로 모든 dependency·미디어·배포물·외부 API·비공개 plugin의 라이선스를 audit했다고 주장하지 않는다.
- 유지보수의 정적 단서: 고정 HEAD의 commit 시각은 2026-10-07T17:45:01+09:00, 제목은 `feat(cli): move dashboard under hub (#14900)`이다. 여러 migration·test 파일이 함께 존재하지만 테스트의 실행 결과나 전체 품질/현재 서비스 가용성을 의미하지 않는다.
- README는 JetBrains client가 shared agent core와 통신한다고 설명하면서 plugin 자체는 비공개라고 명시한다(R01). 공개 `apps/vscode/src/standalone/cline-core.ts` 및 SDK 연결부를 읽는 것과 JetBrains plugin 전체를 확인하는 것은 다르다.

## 현재 공유 엔진과 adapter 경계

| 계층 | 확인한 경로/역할 | 판단 |
|---|---|---|
| SDK 외부 API | `sdk/packages/core/src/ClineCore.ts`: `create/start/send/abort/stop`; start가 host.startSession, send가 host.runTurn에 위임 | programmatic API |
| 실행 host | `runtime/host/host.ts#createRuntimeHost`, `local-runtime-host.ts`, `hub/runtime-host/` | local·hub·remote·auto 선택. auto에서 hub 실패 시 local fallback(R03) |
| 세션 운영 | `SessionRuntime#executeRunInternal` | 세션 transcript/extension state는 유지하고 매 run 새 AgentRuntime 생성(R04) |
| 모델/도구 loop | `sdk/packages/agents/src/agent-runtime.ts` | SDK core 바깥의 별도 공개 package. 모델 생성·stream·tool scheduling·종료(R05–R08) |
| 공급자 | `core/src/services/llms/handler-factory.ts#createAgentModelFromConfig` → `@cline/llms` gateway 또는 등록된 ApiHandler adapter | core와 provider protocol의 연결 |
| hub daemon | `core/src/hub/daemon/entry.ts` 261–280: shared WebSocket server·owner context·runtimeHandlers·cronOptions | 지속 실행/다중 client 서비스. standalone loop와 구분 |
| CLI | `apps/cli/src/session/session.ts` 29–78: `createCliCore` → ClineCore.create, CLI capabilities·hub identity·정책 전달 | 같은 SDK의 터미널 adapter |
| Desktop | `apps/examples/desktop-app/sidecar/context.ts` 1289–1320: ClineCore.create(`backendMode: hub`), sidecar capabilities, session event relay | Tauri/Bun sidecar/UI와 engine을 분리 |
| VS Code 이행부 | `apps/vscode/src/core/controller/index.ts` 1–7은 SDK SdkController re-export. `sdk/cline-session-factory.ts` 1–55는 classic task 생성 대체·legacy settings/persistence 매핑 | `core/` 디렉터리 이름만으로 옛 별도 loop가 활성이라고 단정할 수 없음 |
| JetBrains | README의 비공개 plugin 표기와 공개 standalone adapter 범위 | 공개 core 분석만 가능. 제품 전체 기능 동등성은 미확인 |

## 요청→모델→도구→종료

1. `ClineCore.start`가 host를 통해 세션을 준비한다. `LocalRuntimeHost`는 기본 `DefaultRuntimeBuilder`와 `SessionRuntime`을 사용한다. builder가 builtin/configured-agent/team/MCP 도구와 선택된 확장을 합친다.
2. `SessionRuntime.executeRunInternal`은 사용자 입력을 conversation에 한 번 넣고, provider config로 모델을 생성한다. extension 도구와 설정 도구를 이름으로 합치며 설정 도구가 중복에서 우선한다. 이전 전체 transcript, system prompt, hooks, prepareTurn을 runtime config로 넘긴다(R04).
3. `AgentRuntime`은 iteration 상한/abort를 검사한다. `prepareModelRequest`(1653–1716)는 현재 도구 schema·메시지 사본·options를 만들고 매 요청 경계에서 pending user message를 소비한 뒤 문맥 준비와 beforeModel을 적용한다. provider boundary인 `openTaskLifecycleStream`(2083–2135)이 실제 `config.model.stream(request)`를 연다. text/reasoning/tool-call/usage 등 provider event를 runtime message/event로 조립한다(R06).
4. transient provider retry는 제한된 횟수와 abort 가능한 지수 backoff를 사용한다. visible output/provider tool activity가 이미 있으면 무조건 replay하지 않는다. unknown finish는 tool activity가 없을 때 부분 이력에서 한 번 continuation한다(`agent-runtime.ts` 1187–1277). 이는 Moodcode의 bounded Attempt retry와 비교할 동작이며 새로운 retry 기능이 필요하다는 주장은 아니다.
5. tool-call이 있는 assistant message를 먼저 기록한다. `executeToolCalls`는 모든 call의 정규화/beforeTool/정책/승인 준비를 완료한 뒤 실행한다. 인접 `parallel` 그룹만 Promise.all로 겹치고 순차 도구가 장벽이다(R07). 결과 배열은 호출 순서로 반환된다. Moodcode도 인접 read 도구를 `maxReadConcurrency` 안에서 실행하고 결과 순서를 보존한다(`runner/index.ts` 677–699).
6. `executePreparedTool`은 signal·lineage·tool-call ID·emitUpdate를 도구에 넘긴다. execute 오류는 tool error 결과가 되고 afterTool을 거쳐 tool-result 메시지로 기록된다(R08). 다음 iteration의 모델이 결과를 받는다.
7. tool-call이 없으면 completion reminder 여부를 확인한 뒤 completed로 종료한다. completing tool 결과도 완료 경로다. unknown/max-tokens/error finish는 별도 복구/실패 판정을 거친다(R05). run abort는 signal을 내리고 세션은 이력/결과 정리를 수행한다. provider generation만 중단하는 steer와 run 취소는 구분되어 있다(R06).

## 기능별 실제 구현과 한계

| 범주 | 소스로 확인한 동작 | Moodcode 대조·확인 한계 |
|---|---|---|
| 문맥/요약 | opt-in `createContextCompactionPrepareTurn`(267–362)는 system/tool schema overhead·모델 입력 한도·이전 provider input usage를 함께 계산한다. 기본 agentic 요약, 실패 시 basic fallback; overflow 시 custom 결과가 더 작고 목표 안이어야 하며 basic 복구를 사용(R09). full transcript와 compaction state의 저장을 분리(R10). | Moodcode의 bounded ContextPlan·summary lifecycle·active-prefix checkpoint·semantic memory를 대체하는 결손으로 보지 않는다. Cline의 요약 품질은 실측하지 않음 |
| 기억/검색 | session history search는 별도 파생 SQLite FTS5 index와 bounded hit limit를 사용(`session/search/session-history-search.ts` 123–145, 274–280). 코드 검색은 rg 우선/regex fallback·파일 index·출력 cap(`executors/search.ts`). rules/skills/configured agent config는 builder 확장 자원 | history FTS·rules·일정 notes를 프로젝트 간 semantic memory와 혼동하지 않는다. 모델의 장기 기억 정확성은 미검증 |
| 편집/명령/검증 | builtin read/search/editor/apply-patch/run_commands 등. editor는 exact text replace·newline 처리·diff 출력. shell streaming·timeout/abort·출력 제한과 명령 detach 경로가 존재(R20) | README의 IDE lint/compiler 실시간 수정(R01)의 전체 host 동작은 검증하지 않음. 일반 명령으로 테스트하는 것과 독립 검증 gate는 구분 |
| 승인 | beforeTool이 input·policy를 조정한 후 `autoApprove:false`일 때 callback 요청; callback 미설정은 거절(R07). child에 tool policy/approval callback 전달(R15) | Moodcode의 immutable prepared fingerprint·exact approval/effect binding이 이미 있음. 단순 승인 Boolean 경로를 그대로 옮길 이유가 없음 |
| 취소/background | run-level abort, model-only steer, parent signal을 child에 전달. `spawn_agent`는 끝까지 기다리는 도구(R15). team queued run은 별도 ID·상태를 가지며 background 시작을 지원. shell detach는 process start identity·로그를 남기고 tool 반환 후 프로세스를 유지(R20) | waiting child, team background run, detached shell process는 서로 다른 수명. detach 후 완전 정리/OS 지원은 실측하지 않음 |
| 저장/복구 | SQLite session backend 및 file fallback, manifest/messages/compaction artifacts. metadata OCC(`expectedStatusLock`, bounded retry), stale process/session reconciliation 경로(R10). 팀 export/hydrate가 queued run을 복원(R12) | 이력/상태 저장을 모든 외부 효과의 exactly-once 복구 증명으로 보지 않는다. Moodcode의 uncertainty quarantine/receipt 계약 보존 |
| checkpoint | private Git checkpoint ref·scratch index hooks, restore 전 untracked 포함 snapshot 및 rollback transaction(R11) | Moodcode의 hash 기반 preview/fingerprint 확인·durable review journal과 다름. Git reset/clean 동작을 Moodcode의 기존 restore에 그대로 적용할 후보로 삼지 않음 |
| 하위 agent/팀 | configured agent tools와 focused spawn, lead/teammate tasks·runs·mailbox·mission log·outcome state. 수신자별 readAt, 실행 중 pending steer 알림, 팀 hydration, batch persistence(R12–R15) | Moodcode profile와 terminal child 결과 inbox는 기구현. 살아 있는 agent끼리의 양방향 mailbox와 team task ownership만 추가 범위 |
| hooks/plugins | runtime before/after model/tool/run 제어; 파일 hook을 typed lifecycle에 매핑(R17). plugin path export·manifest 검증·setup context 주입(R18); agent-plugin package의 skills/MCP 자원도 builder에 연결 | model/tool mutation hook은 Moodcode metadata observer보다 강한 계약. repo 파일 발견과 실행 허가를 분리해야 함. 일부 prompt-submit 경로는 return control을 지원하지 않음(R17) |
| tool discovery/MCP | `createMcpTools`는 listTools 전체를 AgentTool로 변환하며 schema·timeout/retry·oversized cache 정책을 적용(R19). stdio 및 HTTP/SSE transport/OAuth 구현이 별도 client에 존재 | 확인 경로는 eager 등록. semantic/bounded discover_tools가 전체 제품에 없다고 단정하지 않음. Moodcode의 bounded discovery·다음 모델 경계 선택·MCP receipt 관리가 이미 있음 |
| 예약 agent | cron spec/store/materializer/runner/report, claim token·lease renewal·동시성·timeout, shared daemon에 연결(R16). 일정 도구 생성에 user-level schedules workspace 경로가 존재 | cron과 영구 input queue는 별도 기능. headless policy는 Cline에서 autoApprove를 설정하고 ask를 끈다(`cron-runner.ts` 83–106). Moodcode에서는 효과 허용 범위를 명시적으로 유지 |

팀 저장의 `TeamPersistenceWriter`는 일반 durable 이벤트를 batch하고 terminal/membership은 즉시 flush하며 실패를 재시도한다(R14). 하지만 실패 중 pending event 수를 제한하고 오래된 이벤트를 버리는 경로가 있으므로, `sendMessage` 반환 즉시 디스크에 영구 수신 영수증이 생긴다고 주장하지 않는다. source상 팀 mailbox를 확인했다는 것과 crash 경계마다 lossless delivery를 검증했다는 것은 다르다.

## 독립 구현 후보

각 후보는 참고 동작을 바탕으로 작성한 Moodcode 고유 계약이다. source·prompt·tool description·fixture 복사나 upstream runtime 추가를 제안하지 않는다. 실제 관련 경로와 검증 조건은 [cline.evidence.json](cline.evidence.json)의 `candidates`에 포함한다.

| 후보 | 기존 Moodcode 상태 | 새 계약 | 우선순위/비용·검증 |
|---|---|---|---|
| C01 영구 team mailbox | `agents/index.ts`, `session-state/index.ts`, `runner/input-scheduler.ts`, `child-tasks/index.ts`의 profile/tasks/inbox/terminal delivery는 있음 | host가 허가한 membership/lineage, sender request dedupe, bounded 수신함·읽음 cursor·task owner CAS. model 경계에서 본문 전달; 저장 receipt 전 durable 성공 반환 금지(R12–R15) | P1/높음. crash 재전송·read 재시도·overflow·다른 team·approval 대기·child 취소에서 누락/이중 실행 검사 |
| C02 lease scheduler | 영구 inbox·workspace 공정성·pause/resume·profile revision·tasks가 있음 | schedule revision/timezone/occurrence→고정 input request ID, claim lease·missed-run 정책·동시성. lease 손실 때 cleanup 증명 전 재실행 금지. 일정 등록이 자동 전면 승인으로 바뀌지 않음(R03,R16) | P1/높음. 두 scheduler·sleep/wake·DST·clock rollback·accept 직후 crash·quarantine 검사 |
| C03 typed lifecycle hook | `plugins/index.ts`의 prepared/settled metadata observer·explicit host factory가 있음 | bounded context/deny/stop, 고정 hook order/revision. 변환은 prepare 전에만; 승인 이후 변경은 stale. post-effect hook 실패가 effect 재시도 근거가 되지 않음(R04,R07,R08,R17,R18) | P2/중간~높음. timeout·abort·잘못된 구조·승인 대기 revision 변화·effect 후 실패 검사 |
| C04 공유/원격 host | `engine.ts`·`ports.ts`·desktop main/worker/preload의 engine 분리/utility ownership/replay/sender 검증이 있음 | 하나의 실행 owner, versioned capability RPC·epoch·requestId·deadline·replay cursor, exact 승인 및 reconnect/handoff 계약(R01,R03,R04) | P2/높음. disconnect·event gap·late approval·capability 교체·fallback 이중 실행 검사 |

병렬 읽기, profiles, 요약, MCP, child approval, checkpoint 자체는 기구현 또는 같은 종류의 계약이므로 신규 후보에서 제외한다. team write child를 추가하더라도 Moodcode의 worktree 격리·상속 예산·deny·승인·취소·통합 경로를 유지해야 한다. Cline의 batch hooks·headless auto-approval·Git restore를 Moodcode의 효과 증명보다 강하다고 판단하지 않는다.

## 대표 고정 소스 근거

아래 20개 범위는 각 160줄 이하이며 evidence JSON의 ID와 일치한다. 본문의 추가 경로·함수는 같은 checkout에서 읽은 보충 설명이다.

| ID | 고정 HEAD 소스 | 근거 |
|---|---|---|
| R01 | [README.md:125–144](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/README.md#L125-L144) | 제품 경계 표는 SDK·CLI·Desktop·VS Code 이행 상태를 표시하고 JetBrains plugin 소스는 비공개라고 명시한다. Plan/Act·승인·checkpoint 설명은 README 주장이다. |
| R02 | [LICENSE:1–23](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/LICENSE#L1-L23) | root LICENSE는 Apache License 2.0이다. 하위 고지와 비공개 plugin·외부 서비스의 권리까지 자동 확장하지 않는다. |
| R03 | [sdk/packages/core/src/runtime/host/host.ts:137–266](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/runtime/host/host.ts#L137-L266) | createRuntimeHost는 local/hub/remote/auto를 분기하고 auto의 hub 연결 실패 때 local로 fallback한다. |
| R04 | [sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts:948–1064](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts#L948-L1064) | SessionRuntime은 모델·extension tool·config tool·기존 transcript·hooks·prepareTurn을 구성하고 새 AgentRuntime을 매 run 생성하며 startup 중 요청한 abort를 run-started 경계에 전달한다. |
| R05 | [sdk/packages/agents/src/agent-runtime.ts:898–1019](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/agents/src/agent-runtime.ts#L898-L1019) | assistant message를 기록하고 tool-call을 실행·결과 메시지로 추가하며, 도구 없는 완료 또는 completing tool 성공으로 run을 종료한다. unknown/max-tokens/error finish는 별도 처리한다. |
| R06 | [sdk/packages/agents/src/agent-runtime.ts:1755–1820](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/agents/src/agent-runtime.ts#L1755-L1820) | 준비된 model request의 generation signal에 steer와 run abort를 결합하며 stream delta를 assistant 이벤트로 조립한다. |
| R07 | [sdk/packages/agents/src/agent-runtime.ts:2333–2490](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/agents/src/agent-runtime.ts#L2333-L2490) | 모든 tool-call의 beforeTool·입력 정규화·정책·승인 준비를 먼저 수행한 뒤 인접 parallel 그룹만 겹쳐 실행하고 sequential 도구를 순서 장벽으로 둔다. |
| R08 | [sdk/packages/agents/src/agent-runtime.ts:2533–2635](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/agents/src/agent-runtime.ts#L2533-L2635) | prepared tool execute에 lineage·run/tool-call ID·abort signal을 넘기고 output/error를 afterTool로 처리한 뒤 tool-result 및 finished 이벤트를 만든다. |
| R09 | [sdk/packages/core/src/extensions/context/compaction.ts:478–580](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/extensions/context/compaction.ts#L478-L580) | overflow 복구는 비어 있지 않고 더 작으며 목표 토큰 안에 있는 custom transcript만 허용하고 그렇지 않으면 basic 전략을 사용한다. 일반 agentic 실패도 취소가 아니면 basic으로 fallback한다. |
| R10 | [sdk/packages/core/src/session/services/persistence-service.ts:222–343](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/session/services/persistence-service.ts#L222-L343) | 세션 metadata 갱신은 expectedStatusLock을 쓰는 bounded OCC 재시도이고 transcript와 compaction state는 manifestStore 경계에 각각 저장한다. |
| R11 | [sdk/packages/core/src/session/checkpoint-restore.ts:50–151](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/session/checkpoint-restore.ts#L50-L151) | checkpoint restore 전 HEAD와 untracked 포함 stash를 private ref로 보관하며 commit/rollback을 제공한다. rollback은 reset/clean/stash apply로 worktree를 복구한다. |
| R12 | [sdk/packages/core/src/extensions/tools/team/multi-agent.ts:705–829](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/extensions/tools/team/multi-agent.ts#L705-L829) | 팀 mailbox는 수신자별 unread/markRead/limit를 지원하고 readAt을 dirty state로 기록한다. tasks·mailbox·runs 등을 export/hydrate하며 queued run 큐를 복원한다. |
| R13 | [sdk/packages/core/src/extensions/tools/team/multi-agent.ts:1560–1624](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/extensions/tools/team/multi-agent.ts#L1560-L1624) | 팀 메시지는 sender/recipient membership을 검사하고 subject/body/taskId를 mailbox에 보관한다. 실행 중 teammate에는 본문 대신 읽기 알림을 pending steer로 넣고 broadcast는 다른 teammate에 전달한다. |
| R14 | [sdk/packages/core/src/runtime/orchestration/team-persistence-writer.ts:78–151](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/runtime/orchestration/team-persistence-writer.ts#L78-L151) | durable team 이벤트·읽음 상태·teammate 정보를 batching하고 terminal/membership 변화는 즉시 flush한다. 실패 시 state delta를 requeue하고 bounded event batch로 재시도한다. |
| R15 | [sdk/packages/core/src/extensions/tools/team/spawn-agent-tool.ts:115–203](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/extensions/tools/team/spawn-agent-tool.ts#L115-L203) | spawn_agent는 parallel 도구이며 focused delegated SessionRuntime 종료를 기다린다. parent ID·abort signal·tool policy·approval callback을 전달하고 시작/종료 observer는 best effort다. |
| R16 | [sdk/packages/core/src/cron/runner/cron-runner.ts:254–392](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/cron/runner/cron-runner.ts#L254-L392) | CronRunner tick은 활성 lease를 먼저 갱신하고 claimDueRuns에 전역 동시성 상한을 전달한다. lease 손실은 abort, disabled/removed spec은 취소, 실행별 timeout과 heartbeat를 관리한다. |
| R17 | [sdk/packages/core/src/hooks/hook-file-hooks.ts:985–1078](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/hooks/hook-file-hooks.ts#L985-L1078) | 파일 hook 설정은 agent start/resume·tool call/result·end/abort를 runtime hooks에 연결한다. beforeTool은 입력 override/stop/context를 받을 수 있으나 이 경로의 prompt_submit은 반환 제어 채널이 없다. |
| R18 | [sdk/packages/core/src/extensions/plugin/plugin-loader.ts:105–146](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/extensions/plugin/plugin-loader.ts#L105-L146) | plugin path의 module export를 로드하고 manifest를 검증·정규화하며 setup에 session/client/user/workspace/automation/logger/telemetry context를 주입한다. |
| R19 | [sdk/packages/core/src/extensions/mcp/tools.ts:16–48](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/extensions/mcp/tools.ts#L16-L48) | MCP listTools 결과를 AgentTool로 eager 변환하고 schema·timeout/retry 설정·cache-oversized 결과 정책 및 호출 context를 MCP callTool에 전달한다. |
| R20 | [sdk/packages/core/src/extensions/tools/executors/bash.ts:850–961](https://github.com/cline/cline/blob/55a133b751b66d42b8a3ffad76c731ad4f51577d/sdk/packages/core/src/extensions/tools/executors/bash.ts#L850-L961) | shell detach는 PID 및 processStartToken을 요구하고 로그 metadata를 만들며 tool promise를 완료시킨 뒤 프로세스 출력은 별도 로그로 계속 보낸다. controller 등록은 session/tool-call에 묶인다. |

## 주장 구분·검증 한계

**실제 구현 확인:** 공개 AgentRuntime loop, SessionRuntime bridge, local/hub/remote 분기, 팀 mailbox/state persistence, scheduled lease runner, hooks/plugin/MCP, checkpoint restore transaction 및 shell detach. **README 주장:** 모든 host에서 같은 경험, IDE lint 수정·체크포인트·OS 배포 및 JetBrains 기능 동등성. **분석자의 추론:** 이들 계약을 Moodcode의 기존 engine/host·durable inbox 위에 독립 확장하면 기능을 추가할 수 있다는 후보 평가. **미확인:** 실제 모델/공급자·서비스·다중 client·crash·OS·GUI 동작과 비공개 plugin.

Claude Code provider처럼 외부 CLI가 자체 도구를 실행하는 경로는 `handler-factory.ts` 79–87에 명시되어 있다. 이 경우 공개 Cline loop 분석을 외부 CLI의 내부 loop/승인/저장 구현 확인으로 확대하지 않는다. cloud·connector·auth·telemetry service와 외부 provider 내부 역시 범위 밖이다.

이번에는 설치·setup·build·test·실제 계정/모델·GUI·upstream benchmark를 실행하지 않았다. HEAD, 근거 파일과 줄 범위, 고정 commit 해시, 후보의 실제 Moodcode 경로 및 JSON 구조만 정적으로 검사했다. Moodcode의 기존 통과 기록은 이번 Cline 실행 결과가 아니다. LFS/submodule/외부 배포를 확보하지 않았으며, 원본 소스를 읽은 분석이므로 clean-room 절차를 수행했다고 주장하지 않는다.
