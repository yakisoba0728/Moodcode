# Moodcode 내부 엔진 독립 구현안

2026-10-07. **이 문서는 새 제안이며 구현 완료 상태가 아니다.** 앱 개발을 진행하지 않고 `packages/contracts`, `packages/engine`, `apps/engine-harness`에서 검증할 수 있는 엔진을 우선한다. 현재 엔진 `6d9a952`를 기반으로 확장한다.

## 설계 방향

OpenCode에서 확인한 유용한 경계는 영구 입력 접수, 안전한 turn 전환, provider/runner 분리, 메시지 projection, 컨텍스트 버전, 도구 lifecycle다. Moodcode는 이 행동을 자체 명세와 테스트로 구현한다. OpenCode의 두 실행 계층, 프레임워크, DB schema, 프롬프트, fuzzy edit 알고리즘을 그대로 이식하지 않는다.

현재 Moodcode의 durable Run, 정확한 request retry, 원자적인 record/event commit, tool-call 쌍, 변경 전후 hash, approval fingerprint, workspace 독점, process supervision, interrupted/격리 복구는 보존한다. 재구현이 현재 데이터와 검증된 계약을 폐기하는 작업이 되면 안 된다.

## 엔진이 소유할 데이터와 자원

| 단위 | 소유할 정보 | 종료/불변 규칙 |
|---|---|---|
| Session | workspace binding, 공개 이력, 입력 순서, pause 상태 | GUI가 없어도 조회 가능 |
| Input | request ID, payload/config/delivery binding, admission seq, disposition | 같은 요청 exact retry는 같은 receipt; 변경 재사용은 conflict |
| Run | 실제 실행 범위, 입력 연결, budgets, terminal 원인 | 기존 ID·terminal·복구 ledger 유지 |
| Turn | provider/model/config/context 참조, attempt, 정규화 parts, usage, outcome | 한 attempt의 제출·응답·중단 경계를 기록 |
| Tool invocation | call ID, 준비된 input, preview/hash, decision, effect, settlement | 완성된 call만 실행; 중복 자동 실행 금지 |
| Context revision | 원본 cutoff, summary provenance, instructions/model/config hash | 요약 성공·검증 후에만 새 projection 활성화 |
| Artifact | 제한된 출력 원문·diff·checkpoint | 공개 응답에는 참조와 한도, credential/native secret 제외 |
| Workspace scope | 파일/검색/config/watch·extension 자원 | 실행·maintenance lease와 종료 확인을 공유 |

DB writer와 event sequence는 application 범위에 둔다. workspace scope는 파일 위치와 서비스 수명을 담당한다. session scheduler가 실행 순서를 담당하고 provider는 단일 모델 turn, tool adapter는 단일 작업을 담당한다. host는 이들을 구성·중지할 뿐 orchestration을 중복 구현하지 않는다.

## 첫 공개 API 확장

기존 `run.submit`은 즉시 실행을 시도하며 바쁜 workspace에서 `WORKSPACE_BUSY`를 반환하는 의미를 유지한다. 새로운 API는 다음과 같이 별도로 정의한다. 이름과 schema는 implementation 시작 전에 contracts에서 확정한다.

| 제안 command | 결과/동작 |
|---|---|
| `input.accept` | durable `inputId`, `admittedSeq`, `disposition`, 선택적 `runId`; `queue`/`steer`/admit-only 지정 |
| `input.list` | cursor로 pending/promoted/cancelled 입력 조회 |
| `input.cancel` | 아직 승격되지 않은 입력만 취소, exact retry |
| `session.resume` | 의도적인 실행 재개; receipt와 completion 구분 |
| `session.pause` | 새 promotion 중지; 현재 작업 취소 여부는 명시적 옵션 |
| `run.getTurns` | turn/parts/usage를 제한된 페이지로 조회 |
| `question.decide` | 정확한 question ID/version에 대한 구조화 답변 |

pending input을 기존 active Run 상태에 억지로 넣지 않는다. 기존 DB의 `one_active_run_per_workspace`와 충돌하지 않도록, queue 입력은 promotion 시 Run을 만든다. 기존 API는 새 admission/scheduler를 호출하는 호환 adapter로 옮기되 기존 receipt, terminal, 승인·복원 동작은 유지한다. `schemaVersion=1` 계약이 바뀌는 부분은 새 command/capability와 명시적 버전 협상으로 노출한다.

### 입력 처리 규칙

1. 입력과 admission event를 하나의 DB transaction으로 저장한 뒤 실행 wake를 보낸다. wake 실패가 접수된 입력을 삭제하지 않는다.
2. active session의 steer는 provider turn과 현재 effectful 도구들의 settlement가 끝난 경계에서 반영한다. 현재 stream이나 실행 중 명령의 입력을 바꾸지 않는다.
3. queue는 현재 작업이 더 이상 continuation을 필요로 하지 않을 때 한 입력씩 승격한다. 같은 session에서는 admission 순서를 보존한다.
4. 같은 workspace의 다른 session은 lease 획득 전까지 대기한다. 저장소를 공유하는 effectful 실행의 병렬화는 worktree 격리 이후에 도입한다.
5. steer로 현재 과업의 선택된 agent turn allowance를 갱신할 수 있어도 Run 전체 시간·호출·출력 한도는 자동으로 무제한 초기화하지 않는다.
6. `run.cancel` 이후 새 queue가 즉시 모델 작업을 시작하지 않도록 해당 session의 자동 promotion을 pause한다. 남은 입력은 사용자가 resume 또는 개별 취소할 수 있다.
7. crash 또는 effects-uncertain이면 실행과 promotion을 중지한다. 저장된 입력을 보여주되 provider/command를 자동 재실행하지 않는다.

pending 입력 개수·합계 bytes·steer batch 크기와 읽기 도구 동시 실행 수에도 상한을 둔다. 초과 입력은 저장 전에 명확한 오류를 반환한다. session 사이의 공정성을 scheduler 계약에 넣어 한 session의 반복 steer가 다른 대기 session을 계속 굶기지 않도록 한다.

admission은 실행 허가와 별개다. 격리된 workspace에 대해 접수까지 허용할지 여부를 contracts에서 정하되, 접수된다면 paused/quarantined disposition을 명시하고 자동 실행은 막는다. 권장 기본은 pending 접수와 실행 차단을 구분하는 것이다.

## Turn과 event 기록

지금 provider 이벤트는 text delta, complete tool call, input/output usage, finish가 중심이다. 다음에는 text/reasoning part, tool argument accumulation, provider usage detail, retryable/overflow 오류 분류, finish cause를 추가한다. native encrypted replay는 도구/UI의 실행 입력과 분리해 보관한다.

모든 token delta마다 새 전체 message JSON을 다시 쓰는 방식은 피한다. turn/part identity를 영구 기록하고 bounded batch로 delta를 flush한다. flush되지 않은 범위와 확정된 범위를 구분한다. terminal·tool settlement처럼 행동이 이어지는 경계는 즉시 transaction으로 기록한다. 구독자는 commit된 session seq를 cursor로 다시 받을 수 있어야 한다.

provider attempt의 재시도는 무조건적인 요청 반복이 아니다. 인증 실패/invalid request, provider rate-limit/연결 실패, overflow, 이미 출력이 나온 뒤의 중단을 구분한다. 재시도가 가능한 것으로 확인된 경계에서도 횟수·시간·budget을 제한한다. 응답 유실이나 tool effect 미확정 상태에서 exactly-once 외부 효과를 보장한다고 주장하지 않는다.

## 긴 대화와 모델 입력

`getHistory`의 GUI paging과 모델 입력 projection을 분리한다. 지금 runner는 `getSnapshot()` 전체를 가져온 뒤 context를 줄인다. 새 model-history query는 DB에서 필요한 최근 교환과 summary cutoff를 읽어, 큰 session을 매 turn 전체 역직렬화하지 않아야 한다.

모델 metadata에는 지원 입력, context/output 한도, reasoning 설정, cache/usage capability와 출처·갱신 시각을 기록한다. 기존 byte hard cap은 유지한다. token estimate와 provider의 실제 usage를 다른 필드로 표시하고, 정보가 없으면 unknown으로 남긴다.

의미 요약은 원본 메시지를 수정하지 않는 versioned record로 만든다. 최소 정보는 원래 목표, 현재 요구와 결정, 검증된 변경·검증 결과, 미완료 작업, 실패·복구 상태, 관련 파일 참조다. 과거 모델 주장과 현재 확인된 파일 상태를 구분한다. 요약이 실패·취소·한도 초과이면 기존 context revision을 유지한다.

tool-call/result 쌍과 진행 중 exchange를 통째로 보존한다. provider/model이 바뀌면 이전 opaque replay를 무조건 새 모델에 넣지 않고 해당 adapter의 호환성 규칙으로 재투영한다. overflow 대응은 새 요약과 더 작은 projection으로 정해진 횟수만 재시도한다. 요약 요청도 Run budget과 취소 범위에 포함한다.

## 도구와 권한

현재 `prepare→fingerprint preview→approval→execute→checkpoint/result→settlement` 경계를 공통 tool runtime 계약으로 정리한다. tool 출력은 `data`, `display`, `artifact`, `truncation`, `warnings`를 구분하고 모델 입력과 조회 화면이 각각 제한된 projection을 사용한다.

첫 추가 파일 편집은 exact match/expected hash를 기준으로 설계한다. line ending/BOM·mode 보존과 rename/delete, 여러 파일 적용 실패의 부분 결과를 명시한다. fuzzy matching이나 모델 기반 edit correction은 별도 품질 검증 후 도입한다. 사용자에게 preview한 입력이 변경되거나 현재 파일 hash가 달라지면 기존 승인을 재사용하지 않는다.

question은 approval과 별개다. 사용자의 요구 보충은 structured answer, 파일·명령 실행 동의는 exact effect approval로 기록한다. 둘 다 pending 상태에서 취소·종료·재시작 시 처리 결과가 명확해야 한다.

scope permission은 path/command/기간과 policy version을 기록하고 **정확한 prepared request binding 위에** 추가한다. plugin·MCP 도구도 같은 prepare/approval/timeout/output/settlement를 거친다. 도구 정의를 숨기는 것만으로 실행 권한을 보장하지 않는다.

## 단계와 완료 조건

| 단계 | 실제 구현 범위 | headless 완료 조건 |
|---|---|---|
| E0 계약·데이터 호환 | 새 input/turn/context/event 명세, DB migration, 이전 API adapter | 기존 schema/DB/session·approval·review/recovery fixture 보존; future schema 거부; 실패 migration rollback |
| E1 입력·scheduler | pending inbox, queue/steer, pause/resume, workspace lease 대기 | exact retry/conflict, admission 뒤 wake 실패, 경계 승격, cancel 뒤 자동 실행 없음, 다중 session 공정성 |
| E2 turn/part·event | durable attempt/part/outcome, richer usage, 제한된 flush·paging | tool args 완료 전 실행 없음, cursor 재연결, crash-before/after-commit 정합성, provider 종료 후 delta 거부 |
| E3 model context | metadata, bounded DB query, provenance summary, token/byte budgets | 오래된 대화에서 최근 exchange·지침 유지, 요약 실패 시 경계 보존, model switch replay, overflow 제한 |
| E4 tool runtime | 공통 구조화 결과, exact edit, question, policy scope, skill/reference | stale preview/hash 거부, denied/cancelled question, 부분 편집 보고, 출력·artifact·timeout·cleanup 한도 |
| E5 backend 확장 | MCP lifecycle, scoped plugins, PTY, worktree·child task, LSP adapter | extension 종료/중단/권한 전파; terminal 실제 종료 확인; 격리된 child task 수명·취소·합계 budget |
| E6 실제 과업 검증 | 임시 저장소의 대표 코딩 과업과 장애·장기 성능 검증 | 정확한 diff와 검사 결과, 실패 원인, tool 횟수/시간/usage/메모리 기록; 사람이 확인할 결과 |

E1과 E2는 같은 admission/run/turn schema에 의존하므로 E0 계약을 먼저 고정한다. 이후 DB/실행, provider/events, context, tool policy를 파일 소유권 단위로 병렬 구현할 수 있다. root integration이 계약·migration·종료와 복구를 합친다. GUI 변경은 이 단계의 완료 조건에 넣지 않는다.

E5 전체를 기다려야 기본 엔진을 사용할 수 있는 것은 아니다. E0~E4를 먼저 끝내면 장기 session·실행 중 입력·질문·편집을 갖춘 자체 엔진이 된다. 기본 실제 과업 검증은 이 단계에서도 수행하고, 이후 MCP/PTY/child task가 추가될 때 확장한다.

## 필요한 검증 사례

- 입력: 같은 request의 재전송/내용·delivery 변경, DB commit 직후 wake 유실, admission 중 close, 여러 queue와 steer 혼합, 바쁜 workspace의 다른 session.
- 모델: fragmented tool JSON, duplicate call ID, finish 이후 content, 429/인증 실패, 출력 전/후 연결 중단, overflow, 모델 변경 시 replay 호환, 누락 usage.
- 도구: approval 대기 중 취소, 승인 이후 prepare fingerprint 변경, 명령의 child process 종료 지연, output 한도, 효과 미확정 뒤 새 queue 차단.
- 컨텍스트: 1천/1만/10만 message의 DB 읽기량·시간·메모리, summary 실패·취소, 오래된 지침과 새 요청, tool-call/result pair 유지.
- 재시작: input-only, turn-started, effect-running, settlement-committed, review-interrupted 각 시점의 기록과 격리. 자동 provider/tool 재실행 0.
- 확장: scoped 등록/해제, 도구 이름 충돌, pending MCP disconnect, child task/PTY의 부모 종료와 budget·권한 전파.

테스트는 자체 계약에서 만든 fixture를 사용한다. OpenCode 테스트를 이름이나 문법만 바꿔 복사하지 않는다. 실제 모델 검증은 임시 repository·고정 과업으로 별도 수행하고 비용·실패를 포함한 결과를 기록한다.

## 첫 구현 착수 범위

첫 구현 묶음은 **E0 계약과 migration, E1 durable input/scheduler, E2 turn/parts의 최소 저장 경계**다. provider와 파일 효과가 일어나는 경계부터 정한 뒤 컨텍스트 압축과 확장 도구를 더한다. 기존 기능을 동시에 두 엔진으로 오래 운영하기보다 호환 adapter를 통해 하나의 Moodcode runner로 수렴한다.

근거: [실행 분석](./01-execution-state.md), [모델·컨텍스트 분석](./02-model-context.md), [도구·권한 분석](./03-tools-permissions.md), [현재 자체 엔진 계약](../moodcode/engine-spec.md), [라이선스·출처 기준](./05-license-and-provenance.md).
