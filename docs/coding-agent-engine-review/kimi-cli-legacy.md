# Kimi CLI 구 Python 엔진 분석

분석일: 2026-10-07. `static-source-review`로 [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)의 보존된 Python 엔진을 읽었다. 새 TypeScript [Kimi Code CLI 분석](kimi-code.md)과 별도 항목이다. **고정 HEAD의 공개 console 진입점은 이미 이관 안내로 전환되어 Python 엔진을 시작하지 않는다.** 아래 엔진 흐름은 저장소에 남은 historical 내부 구현의 분석이다. 설치·upstream 실행·모델 호출은 수행하지 않았다.

| 기준 | 값 |
|---|---|
| 고정 HEAD | `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82` |
| 원본 checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/kimi-cli-legacy` |
| 마지막 고정 commit | 2026-09-22 09:29:17 UTC, `feat(cli): short-circuit entry points to a Kimi Code installer (#2666)` |
| 언어·package | Python ≥3.12, root `kimi-cli` 1.52.0; `src/kimi_cli` app/soul/tool/host, workspace `packages/kosong` 모델·도구 추상화, `packages/kaos` OS 추상화, legacy PyPI alias `packages/kimi-code`, `sdks/kimi-sdk` |
| 유지보수 상태 | 고정 README에서 archived·read-only·후속 release/bug/security update 없음 선언. root package manifest도 Inactive다. [L03] |
| license | 실제 root `LICENSE` Apache-2.0, root `NOTICE` Moonshot AI/OpenAI Codex 고지. 새 TypeScript 저장소의 MIT와 다르다. [L01, L02] |
| Moodcode 비교 | engine source `464812f7d1af24466f57070663131f5979aeca51`, 문서 기준 `3065fdd03649df393f4170b38a2f049a1e52d2f3` |
| 재현 근거 | [kimi-cli-legacy.evidence.json](kimi-cli-legacy.evidence.json), [분석 기준](analysis-protocol.md), [Moodcode 기준](moodcode-baseline.md) |

## 고정 소스 근거

대표 permalink는 모두 위 full SHA에 고정했다. JSON에는 아래 27개 범위의 전체 파일·범위 SHA-256을 기록했다. 본문의 ID는 같은 근거를 가리킨다.

| ID | 고정 permalink·범위 | 확인한 계약 |
|---|---|---|
| L01 | [`LICENSE:1–16`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/LICENSE#L1-L16) | root Apache-2.0 텍스트. |
| L02 | [`NOTICE:1–14`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/NOTICE#L1-L14) | Moonshot AI와 재사용된 OpenAI Codex skill 고지. |
| L03 | [`README.md:1–57`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/README.md#L1-L57) | archive 선언, 신규 TypeScript successor와 legacy PyPI alias 구분. |
| L04 | [`__main__.py:12–63`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/__main__.py#L12-L63) | console main의 deprecation gate; 보존된 original CLI는 호출하지 않음. |
| L05 | [`app.py:243–327`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/app.py#L243-L327) | LLM/Runtime/Agent/Context restore/KimiSoul/HookEngine wiring. |
| L06 | [`kimisoul.py:659–759`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/kimisoul.py#L659-L759) | `run`의 prompt block, slash/flow/turn 선택, Stop hook의 한 번 continuation. |
| L07 | [`kimisoul.py:998–1109`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/kimisoul.py#L998-L1109) | max step, auto compaction, checkpoint, `_step`, 종료/steer/D-Mail 처리. |
| L08 | [`kimisoul.py:1190–1346`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/kimisoul.py#L1190-L1346) | 모델 retry, usage, tool 결과 대기, shielded 문맥 저장과 종료 이유. |
| L09 | [`kosong/__init__.py:104–222`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/packages/kosong/src/kosong/__init__.py#L104-L222) | 모델 generation 중 tool task 생성, 실패/취소 후 future 정리. |
| L10 | [`context.py:123–248`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/context.py#L123-L248) | JSONL checkpoint, 회전 후 rewind, message/usage append. |
| L11 | [`denwarenji.py:6–39`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/denwarenji.py#L6-L39) | 단일 pending D-Mail·checkpoint 유효성·filesystem 복원 TODO. |
| L12 | [`compaction.py:110–198`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/compaction.py#L110-L198) | 최근 user/assistant 두 개 기준 suffix 보존, text-only 과거 요약·빈 toolset. |
| L13 | [`toolset.py:343–486`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/toolset.py#L343-L486) | same-step result 공유, cross-step 반복 관측, PreToolUse block와 실제 call. |
| L14 | [`soul/__init__.py:179–254`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/__init__.py#L179-L254) | 외부 cancel event→soul task 취소→wire/UI drain. |
| L15 | [`approval.py:200–318`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/approval.py#L200-L318) | tool call 내 승인 요청, yolo/afk/action cache, source binding·취소 feedback. |
| L16 | [`shell/__init__.py:221–264`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/tools/shell/__init__.py#L221-L264) | KAOS shell spawn, stdin EOF, stream timeout/cancel kill. |
| L17 | [`kaos/local.py:38–176`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/packages/kaos/src/kaos/local.py#L38-L176) | local subprocess pipes와 직접 `process.kill`; foreground process group 소유 증거와 구분. |
| L18 | [`background/manager.py:337–481`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/background/manager.py#L337-L481) | background control·group/taskkill, agent cancel, heartbeat/lost recovery. |
| L19 | [`agent.py:339–369`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/agent.py#L339-L369) | child의 별도 D-Mail과 공유 session/workdir·approval/runtime. |
| L20 | [`subagents/core.py:37–86`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/subagents/core.py#L37-L86) | child Context·system prompt 복원, explore Git context, 별도 KimiSoul. |
| L21 | [`hooks/engine.py:205–337`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/hooks/engine.py#L205-L337) | regex matcher·command 중복 제거·parallel command/wire hooks·오류 fail-open. |
| L22 | [`toolset.py:907–974`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/soul/toolset.py#L907-L974) | MCP schema wrapping, approval, FastMCP call timeout·오류 변환. |
| L23 | [`acp/session.py:155–248`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/acp/session.py#L155-L248) | ACP prompt→same CLI run, content/tool/approval 변환, stop reason, unsupported question. |
| L24 | [`llm.py:326–441`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/llm.py#L326-L441) | Kimi/OpenAI legacy/Responses/Anthropic/Google/Vertex adapter 분기. |
| L25 | [`read_media.py:20–148`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/tools/file/read_media.py#L20-L148) | 100 MiB media 상한, image/video capability, Kimi upload 또는 data URL. |
| L26 | [`replace.py:82–195`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/tools/file/replace.py#L82-L195) | 문자열 편집·diff 승인·plan-file 예외·쓰기; expected hash 재검사는 이 경로에 없음. |
| L27 | [`default/agent.yaml:1–36`](https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/agents/default/agent.yaml#L1-L36) | 기본 tool/profile 구성과 주석 처리된 D-Mail. |

## 실제 공개 진입점과 보존된 엔진 흐름

**Source:** root `pyproject.toml:79`의 `kimi`/`kimi-cli`는 `kimi_cli.__main__:main`을 호출한다. 이 함수는 `_deprecation_gate`를 거쳐 무인자 호출이면 새 CLI installer 함수로, version이면 version과 이관 메시지로, 나머지 인자이면 이관 메시지로 끝난다. `run_original_cli`는 보존되었으나 `main`에서 호출하지 않는다고 코드가 명시한다. 이 보고서는 installer를 실행하지 않았다. `python -m kimi_cli.cli`에 남은 내부 Typer 진입점까지 없다고 일반화하지 않는다. [L04]

**Source/historical:** 보존된 `cli/__init__.py:619–677`은 `KimiCLI.create` 후 shell/print/ACP/wire host로 분기한다. print에서 `runtime_afk=True`를 전달하므로 모든 host가 매 tool마다 수동 승인한다고 설명할 수 없다. `KimiCLI.create`는 설정·OAuth/LLM→Runtime→agent spec/toolset→persisted Context 복원→KimiSoul→HookEngine을 만든다. 저장된 system prompt가 있으면 agent의 새 prompt 대신 사용한다. 이 wiring이 존재한다는 사실과 공개 console에서 접근 가능하다는 사실은 다르다. [L05]

`Soul`은 protocol이고 실제 엔진은 `KimiSoul`이다. `run`은 OAuth 갱신, 승인 source 설정, UserPromptSubmit block, TurnBegin을 거쳐 slash command·Ralph/flow runner·일반 `_turn` 중 하나로 분기한다. `_turn`은 모델 capability를 검사하고 user 메시지 앞에 checkpoint를 만들며 `_agent_loop`로 들어간다(`kimisoul.py:841–852`). Stop hook이 추가 작업을 요구하면 최대 한 번 `_turn`을 더 실행한다. 이것은 명령 성공을 자동 증명하는 검증 gate가 아니다. [L06]

`_agent_loop`는 max steps를 검사하고 StepBegin→필요한 compaction→checkpoint→`_step`을 반복한다. `_step`의 실제 호출은 `kosong.step(chat_provider, system_prompt, toolset, effective_history, …)`이다. request별 provider wrapper·toolset per-step 상태를 만든 뒤 제한된 exponential-jitter retry와 connection recovery로 감싼다. `kosong.step`은 streaming generation 중 발견한 tool call을 `toolset.handle`로 보내고 future를 모은다. provider 오류/취소면 이미 생성된 futures를 cancel하고 gather한다. [L07–L09]

모델 응답 후 usage/status를 기록하고 모든 tool result를 기다린 뒤 assistant/tool 메시지 저장을 shield한다. tool call이 있으면 다음 step으로 간다. tool 없는 응답은 `no_tool_calls`, root의 feedback 없는 순수 거절은 `tool_rejected`, 반복 한도 신호는 `tool_call_repeat`로 끝난다. feedback 있는 거절과 child 거절은 모델이 대안을 선택하도록 이어진다. 종료 직전 steer가 있으면 메시지를 넣고 계속한다. max-step 및 fatal exception은 별도 오류 종료다. `run`의 finally는 시작된 turn을 닫고 해당 승인 source의 pending 요청을 취소한다(`kimisoul.py:788–839`). [L07, L08]

## 문맥·기억·D-Mail·저장

문맥은 Context의 메시지 목록과 JSONL backend다. message·usage·checkpoint·system prompt가 별도 record로 남는다. `Context.restore:30–65`는 record를 읽으며 malformed line을 건너뛰고 마지막 usage 이후 text token을 추정한다. bounded SQL history나 native-effect exactly-once journal과 동일한 저장 계약으로 보지 않는다. `wire/file.py:95–131`에는 별도의 versioned wire JSONL append/replay가 있다. [L10]

**Source:** D-Mail은 checkpoint ID와 메시지를 하나만 pending으로 유지한다. `_step`은 도구 결과를 저장한 다음 D-Mail을 확인하여 `BackToTheFuture`를 던지고, loop는 Context 파일을 회전한 뒤 해당 checkpoint 이후 대화를 제외하며 새 checkpoint와 D-Mail 메시지를 넣는다. 현재 작업 디렉터리에서 이미 일어난 효과는 남는다. `denwarenji.py`에는 filesystem 상태 복원이 TODO다. 따라서 “되돌리기”는 **대화 이력 rewind**이며 Moodcode 파일 restore와 같지 않다. 원본에 남기는 rotated history와 현재 모델 문맥의 관계도 구분해야 한다. [L07, L08, L10, L11]

**Flags/config:** D-Mail은 기본 `default/agent.yaml`에서 주석 처리되어 있다. 별도 `agents/okabe/agent.yaml:1–26`은 도구를 활성화한다. KimiSoul 생성 시 toolset에 SendDMail이 있을 때만 checkpoint ID를 user 메시지로 노출한다(`kimisoul.py:250–257`). 구현 존재를 기본 활성 기능으로 설명하지 않는다. [L27]

SimpleCompaction은 오래된 prefix의 TextPart를 tools 없는 별도 모델 호출로 요약하고 thinking part를 제외한다. 최근 user/assistant 메시지 두 개를 세는 경계부터 suffix를 보존하므로 Moodcode의 완전한 tool exchange 선택과 같은 기준은 아니다. 수동 focus 지시가 가능하다. 결과 적용은 Context clear/rotation→system prompt→checkpoint→요약/최근 메시지→active background task snapshot 순이다(`kimisoul.py:1573–1606`). 자동 trigger는 token count와 reserve/ratio를 사용한다. [L07, L12]

지침은 `soul/agent.py:88–160`에서 project root부터 cwd까지 `.kimi/AGENTS.md` 및 AGENTS/agents 파일을 합치며 32 KiB 상한을 적용한다. Runtime.create는 scoped skills를 발견해 prompt용 목록을 만들고 agent spec의 tools·exclusions·child profile·plugin/MCP를 구성한다(`agent.py:228–240`, `:403–484`). 로컬 Grep/Glob/ReadFile, service-backed web search·URL fetch가 있다. 이번 소스 조사에서 프로젝트 간 자동 학습 기억·embedding 색인·LSP 기반 의미 검색의 완전한 계약은 확보하지 못했다. 제품 전체의 부재를 단정하지 않는다.

Moodcode에는 이미 bounded context, semantic memory, tools 없는 summary, active-prefix checkpoint, session-owned media/history anchors, archive/recovery가 있다. 여기서 참고할 차이는 effect를 되돌리지 않는 **명시적 대화 분기**와 반복 관측·lifecycle 경계다.

## 편집·명령·승인·취소·복구

문자열 편집은 파일을 읽고 replacement를 계산하여 diff를 승인받은 다음 write한다. plan file 편집은 별도 예외다. 확인한 `StrReplaceFile` 경로는 expected hash/승인 후 preimage 재읽기 계약을 제공하지 않는다. Moodcode의 exact prepare/fingerprint/hash/effect binding을 줄이는 참고 사례로 삼지 않는다. shell·read·search 결과는 다음 모델 문맥에 들어가 검증 재료가 되지만 별도의 테스트 통과를 강제하는 엔진 gate는 확인하지 못했다. [L26]

Approval은 현재 tool call을 요구하고 action 이름을 session auto-approve 단위로 사용한다. yolo/afk·runtime AFK 및 session action cache이면 자동 승인하고, 그렇지 않으면 tool call/source별 request를 만들어 응답을 기다린다. `approval_runtime/runtime.py:61–189`는 요청·waiter를 메모리에 두고 source별 cancel을 처리한다. 이 구조는 Moodcode의 durable exact fingerprint 승인과 같은 계약이 아니다. root feedback 없는 rejection과 feedback 있는 rejection이 turn continuation에 미치는 영향도 다르다. [L08, L15]

Foreground Shell은 command 승인을 받은 뒤(`shell/__init__.py:81–104`) KAOS에 shell `-c`를 전달한다. stdin을 닫고 stdout/stderr reader를 timeout으로 감싸며 cancel/timeout에 `process.kill`을 호출한다. local KAOS 구현은 직접 asyncio process의 kill만 호출하고 spawn에는 process-group 생성 옵션이 없다. 이 읽기로 parent/daemon 전체 cleanup 또는 crash-safe ownership을 인증할 수 없다. [L16, L17]

Background shell은 별도 worker·disk spec/runtime/control/output 및 heartbeat를 사용하고 POSIX session/child group, Windows taskkill 정리 경로가 있다(`background/manager.py:106–207`, `background/worker.py:86–145`). manager kill은 control을 저장하고 best-effort signal을 보낸다. in-process background child agent는 task cancel 및 source 승인 취소를 사용한다. recovery는 살아 있지 않은 in-process agent나 heartbeat가 만료된 worker를 lost/killed로 표시한다. heartbeat 판정이 효과 소멸·PID 재사용 방지·자동 재실행 안전성을 증명하는 것은 아니다. [L18]

`run_soul`은 외부 cancel event와 soul task를 함께 기다려 실제 task를 취소하고 notification/wire/UI를 drain한다. model/tool cancellation과 파일 효과 복원은 별개다. Moodcode에는 이미 command supervisor·PTY·effect marker·cleanup unknown 격리·archive/recovery ledger가 있으므로 단순 background kill 또는 resume를 새 누락 기능으로 제안하지 않는다. [L09, L14]

## 하위 에이전트·확장·공급자·미디어

Child는 agent type/model/tool policy로 만들며 per-agent Context·system prompt·output/wire 파일을 복원한다. explore의 새 실행에는 Git context를 넣는다. runtime은 parent session·workdir·config/OAuth·approval state·notification·additional dirs를 공유하고 D-Mail 상태만 따로 만든다. 이 문맥 분리는 worktree filesystem 격리가 아니다. foreground runner는 stable ApprovalSource, child 상태 전환, cancellation 및 summary continuation을 연결한다(`subagents/runner.py:204–328`). [L19, L20]

`explore.yaml`은 edit/write를 제외하지만 Shell은 허용하여 read-only 동작을 prompt로 제한한다. `plan.yaml`은 Shell도 제외한다. 기본 root는 coder/explore/plan profile을 등록한다. Moodcode의 실제 read-only delegation allowlist·별도 worktree/DB·budget/deny/cancel 상속·terminal result dedupe가 이미 있다. 따라서 같은 child 재개가 있음을 이유로 Moodcode의 child isolation 계약을 약화시키지 않는다. [L27]

KimiToolset은 동일 step의 canonical 동일 호출에 대해 기존 task를 기다리고 같은 결과를 다른 tool-call ID로 반환한다. cross-step 반복은 reminder를 붙이면서 **도구를 다시 호출**하고 반복 streak가 force-stop을 만든다. `toolset.py:153–171`의 reminder 단계는 3/5/8, force stop은 12다. arg identity만으로 실행을 안전하게 공유할 수 있다는 보장은 없으므로 효과 도구에 그대로 적용할 후보가 아니다. [L08, L13]

Hooks는 UserPromptSubmit/Stop/PreToolUse·post-tool/failure·session/child·pre/post compaction·notification 사건에 연결된다. engine은 regex matcher, command 중복 제거, command 및 wire hook 병렬 실행을 제공한다. hook 실행 내부 오류는 fail-open이고 정상 block 결과는 반환한다. Stop continuation은 `run`에서 한 번 제한한다. plugin tools와 MCP는 agent loading에 결합되며 MCP call도 approval과 timeout을 거친다. timeout을 문자열로 판별하는 경로가 있어 이를 durable accepted RPC receipt·cleanup 인증과 동일시하지 않는다. [L06, L13, L21, L22]

ACP는 동일 KimiCLI.run의 events를 text/thinking/tool/approval로 변환하고 cancel/max-step을 protocol stop reason으로 보낸다. `acp/server.py:98–112`는 image/embedded-context, audio false, HTTP MCP·session load/list/resume를 선언한다. `acp/session.py:469–554`는 client permission request에 once/session/reject를 매핑하고 실패면 reject한다. 반면 question은 empty answer로 해결하고 지원하지 않는 content도 text placeholder로 바꾼다. 이것이 모든 editor 기능 호환을 증명하지 않는다. [L23]

Provider는 Kimi, OpenAI legacy/Responses, Anthropic, Google GenAI/Gemini, Vertex로 분기한다. 모델 metadata/capability와 OAuth resolve는 별도 경계다. ReadMediaFile은 image/video capability가 없으면 로드하지 않으며 100 MiB/file 상한, image data URL, Kimi video upload 또는 video data URL을 사용한다. 확인한 상한은 시간/frame/token aggregate 예산을 인증하지 않는다. native remote PDF/audio/media 생성의 완전한 지원은 이번 조사에서 확인하지 않았다. Moodcode는 이미 bounded image/PDF 입력을 구현했고 video/audio와 실제 provider별 media 검증은 열린 범위다. [L24, L25]

외부 경계에는 provider/OAuth·Kimi video upload/search 서비스·remote MCP/OAuth·plugin 다운로드·telemetry·deprecation installer CDN이 있다. source license가 서비스 계정 접근·데이터 보관/삭제 조건을 대신하지 않는다.

## Moodcode 독립 구현 후보

모두 후속 제안이며 구현은 하지 않았다. 비용 M/L은 기존 계약 대비 상대 규모다. JSON에 실제 존재하는 Moodcode 경로와 검증 조건을 기록했다.

| 후보 | 우선순위·비용 | 기존 Moodcode 구현 | 추가할 계약 |
|---|---|---|---|
| kimi-cli-legacy-C1: 명시적 대화 분기 | P2 · L | bounded context·active-prefix checkpoint·원본 journal·파일 restore | terminal/정리 확인 이후 immutable source cutoff로 별도 context branch 생성. 파일/명령 효과가 남는다는 observation을 필수로 제공하고 원본 승인·terminal 이력을 보존. [L07, L10, L11] |
| kimi-cli-legacy-C2: 무진전 반복 진단 | P1 · M | effect 사이 동일 read 차단·canonical repeat identity·tool budget | tool/입력뿐 아니라 결과 digest·context/catalogue/effect epoch를 가진 bounded stall 기록과 종료 이유. 새로운 증거·steer·변경 후 읽기는 진행으로 구분하고 승인된 write/network 결과를 공유하거나 재실행하지 않음. [L08, L13] |
| kimi-cli-legacy-C3: 제한된 Stop continuation hook | P2 · M | host plugin prepared/settled metadata·exact approval·durable inbox | terminal commit 전에 host hook이 한 번 추가 입력을 제안; source/dedupe ID·상속 budget·cancel·승인을 유지하고 post-effect hook 오류에서 실행을 반복하지 않음. [L06, L14, L21] |
| kimi-cli-legacy-C4: ACP host adapter | P2 · L | engine/host 분리·events·승인·취소·session restore·media input | negotiated capability에 맞춘 prompt/event/permission/cancel 변환, engine owner와 approval fingerprint 유지. unsupported question/media를 명시 실패로 돌리고 client IO 효과는 별도 owner receipt 필요. [L14, L15, L23] |

C1은 `context/{service,active-prefix}.ts`, `storage/index.ts`, `session-state/index.ts`, `review/index.ts`, `contracts/src/v2.ts`에 연결한다. C2는 `runner/{index,turn-executor}.ts`, `tools/runtime/index.ts`, `context/tool-history.ts`, contracts v2가 관련된다. C3는 `plugins/index.ts`, `runner/{index,input-scheduler}.ts`, `permission/index.ts`, `session-state/index.ts`를 확장한다. C4는 `engine.ts`, `ports.ts`, `permission/index.ts`, `runner/input-scheduler.ts`, contracts의 index/validation을 재사용하는 새 host 범위다. 각 경로는 `packages/engine/src` 또는 `packages/contracts/src` 아래이며 실제 파일과 해당 구현을 읽고 비교했다.

## 라이선스·분석 한계

root는 Apache-2.0이며 NOTICE의 제품 이름이 Kimi Code CLI라고 적혀 있어도 이 저장소를 새 TypeScript/MIT project로 바꾸는 근거가 아니다. NOTICE는 `src/kimi_cli/skills/skill-creator/SKILL.md`의 OpenAI Codex 재사용을 지정한다. `packages/kosong`, `packages/kaos`, `sdks/kimi-sdk`에도 실제 Apache-2.0 LICENSE와 Moonshot AI NOTICE가 있다. 하위 고지·전이 의존성·native artifact·문서 미디어 전체 audit 또는 법률 검토는 수행하지 않았다. [L01, L02]

**README 주장:** archive·migration 및 legacy CLI 기능 소개는 고정 문서의 주장이다. migration 성공, 기존 설치 중단 시점, 모든 ACP client/OS/provider 지원을 실측하지 않았다. **추론:** 공유 child runtime·직접 process kill·heartbeat/lost와 Moodcode의 별도 owner/cleanup 계약 사이의 차이는 읽은 소스 범위에 한정한다. **Unverified:** 자동 설치·build/test·실제 모델·원격 서비스·benchmark·GUI·SIGKILL 실험은 실행하지 않았고, 다른 branch/과거 release·submodule/LFS 외부 자료도 검증하지 않았다. **Flags/config:** D-Mail opt-in profile, print runtime AFK, yolo/afk, agent tool allowlist, model capability, loop retry/step/compaction/Ralph 설정에 따라 동작이 달라진다.

이 변경에는 보고서와 evidence만 포함한다. upstream source·prompt·tool description·fixture·media를 Moodcode로 복사하지 않았고 runtime 의존성을 추가하지 않았다. 소스를 읽었으므로 clean-room 분석이라고 주장하지 않는다. 파일·줄 범위·SHA-256·고정 commit 소속 검사는 정적 근거 검증이며 upstream 실행 검증이 아니다. Moodcode의 기존 pass 기록은 [구현 상태](../moodcode/implementation-status.md)에 남은 이전 결과다.
