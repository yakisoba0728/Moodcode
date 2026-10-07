# Mistral Vibe 엔진 정적 분석

2026-10-07. 분석 방식은 `static-source-review`다. 핵심은 **현재 기본 엔진인 Unified Harness와 `--legacy-harness`의 Python `AgentLoop`를 구분하는 것**이다. Rust TUI와 ACP는 같은 app-server의 client/adapter 경계이며 독립적인 모델·도구 엔진으로 취급하지 않는다. Moodcode의 이미 구현된 요약·프로필·MCP·PTY·child·승인을 다시 신규 기능으로 제안하지 않는다.

## 원본과 package·license 경계

- 저장소: [mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe)
- 전체 HEAD: `7cb91894c40bb25173abcfa36e5ea2b4b81eb28c`
- 읽은 checkout: `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/mistral-vibe`
- 비교 기준: Moodcode 문서 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 `464812f7d1af24466f57070663131f5979aeca51`와 [구현 상태](../moodcode/implementation-status.md).

`pyproject.toml`의 package는 `mistral-vibe` 2.26.0, Python ≥3.12다. `vibe`→Python launcher, `vibe-acp`→ACP entrypoint, `vibe-app-server`→stdio 진입점을 선언한다. 배포 build는 Maturin과 PyO3 native Unified Harness를 포함한다. 저장소 안의 `harness/core`는 Rust deterministic state/transition core이고 `harness/runtimes/python/python/mistralai_vibe_local_harness`는 provider·filesystem·process·MCP·hook effect를 수행하는 Python runtime이다. `vibe/cli-rust`는 Ratatui/Tokio terminal client이며 Python Textual client도 남아 있다.

Root 실제 `LICENSE`는 Apache-2.0이고 `distribution/zed/LICENSE`도 Apache-2.0 전문이다. 다만 `vibe/cli-rust/Cargo.toml`의 하위 package는 `license = "Proprietary"`, `publish = false`다. 이 표기를 root Apache 고지로 덮어 쓰거나 전체 Rust client의 재사용 허용성을 확정하지 않는다. `harness/core/Cargo.toml`에는 별도 license field가 없으며 별도 LICENSE를 발견하지 않았다. 최종 배포 의존성 audit나 법률 검토를 수행한 결과가 아니다. 이번 산출물에는 source·prompt·tool description·fixture를 복사하지 않는다. [MV-R18, MV-R19]

마지막 commit은 로컬 Git metadata상 2026-10-06 `fix(ci): pin the release sdist wheel build and test the sdist path in CI (#1191)`이다. version/build 변경·CI·많은 test source가 있는 활동 중인 snapshot으로 볼 수 있지만, release publish·실제 CI 통과·현재 지원 품질을 검증한 것은 아니다. README의 Windows 동작/UNIX 공식 지원은 문서 주장으로만 기록한다.

## 대표 고정 근거

근거의 상대 경로·줄 범위·파일 및 범위 SHA-256은 [evidence JSON](mistral-vibe.evidence.json)에 있다. 본문은 아래 ID를 인용한다.

| ID | 확인 범위 | 고정 SHA 소스 |
|---|---|---|
| MV-R01 | 기본 엔진 선택 | [vibe/_experimental_harness.py:123](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/_experimental_harness.py#L123-L157) |
| MV-R02 | Host/backend composition | [vibe/app_server/_runtime.py:1184](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/app_server/_runtime.py#L1184-L1288) |
| MV-R03 | Unified action continuation | [harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_runtime.py:1844](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_runtime.py#L1844-L1904) |
| MV-R04 | Unified 모델 호출 | [harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_completion.py:199](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_completion.py#L199-L285) |
| MV-R05 | Python legacy loop | [vibe/core/agent_loop/_loop.py:2051](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/core/agent_loop/_loop.py#L2051-L2144) |
| MV-R06 | Legacy hook→approval→tool | [vibe/core/agent_loop/_loop.py:2685](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/core/agent_loop/_loop.py#L2685-L2781) |
| MV-R07 | Unified compaction | [harness/core/src/core/features/compaction/execution.rs:163](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/harness/core/src/core/features/compaction/execution.rs#L163-L238) |
| MV-R08 | 세션 publication | [harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_storage.py:1868](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_storage.py#L1868-L1980) |
| MV-R09 | Trust-gated discovery | [vibe/core/config/harness_files/_harness_manager.py:92](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/core/config/harness_files/_harness_manager.py#L92-L210) |
| MV-R10 | 하위 지침 injection | [vibe/app_server/_agents_md_hooks.py:61](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/app_server/_agents_md_hooks.py#L61-L153) |
| MV-R11 | Agent profile ceiling | [vibe/core/agents/models.py:27](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/core/agents/models.py#L27-L129) |
| MV-R12 | Child 후속 지시 receipt | [harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_subagents/_controller.py:936](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_subagents/_controller.py#L936-L1031) |
| MV-R13 | Hook rewrite 검증 | [vibe/core/agent_loop_hooks.py:258](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/core/agent_loop_hooks.py#L258-L328) |
| MV-R14 | Managed process 정리 | [harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_processes/_manager.py:708](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/_processes/_manager.py#L708-L819) |
| MV-R15 | ACP prompt adapter | [vibe/acp/agent.py:770](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/acp/agent.py#L770-L847) |
| MV-R16 | Rust TUI/server 경계 | [vibe/cli-rust/src/server/process.rs:77](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/cli-rust/src/server/process.rs#L77-L160) |
| MV-R17 | Catalogue와 shell gate | [vibe/core/tools/manager.py:299](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/core/tools/manager.py#L299-L390) |
| MV-R18 | Root license | [LICENSE:189](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/LICENSE#L189-L201) |
| MV-R19 | Rust CLI metadata | [vibe/cli-rust/Cargo.toml:1](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/vibe/cli-rust/Cargo.toml#L1-L18) |
| MV-R20 | README 주장 | [README.md:94](https://github.com/mistralai/mistral-vibe/blob/7cb91894c40bb25173abcfa36e5ea2b4b81eb28c/README.md#L94-L179) |

## 실제 진입점부터 종료까지

**기본 경로.** `vibe.cli.launcher.main`은 `VIBE_CLI=rust/python` 또는 cached Rust TUI rollout으로 client를 선택한다. README 323–331의 “unset이면 Python”과 달리 소스 launcher 22–30은 cached rollout도 확인하므로 README 문장만으로 TUI 기본값을 단정하지 않는다. 이 client 선택과 engine 선택은 독립적이다. `resolve_harness_selection`은 flag가 없어도 Unified를 고르며 `--experimental-harness`는 현재 중복 flag, `--legacy-harness`만 임시 legacy escape hatch다. runtime이 없거나 호환되지 않으면 startup 오류이며 자동 legacy fallback은 없다. [MV-R01, MV-R02]

`HarnessProcess.create_session_backend_host`는 Unified Host를 `adapt_harness_host`로 감싸 기존 `SessionBackendHost`에 연결한다. session context는 config/model routes, tool/agent ceiling, system instructions, credentials service, MCP/connector/plugin catalog와 hooks를 주입한다. `Runtime._drive`는 Core transition의 pending action을 시작하고 완료 event를 lock 아래 Core에 적용한다. 다음 transition에 새 action이 생기면 반복하고, in-flight action이 없으면 반환한다. pending에서 사라진 action은 취소하며 drive 실패는 별도 settlement 경로에 넘긴다. 즉 Core가 모델 호출·도구·승인·hook의 상태 전이를 결정하고 Runtime이 effect를 수행한다. [MV-R02, MV-R03]

모델 action은 `execute_completion`에서 agent/compaction route를 구분하고 매 호출 credential을 resolver에서 얻는다. Mistral SDK adapter 또는 generic adapter로 messages/tools를 보내며 provisional delta와 provider retry 관측을 연결한다. generic package에는 OpenAI Chat/Responses, Anthropic, Vertex adapter가 있다. 지원 source가 있다는 사실과 실제 계정별 capability·retry 성공은 다르다. Core의 `turn.rs::dispatch/finish_pending_completion/finish_pending_tool/next_completion`가 completion과 tool batch의 결과를 받아 continuation/terminal을 정한다. Runtime의 `_resolve_action`은 intent/result receipt를 기록하고 process/subagent action은 각각 전용 controller로 보낸다. [MV-R03, MV-R04]

**Python legacy 경로.** `AgentRuntimeFactory`→`AgentLoop`→`act`→`_conversation_loop`가 사용자 입력을 열고 middleware를 실행한다. `_perform_llm_turn`→`_chat_streaming` 또는 `_chat/_complete`→`backend.complete/complete_streaming`가 호출 경로다. formatter가 모델 메시지의 tool call을 parse/resolve하고 `_handle_tool_calls`가 도구를 concurrent batch로 실행한다. `_execute_tool_call`은 serialize→pre-tool pipeline→permission→invoke 순서다. 도구 result를 history에 붙이면 마지막 메시지가 tool이어서 다음 모델 turn을 계속한다. 정상 답변 뒤 pending injection이 없으면 post-turn hook을 검사하고 종료한다. 매 step와 finally에서 저장하며 middleware는 turn/token/price/read-only/auto-compact 제한을 적용한다. overflow self-heal은 해당 사용자 turn의 한정된 compaction 재시도다. [MV-R05, MV-R06]

`_should_execute_tool`(legacy `_loop.py` 2949–3020)은 bypass, ALWAYS/NEVER, granular required permission coverage, approval broker를 구분한다. hook이 rewrite한 인자가 이 permission 판단에 들어간다. 이는 Moodcode의 exact prepare/fingerprint/effect 승인 계약과 동일한 구현이라고 주장할 수 없다. Moodcode에 참고할 것은 실행 순서이고, 사용자 승인과 hash binding은 기존 Moodcode의 더 구체적인 계약을 유지해야 한다. [MV-R06, MV-R13]

## 문맥·지침·기억·세션

| 범주 | 소스로 확인한 동작 | 기본/선택·확인 한계 |
|---|---|---|
| 문맥 선택 | Core model context와 serialized input budget; agent/compaction image delivery projection, provider context usage와 추정치 기반 threshold; legacy는 완전한 tool adjacency를 맞춰 context boundary 이후를 선택 | native tokenizer 전체 동등성·실제 provider token 정확성은 미측정 |
| Compaction | Unified는 summary 유효성과 replacement budget을 확인한 후 context 교체; 실패/잘못된 delimiter/empty/tool call을 별도 실패 또는 한정 재시도로 처리 [MV-R07] | 설정 threshold 또는 수동 명령. legacy `CompactionManager` 89–179는 snapshot copy를 요약하고 boundary envelope를 append; primary가 tools를 포함할 수 있고 fallback은 tools 없는 별도 모델 호출이므로 두 경로를 혼동하지 않음 |
| 프로젝트 지침 | 신뢰한 project root와 user instructions를 startup prompt에 합성; 파일 읽기 성공 뒤 하위 AGENTS.md를 발견하고 session당 directory 단위 dedup [MV-R09, MV-R10] | trust 거절 시 project behavior가 비활성. additional roots는 명시적 opt-in; dedup state의 모든 restart/UI edge case를 실측하지 않음 |
| 검색·skill | 로컬 file/grep 도구, skill header discovery와 필요할 때 `skill.read`/legacy skill tool 내용 로딩 | semantic repository index와 같지 않음. remote registry skills는 `experimental_enable_registry_skills=False`이며 Mistral provider/API key가 필요한 opt-in |
| 기억 | 저장한 transcript, compaction summary, profile/instructions, session scratchpad | legacy scratchpad는 runtime 소유 임시 디렉터리이며 cleanup 대상. 조사한 경로에서 자동 cross-project semantic memory/학습 publication을 확인하지 못했으나 제품 전체 부재로 단정하지 않음 |
| 세션 저장/복구 | Unified: checkpoint/runtime/projection/chunks·SHA-256 manifest·fsync/atomic publication·CURRENT와 journal replay [MV-R08]. legacy: `SessionLogger`의 serialized messages JSONL+metadata와 `SessionLoader` validation/`AgentRuntimeFactory.resume_root` | session logging off는 임시 store 수명으로 처리. resume에는 session lease·model/profile/config baseline와 import provenance가 관여; crash recovery 성공을 실행 검증하지 않음 |

Folder trust는 명령/편집 승인의 대체물이 아니다. `TrustedFoldersManager`는 repo/cwd/session trust와 decline을 구분하고, `HarnessFilesManager._trusted_workdir`는 신뢰가 없는 cwd를 project roots에 넣지 않는다. 따라서 project config뿐 아니라 hook/tool/skill/plugin/agent directory가 함께 gate된다. builtin AGENTS hook은 additional roots 목록에 cwd가 다시 들어가 trust gate를 우회하지 않도록 걸러낸다. [MV-R09, MV-R10]

## 도구·승인·취소·복구

Legacy `ToolManager`는 builtin/custom/MCP/connector catalogue를 합성하고 runtime availability→source filtering→enabled patterns→disabled patterns 순서로 좁힌다. allow와 deny가 함께 있으면 deny가 최종이다. 인스턴스는 호출 때 lazy 생성한다. MCP stdio/HTTP·OAuth/sampling/descriptor cache와 client tool I/O port가 별도 경계다. Unified runtime도 `_local_actions`가 filesystem/shell/skill/hook를 dispatch하고 MCP/connector controller를 연결한다. catalogue가 동일 이름을 표현하더라도 각 engine의 schema와 실행 경로는 같다고 가정하지 않는다. [MV-R17, MV-R02]

코딩 도구는 read/write/search-replace/grep와 shell이다. legacy `edit.run`은 파일 lock 아래 원문을 읽어 old string이 없거나 `replace_all=False`에서 여러 번 나타나면 거절하고 atomic write로 교체한다. Unified `_local_actions`는 `file_system.read_file/write_file/search_replace`를 `_file_tools`로 전달한다. 테스트·lint는 shell을 실행하거나 등록한 hook을 통해 요청할 수 있다. 이번 검토 범위에서 자동 LSP 진단/formatter와 Moodcode의 checkpoint 동기화에 해당하는 독립 호출 경로는 확인하지 않았다. 외부 tools를 통해 제공할 가능성까지 배제하지 않는다.

README의 managed shell/poll/stdin은 rollout 동작으로 기술되어 있다. legacy config의 `managed_shell_tools_enabled`는 false이고 GrowthBook layer가 server experiment 값을 매핑한다. `ToolManager`는 이 flag 및 POSIX runtime 지원으로 managed variants를 노출한다. Unified의 `process.*`는 별도의 session-owned process controller다. 기존 shell, managed legacy shell, Unified process capability를 모두 “기본 PTY 기능” 한 항목으로 합치지 않는다. [MV-R17, MV-R20]

취소는 source상 여러 계층이다. legacy 모델 stream은 중단된 assistant를 보존하고 missing tool responses를 보완한다. tool cancellation은 cancelled result와 post-tool finalization으로 반영한다. Unified `Runtime.interrupt`는 Core interrupt, cancelled command receipt settlement와 subagent reconciliation을 수행하고 `close`는 child controller·process manager를 닫는다. Managed process manager는 graceful terminate→wait→force terminate→wait를 시도하고 확인 실패는 `orphaned` 및 output unavailable로 기록한다. 이 코드가 모든 daemon/OS process tree의 종료를 증명한다는 뜻은 아니다. Moodcode에 이미 있는 unknown cleanup 격리·native owner proof보다 일반적으로 강하다고 평가하지 않는다. [MV-R06, MV-R14]

## 프로필·하위 에이전트·hook·adapter

`AgentProfile`은 model/tool/config override와 instructions를 TOML로 표현한다. ask는 approval, plan은 read-only 성격이지만 plan-file path에는 별도 write/edit 허용 규칙을 준다. accept-edits는 file edit 자동 승인, auto-approve는 bypass이며 기본 accept-edits 문서 주장과 Moodcode Build의 explicit approval 기본값은 다르다. smart-approve는 Unified 전용 classifier gate이며 명시적 agent/flag 선택 범위다. explore는 read/grep/skill만 허용된 subagent다. 기존 Moodcode profiles는 immutable revision과 별도 Plan/Build safety를 갖추므로 일반 profile 기능은 신규 후보가 아니다. [MV-R11, MV-R20]

**위임 도구 이름도 engine별로 다르다.** legacy는 `task`(`Task.run`)이고 이 tool이 subagent type과 depth=1을 확인한 뒤 `SubagentRunnerPort.run`으로 넘긴다. 기본 Unified는 `subagent.spawn/list/wait/send_message/interrupt/stop` action을 controller에서 dispatch한다. 조사한 경로에서 `delegate_task`라는 동일 tool 이름을 찾지 못했다. Moodcode `delegate_task`와 비교하는 대상은 위 동작이며 이름이나 API를 복제하자는 뜻이 아니다. Unified child는 idle 후에도 ready로 유지되고 후속 입력을 받아 새 Turn 또는 running Turn steer에 연결한다. `_send/_resume_send`는 generation과 operation receipt를 영구 저장하여 parent intent와 child command admission을 결합한다. 기존 terminal child 결과 전달을 이 live mailbox로 확대하는 것은 별도 계약이다. [MV-R12, MV-R20]

Hooks는 legacy pre_tool/post_tool/post_agent와 Unified pre/post agent turn, pre/post LLM call, pre/post tool call이 있다. legacy pre-tool rewrite는 args schema를 재검증하고 invalid rewrite는 denial로 멈춘다. post-agent feedback은 injected user message로 다시 loop를 이어갈 수 있다. configured shell hook executor는 capped output·timeout·cancel process cleanup을 가진다. builtin instructions hook은 공개 foreign hook의 실행 notice와 구분된다. Moodcode `observePluginTool`의 prepared/settled는 metadata 관측으로 이미 존재하므로 후보는 approval 이전 proposal gate와 제한된 post-turn 검증 continuation이다. [MV-R13, MV-R06, MV-R05, MV-R10]

Rust TUI는 stdio app-server를 spawn하고 JSON-RPC request/update/callback을 처리한다. Unix backend process group, stdin/stdout/stderr lifetime을 client가 소유한다. engine state는 Python app-server/Unified runtime에 있고 TUI는 projection/control 역할이다. ACP `VibeAcpAgent.prompt`도 `AppServerSession.act`를 호출하여 동일 event를 ACP update로 매핑하며 usage, cancelled, max_tokens, max_turn_requests를 반환한다. permission/user question/client file/terminal I/O가 protocol capability와 callback으로 연결되고 cancel은 session interrupt로, close는 app-server close로 내려간다. 실제 editor별 interoperability는 확인하지 않았다. [MV-R15, MV-R16, MV-R02]

## Moodcode의 추가 계약 후보

아래는 구현하지 않은 제안이다. 세부 contract·검증 조건·실제 existing Moodcode 경로는 evidence JSON의 같은 ID에 있다. 우선순위는 비교 분석 판단이며 제품 roadmap 확정은 아니다.

| 후보 | Moodcode에 이미 있는 부분 | 새 계약 | 우선순위·비용 |
|---|---|---|---|
| MV-C01 프로젝트 신뢰 | nested instruction discovery와 durable baseline, 명시적 host plugin | canonical workspace/digest별 session/durable trust, repository behavior 활성화/철회, 다음 모델 경계 무효화. 읽기·승인·Plan/Build와 독립 [MV-R09, MV-R10] | P1 / M |
| MV-C02 lifecycle hook | plugin prepared/settled metadata, exact prepare/approval/effect | propose 입력 수정→schema 검증→새 prepare/fingerprint→승인, bounded post-turn 검증 continuation. credentials와 prepared 승인 변경은 허용하지 않음 [MV-R06, MV-R13, MV-R05] | P2 / L |
| MV-C03 child 후속 입력 | 격리 worktree/read-only delegate_task, budget/deny/cancel 상속, terminal 결과 inbox delivery | generation/operation-bound live mailbox, parent intent/child admission/ack receipt, ready 새 Turn과 running steer. 기존 ceiling/예산을 매 Turn 유지 [MV-R12] | P2 / L |
| MV-C04 ACP adapter | engine/host 분리, durable command/event/input·approval/cancel/paging | 별도 thin protocol adapter와 capability negotiation; 기존 engine loop 사용, disconnect/cancel 구분, replay의 tool pairing 보존 [MV-R02, MV-R15, MV-R16] | P2 / M |

C01은 `context/sources.ts`와 `service.ts`의 현재 nested 지침 및 baseline provenance 위에 추가한다. C02는 `plugins/index.ts` 관측 hook을 그대로 유지한 새 propose-stage 계약이다. C03은 `child-tasks/index.ts`의 terminal delivery와 `runner/input-scheduler.ts`를 연결하되 새 message receipt가 필요하다. C04는 `engine.ts`, `ports.ts`, contracts v1/v2의 existing host identity·approval scope를 재사용한다. MCP/PTY/LSP/formatter/summary/profile/child/approval 자체는 기존 구현 범위로 보존한다.

## 외부 서비스·확인 한계

Mistral hosted models/browser auth, generic provider endpoints, telemetry/Sentry와 GrowthBook rollout, opt-in remote skills registry, MCP/connector services는 각각 별도 credential·네트워크·이용 조건 경계다. `enable_telemetry`는 source default true, tracing은 별도 opt-in이다. README는 telemetry/crash reporting 비활성 설정과 Privacy Policy를 안내하지만 실제 수집 payload·서버 보존 정책을 이 검토에서 검증하지 않았다. root license가 외부 서비스 이용 권한을 부여한다고 해석하지 않는다.

이번 검증은 JSON 구조, reference 20개의 파일·줄 범위·고정 SHA 및 hash, candidate 4개의 existing Moodcode 경로·reference ID를 읽기 전용으로 확인하는 정적 검사다. upstream 설치/build/test/GUI/모델/계정/API 실행이나 benchmark를 수행하지 않았다. packaged native module/binary의 실제 load, server rollout 배정, OS별 process ownership·cleanup와 crash recovery, provider vision 및 ACP editor 호환성은 확인하지 못했다. Git LFS/submodule/생성 배포 파일에 대한 full dependency audit도 아니다. Moodcode 1차 테스트/실제 모델 통과 기록은 기존 baseline이며 이번 upstream 실행 결과가 아니다. 원본을 읽은 분석으로 clean-room 절차를 수행했다고 주장하지 않는다.
