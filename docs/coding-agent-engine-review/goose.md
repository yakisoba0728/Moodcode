# Goose 엔진 정적 분석

2026-10-07. Goose는 Rust의 `Agent`를 CLI가 직접 호출하고 desktop/API가 ACP 서버를 통해 사용하는 범용 로컬 에이전트다. 이번 HEAD에는 기존 loop와 **기본값이 꺼진 실험 상태 기계**가 공존한다. Moodcode에서 유용한 후속 후보는 레시피·구조화 결과, ACP와 문맥 소유권, 승인된 지속 기억, 제한된 lifecycle hook, 여러 child의 durable join이다. MCP·도구 검색·하위 작업·문맥 요약 자체는 Moodcode에 이미 있다.

## 원본·검토 경계

| 항목 | 고정 기준 |
|---|---|
| canonical 원본 | [aaif-goose/goose](https://github.com/aaif-goose/goose); 요청에 포함된 `block/goose`는 같은 프로젝트의 이전 주소 |
| full HEAD | `f9c18a81952e8895b6f2d88b0f4569f3975034af` |
| 로컬 checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/goose` |
| 분석 모드 | `static-source-review`; 설치·실행·테스트·모델·계정·GUI 호출 없음 |
| package 경계 | `crates/goose`: session/Agent/extension/ACP·플랫폼 조합. `goose-agent`: generic operation/inference/state machine. `goose-provider-types`: message/model/provider 계약. `goose-providers`: 기본 provider 구현. `goose-context-management`: 요약 유틸리티. `goose-mcp`: bundled MCP server. `goose-cli`: CLI·serve 진입. `ui/desktop`: Electron/TypeScript/React ACP client |
| 유지보수 관측 | workspace version `1.54.0`; HEAD commit `2026-10-07T02:38:09Z`, OpenAI model metadata/Responses 변경. source-manifest의 같은 날짜 GitHub snapshot은 archived=false·disabled=false. CI 통과나 릴리스 품질을 실행 확인한 결과는 아님 |
| Moodcode 비교 | 문서 `3065fdd03649df393f4170b38a2f049a1e52d2f3`, engine `464812f7d1af24466f57070663131f5979aeca51`; [baseline](./moodcode-baseline.md)·[구현 상태](../moodcode/implementation-status.md) |

root `LICENSE`는 Apache-2.0이며 workspace와 주요 crate, desktop manifest도 이를 표시한다(G02). 아래는 root와 별도로 읽은 bundled 웹 시각화 라이브러리 고지다. 파일명 검색에 잡히는 `SecureStorageNotice.tsx`는 keychain 안내 UI로, 라이선스 고지가 아니다.

| 별도 고지 경로 | 읽은 고지 |
|---|---|
| [chart-js.license](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose-mcp/licenses/chart-js.license#L1-L9) | MIT, Chart.js Contributors |
| [d3-js.license](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose-mcp/licenses/d3-js.license#L1-L13) | ISC 형식, Mike Bostock |
| [d3-sankey.license](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose-mcp/licenses/d3-sankey.license#L1-L27) | BSD 3-Clause 형식, Mike Bostock |
| [leaflet-markercluster.license](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose-mcp/licenses/leaflet-markercluster.license#L1-L20) | MIT 형식, David Leaver |
| [leaflet.license](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose-mcp/licenses/leaflet.license#L1-L26) | BSD 2-Clause, Volodymyr Agafonkin·CloudMade |
| [mermaid.license](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose-mcp/licenses/mermaid.license#L1-L21) | MIT, Knut Sveidqvist |

외부 Rust/JS/native 의존성, code-mode의 `pctx`·V8 관련 패키지, 모델·구독 공급자, 원격 MCP/ACP 서비스의 권리는 각각 별도 범위다. 이번 분석은 전이 의존성이나 배포 binary 전체의 license audit·법률 검토가 아니다. 원본 source·prompt·tool description·fixture·미디어를 Moodcode에 옮기지 않았다. 원본을 읽었으므로 clean-room 절차를 수행했다고 주장하지 않는다.

## 대표 근거

본문의 G 번호는 아래 고정 permalink와 [기계 검증용 근거](./goose.evidence.json)를 가리킨다. JSON은20개 원본 구간의 file/range SHA-256과5개 구현 후보를 기록한다.

| ID | 고정 소스 | 확인 범위 |
|---|---|---|
| G01 | [README.md:23–29](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/README.md#L23-L29) | 제품 주장 |
| G02 | [LICENSE:1–23](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/LICENSE#L1-L23) | root license |
| G03 | [crates/goose/src/agents/agent.rs:2176–2289](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/agent.rs#L2176-L2289) | reply 진입·분기 |
| G04 | [crates/goose/src/agents/agent.rs:2870–3013](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/agent.rs#L2870-L3013) | 기존 모델 stream |
| G05 | [crates/goose/src/agents/agent.rs:3035–3118](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/agent.rs#L3035-L3118) | 검사·승인·tool batch |
| G06 | [crates/goose/src/agents/agent.rs:1741–1838](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/agent.rs#L1741-L1838) | 실험 pipeline |
| G07 | [crates/goose/src/agents/extension_manager/lease.rs:570–716](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/extension_manager/lease.rs#L570-L716) | lease 기반 dispatch |
| G08 | [crates/goose/src/context_mgmt/mod.rs:70–207](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/context_mgmt/mod.rs#L70-L207) | 문맥 compaction |
| G09 | [crates/goose/src/session/session_manager.rs:1922–2013](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/session/session_manager.rs#L1922-L2013) | SQLite message transaction |
| G10 | [crates/goose-mcp/src/memory/mod.rs:184–283](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose-mcp/src/memory/mod.rs#L184-L283) | scope별 기억 파일 |
| G11 | [crates/goose/src/agents/platform_extensions/chatrecall.rs:134–215](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/platform_extensions/chatrecall.rs#L134-L215) | 세션 recall |
| G12 | [crates/goose/src/recipe/mod.rs:43–129](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/recipe/mod.rs#L43-L129) | recipe schema |
| G13 | [crates/goose/src/agents/platform_extensions/summon.rs:884–961](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/platform_extensions/summon.rs#L884-L961) | 기존 child·Auto 한계 |
| G14 | [crates/goose/src/agents/state_machine/ops_foreground_subagent.rs:191–257](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/state_machine/ops_foreground_subagent.rs#L191-L257) | 실험 foreground join |
| G15 | [crates/goose/src/hooks/mod.rs:700–798](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/hooks/mod.rs#L700-L798) | blocking hook |
| G16 | [crates/goose/src/agents/platform_extensions/developer/shell.rs:557–660](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/platform_extensions/developer/shell.rs#L557-L660) | shell 취소·출력 정리 |
| G17 | [crates/goose/src/acp/server.rs:2271–2375](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/acp/server.rs#L2271-L2375) | ACP server prompt |
| G18 | [ui/desktop/src/gooseServe.ts:325–407](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/ui/desktop/src/gooseServe.ts#L325-L407) | desktop local host |
| G19 | [crates/goose-cli/src/session/mod.rs:1301–1335](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose-cli/src/session/mod.rs#L1301-L1335) | CLI shared Agent |
| G20 | [crates/goose/src/acp/provider.rs:677–814](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/acp/provider.rs#L677-L814) | ACP provider context |

## 진입부터 종료까지

**기존 기본 경로.** CLI `process_agent_response`는 `SessionConfig`를 만들고 Ctrl+C token을 연결해 `goose::agents::Agent.reply`를 직접 호출한다(G19). `reply`는 세션 context와 live message ID를 적용하고 `reply_impl`에 들어간다(G03). 새 요청은 session DB와 현재 provider 상태를 읽고 slash command·hook·project instruction을 거친다. `prepare_tools_and_prompt`는 현재 session의 extension lease, schema, extension instruction, 모델 설정과 working-directory hints를 함께 준비한다. 이후 inference마다 lease·tool·prompt를 다시 구성해 그 호출에 보여 준 catalogue로 dispatch한다. 추가 확인 구간은 `agents/reply_parts.rs:205–256`, `agents/agent.rs:2743–2780`이다.

모델 호출은 `stream_response_from_provider`에 system/conversation/tools를 전달한다. 응답의 usage·text/reasoning·tool request를 구분하고 `AgentEvent`로 내보내며 취소 token과 stream next를 경쟁시킨다(G04). tool request가 나오면 inspector가 approved/needs-approval/denied를 나누고 필요한 confirmation을 기다린다. 승인된 tool stream은 여러 개를 함께 소비하며 tool response를 call ID에 맞춰 만든다(G05). 기본 loop가 여러 도구를 동시 소비한다는 사실을 임의 효과의 안전한 병렬성 또는 rollback 보장으로 해석하지 않는다.

도구 없는 응답은 final-output schema·goal/grind·pending steer·recipe retry 조건에 따라 완료 또는 후속 호출로 이어진다. `max_turns`와 Stop hook의 연속 block cap이 반복을 제한한다. loop 말미에는 생성한 메시지를 DB에 저장하고 Stop 판정을 거쳐 종료하며 lease를 drop한다. 이 부분은 `agents/agent.rs:2810–2868, 3464–3497, 3660–3723`에서 읽었다. 일반 모델의 stream wrapper는 첫 성공 item 이전의 transient 오류만 제한된 backoff로 재호출하며, 이미 item이 왔거나 provider가 자체 문맥을 소유하면 이 retry를 수행하지 않는다. [추가 stream wrapper 근거](https://github.com/aaif-goose/goose/blob/f9c18a81952e8895b6f2d88b0f4569f3975034af/crates/goose/src/agents/reply_parts.rs#L357-L487). 모든 provider의 내부 HTTP retry와 accepted-effect 재실행까지 동일하게 보장한다는 뜻은 아니다.

**실험 경로.** `Agent.reply(..., use_state_machine=true, ...)`는 `reply_with_state_machine`으로 분기한다(G03). `agents/state_machine/mod.rs:94–98`의 `GOOSE_STATE_MACHINE` 환경 기본값은 false이며 ACP는 요청 metadata를 통해 경로를 선택한다. 새 `goose-agent::StateMachine`을 무조건 기본 엔진으로 설명하면 부정확하다.

실험 pipeline은 entry hook·slash command·steer·shell escape·compaction·approval·skill·foreground child·recipe·extension tool·retry·Stop·max-turn operation 뒤에 inference를 둔다(G06). generic machine은 매 step에 session을 다시 load하고 처음 적용되는 operation의 effect를 persistence handler에 넘긴 뒤 `yield_to_client`이면 멈춘다(`goose-agent/src/machine.rs:98–181`). Goose effect handler는 message·visibility·recipe·usage를 저장한 뒤 confirmation/history-replaced event를 내보낸다(`agents/state_machine/session.rs:39–144`). 이는 외부 도구 효과와 DB 변경을 하나의 원자 transaction으로 묶는다는 보장이 아니다.

## 기능과 실제 경계

| 범주 | 소스로 확인한 동작 | 해석·확인 한계 |
|---|---|---|
| 모델/공급자 | 공통 `Provider.stream(model, system, messages, tools)`와 모델 metadata. ACP adapter는 external session ID/resume, model/mode/effort, ActionRequired permission 경로를 가짐(G20). | provider-types 계약과 실제 외부 agent가 다름. subscription 로그인·모든 provider의 image/reasoning·OS 호환성을 실행하지 않음. |
| 문맥 선택·요약 | agent-visible projection과 conversation repair 후 모델로 보냄. compaction은 원본을 user-visible로 보존하면서 agent visibility를 끄고 agent-only summary/continuation과 최신 요청을 추가(G08). | summary의 원문 보존과 별도 durable Attempt/cleanup proof는 다른 계약. 요약 내용 정확도·비용·토큰 개선은 실측하지 않음. |
| tool-pair 요약 | `context_mgmt/mod.rs:444–575`에서 tools 없는 one-shot 요약과 완전한 request/response sibling 집합의 group 처리 확인. 이번 turn의 tool 수를 보호하고 자체 문맥 provider에서는 생략. | Moodcode의 completed-history summary·opt-in active-prefix와 단위가 다름. 완전 exchange를 훼손하지 않는 계약을 먼저 유지해야 함. |
| 기억·회상 | Memory MCP는 사용자 전역/프로젝트별 category·tag 텍스트 저장(G10). chatrecall은 session 발췌 또는 날짜/keyword 검색(G11), 검색 로드는 agent audience로 투영. | MemoryServer 안내의 사용자 확인 문구는 지침임. `remember` 함수 자체의 exact 승인 transaction 보장으로 판단하지 않음. recall은 embedding 기반 검색이라고 단정하지 않음. |
| MCP·extension | stdio·streamable HTTP·builtin subprocess·in-process platform client가 동일 extension manager로 연결됨. lease는 scope/cwd/schema catalogue를 잡고 call/result·notification·elicitation을 연결(G07). | `extension_manager/mod.rs:719–790` 및 `lease.rs:181–271` 추가 확인. 외부 extension이 반환한 mutation metadata는 제거함. 세션별 lease를 Moodcode의 승인/불확실성 proof와 동일시하지 않음. |
| discovery | extension manager의 search/enable/disable/resource 도구, summon의 recipe/agent/source discovery 확인. code-mode feature는 catalogue/filesystem disclosure에서 `pctx` progressive 검색으로 일부 schema를 숨김(`reply_parts.rs:260–319`). | 기본 경로의 extension 검색과 개별 tool 선택은 다름. code-mode 기능의 전체 runtime·sandbox·브라우저 연결은 미확인. Moodcode의 `discover_tools` add/replace를 새 기능 부재로 표현하지 않음. |
| 파일·명령·검증 | developer `file_read`/`file_write`/`file_edit`, 유일한 before 문자열을 요구하는 replacement, 직접 `fs::write` 확인(`developer/edit.rs:47–174`). shell은 stdout/stderr stream·timeout/cancel·exit/structured result(G16). | 코딩 검증은 shell 명령으로 실행할 수 있는 기반이다. lint/test 성공을 필수 완료조건으로 만드는 engine gate를 이번 경로에서 확인하지 않음. 이 shell은 null stdin의 pipes이며 Moodcode PTY와 별도. |
| 권한/모드 | `GooseMode`는 Auto(default), Approve, SmartApprove, Chat. Chat는 tools를 skip, 다른 모드는 inspector/confirmation 경로를 사용(G05). | SmartApprove의 도구 annotation/검사 결과와 Moodcode의 exact fingerprint 승인·deny 우선·Plan/Build는 다른 계약. 기본 Auto를 Moodcode 안전 모드로 도입하지 않음. |
| 저장·복구 | SQLite session/message, 안정된 message ID·visibility/metadata, BEGIN IMMEDIATE append와 전체 conversation transaction 교체(G09), provider resume(G20). | conversation 교체가 append-only audit는 아님. 파일 checkpoint/restore·accepted 외부 효과의 crash journal·unknown cleanup 격리와의 동등성은 미확인. |
| 취소·정리 | 모델 stream select·tool token 전파(G04/G05/G07), shell child kill+wait 시도와500ms output drain(G16), ACP active-run drop guard(G17). `server.rs:2245–2248`는 stream을 drop하고 foreground child 취소. | child kill 시도의 오류를 무시하는 경로가 있으며 후손/daemon 부재 proof를 읽은 것은 아님. MCP subprocess용 Unix group·Linux parent-death 설정(`subprocess.rs:68–143`)과 durable process ownership 인증은 구분. |
| 레시피 | parameter·provider/model/max-turn·JSON response schema·subrecipe·retry를 함께 선언(G12), summon이 recipe를 child 실행 설정으로 연결(G13). | `sequential_when_repeated`는 schema/변환에 존재하지만 이번 scheduling 경로에서는 동작 보장을 확인하지 못함. recipe 선언을 자동 workflow DAG 보장으로 확대하지 않음. |
| 하위 에이전트 | 기존 summon delegate는 별도 session/Agent·provider/model/extensions·max-turn·cancel을 사용하고 재위임을 거절(G13). 실험 foreground는 persisted child 설정으로 JoinSet 실행 후 부모에 결과 effect 전달(G14). | 기존 경로는 승인 ActionRequired 미전달로 Auto를 강제한다고 주석·코드가 명시. 부모 working-dir를 쓸 수 있는 child이며 Moodcode worktree 격리·deny/budget 상속과 같지 않음. 실험 foreground의 기능을 기본 delegate에 합치지 않음. |
| hooks | SessionStart/End·UserPromptSubmit·Pre/PostTool·read/edit/shell·Stop events, matcher와 command payload·deny/failure 결과(G15). `hooks/mod.rs:1050–1104`는 deadline·kill_on_drop. | command hook은 별도 외부 효과이며 observer hook보다 권한이 큼. timeout은 process-tree cleanup proof가 아님. Stop의 제한된 반복만 참고 후보로 삼음. |

**공유 core의 실제 범위.** desktop main은 secret·localhost endpoint·working directory로 `goose serve` binary를 spawn한다(G18). renderer는 `ui/desktop/src/acp/acpConnection.ts:131–165`에서 WebSocket ACP initialize를 수행한다. CLI의 `serve`는 `AcpServerFactory`와 HTTP/WebSocket router를 생성하며(`goose-cli/src/cli.rs:1808–1824`), ACP prompt가 동일 `Agent.reply`를 호출한다(G17). 일반 CLI는 core를 직접 호출한다(G19). 따라서 모델/tool/session 로직은 Rust core를 공유하지만 client의 화면 상태·permissions UI·재연결은 별도 구현이다. README의 API 임베딩 주장을 제품 전체의 모든 SDK 경로·프로토콜 호환성 검증으로 확대하지 않는다(G01).

## 구현·주장·추론·미확인 구분

| 분류 | 기록 |
|---|---|
| 구현 확인 | 기본/실험 실행 분기, stream/approval/extension dispatch, visibility compaction, SQLite 기록, scoped memory/recall, recipe schema와 child 호출, hooks, ACP server/provider 및 desktop/CLI core 연결 |
| README 주장 | macOS/Linux/Windows native desktop,15+ providers,70+ MCP extensions, 기존 구독 ACP 연동, 범용 workflow(G01). 수량·실제 인증·지원 범위를 실측하지 않음. |
| 분석자 추론 | 버전 고정 레시피·구조화 child 결과는 반복 작업을 재현하기 쉽게 할 수 있음. context ownership은 외부 agent와의 이중 summary/retry를 줄일 수 있음. lifecycle hook의 bounded 종료 조건은 검증 요청을 표준화할 수 있음. 성능·품질 향상 수치는 없음. |
| 미확인 | 모든 provider/OS·외부 서비스·GUI·SDK 전체 흐름, code-mode 전체 실행, lint/test 필수 gate, 후손 process cleanup, 파일 checkpoint/restore 전체 경로, accepted-effect crash recovery 동등성, subrecipe의 sequential 필드 실제 강제 |

소스에서 특정 경로를 확인하지 못했다는 이유로 Goose 제품 전체에 기능이 없다고 단정하지 않는다. 이번 문서는 확인한 고정 HEAD와 읽은 범위를 다룬다.

## Moodcode에 이미 있는 기능

| 기존 Moodcode 계약 | 실제 관련 경로 | 이번 분석의 추가 범위 |
|---|---|---|
| MCP stdio/HTTP·catalogue/resource·exact prepare/approval·execution outcome | [registration.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/mcp/registration.ts:10), [mcp/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/mcp/index.ts:1) | 외부 ACP agent의 permission·context 소유권은 별도 호환 계약. |
| 고정 runtime capture·bounded discovery·schema add/replace | [tool-discovery.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/tool-discovery.ts:38), [runtime/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/runtime/index.ts:1) | extension search 자체를 신규 제안하지 않음. recipe가 선택 집합·revision을 고정하는 계약만 확장. |
| bounded context·완전 exchange·extractive/semantic memory·history 검색 | [memory.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/memory.ts:11), [semantic-memory.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/semantic-memory.ts:36), [engine.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/engine.ts:444) | global/project 기억 publication과 provider-owned context를 세션 summary와 구분. |
| read-only delegate·실제 worktree child·예산/deny/cancel 상속·terminal inbox delivery | [delegation.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/child-tasks/delegation.ts:19), [child-tasks/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/child-tasks/index.ts:739) | 부모 turn의 여러 child join/집계 조건과 recipe result schema가 후속 후보. Goose의 Auto 강제 경로를 이식하지 않음. |
| structured result·artifact paging·독립 model/display byte cap | [result.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/artifacts/result.ts:16), [artifact.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/session/artifact.ts:1) | 집계/기억/ACP 결과도 기존 artifact identity와 예산에 연결. |
| Plan/Build·deny 우선·exact approval·checkpoint/restore | [policy.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/permission/policy.ts:18), [review/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/review/index.ts:258) | recipe·hook·외부 permission이 기존 승인 binding이나 복구 blocker를 완화하지 않도록 유지. |
| host PTY·명령 취소/cleanup·plugin metadata hooks | [terminals/types.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/terminals/types.ts:14), [plugins/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/plugins/index.ts:58) | 단순 shell pipes나 hook metadata 관측을 신규 기능으로 제안하지 않음. |

## 독립 구현 후보

다음은 구현 결과가 아니라 후속 계약 제안이다. 세부 `moodcodePaths`·`referenceIds`·`contract`·`validation`은 근거 JSON과 일치한다.

| 후보 | 우선순위·비용 | 참고 동작과 기존 기능의 차이 |
|---|---|---|
| GOOSE-C01 고정 레시피·구조화 결과 | P1 / 중간~높음 | G06/G12/G13/G14. 기존 profile/skill/child 위에 parameterized 실행 binding과 result schema 추가. |
| GOOSE-C02 ACP·문맥 소유권 | P1 / 높음 | G03/G08/G17–G20. existing host/provider 분리에 external session·capability·permission·cleanup을 추가. |
| GOOSE-C03 승인된 기억 publication | P2 / 중간 | G08/G10/G11. 기존 session summary와 별도로 user/project scope 저장·삭제·철회. |
| GOOSE-C04 제한된 lifecycle/Stop hook | P2 / 중간~높음 | G05/G06/G15/G16. 기존 prepared/settled observer를 유지하며 deny-only policy와 bounded stop 검증 추가. |
| GOOSE-C05 durable child join·집계 | P2 / 중간 | G06/G12/G13/G14. existing terminal delivery 위에 부모 turn의 all/first-terminal join 조건과 단일 집계 receipt 추가. |

**C01 계약·검증.** host가 등록한 recipe ID/revision과 parameter schema, profile, tools, mode, budget, result schema를 실행 preview에 고정한다. 기존 Plan/Build·deny·exact approval를 통과하고 child/retry는 부모 예산을 사용한다. 결과는 bounded JSON valid/invalid/denied/cancelled/uncertain로 기록한다. parameter 누락·stale revision·순환·깊이 초과, schema 실패, 거절·취소·재시작·중복 요청을 검증하고 효과를 자동 재실행하지 않는다.

**C02 계약·검증.** host factory만 외부 실행 파일/transport를 등록하고 ACP capability를 협상한다. 외부 session/run/tool ID를 Moodcode identity와 별도로 묶고 engine-owned/provider-owned context를 명시한다. foreign permission을 exact payload/revision 승인에 대응할 수 없는 capability는 거절하거나 제한하며 mode가 기존 deny를 완화할 수 없다. synthetic peer로 initialize/load/prompt/permission/cancel, 중복 prompt·stale 승인·partial stream·disconnect를 검증한다. accepted 실행의 outcome/cleanup이 없으면 uncertain을 유지하고 재연결만으로 재시도하지 않는다.

**C03 계약·검증.** 기억 source·scope·revision·원문을 preview에 고정해 승인된 publication/remove로 처리한다. summary를 preference로 자동 승격하지 않으며 저장·모델 투영 한도, CAS·삭제/철회·archive inclusion 정책을 갖춘다. 모델에는 과거 source data로 표시한다. 중복·CAS 충돌·scope traversal·stale 승인·예산 초과·프로젝트 경계·철회 이후 투영 갱신을 검증한다.

**C04 계약·검증.** hook은 host가 고정한 ID/revision·event·metadata·deadline·output cap을 사용한다. prepared payload/fingerprint·credentials·policy를 바꾸지 못하고 사전 정책은 추가 deny만 가능하다. external command hook은 별도 승인과 supervisor cleanup ledger를 따른다. Stop hook은 같은 budget의 후속 검증 요청을 제한 횟수로 반환한다. mutation·deny 완화·timeout/overflow·cleanup unknown·cancel·종료 직전 crash와 terminal 이후 event 금지를 검증한다.

**C05 계약·검증.** delegate batch의 child ID·parent turn·all/first-terminal join 조건·budget·허용 profile/tool을 durable record로 고정한다. 기존 read-only worktree 정책을 유지하며 completed/failed/cancelled/uncertain를 구분해 한 번만 집계한다. 원문은 artifact paging으로 전달한다. 완료 순서·부분 실패·첫 종료 뒤 나머지 child·부모 cancel·재시작·중복 terminal·큰 결과를 검증하고 uncertain child가 있는 all-join을 성공으로 처리하지 않는다.

## 정적 검증과 남은 범위

이 작업은 두 분석 파일만 추가한다. 근거20개는 원본 HEAD의 tracked file·유효한1-based 줄 범위·160줄 이하·file/range SHA-256을 확인했고,5개 후보의 Moodcode 경로와 근거 ID를 검사했다. 원본 HEAD와 tracked worktree를 변경하지 않았다. 이는 정적 근거 재현성 확인이며 upstream test/benchmark 통과 또는 새 기능 구현 완료가 아니다. Moodcode의 기존 테스트 기록은 별도 baseline이다.
