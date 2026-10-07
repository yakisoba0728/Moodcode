# SWE-agent 원본 엔진 정적 분석

분석일: 2026-10-07, Asia/Seoul. 원본은 [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent), full HEAD는 `3ea751c087f32b16e039a2233dd6eefecef325d5`, checkout은 `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/swe-agent`다. `static-source-review`이며 [근거 JSON](swe-agent.evidence.json)을 따른다. Moodcode 비교 기준은 문서 HEAD `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 source `464812f7d1af24466f57070663131f5979aeca51`다.

이 원본의 참고 가치는 configurable tool bundle, 모델 history 투영, 코딩 작업 전체를 다시 시도하는 reviewer loop의 경계에 있다. Moodcode에는 이미 typed tools·exact approval·durable Run/Turn/Attempt/Part·bounded context·worktree child·effect recovery가 있다. 원본 전체의 도입보다 이 기존 구조에 추가할 관측·검증 계약을 제안한다. 일반 소프트웨어 issue 수정의 읽기·편집·명령·검증 수명만 분석했으며 offensive/cyber agent workflow·대상·PoC는 분석 범위에서 제외했다.

## 기준점과 유지보수 상태

Python `>=3.11`의 `sweagent` package이고 고정 소스 버전은 `1.1.0`이다. `agent/`, `tools/`, `environment/`, `run/`을 나누며 CLI `sweagent`는 `sweagent.run.run:main`에 연결된다. Pydantic/Jinja 기반 config·template, LiteLLM provider 호출, Tenacity 재시도, SWE-ReX deployment/runtime, GitPython·datasets 등 외부 package 경계가 있다. SWE-ReX는 이 checkout의 하위 구현이 아니라 `swe-rex>=1.4.0` 의존성이다. [SWA-R03; `sweagent/__init__.py:15–18` 보조 정적 확인]

README는 현재 개발 노력의 대부분이 mini-SWE-agent로 옮겨졌고 mini가 SWE-agent를 대체했다고 안내한다. 이는 upstream의 상태 설명이다. `source-manifest.json`의 2026-10-07 GitHub API 관측은 `archived=false`이며, archive되지 않았다는 사실이 원본에 개발 노력이 집중되어 있음을 뜻하지 않는다. 고정 HEAD의 마지막 commit 시각은 manifest 기준 `2026-07-16T11:21:18-04:00`이다. 현재 live release·이슈 대응을 별도로 조사한 결과는 아니다. [SWA-R02]

| 구분 | 내용 | 이번 분석의 판단 |
|---|---|---|
| README 주장 | mini가 같은 성능을 더 단순하게 제공하고, 앞으로 mini 사용을 권장 | 비교 성능을 재현하지 않았다. 역사·reference 역할로 구분한다. |
| README 주장 | SWE-bench 성능, 자유로운 모델 agency, YAML 설정, 연구 친화적 구조 | 성능·일반화·시작 시간의 측정 결과로 표시하지 않는다. |
| 소스 확인 | bundle schema·함수 호출 parser·persistent bash session·history processor·RetryAgent | 실제 코드 경계를 아래에서 추적한다. |
| mini와 대조 | [별도 mini v2 분석](mini-swe-agent.md)은 작은 Model/Environment/Agent protocol과 기본 bash tool을 다룬다. 원본은 bundle command를 shell 호출로 변환하고 reviewer가 여러 코딩 시도를 선택할 수 있다. | mini의 현재 provider·취소·trajectory 계약을 원본에 소급하지 않는다. 각 근거는 이 원본 HEAD에서 별도로 확인했다. |

README 일반 코딩 설명과 주장 범위는 `README.md:19–45`를 읽었으며, 대표 근거 SWA-R02는 유지보수 안내만 담는다.

## 모델에서 observation까지

1. CLI `run`은 `run_single.run_from_cli()`로 분기한다. `RunSingle.from_config()`가 환경 변수·output directory, agent, `SWEEnv`, patch 저장 hook과 선택적 PR hook을 구성한다. `RunSingle.run()`이 environment를 시작하고 `agent.run()`을 호출한 뒤 결과 hook·prediction 저장·environment close를 수행한다. PR hook 등록은 사용자 승인 시스템이 있다는 증거가 아니다. 이번에 외부 쓰기나 hook을 실행하지 않았다. [SWA-R03, R04; `sweagent/run/run.py:70–100` 보조 정적 확인]
2. `DefaultAgent.setup()`은 tools 설치, problem statement 환경 변수, system·demonstration·instance template를 준비한다. `messages`는 같은 agent 이름의 history를 골라 configured processor를 순서대로 적용한다. `forward()`는 이 query snapshot을 복사하여 trajectory용으로 보존하고 `model.query()`→`tools.parse_actions()`→`handle_action()`을 호출한다. [SWA-R11, R15; `sweagent/agent/agents.py:540–606` 보조 정적 확인]
3. `LiteLLMModel._single_query()`는 text/message token 추정과 input 한도를 검사하고, 함수 호출 모드이면 bundle에서 생성한 schema를 `litellm.completion()`에 넘긴다. 응답의 text·tool calls·thinking blocks를 추출하고 cost·통계를 갱신한다. streaming delta나 provider attempt별 durable journal은 이 경로에서 확인하지 않았다. [SWA-R06, R07]
4. 기본 `FunctionCallingParser`는 **정확히 한 tool call**, 등록 command 이름, JSON arguments, required/extra key를 검사한다. 이를 command의 invocation format으로 렌더링하고 조건부 quoting을 거쳐 shell action 문자열로 만든다. schema에 선언된 모든 argument type·enum을 parser가 다시 검증하는 것은 아니다. schema 생성·key 검사·실제 명령 실행을 하나의 typed effect 계약으로 설명하면 안 된다. text/JSON/XML/code-block parser는 대안이며 현재 기본 single function call과 구분한다. [SWA-R08, R09]
5. `handle_action()`은 command filter·`exit`를 검사하고 multiline 입력을 guard한 뒤 `SWEEnv.communicate()`를 호출한다. 일반 경로는 nonzero exit를 강제 오류로 취급하지 않는다. 환경은 출력 문자열을 반환하고 state command가 별도로 상태를 얻는다. timeout에는 session interrupt를 요청하며 연속 timeout 한도에서는 종료한다. [SWA-R10, R11, R05]
6. action 결과의 submit marker를 확인하고 `/root/model.patch`를 읽어 `done`·submission·exit status를 결정한다. `step()`은 assistant action과 다음 observation template, trajectory, model stats를 기록한다. 함수 호출 observation의 원래 call ID는 provider message로 변환될 때 유지된다. `run()`은 `done`까지 반복하며 **정상적으로 반환한 step 뒤에** trajectory를 저장한다. step 전체를 감싼 `finally` 저장 계약은 아니다. [SWA-R13–R15, R07]

`_add_templated_messages_to_history()`는 function calling일 때 observation role을 `tool`로 바꾸고 call ID를 붙인다. 원본 history/trajectory와 provider request는 다르다. requery 실패 step은 trajectory에 남지만 정상 history에는 저장하지 않고 임시 오류 메시지로 다음 query를 만든다. 이후 정상 step에는 과거 오류가 빠질 수 있다. [SWA-R13; `sweagent/agent/agents.py:675–713` 보조 정적 확인]

## 도구·편집·문맥의 실제 경계

`ToolConfig`는 builtin bash와 bundle의 command를 합치며 이름 중복을 거절한다. command docs·함수 schema·multiline ending을 config 구성 시 만든다. `Bundle`은 로컬 경로·`config.yaml`·hidden tool 이름을 확인한다. `ToolHandler.install()`은 bundle directory를 runtime에 upload하고 PATH·실행 권한·선택적 `install.sh`를 설정한 뒤 command 존재를 확인한다. 이는 host가 실행 코드를 공급하는 확장 경계다. 이름이 hidden인 command를 schema에서 빼는 것만으로 shell의 실행 능력이 철회되지는 않는다. [SWA-R09, R10; `sweagent/tools/bundle.py:17–57` 보조 정적 확인]

filter는 문자열 시작·정확한 standalone 일치·일부 command의 regex 조건이다. interactive command의 지원 여부를 관리하는 범위이며 파일 preimage hash·approval identity·scope grant·effect class 정책을 대신하지 않는다. `propagate_env_variables`는 host 값을 환경으로 전달할 수 있고 config 설명도 debug log에 값이 보일 수 있음을 명시한다. Moodcode의 credential reference·host 등록 경계와 같은 계약으로 취급하지 않는다. [SWA-R09, R10]

현재 `config/default.yaml:41–69`는 registry·`edit_anthropic`·review-on-submit bundle, builtin bash, function calling, cache-control processor를 고른다. default editor의 `str_replace()`는 파일과 old/new 문자열에 `expandtabs()`를 적용하고 old text의 단일 occurrence를 요구한 뒤 실제 파일을 쓴다. optional linter가 새 오류를 찾더라도 이 구현은 이미 적용된 편집에 warning을 붙인다. 별도 windowed linting editor가 undo하는 동작과 구분해야 한다. editor의 직접 쓰기·local undo는 Moodcode의 bounded UTF-8 exact hash 승인·BOM/line ending 보존·checkpoint와 다르다. [SWA-R20; `tools/edit_anthropic/bin/str_replace_editor:30–33`, `tools/windowed_edit_linting/bin/edit:94–124` 보조 정적 확인]

| 범주 | 소스로 확인한 기능 | 한계·Moodcode 비교 |
|---|---|---|
| 저장소 탐색·검증 | bash와 configured bundle로 read/search/edit/test command를 실행할 수 있다. editor에는 filemap·viewport·undo 경로도 있다. | 테스트가 항상 실행·성공했다는 엔진 invariant는 아니다. repository symbol index·semantic search 서비스의 수명은 상세 분석하지 않았다. |
| history 선택 | processor chain, 오래된 observation의 내용 생략, 파일별 오래된 window 생략, regex 제거, cache-control, image parsing processor | `LastNObservations`는 메시지 pair 자체를 삭제하지 않고 observation 내용을 대체한다. `ClosedWindowHistoryProcessor`는 user-role의 특정 출력 형식만 다루므로 모든 tool-role·editor 형식에 자동 적용된다고 볼 수 없다. |
| 문맥 예산 | model input token 추정·config override·observation 길이에 따른 template 선택 | 길이·token 추정은 환경 출력의 hard byte capture limit과 다르다. 기본 경로의 자동 semantic summary·프로젝트 간 지속 기억은 확인하지 않았다. |
| 원본 보존 | query snapshot·action·observation·state·history·stats를 trajectory에 기록 | processor는 모두 깊은 복사를 하는 것이 아니다. cache-control processor처럼 입력 entry를 변경하는 경로도 있어 raw journal 불변을 가정하면 안 된다. |
| 이미지 | problem statement의 multimodal 분기와 regex data URL→image content processor | bounded import·attachment identity·PDF/audio/video와 실제 원격 인식은 확인하지 않았다. |
| provider | GenericAPI config의 endpoint·key 선택·fallback·tokenizer·LiteLLM registry, human/replay/test model factory | LiteLLM 등록 가능성이 모든 provider의 live 호환성을 증명하지 않는다. native Responses·MCP catalog/session의 수명은 이 core 경로에서 확인하지 않았다. |

[SWA-R06, R07, R13, R16, R20; `sweagent/agent/history_processors.py:261–387` 보조 정적 확인]. 기능 부재는 살펴본 코딩 core의 확인 범위이며 제품 전체 부재를 단정하지 않는다.

## 예산·오류·취소·환경 소유권

예산은 API instance cost/call limit, process 전역 cost, command별 timeout, 누적 command execution time으로 나뉜다. `_update_stats()`는 응답 후 한도를 검사하고 strict 초과 비교를 사용하므로 한 호출이 비용 한도를 넘거나 call limit보다 한 번 더 호출될 수 있다. `api_calls`는 이 갱신에 도달한 호출 수이며 모든 전송 시도 수·trajectory step 수와 같지 않다. token 통계는 provider usage 전체를 그대로 저장하는 대신 tokenizer로 계산한 입력과 응답 text에 기반한다. tool argument·hidden reasoning 등과의 실제 accounting 일치는 검증하지 않았다. default API cost는 3달러, call limit·global cost 0은 비활성이다. 별도의 기본 logical step cap은 이 DefaultAgent loop에서 확인하지 않았다. [SWA-R06, R15; `sweagent/agent/models.py:55–78` 보조 정적 확인]

provider 전송 재시도는 Tenacity로 기본 20회 attempt·random exponential 10–120초 설정이며 context/cost/config/auth/permission 등의 예외는 재시도 제외 목록에 있다. `reraise=True`여서 마지막 원래 예외가 나오는 경로도 agent의 일반 오류 종료와 구분한다. format·blocked action·bash syntax 오류 재질의는 별도의 `max_requeries` 기본 3 한도다. `_RetryWithOutput`/`_RetryWithoutOutput` 제어 신호는 같은 format failure counter를 증가시키지 않는다. 누적 command execution 한도는 다음 `forward()`에서 검사하며 provider 대기·installation·state command의 전체 wall time이나 실행 중인 명령을 선점하는 전역 timer가 아니다. [SWA-R07, R11, R12; `sweagent/agent/models.py:55–63`, `sweagent/agent/agents.py:149–164` 보조 정적 확인]

오류 종료는 대부분 `attempt_autosubmission_after_error()`로 남은 patch를 수집한다. runtime이 죽었으면 이전 trajectory state의 diff를 사용하고, 살아 있으면 repo의 변경을 stage하여 patch를 쓰는 command를 별도로 실행한 뒤 읽는다. 따라서 `submitted (exit_context)` 같은 결과는 실패 원인과 산출물 존재가 결합된 상태이며 task 성공·테스트 통과·fresh diff의 증명이 아니다. 이 오류 처리 자체가 환경 파일/Git index에 추가 효과를 줄 수 있다는 점도 Moodcode의 cleanup uncertainty 뒤 실행 차단과 다르다. [SWA-R12, R14]

`SWEEnv`는 default Docker deployment를 SWE-ReX factory에 맡기고 session 하나를 만든다. `communicate()`는 같은 runtime session에서 실행하므로 cwd·환경 변수 등 shell 상태가 지속된다. 별도 `execute_command()`는 session 밖 subprocess 경계다. `reset()`은 repository 기본 commit으로 되돌리는 설정을 실행하고 `hard_reset()`은 deployment close/start를 한다. default Docker는 실행 환경 구분이지 filesystem/network privilege·mount·host 접근·descendant cleanup이 모두 보장된 sandbox의 증명은 아니다. 실제 deployment 구현, container image, process tree·OS 소유권은 외부 SWE-ReX를 실행·검증하지 않았으므로 미확인이다. [SWA-R05; `sweagent/environment/swe_env.py:24–46`, `265–276` 보조 정적 확인]

취소는 `KeyboardInterrupt`를 `forward_with_handling()`에서 다시 올리고 batch는 pending future를 취소하되 running instance 완료를 기다린다. 이것은 durable cancelled terminal·provider cleanup receipt 계약과 다르다. batch의 `_run_instance()`는 `finally`에서 환경을 닫지만 단일 runner의 `env.close()`는 정상 종료 경로 끝에 있으므로 중간 예외에도 닫힌다고 주장할 수 없다. `SWEEnv.close()`는 SWE-ReX `stop()`을 기다리지만 stop의 실제 소유권 증명은 이 저장소의 분석 범위를 넘는다. [SWA-R04, R05, R12, R19]

## trajectory·재실행·작업 전체의 재시도·평가

trajectory는 전체 `history`·`trajectory`·`info`, serialized replay config, environment 이름을 JSON으로 `write_text()` 덮어쓴다. 환경 이름은 실행 filesystem snapshot이 아니다. 임시 파일 rename/fsync·transaction journal·effect dispatch recovery frontier를 이 저장 경로에서 확인하지 않았다. 저장 전에 process가 멈추거나 serialization이 실패했을 때 모든 마지막 step이 남는다는 증명도 없다. [SWA-R13, R15]

`RunReplay`는 저장 config를 읽고 model을 `ReplayModel`로 바꾼 뒤 assistant history의 action/tool call을 새 파일로 추출한다. 새 `SWEEnv`·`DefaultAgent`·`RunSingle`을 구성하여 명령을 다시 실행한다. parser 형식이 trajectory와 맞는지 검사한다. 이는 action 재현이며 실행 중인 provider/effect를 같은 owner identity로 이어가는 crash restore가 아니다. error requery가 정상 history에서 빠졌다면 replay는 원래 모든 provider 시도를 재현하지도 않는다. Moodcode archive import·checkpoint restore·uncertain effect recovery의 계약을 대체하면 안 된다. [SWA-R18, R13]

`RetryAgent`는 코딩 시도별 새 DefaultAgent를 구성하고 이전 시도·reviewer 통계를 반영한 잔여 cost를 적용한다. 각 시도 완료를 reviewer loop에 전달하고 재시도하면 deployment를 hard reset한다. 최종 chooser는 best attempt의 결과를 선택하고 전체 통계를 기록한다. 이는 provider transport retry와 구분되는 **task 전체 재시도**다. reviewer 판단은 실제 검증 결과와 다르며 협력 child·mailbox·동시에 쓰는 worktree team의 구조도 아니다. score/chooser loop에는 max attempt·cost·stop decision이 있다. [SWA-R17; `sweagent/agent/reviewer.py:189–230`, `565–650` 보조 정적 확인]

batch는 instance별 model/agent/environment·thread worker·trajectory·prediction을 만든다. `should_skip()`은 비어 있거나 malformed이거나 exit status 없는 trajectory를 지워 재실행하고, 그 외 exit status가 있으면 건너뛴다. 실패·자동 제출·검증 성공을 모두 구분하는 완료 증거 검사는 아니다. `SweBenchEvaluate` hook은 지원 subset을 외부 `sb-cli submit` 호출에 매핑하고 report를 옮긴다. eval CLI의 availability·서비스 약관·grading 성공은 미확인이다. 이 정적 연결을 SWE-bench 실행이나 논문 성능 재현으로 표현하지 않는다. [SWA-R19; `sweagent/run/hooks/swe_bench_evaluate.py:19–116` 보조 정적 확인]

## Moodcode에 제안하는 독립 계약

네 후보는 이번에 구현·실행하지 않았다. P1은 기존 실행 계약의 추가 증거·회귀 검증을 먼저 검토할 후보, P2는 후속 관측·워크플로 후보다. S는 제한된 진단/fixture, M은 여러 실행·저장 경계, L은 작업 전체 workflow와 host 연결 비용을 뜻한다. 기존 Moodcode 기능은 [baseline](moodcode-baseline.md)과 [현재 구현 상태](../moodcode/implementation-status.md)를 따른다.

| ID·우선순위·비용 | 참고 동작·이미 있는 Moodcode 기능 | 추가할 독립 계약 | 검증 조건 |
|---|---|---|---|
| SWA-C01 · P2 · M | processor로 query를 줄이고 raw history/trajectory와 구분. Moodcode는 bounded ContextPlan·semantic memory·historical tool projection이 이미 있다. | policy별 투영 진단을 원래 message/Run/Turn/Attempt와 context revision에 묶는다. omitted observation의 이유·byte 수·historical file 여부를 표시하고 active exchange·call ID pair를 보존한다. raw journal은 변경하지 않는다. | 같은 source의 결정적 결과, user/tool 형식 차이, 이미지와 UTF-8 경계, stale file evidence, processor 순서·정책 변경, raw 불변·상한·pair completeness. |
| SWA-C02 · P1 · M | 오류 후 patch 수집·replay. Moodcode는 artifact·checkpoint·archive·tool recovery frontier가 이미 있다. | 실패·중단 Run의 읽기 전용 코딩 결과 manifest에 source journal sequence, patch/file hash, 실행된 검증 명령·outcome, cleanup disposition을 묶는다. 산출물이 있어도 terminal failure/uncertainty를 성공으로 바꾸지 않는다. 수집은 새 Git stage·명령 replay를 시작하지 않는다. | patch만 존재·검증 실패·검증 미실행 구분, 이전 diff의 freshness, partial restore, unknown cleanup 실행 차단, export/import 불변, 수집 중 crash와 byte 상한. |
| SWA-C03 · P2 · L | reviewer 기반 task 전체 재시도·batch skip. Moodcode는 provider Attempt·agent profile·격리 child/worktree·예산 상속·terminal inbox 전달이 이미 있다. | opt-in issue attempt group은 config/base commit/검증 계획을 고정하고 별도 worktree에서 bounded 시도를 수행한다. reviewer는 read-only advisory이며 별도 비용·identity를 가진다. 최종 선택도 exact 승인된 적용을 거친다. skip은 같은 source/config의 성공·파일/검증/cleanup 증거가 모두 맞을 때만 허용한다. | provider retry와 task attempt 분리, parent 잔여 예산·deny/cancel 상속, 동시 case 중복, reviewer 과예산·실패, stale base와 config 변경, failure status skip 거절, 선택 patch 승인 뒤 변경 거절. |
| SWA-C04 · P1 · S | bundle 중복 이름·schema/command 렌더링·실제 editor 동작의 차이. Moodcode는 scoped versioned runtime·bounded discovery·같은 Turn capture·exact prepared/effect가 이미 있다. | host 도구 등록 manifest를 schema digest, scope/revision, effect/approval policy, descriptor와 handler identity로 고정하고 등록 간 변경을 읽기 전용으로 비교한다. shell bundle install을 도입하지 않는다. 변경 schema는 다음 model 경계에만 보이며 prepared 승인을 재사용하지 않는다. | 중복 이름·scope 충돌, stale capture·hidden descriptor, type/enum/input 오류의 effect 0, handler/descriptor 불일치, 등록 변경 중 approval·discovery 상한, linter warning과 검증 성공 구분. |

각 후보의 실제 Moodcode 경로와 계약·검증 조건은 JSON에 기록했다. C01은 `context/service.ts`, `context/plan.ts`, `context/tool-history.ts`, `storage/native-history.ts`; C02는 `storage/tool-recovery-frontier.ts`, `storage/archive.ts`, `review/index.ts`, `artifacts/index.ts`; C03은 `child-tasks/index.ts`, `worktrees/index.ts`, `config/budgets.ts`, `runner/turn-executor.ts`, `runner/input-scheduler.ts`, `scripts/evaluate-engine.mjs`; C04는 `tools/runtime/index.ts`, `tools/runtime/discovery.ts`, `runner/tool-discovery.ts`, `runner/index.ts`, `tools/edit/index.ts`를 읽고 비교했다. 모든 `packages/engine/src/` 경로는 실제 기존 파일이다. 새 후보를 기존 durable attempts·approval·inbox·context·typed tools·effects·recovery가 없는 것처럼 표시하지 않는다.

## 라이선스와 확인 한계

실제 root `LICENSE`는 MIT이며 2024 John Yang 외 저작권자를 명시한다. tracked license/notice filename 검색에서 별도 하위 license 파일은 발견하지 않았다. 다만 default editor 파일 header는 Anthropic quickstarts editor의 adaptation이라는 별도 출처를 명시한다. root MIT가 모든 외부 출처·SWE-ReX/LiteLLM 전이 의존성·container image·dataset·provider·evaluation 서비스의 허가와 약관 검토를 대신하지 않는다. 배포 의존성 전체 audit·법률 검토를 수행하지 않았다. [SWA-R01, R03; `tools/edit_anthropic/bin/str_replace_editor:3–6` 보조 정적 확인]

이번 변경에는 분석·출처·독립 동작 명세만 포함한다. upstream source/prompt/tool description/fixture/media 복사·runtime 의존성 추가·원본 수정·설치·upstream tests·모델/계정·container·benchmark·GUI·공유 build·commit을 수행하지 않았다. 원본을 읽은 분석이므로 clean-room 절차라고 주장하지 않는다. 근거의 파일 identity·줄 범위·SHA-256·고정 commit 소속과 후보 Moodcode 경로를 정적으로 검사했으며 runtime 성공이나 cleanup·성능을 입증하지 않는다. 외부 SWE-ReX 구현·이미지/dataset·optional browser·모든 대안 parser·action sampler·제출/PR hook의 완전한 lifecycle은 미확인 범위다. 기존 Moodcode 1차 검증 기록과 열린 OS/provider/CI 항목은 그대로 보존한다.

## 고정 소스 대표 근거

아래 20개 범위는 JSON과 같고 각각 160줄 이하다. 본문은 ID를 인용하고 고정 SHA URL은 이 표에 모았다. 별도 명시한 보조 정적 확인은 실행 결과가 아니다.

| ID | 고정 소스 | 핵심 근거 |
|---|---|---|
| SWA-R01 | [LICENSE:1–21](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/LICENSE#L1-L21) | root MIT·고지 조건 |
| SWA-R02 | [README.md:19–24](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/README.md#L19-L24) | mini로 개발 노력 이동·superseded 안내 |
| SWA-R03 | [pyproject.toml:13–67](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/pyproject.toml#L13-L67) | Python·package·외부 의존성·CLI |
| SWA-R04 | [run/run_single.py:165–207](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/run/run_single.py#L165-L207) | config→env/agent→run→정상 close |
| SWA-R05 | [environment/swe_env.py:109–232](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/environment/swe_env.py#L109-L232) | SWE-ReX session·reset·interrupt·출력·stop |
| SWA-R06 | [agent/models.py:632–781](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/models.py#L632-L781) | provider query·추정 token·사후 cost/call 한도 |
| SWA-R07 | [agent/models.py:794–903](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/models.py#L794-L903) | retry 제외·tool ID·provider factory |
| SWA-R08 | [tools/parsing.py:397–454](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/tools/parsing.py#L397-L454) | 단일 call·이름/key 검사·shell 렌더링 |
| SWA-R09 | [tools/tools.py:75–224](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/tools/tools.py#L75-L224) | bundle·schema·중복·timeout config |
| SWA-R10 | [tools/tools.py:252–380](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/tools/tools.py#L252-L380) | upload/install·state·command filter |
| SWA-R11 | [agent/agents.py:936–1060](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py#L936-L1060) | query→parser→action→observation·timeout |
| SWA-R12 | [agent/agents.py:1062–1218](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py#L1062-L1218) | 재질의·오류·cancel 전달·autosubmit 종료 |
| SWA-R13 | [agent/agents.py:714–821](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py#L714-L821) | observation·JSON overwrite·임시 requery history |
| SWA-R14 | [agent/agents.py:823–904](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py#L823-L904) | runtime 실패 시 diff·patch 수집·submission |
| SWA-R15 | [agent/agents.py:1220–1294](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py#L1220-L1294) | trajectory·history bookkeeping·done loop |
| SWA-R16 | [agent/history_processors.py:141–258](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/history_processors.py#L141-L258) | old observation·tag·user-role window 투영 |
| SWA-R17 | [agent/agents.py:303–440](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py#L303-L440) | task 시도·잔여 cost·hard reset·review 선택 |
| SWA-R18 | [run/run_replay.py:96–202](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/run/run_replay.py#L96-L202) | config/assistant action 추출·새 환경 재실행 |
| SWA-R19 | [run/run_batch.py:268–409](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/run/run_batch.py#L268-L409) | worker·pending cancel·finally close·status skip |
| SWA-R20 | [edit_anthropic/bin/str_replace_editor:516–594](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/tools/edit_anthropic/bin/str_replace_editor#L516-L594) | unique replacement·tab 확장·쓰기 뒤 lint warning |
