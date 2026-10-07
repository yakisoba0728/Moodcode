# mini-SWE-agent 메인 엔진 정적 분석

분석일: 2026-10-07, Asia/Seoul. 원본은 [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent), full HEAD는 `04d809ceab9df28f9adaed044884180159172930`, checkout은 `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/mini-swe-agent`다. 분석 방식은 `static-source-review`이며 [기계 판독 근거](mini-swe-agent.evidence.json)를 따른다. Moodcode 비교 기준은 문서 HEAD `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 source `464812f7d1af24466f57070663131f5979aeca51`다.

현재 v2의 장점은 모델·agent loop·실행 환경을 작은 인터페이스로 나눠 코딩 작업의 흐름을 쉽게 추적할 수 있다는 점이다. Moodcode에는 typed tools, exact approval, durable Run/Turn/Attempt/Part, worktree child, budget 상속과 cleanup uncertainty 계약이 이미 있다. 따라서 bash-only 엔진으로 교체하는 제안보다 기존 계약을 작고 독립적인 검증 행렬로 확인하는 데 참고 가치가 크다. SWE-agent 원본 저장소와 별개 프로젝트이며, 이 문서는 일반 소프트웨어 편집·명령·검증 흐름만 다룬다.

## 기준점·package·주장 구분

Python `>=3.10`의 단일 `minisweagent` package이며 고정 소스의 버전은 `2.4.6`이다. `agents/`, `models/`, `environments/`, `run/`을 분리하고 `mini`와 `mini-swe-agent` entry point는 `run.mini:app`으로 연결한다. Pydantic, Jinja, LiteLLM, Tenacity, Typer, Rich/Textual 등을 사용하며 Modal·Contree·SWE-rex 등은 선택적 의존성도 포함한다. 약식 프로젝트 설명의 “작다”와 배포 의존성의 크기는 구분해야 한다. [MSA-R03, R04]

고정 HEAD의 마지막 commit 날짜는 `2026-09-03T01:05:59-04:00`이고 메시지는 main merge다. package metadata는 Alpha로 분류한다. 이는 checkout의 유지보수 흔적이며 2026-10-07 현재 GitHub 이슈 대응·release 활동을 별도로 조회한 결과는 아니다.

| 분류 | 확인 내용 | 판단 범위 |
|---|---|---|
| README 주장 | agent class 약 100줄, SWE-bench Verified >74%, 빠른 시작, DeepSWE에서 다른 제품보다 우수 | 이 분석에서 benchmark·startup 측정·비교 모델 실행을 하지 않았다. 수치를 검증 결과로 인용하지 않는다. |
| 확인한 소스 | 현재 `agents/default.py`는 190줄이며 class는 38줄에서 시작한다. v2 기본 모델은 bash toolcall, text regex 대안도 있다. | 100줄을 엄밀한 현재 코드 크기나 전체 runtime 크기로 취급하지 않는다. |
| README 주장과 소스 차이 | README는 `subprocess.run`과 선형 history를 설명한다. 현재 local은 `Popen`+`communicate`를 사용하고 JSON trajectory에는 API에 보내지 않는 `extra` metadata도 저장한다. | 선형 append 설계는 확인되지만 trajectory JSON과 API 요청이 byte 단위로 동일하지 않다. Responses는 output item으로 다시 펼친다. |

[MSA-R02, R06–R08, R12, R20]

## 진입점에서 종료까지

1. `run.mini.main()`이 YAML/key-value config와 CLI override를 병합한다. 기본 output은 전역 config directory의 마지막 trajectory 파일이다. `get_model()`, `get_environment(..., default_type="local")`, `get_agent(..., default_type="interactive")`로 구성한 뒤 `agent.run(task)`를 부른다. 전역 설정 로드와 초기 설정 호출은 실제 실행 시 부작용이 있으므로 분석에서 package를 import하지 않았다. [MSA-R04, R05]
2. `DefaultAgent.run()`은 system/user 메시지를 만들고 `step()`을 반복한다. `step()`은 `query()`→`execute_actions()`다. 모델이 `extra.actions`를 반환하고 agent는 action마다 환경을 순차 호출한다. `Model`은 query·메시지/observation formatting·serialize, `Environment`는 execute·template vars·serialize, `Agent`는 run·save protocol을 가진다. [MSA-R04, R06]
3. `LitellmModel.query()`가 API message에서 `extra`를 제거하고 provider에 맞게 thinking/cache 정보를 처리한 뒤 `litellm.completion()`을 호출한다. 기본 schema는 bash 한 종류다. 모델 계층의 `parse_toolcall_actions()`가 JSON arguments, tool name, command 키 존재를 확인하고 tool call ID와 command를 action으로 만든다. command 값의 문자열 검증까지 이 parser에서 하는 것은 아니다. 모든 action을 파싱한 뒤 실행 경계로 넘기므로 뒤쪽 malformed call이 발견되면 이 응답의 앞쪽 action도 실행되지 않는다. [MSA-R08, R09]
4. 환경은 output·returncode·exception metadata를 돌려준다. model formatter가 tool call ID에 대응하는 observation을 만들고 메시지에 append한다. 일반 nonzero exit는 observation이므로 모델이 다음 step에서 수정할 수 있다. text regex 모드는 정확히 한 action을 요구하고 user-role observation을 만든다. v2 기본의 여러 bash call과 구분한다. [MSA-R06, R09, R10, R12]
5. 환경이 성공 output 첫 줄에서 완료 marker를 읽으면 `Submitted`를 발생시키고 남은 output을 submission으로 기록한다. 이 marker는 완료 신호이며 테스트 성공·변경 파일 범위·Git patch 유효성을 engine이 증명한 결과는 아니다. `DefaultAgent.run()`은 exit-role 메시지가 마지막이면 종료하고 그 metadata를 반환한다. [MSA-R06, R12, R13]
6. 모든 step의 `finally`에서 trajectory save를 호출한다. 일반 `Exception`은 exit·traceback을 기록한 뒤 다시 던진다. 제출·제한·사용자 feedback은 메시지를 운반하는 flow exception으로 처리한다. [MSA-R06, R07]

기본 `DefaultAgent.execute_actions()`는 list comprehension이다. 여러 action 중 나중 action에서 제출/예외가 발생하면 앞선 성공 output을 formatter에 전달하기 전에 흐름을 벗어날 수 있다. `InteractiveAgent`는 별도 `try/finally`로 이미 모은 output을 보존하고 formatter는 미실행 action에 placeholder observation을 붙인다. 이 두 경로를 동일한 부분 결과 보존 계약으로 설명하면 안 된다. [MSA-R06, R09, R14]

## 기능 경계

| 범주 | 소스에서 확인한 동작 | 확인 한계·Moodcode와의 차이 |
|---|---|---|
| 탐색·편집·검증 | 하나의 command로 저장소 읽기, 파일 편집, 코딩 테스트를 수행할 수 있다. | 전용 read/search/edit/test registry와 파일 hash 승인 계약을 기본 loop에 두지 않는다. 무엇을 읽고 편집·검증할지는 모델과 명령에 달려 있다. |
| 문맥·기억 | 전체 `messages`를 다음 query에 넘기는 선형 append. tool observation template는 길면 앞/뒤 각각 5,000자를 보여준다. | 10,000자는 token·UTF-8 byte 한도가 아니며 raw output은 `extra`에 남는다. 전체 history hard cap, 자동 summary, semantic memory, repository index는 살펴본 기본 경로에서 확인하지 않았다. LiteLLM context overflow는 abort 대상이다. |
| 기본 도구 | v2 기본은 bash toolcall 하나, text regex는 대안. 도구 응답은 원래 call ID를 유지한다. | bash-only는 provider toolcall을 사용하지 않는다는 뜻이 아니다. README의 무toolcall 설명은 현재 기본 경로를 완전히 설명하지 않는다. |
| provider·확장 | LiteLLM completion/Responses, OpenRouter, Portkey, Requesty, deterministic class를 factory에서 선택. full import path도 가능. Responses는 과거 output item을 stateless input으로 펼친다. | factory 등록은 provider/endpoint별 live 호환성 증명이 아니다. 기본 tool catalog의 동적 discovery·MCP 수명 관리는 이 protocol에서 확인하지 않았다. |
| 이미지 | optional regex로 구조화된 `image_url` content를 만들 수 있고 기본 regex는 비활성이다. | Moodcode의 bounded image import·token policy·지속 attachment identity와 동등한 계약으로 볼 수 없다. PDF/audio/video 처리나 실제 multimodal 인식은 확인하지 않았다. |
| 승인·상호작용 | interactive 기본 confirm, regex whitelist, human/yolo mode, 여러 command의 일괄 확인, 제출 시 새 task/종료 확인. | stdin 확인은 persisted approval identity/fingerprint, expiry, scope grant와 다르다. human/yolo/whitelist가 승인 생략 경로다. |
| 취소 | interactive `KeyboardInterrupt`는 사용자 comment를 받아 다음 모델 턴에 넣는다. batch 첫 interrupt는 미시작 future만 cancel한다. | 취소된 durable terminal과 provider/process cleanup proof를 보장하는 API가 아니다. running batch job은 첫 interrupt에서 계속 기다린다. |
| 하위 작업 | batch worker마다 별도 model/env/agent로 독립 instance 처리. | 협력 subagent, parent budget inheritance, mailbox, worktree 변경 통합이 있는 것과 구분한다. 살펴본 core protocol에는 child 방법이 없다. |

[MSA-R04, R06, R08–R10, R14–R20]. 기능 부재는 이 기본 경로의 확인 범위이며 grep 결과만으로 확장·제품 전체 부재를 단정하지 않는다.

## 예산·오류·실행 환경

`DefaultAgent.query()`는 model query 전에 step count·누적 cost·wall time을 확인한다. `n_calls`는 query 시도 전에 증가하며 provider 내부 재시도 횟수와 같은 수가 아니다. cost는 응답이 끝난 뒤 계산하므로 호출 한 번이 cost limit을 넘길 수 있다. wall time은 constructor에서 시작한 `time.time()`을 정수 초로 검사하며 살아 있는 API 요청·명령을 해당 시간에 선점하는 timer는 아니다. 동일 agent 객체의 `run()` 재호출은 messages를 비우지만 cost·call count·시작 시각을 reset하지 않는다. [MSA-R06]

provider 전송 오류 재시도와 malformed response를 모델에 되돌리는 재질의는 별도다. Tenacity는 기본 최대 10회, 지수 대기 4–60초를 사용하며 auth·권한·지원 불가·context overflow·keyboard interrupt 등은 LiteLLM abort 목록에 있다. malformed action은 billed response와 계산된 cost를 오류 metadata에 보존한 뒤 agent가 feedback을 append한다. 연속 format error는 기본 3회에서 exit하며 clean step이면 counter를 reset한다. format-error 진단 template는 output-limit 종료를 구분할 수 있다. cost 미등록 시 기본은 오류이며 `ignore_errors`는 0으로 처리하므로 그 값이 실제 무료 사용을 입증하지는 않는다. [MSA-R06, R08, R11, R15, R18, R20]

`GLOBAL_MODEL_STATS`는 같은 Python process의 여러 model 사용량을 집계하고 선택적 전역 cost/call 한도를 검사한다. 이는 부모/자식 allocation을 실행 전에 예약하는 계약이나 process 재시작 후 이어지는 durable budget이 아니다. Moodcode의 `BudgetAccount`는 logical Turn과 provider Attempt를 구분하고 child 예약은 부모 잔여 예산에 묶는다. 이미 있는 기능의 대체가 아니라 오류 경계의 추가 검증을 제안한다. [MSA-R18; Moodcode `config/budgets.ts`, `runner/turn-executor.ts`, `child-tasks/index.ts`]

local은 host cwd와 환경을 사용해 각 action을 새 shell process에서 실행한다. 디렉터리·shell 변수 변경은 다음 action에 자동 유지되지 않지만 파일 효과는 남는다. POSIX timeout은 새 process group을 kill한 뒤 output을 수집하며 Windows는 직접 process kill 경로다. 전체 stdout/stderr를 메모리로 수집하고 환경 자체에는 hard capture byte 한도가 없다. `shell=True`이므로 local의 bash라는 API 명칭과 실제 host 기본 shell interpreter 선택도 구분한다. [MSA-R12]

Docker는 instance용 container를 먼저 만들고 action마다 `docker exec`와 설정된 interpreter/cwd/env를 사용한다. container filesystem은 action 사이에 유지되고 shell process는 새로 실행된다. executable을 바꿔 Podman을 사용할 수 있는 구조다. cleanup은 destructor에서 stop/rm command를 background launch하므로 정적 소스만으로 종료 확인 receipt·crash 시 정리 성공을 입증할 수 없다. host의 exec timeout 또한 container 내부 전체 process tree의 부재 증명으로 볼 수 없다. Singularity·Bubblewrap·Contree·SWE-rex 환경 이름은 factory에 등록되어 있지만 이 문서의 상세 생명주기 근거는 local/Docker에 한정한다. [MSA-R13; `environments/__init__.py` 정적 확인]

## trajectory·batch·평가

`serialize()`는 config/class identity, version, model cost/call count, submission/exit status와 messages를 결합하고 format label은 `mini-swe-agent-1.1`이다. v2 package version과 저장 format label이 같을 필요는 없다. `save()`는 전체 JSON을 `Path.write_text()`로 덮어쓰며 source에는 임시 파일 rename·fsync·DB transaction이 없다. 관측 가능한 export 기능을 Moodcode의 SQLite journal·effect recovery와 동일하게 취급하지 않는다. inspector는 파일을 읽는 browser이며 저장된 trajectory를 살아 있는 실행으로 복구하는 경로는 살펴본 기본 agent/runner에서 확인하지 않았다. [MSA-R07; `run/utilities/inspector.py:153–176` 정적 확인]

SWE-bench batch는 dataset/subset/filter/slice/seeded shuffle, instance별 environment startup, `ProgressTrackingAgent`, thread pool, trajectory와 `preds.json` 출력을 제공한다. `preds.json` 갱신은 process 안의 lock으로 직렬화하며 worker finally에서 결과를 기록한다. 실패한 instance도 결과 key가 생길 수 있다. `--redo-existing`이 없으면 존재하는 key를 모두 건너뛰므로 성공 증거를 검사하는 resume가 아니다. 재실행할 instance의 기존 prediction/trajectory를 먼저 지우고 새로 시작한다. [MSA-R16, R17]

benchmark의 submission은 agent가 반환한 output을 `model_patch`로 저장하는 연결이다. [고정 SWE-bench config](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/config/benchmarks/swebench.yaml#L75-L128)는 patch 준비·검토·제출 단계를 안내하고 `/testbed`의 Docker 환경과 step/cost 제한을 정한다. 안내 문구와 평가자가 실제 테스트를 통과했다고 판정한 결과를 구분해야 한다. 이 batch runner 분석을 SWE-bench grading 실행·논문 수치 재현으로 표시하지 않는다.

## Moodcode에 제안하는 독립 계약

아래 네 후보는 이번에 구현하거나 실행하지 않았다. 우선순위 P1은 계약 회귀 검증을 먼저 검토할 후보, P2는 후속 관측 도구/검증 편의 후보다. 비용 S는 제한된 fixture/보고서 변경, M은 여러 실행·저장 경계에 걸친 설계와 검증을 뜻한다.

| ID·우선순위·비용 | 참고 동작과 현재 Moodcode 상태 | 독립 계약 | 검증 조건 |
|---|---|---|---|
| MSA-C01 · P1 · S | billed FormatError·연속 오류 종료에서 얻는 진단 행렬. Moodcode는 이미 Attempt/Part·usage·부분 tool proposal·제한된 provider retry를 기록한다. | malformed JSON/unknown tool/output-limit/transport 오류를 구분한 합성 시나리오 보고서를 만든다. 이미 관측한 usage·부분 제안의 identity를 보존하고 실행 가능한 finish 전에는 effect를 시작하지 않는다. protocol 오류를 일반 자동 retry로 완화하지 않는다. | completion/Responses별 같은 시나리오, usage absent/0 구분, 관측 후 전송 실패 재시도 금지, terminal 이후 기록 금지, cleanup uncertainty의 실행 차단, tool effect 0 확인. |
| MSA-C02 · P2 · M | 선형 trajectory의 inspect 용이성. Moodcode는 이미 영구 Run/Turn/Attempt/Part, bounded paging와 archive export/import가 있다. | 같은 journal sequence에 고정된 읽기 전용 코딩 trajectory 투영을 정의한다. 각 item은 원래 Run/Turn/Attempt/Part/call ID를 유지하고 model-input projection과 실행 observation을 구분한다. 숨겨진 retry·summary·partial output을 표시하고 credential/native opaque payload는 자동 공개하지 않는다. | paging 전체 순서·중복/누락, 실패한 Attempt·부분 observation, byte 상한·UTF-8, 저장소 변동 시 snapshot binding, export 전후 원본 불변. import로 실행·도구가 시작되지 않음. |
| MSA-C03 · P1 · M | dataset batch skip의 단순함에서 확인한 성공/실패 혼동 경계. Moodcode의 기존 headless fixture 3개는 독립 임시 저장소·정확한 승인·최종 파일/명령 검사와 report를 갖는다. | batch case identity를 engine source/fixture digest/provider config hash/예산과 묶고 성공 terminal·파일 결과·검증 명령·cleanup이 일치하는 case만 완료로 건너뛴다. failed/cancelled/uncertain은 별도로 보존한다. 재실행은 새 attempt identity이며 과거 report를 덮어쓰지 않는다. | 중간 report 쓰기 중단, 같은 case 동시 제출, config 변경, 실패 key 존재, 취소 pending/running 구분, source 다른 결과 재사용 거절, 모델 사용 시 실제 성공률과 scripted 계약 통과율을 별도 표시. |
| MSA-C04 · P2 · S | 새 shell마다 cwd/env는 초기화되고 파일은 남는 경계. Moodcode는 이미 `run_command`·supervisor·process cleanup·typed preparation·worktree가 있다. | host 명령과 격리 worktree 명령의 동일 상태 수명 행렬을 추가한다. cwd/env 초기화와 파일 지속성을 구분하고 command·workspace·timeout exact approval을 유지한다. container 지원을 이 후보의 완료 조건에 포함하지 않는다. | 두 연속 command의 cwd/env 비승계·파일 승계, nonzero output, UTF-8/bounded artifacts, timeout·cancel·descendant cleanup, child budget/deny 상속, 미확정 cleanup 차단. 지원한 OS만 실측으로 표시. |

관련 실제 Moodcode 경로와 후보의 세부 계약은 JSON에 기록했다. C01은 `runner/turn-executor.ts`, `runner/index.ts`, `provider/openai-compatible.ts`, `provider/responses.ts`, `config/budgets.ts`; C02는 `storage/native-records.ts`, `storage/native-history.ts`, `storage/archive.ts`; C03은 `scripts/evaluate-engine.mjs`, `runner/input-scheduler.ts`, `child-tasks/index.ts`; C04는 `tools/command/index.ts`, `tools/command/process-control.ts`, `tools/command/backends.ts`, `worktrees/index.ts`를 읽고 비교했다. 기존 Moodcode의 1차 완료·실제 모델·OS 검증 기록을 새 upstream 검증으로 재명명하지 않는다.

## 라이선스·검증 한계

root 실제 `LICENSE.md`는 MIT이며 저작권자는 2025 Kilian A. Lieret/Carlos E. Jimenez다. tracked license/notice filename 검색에서는 이 root 파일만 확인했다. 하위 package의 별도 license 발견 여부와 LiteLLM/OpenAI·container image·dataset·원격 서비스의 허가/약관은 다른 문제다. 전이 의존성 전체 audit·dataset 재배포 검토·법률 검토를 수행하지 않았다. [MSA-R01, R03]

이번 변경에는 분석과 독립 동작 명세만 포함한다. upstream source·prompt·tool description·fixture·media를 Moodcode에 복사하지 않았고 runtime 의존성을 추가하지 않았다. 원본을 읽었으므로 clean-room 절차를 주장하지 않는다. 설치·upstream tests·실제 model/계정·benchmark·environment container·GUI·공유 build·commit은 실행하지 않았다. 원본 HEAD와 checkout을 변경하지 않았다. 정적 파일 identity·줄 범위·SHA-256 검사만 수행하며 runtime 성공과 성능을 입증하지 않는다.

## 고정 소스 대표 근거

아래 20개는 JSON과 동일한 범위이며 각각 160줄 이하다. 본문은 ID로 인용하고 URL은 이 표에 모았다.

| ID | 고정 소스 | 핵심 근거 |
|---|---|---|
| MSA-R01 | [LICENSE.md:1–21](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/LICENSE.md#L1-L21) | root MIT·저작권·고지 조건 |
| MSA-R02 | [README.md:5–54](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/README.md#L5-L54) | v2·약 100줄·성능·bash/선형 history 주장 |
| MSA-R03 | [pyproject.toml:6–106](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/pyproject.toml#L6-L106) | Python/package·의존성·entry point·Alpha metadata |
| MSA-R04 | [__init__.py:11–82](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/__init__.py#L11-L82) | version·설정 초기화·Model/Environment/Agent protocol |
| MSA-R05 | [run/mini.py:55–105](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/run/mini.py#L55-L105) | CLI config merge·factory·run 진입 |
| MSA-R06 | [agents/default.py:19–157](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py#L19-L157) | query/execute loop·제한·오류·finally save |
| MSA-R07 | [agents/default.py:159–190](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py#L159-L190) | trajectory serialize·JSON overwrite |
| MSA-R08 | [models/litellm_model.py:27–151](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/litellm_model.py#L27-L151) | completion·bash·response/cost 보존·abort·formatting |
| MSA-R09 | [models/utils/actions_toolcall.py:11–113](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/utils/actions_toolcall.py#L11-L113) | bash action validation·call ID·미실행 placeholder |
| MSA-R10 | [models/utils/actions_text.py:1–70](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/utils/actions_text.py#L1-L70) | 단일 regex action 대안·user observation |
| MSA-R11 | [models/utils/retry.py:9–25](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/utils/retry.py#L9-L25) | 전송 재시도 한도·지수 대기 |
| MSA-R12 | [environments/local.py:13–92](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/environments/local.py#L13-L92) | local command·submission·POSIX timeout kill |
| MSA-R13 | [environments/docker.py:15–161](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/environments/docker.py#L15-L161) | container 시작/exec·config·background cleanup |
| MSA-R14 | [agents/interactive.py:24–183](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/interactive.py#L24-L183) | 승인 mode·interrupt·부분 output·limit 상향 |
| MSA-R15 | [config/mini.yaml:101–151](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/config/mini.yaml#L101-L151) | 기본 한도·head/tail observation·length 진단 설정 |
| MSA-R16 | [run/benchmarks/swebench.py:79–177](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/run/benchmarks/swebench.py#L79-L177) | instance 환경·trajectory/prediction 저장 |
| MSA-R17 | [run/benchmarks/swebench.py:200–275](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/run/benchmarks/swebench.py#L200-L275) | dataset·기존 key skip·workers·pending cancel |
| MSA-R18 | [models/__init__.py:13–113](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/__init__.py#L13-L113) | process 전역 cost/call·provider factory |
| MSA-R19 | [models/utils/openai_multimodal.py:7–50](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/utils/openai_multimodal.py#L7-L50) | optional image_url expansion |
| MSA-R20 | [models/litellm_response_model.py:25–98](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/models/litellm_response_model.py#L25-L98) | Responses item projection·query·parse error 보존 |
