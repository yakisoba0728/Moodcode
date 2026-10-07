# Aider 엔진 정적 분석

2026-10-07. Aider는 파일 집합과 편집 형식을 가진 `Coder`가 문맥 구성 → 모델 응답 → 편집 파싱·적용 → Git 기록 → lint/test 수리를 직렬로 수행하는 터미널 중심 Python 엔진이다. Moodcode에 유용한 차이는 **심볼 관계를 이용한 저장소 구조 문맥**, **검증 계획과 제한 수리 단계**, **설계→편집 모델 역할 전환**, **Run에 결속한 승인형 Git 커밋**이다. 모델 스트림·요약·도구 오류 피드백·승인·취소·기록·하위 작업 자체는 Moodcode에 이미 있으므로 신규 결손으로 세지 않는다.

## 기준점과 범위

| 항목 | 확인 결과 |
|---|---|
| 원본 | [Aider-AI/aider](https://github.com/Aider-AI/aider) |
| 고정 HEAD | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` |
| 원본 checkout | `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/aider` |
| 언어·package | Python `aider-chat`, Python ≥3.10,<3.15. `aider` console script는 `aider.main:main`. [package metadata](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/pyproject.toml#L2-L30) |
| 분석 방식 | 소스와 Git metadata를 읽은 정적 분석. 설치·setup·테스트·benchmark·GUI·계정·실제 모델 실행 없음 |
| 유지보수 관측 | 이 checkout의 HEAD commit 일자는 2026-05-22이고 최근 로그에 모델 목록·bash tags 변경과 merge가 있다. metadata는 Beta로 표시한다. 고정 checkout 이후의 모든 릴리스나 현재 활동 상태는 확인하지 않았다. |
| Moodcode 비교 | 문서 HEAD `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 source `464812f7d1af24466f57070663131f5979aeca51`. 현재 구현 상태 문서와 실제 관련 경로를 함께 읽었다. |

핵심 package 경계는 `main.py`(CLI·구성), `coders/`(응답·편집 형식), `models.py`(모델 metadata·LiteLLM 요청), `repomap.py`(심볼 문맥), `history.py`(요약), `repo.py`(Git), `commands.py`/`run_cmd.py`(사용자 명령), `io.py`(입출력·이력)다. 외부 LiteLLM·tree-sitter·GitPython·GUI·voice·watcher의 전체 구현은 이번 분석 범위가 아니다.

## 실행 경로와 실제 확인 동작

1. **진입·lifecycle.** `main`은 모델·GitRepo·Commands·ChatSummary와 파일 집합을 마련해 `Coder.create`에 설정을 넘긴다(R01). `create`는 `coders.__all__`의 `edit_format`으로 구현을 선택한다(R02). 입력 루프의 `run` → `run_one` → `send_message`에서 사용자 slash command 전처리와 파일/URL 언급을 처리하고, `reflected_message`가 있으면 재요청한다. 기본 `max_reflections=3`이 적용된다(R03). [입력·reflection 루프](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L876-L944). 반복 budget이 Moodcode의 durable Run/Turn/Attempt와 같은 저장 계약이라고 보지는 않는다.

2. **모델 요청·stream·종료.** `send_message`가 `format_messages`와 token 검사를 거쳐 `send`를 호출하고, `Model.send_completion`이 모델별 temperature/extra params/timeout·stream 및 선택적 function 요청을 LiteLLM에 보낸다(R04). 이 function 경로는 첫 function을 강제 선택하는 형태다. 텍스트 편집 coder와 범용 도구 실행 registry를 구분해야 한다. `show_send_output_stream`은 text·reasoning·function delta를 축적하며 길이 종료를 별도 예외로 처리한다(R05). 지정 provider 오류는 증가 대기와 `RETRY_TIMEOUT`으로 제한하고 context 초과·중단은 루프를 벗어난다(R18). `send`의 finally가 부분 응답을 IO 기록으로 내보낸다. [실제 send 경계](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1783-L1834).

3. **문맥·기억.** `format_chat_chunks`는 system/examples, 완료 이력, repo-map, read-only 파일, 편집 파일, 현재 대화를 분리한다(R06). `Coder.get_repo_map`은 현재 대화에서 파일·심볼 언급을 모아 chat 파일과 나머지 파일을 분리하고, 편향된 map 생성 실패 시 global/unhinted map으로 되돌아간다. [repo-map 입력·fallback](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L709-L748). `ChatSummary.summarize_real`은 오래된 head를 요약하고 최근 tail을 assistant 경계에 맞춰 유지한다(R13). 요약 모델은 weak→main 순서로 시도하며, 별도 worker 시작/합류 경로가 있다. [요약 모델 fallback](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/history.py#L98-L123), [요약 worker](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1002-L1037).

4. **repo-map·ranking.** `RepoMap.get_tags_raw`는 언어별 tree-sitter query로 정의·참조·위치를 추출한다(R07). 참조 query가 없을 때 이름 token으로 보충하는 경로도 있다. 언급 심볼과 chat 파일에 가중치를 주고 참조 빈도의 영향을 줄인 그래프를 PageRank로 계산해 정의에 순위를 분배한다(R08). `get_ranked_tags_map_uncached`가 tag prefix를 tree로 렌더링해 토큰 크기를 측정·이분 탐색한다(R09). **목표 토큰의 15% 이내면 목표를 약간 넘는 후보도 수용할 수 있어 strict hard cap과 다르다.** 태그 cache는 mtime 기반이고 map refresh에는 auto/files/always/manual 정책이 있다. [tag cache](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L233-L262), [map cache](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L585-L625).

5. **편집·명령·검증.** `apply_updates`는 `get_edits` → dry-run → `prepare_to_edit` → `apply_edits` 순서로 처리하며 malformed response를 reflection으로 되돌린다(R10). 기본 diff 구현은 `EditBlockCoder`의 SEARCH/REPLACE block 파서와 적용 함수다. [diff 형식 구현](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_coder.py#L15-L77). 이것이 Moodcode의 expected SHA와 단일 exact match 편집 계약을 대신할 근거는 아니다. 적용 후 자동 commit, lint, 제안 shell command, 옵션 test가 연결된다(R12). `Linter.lint`는 언어별 사용자 명령·기본 lint 및 오류 주변 tree context를 구성한다. `cmd_test`는 비정상 종료 출력을 모델 문맥으로 돌려준다. [lint dispatch](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/linter.py#L82-L116), [test 결과 피드백](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L993-L1048). 실패 수정은 확인 후 reflection으로 수행한다. **lint 기본 활성·test 기본 비활성**이다. [기본 검사 설정](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L312-L321). 원본에는 lint 전 commit과 lint 후 commit이 모두 있으므로 commit을 검사 통과 증명으로 해석할 수 없다.

6. **권한·취소.** `allowed_to_edit`는 이미 chat에 넣은 파일은 편집 대상으로 허용하고 새 파일·미추가 파일은 확인하며 Git ignore 대상은 건너뛴다(R11). 제안 shell command는 별도 explicit yes 확인을 요구한다. [제안 명령 확인](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2450-L2475). `confirm_ask`의 전역 yes도 explicit-yes-required 질문에는 자동 yes를 주지 않는다. [확인 정책](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L866-L872). Ctrl-C는 전송을 중단하고 중단 표식을 현재 이력에 추가하며, 2초 안에 재입력하면 프로세스를 종료하는 경로다. [중단 이력](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1575-L1583), [Ctrl-C 처리](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L986-L1000). `run_cmd`는 TTY에서 pexpect, 그 밖에서는 subprocess를 선택한다. [명령 backend](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/run_cmd.py#L11-L23). 여기서 Moodcode의 timeout/cancel/process ownership·미확정 효과 복구 수준의 보장이 확인되었다고 주장하지 않는다.

7. **Git·history·storage.** `auto_commit`은 편집 파일 집합과 대화 문맥을 `GitRepo.commit`에 전달하고 성공 hash를 session 집합에 기록한다. 변경 전 dirty 파일을 따로 commit하는 경로도 있다(R15). `GitRepo`는 diff로 메시지를 생성하고 선택 경로 staging·commit 및 author/committer/co-author 설정을 처리한다. [attribution 설정](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L238-L279), [실제 stage·commit](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repo.py#L280-L314). `/undo`는 이번 chat의 Aider commit, 단일 parent, clean 파일, 이전 tree와 origin branch HEAD 상태를 확인한다(R16). origin HEAD와의 동일성 검사를 모든 remote에서의 미공유 증명으로 확대하면 안 된다. 실제 파일 checkout 뒤 soft reset이 이어진다. [undo 적용](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L623-L644). 대화는 Markdown append(R17), 입력은 prompt-toolkit FileHistory, 선택적 LLM 로그는 텍스트 append이며 restore-chat-history가 Markdown을 다시 분리한다. [LLM log](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L754-L765), [대화 복원](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L519-L523). 이 경로를 transaction journal이나 crash-safe provider/tool receipt로 간주하지 않는다.

8. **역할·확장·공급자.** `ArchitectCoder.reply_completed`는 설계 응답을 확인받고 별도 editor model·edit format coder에 보내며 editor의 history와 map을 비우고 shell 제안을 끈다. 비용과 commit 집합을 회수하는 **직렬 두 단계**다(R14). 이것이 병렬·격리 subagent라는 뜻은 아니다. 모델 설정 YAML, LiteLLM metadata JSON5 등록(R19), 고정 coder 종류와 model settings가 주 확장 경계다. 확인한 coding 경로에서는 범용 MCP catalog나 별도 격리 subagent owner 구현을 찾지 못했다. 해당 제품 전체에 없다고 단정하지 않는다.

## 구현 확인·문서 주장·추론의 구분

| 분류 | 판단 |
|---|---|
| 구현 확인 | 위 Coder 호출 경로, stream, repo-map parser/ranking/크기 조정, summary, edit reflection, lint/test, 확인 질문, Git commit/undo guard, 텍스트 이력, architect/editor, 모델 metadata 등록 |
| README 주장 | 거의 모든 cloud/local LLM, 전체 codebase map의 큰 프로젝트 효과, 100+ 언어, IDE comments·voice·images/web pages, 매 변경 lint/test 자동화. [README 기능 설명](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/README.md#L42-L101). 실제 모든 모델/언어/플랫폼의 호환성·품질을 검증하지 않았다. test는 옵션이라는 실제 기본값과 구분한다. |
| 분석자 추론 | 구조 문맥이 반복적인 파일 탐색 비용을 줄일 가능성과 역할별 모델 선택의 비용/품질 효과. 이번에 성능·비용 비교를 실행하지 않았으므로 향상 수치 없음 |
| 미확인 | 실제 모델 출력·원격 오류와 token 비용, GUI·voice·watcher/browser의 완전 흐름, OS별 command cleanup, 외부 parser/서비스 전체 동작, crash recovery 동등성 |

## Moodcode의 기구현 범위와 후보

Moodcode의 [구현 상태](/Users/yakisoba0728/Documents/GitHub/Moodcode/docs/moodcode/implementation-status.md)는 문서 근거이며, 아래는 실제 관련 경로 확인을 추가한 비교다.

| 이미 구현된 Moodcode 기능 | 확인한 실제 경로 | 이번 후보와의 관계 |
|---|---|---|
| bounded ContextPlan·명시적 모델 한도·완전한 tool history·semantic memory | [plan.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/plan.ts:29), [service.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/service.ts:107) | 요약·context 한도를 신규 기능으로 제안하지 않는다. 구조 문맥의 선정 입력만 확장한다. |
| exact edit·hash·preview 승인·일반 도구 오류 피드백 | [edit/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/edit/index.ts:7), [runner/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/index.ts:966) | fuzzy edit 이식이나 별도 무제한 repair loop를 제안하지 않는다. |
| approved command·bounded output·timeout/cancel, LSP 진단·formatter·checkpoint 변경 동기화 | [command/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/command/index.ts:79), [lsp/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/lsp/index.ts:480), [formatters/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/formatters/index.ts:109), [engine.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/engine.ts:380) | 검증의 실행 기반은 이미 있다. 선택된 검사와 결과·수리 종료를 기록하는 계층이 후보다. |
| immutable profile·실제 worktree child·승인된 read-only delegate | [agents/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/agents/index.ts:7), [delegation.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/child-tasks/delegation.ts:51) | subagent나 model switching의 부재를 주장하지 않는다. 선택적 직렬 역할 workflow로 한정한다. |
| Git runner·worktree·child merge·diff·restore journal | [git.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/workspace/git.ts:17), [worktrees/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/worktrees/index.ts:20), [review/index.ts](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/review/index.ts:233) | 자동 커밋이 복구를 대체하지 않는다. 전용 승인형 commit receipt만 후보다. |

- **AIDER-C01 · P1 / M — 심볼 관계 기반 구조 문맥.** 현재 context/history·glob/regex 도구에 host 등록 parser와 hash-bound 심볼 index를 추가하고 요청의 파일·심볼 관련 후보를 읽기 전용으로 투영한다. path/line/hash·선정 사유·누락을 보존하며 기존 ContextPlan 예약 안에서 hard cap을 적용한다. parser 미지원·예산 초과는 기존 검색/파일 목록으로 축소한다. 검증은 참조→정의 선정, 동명이인, ignore, rename/delete·stale hash, 큰 저장소·취소, tool schema/history 예약과 합산한 상한이다. Aider의 query·가중치 상수·15% 허용 정책을 가져오지 않는다(R06–R09).

- **AIDER-C02 · P1 / M — 검증 계획과 제한된 수리 단계.** host/사용자가 검사 identity·plan revision·변경 파일 선택·순서·수리 상한을 정하고 기존 command/LSP 결과를 checkpoint hash와 결속한다. 승인/정책·남은 Run budget 안에서 실패 진단만 다음 모델 경계에 투영하고 동일 hash·진단 반복은 정체로 끝낸다. lint 실패→수리→pass, test 수리 상한, stale diagnostics·외부 수정·deny·취소·잘린 출력·cleanup uncertainty가 false pass 또는 무한 루프가 되지 않는지 검증한다. 이미 구현된 일반 도구 피드백·LSP·formatter를 재구현하지 않는다(R03, R10, R12).

- **AIDER-C03 · P2 / M — 설계→편집 역할 workflow.** 등록된 planner/editor profile revision, model/tool/budget와 단계 Run을 결속한다. 읽기 전용 설계 artifact hash·관측 파일 hash를 저장하고 사용자 선택 후 editor에 bounded 새 입력으로 전달한다. 기존 Build 승인·exact edit·cancel·durable 기록을 유지한다. 역할별 model/context 요청, 권한 확대 차단, stale 설계, 중복 접수·crash·취소를 검증한다. 모델 효율 개선은 실제 평가 전 가설이다(R02, R14, R19).

- **AIDER-C04 · P2 / M — 승인형 Git commit receipt.** preview는 Run/checkpoint·HEAD/index·선택 경로/변경 hash·최종 메시지를 결속하며 실행 직전 재검사한다. 사용자의 staged/unstaged 변경을 자동 baseline commit하거나 같이 stage하지 않는다. 실제 full SHA·parent·선택 변경·검증 결과·attribution을 receipt로 기록하고 uncertain outcome은 복구 전 재시도를 막는다. staged 보존·선택 경로·stale HEAD/index, hook failure·성공 뒤 receipt crash·중복 요청을 독자 fixture로 검증한다. 기존 restore를 유지하고 HEAD reset undo는 이 후보에 넣지 않는다(R12, R15, R16).

위 검증 조건은 **향후 Moodcode 독립 구현을 위한 수용 기준**이며 이번에 실행한 upstream 테스트 결과가 아니다. 정확한 후보 필드·관련 Moodcode 경로는 [evidence JSON](/Users/yakisoba0728/Documents/GitHub/Moodcode/docs/coding-agent-engine-review/aider.evidence.json)에 있다.

## 라이선스·출처와 확인 한계

실제 root `LICENSE.txt`는 **Apache-2.0**이며 package classifier도 Apache로 표시한다(R20). appendix의 copyright는 placeholder 형태이므로 특정 저작권자·연도를 새로 추정하지 않았다. [license appendix](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/LICENSE.txt#L179-L202). Git tracked LICENSE/NOTICE/COPYING 명칭 inventory에서는 root `LICENSE.txt` 하나를 찾았다. 별도 문서·소스 내 credit는 다음과 같이 확인했다.

- [tree-sitter-languages query credits](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/queries/tree-sitter-languages/README.md#L2-L24)는 수정한 query의 원본을 열거하고 대부분 MIT, Elixir Apache-2.0을 명시한다.
- [language-pack query credits](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/queries/tree-sitter-language-pack/README.md#L1-L7)는 query가 외부 저장소에서 파생되었다고 적고 별도 출처 목록을 가리킨다.
- [HCL query 주석](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/queries/tree-sitter-languages/hcl-tags.scm#L1-L3)도 외부 grammar와 Apache-2.0 출처를 명시한다.

root 허가와 query·parser·LiteLLM·GitPython 등 배포 의존성의 고지는 별도다. 이번에 전체 전이 의존성 audit나 법률 검토를 수행하지 않았다. Moodcode에는 upstream source·prompt·tool description·fixture·미디어나 runtime 의존성을 추가하지 않았다. 원본을 읽은 분석이므로 clean-room 절차를 주장하지 않는다. 후속 구현은 위 계약과 독자 fixture에서 시작한다.

실제 모델·서비스·GUI·설치·upstream tests를 실행하지 않았고 원본 checkout을 바꾸지 않았다. 소스에서 확인한 guards는 런타임 성공·완전한 원격 Git 도달 가능성·프로세스 소유권 종료·crash recovery 동등성의 증명이 아니다. 제품 전체 부재를 grep 검색 결과만으로 단정하지 않았다.

## 고정 소스 근거

아래 20개는 JSON과 같은 대표 근거다. 줄 번호는 1부터 시작하며 링크는 모두 full HEAD에 고정했다. 보조 호출·credit 링크는 본문에 추가했다.

| ID | 고정 소스 | 확인한 주장 |
|---|---|---|
| AIDER-R01 | [aider/main.py:973–1007](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/main.py#L973-L1007) | main이 모델·편집 형식·파일 집합·Git·stream·repo map·summary·lint/test 설정으로 Coder.create를 호출한다. |
| AIDER-R02 | [aider/coders/base_coder.py:190–201](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L190-L201) | Coder.create는 coders.__all__ 중 edit_format이 일치하는 구현을 선택하고 미지원 형식은 거절한다. |
| AIDER-R03 | [aider/coders/base_coder.py:924–944](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L924-L944) | run_one은 reflected_message를 다시 보내며 max_reflections를 적용한다. |
| AIDER-R04 | [aider/models.py:985–1037](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/models.py#L985-L1037) | Model.send_completion은 모델별 요청 옵션과 선택적 단일 function tool을 구성하고 LiteLLM completion을 호출한다. |
| AIDER-R05 | [aider/coders/base_coder.py:1900–1959](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1900-L1959) | 스트림의 길이 종료·function delta·reasoning·text를 처리하며 부분 응답과 렌더링 상태를 갱신한다. |
| AIDER-R06 | [aider/coders/base_coder.py:1276–1295](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1276-L1295) | 완료 이력·repo-map·읽기 전용 파일·편집 파일·현재 메시지를 별도 chat chunk로 조립한다. |
| AIDER-R07 | [aider/repomap.py:279–336](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L279-L336) | RepoMap.get_tags_raw는 tree-sitter 언어 parser/query를 사용해 심볼 정의·참조와 위치를 추출한다. |
| AIDER-R08 | [aider/repomap.py:490–545](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L490-L545) | 언급 심볼·현재 chat 파일·참조 빈도로 그래프 가중치를 조절하고 PageRank를 심볼 정의에 분배한다. |
| AIDER-R09 | [aider/repomap.py:666–706](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py#L666-L706) | 랭킹된 tag prefix를 렌더링·토큰 계산하며 이분 탐색으로 repo-map 크기를 조정한다. 목표 대비 15% 근접 허용 조건이 있으므로 strict hard cap과 다르다. |
| AIDER-R10 | [aider/coders/base_coder.py:2269–2336](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2269-L2336) | 편집 파싱·dry-run·파일 권한 확인·적용을 수행하며 형식 오류를 reflected_message로 되돌린다. |
| AIDER-R11 | [aider/coders/base_coder.py:2191–2240](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2191-L2240) | 이미 chat에 추가된 파일은 편집 허용하며 신규·추가되지 않은 파일은 확인하고 Git ignore 파일은 건너뛴다. |
| AIDER-R12 | [aider/coders/base_coder.py:1585–1623](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1585-L1623) | 편집 후 commit·lint·제안 명령·옵션 test를 연결하고 lint/test 실패 수정 여부 확인 후 reflection을 요청한다. |
| AIDER-R13 | [aider/history.py:33–96](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/history.py#L33-L96) | ChatSummary는 오래된 head를 요약하고 assistant 경계로 맞춘 최근 tail을 유지하며 모델 입력과 이력 토큰 상한을 사용한다. |
| AIDER-R14 | [aider/coders/architect_coder.py:11–48](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/architect_coder.py#L11-L48) | ArchitectCoder는 확인된 설계 응답을 별도 editor model/edit format Coder에 보내며 비용과 commit 집합을 회수한다. |
| AIDER-R15 | [aider/coders/base_coder.py:2375–2423](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L2375-L2423) | 자동 커밋은 edited 파일 집합을 GitRepo에 전달하고 commit hash를 session 집합에 기록하며 별도 dirty baseline commit 경로가 있다. |
| AIDER-R16 | [aider/commands.py:570–621](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/commands.py#L570-L621) | undo는 이번 chat의 aider commit·단일 parent·파일 clean 상태·이전 tree·origin branch HEAD 조건을 검사한다. 전체 원격 도달 가능성 증명은 아니다. |
| AIDER-R17 | [aider/io.py:1117–1136](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/io.py#L1117-L1136) | 대화 이력은 Markdown 텍스트 파일 append이며 저장 오류 시 이후 기록을 비활성화한다. |
| AIDER-R18 | [aider/coders/base_coder.py:1456–1491](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py#L1456-L1491) | 모델 호출의 지정 오류는 제한된 지수 대기로 재시도하며 ContextWindowExceeded와 KeyboardInterrupt는 전송 루프를 벗어난다. |
| AIDER-R19 | [aider/models.py:1085–1133](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/models.py#L1085-L1133) | 모델 설정 YAML과 LiteLLM 모델 metadata JSON5 파일을 등록하는 확장 경계가 있다. |
| AIDER-R20 | [LICENSE.txt:1–11](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/LICENSE.txt#L1-L11) | root 실제 LICENSE.txt는 Apache License Version 2.0이다. 별도 SCM query credit는 보고서에 구분한다. |
