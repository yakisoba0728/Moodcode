# Moodcode 엔진 구현 TODO

갱신일: 2026-10-07, Asia/Seoul. 기준 구현: `6d9a952`, 분석·구현안: `77e16e2`. 사용자가 확정한 순서는 **자체 엔진을 먼저 구현하고 이후 Electron GUI에 연결**하는 것이다.

상태: 자체 엔진의 inbox·실행·provider·context·도구·MCP·PTY·저장 확장을 병렬 구현하고 headless 통합 검증을 통과했다. 남은 확장의 실제 연결과 운영 검증을 병렬로 진행한다. 이 파일을 구현 진행 상태의 기준으로 사용한다.

## 작업 규칙

- `[ ]`는 미완료, `[x]`는 해당 완료 조건과 필요한 검증을 만족한 항목이다. 착수한 항목은 별도로 아래 `진행 중`에 기록한다. blocked 항목은 원인과 해제 조건을 해당 항목 아래에 남긴다.
- 항목 ID는 유지한다. 범위를 나누면 하위 ID를 추가하고, 순서를 바꾸면 선행 조건도 함께 갱신한다. 같은 기능을 여러 문서에서 따로 완료 처리하지 않는다.
- 선행 계약을 합의한 작업은 파일 담당 범위를 나누어 병렬 구현한다. 통합·검증·검토·커밋은 검증 가능한 변경 단위로 진행하고, 완료 항목에 검증 명령·보고서와 커밋을 연결한다. 설계 문서나 독립 모듈 작성만으로 연결되지 않은 실행 기능을 완료 처리하지 않는다.
- OpenCode에서 확인한 동작을 Moodcode 계약과 자체 fixture로 구현한다. 원본 코드·프롬프트·도구 설명·테스트를 이름만 바꿔 가져오지 않는다. 실제 외부 코드 재사용이 필요하면 출처와 고지를 별도로 기록한다.
- 각 단계는 headless engine/harness로 검증한다. 기본 회귀는 fixture를 사용하고, 실제 계정 요청은 명시적으로 분리한다. GUI·서명·앱 업데이트는 이 목록의 구현 범위에 넣지 않는다.

진행 중: **E3-11, E4-12, E5-10~12, E6-06~07**. **새 구현 완료 64/75**. E0-01~04는 [첫 통합 기록](docs/moodcode/engine-foundation-verification.md), 이후 완료 항목은 [native 통합 검증](docs/moodcode/engine-native-verification.md)을 따른다. 테스트로 개별 완료 조건을 확인한 독립 확장은 순차 선행 조건과 병렬로 완료 처리했으며, 연결되지 않은 child/LSP 기능은 미완료로 유지한다. 담당 범위는 [병렬 엔진 구현](docs/moodcode/engine-implementation-waves.md)에 기록한다.

## 유지하고 회귀 검증할 기반

| 현재 구현 | 보존할 계약 | 근거 |
|---|---|---|
| SQLite·영구 Run | record/event 원자 commit, terminal 불변, DB owner, request 중복·충돌 | [storage](packages/engine/src/storage/index.ts) |
| 실행·예산 | 같은 workspace의 effectful 실행 독점, 시간·호출·출력 상한, 종료 정산 | [runner](packages/engine/src/runner/index.ts) |
| provider·대화 | 한 turn 통신, 완성된 tool call, tool-call/result 쌍, bounded replay | [ports](packages/engine/src/ports.ts), [Responses](packages/engine/src/provider/responses.ts) |
| 승인·파일 변경 | preview/fingerprint·현재 hash 검증, 변경 전후 checkpoint·부분 실패 기록 | [permission](packages/engine/src/permission/index.ts), [patch](packages/engine/src/tools/patch/index.ts) |
| 명령·취소·복구 | supervisor·effect marker, 종료 미확정 격리, 재시작 후 자동 효과 재실행 금지 | [command](packages/engine/src/tools/command/index.ts), [recovery](packages/engine/src/recovery/index.ts) |
| 변경 복원 | 현재 파일 충돌 검사, maintenance lease, review journal·복구 ledger binding | [review](packages/engine/src/review/index.ts), [audit](packages/engine/src/review/audit.ts) |

이 표는 현재 소스와 이전 검증 기록을 요약한다. 이번 TODO 작성에서 테스트를 재실행했다는 뜻은 아니다. 현재 기능과 한계는 [구현 상태](docs/moodcode/implementation-status.md)를 따른다.

## 구현 순서

| 단계 | 항목 수 | 목적 | 완료 시 동작 |
|---|---:|---|---|
| E0 | 8 | 계약·호환·구조 정리 | 새 기능을 기존 기록과 API를 보존하며 추가할 기반 |
| E1 | 11 | 입력·scheduler 재구현 | queue/steer, pause/resume, 안전한 승격 |
| E2 | 11 | turn·parts·provider 개선 | 모델 attempt/응답/도구를 명확하게 기록·조회 |
| E3 | 12 | 긴 대화·컨텍스트 개선 | bounded history, 모델 예산, 출처 있는 의미 요약 |
| E4 | 12 | 도구·권한·질문 개선 | exact edit, 등록 수명, scope 정책, 구조화 질문·결과 |
| E5 | 13 | 엔진 확장 | MCP·PTY·격리된 child task·LSP·OS backend |
| E6 | 8 | 품질·운영 검증 | 실제 과업, 성능·장애 검증, 복구·CI·명세 정리 |

E0→E1→E2→E3→E4를 우선한다. E4 완료 뒤 E6-01~E6-04로 기본 엔진 품질을 먼저 확인하고 E5를 확장한다. 검증은 모든 구현 항목의 완료 조건이며 E6까지 미루지 않는다. E5는 의존성이 맞는 작은 기능부터 선택할 수 있다.

## E0 — 계약·기존 데이터 호환

주요 경로: [contracts](packages/contracts/src/index.ts), [validation](packages/contracts/src/validation.ts), [ports](packages/engine/src/ports.ts), [storage](packages/engine/src/storage/index.ts), [engine](packages/engine/src/engine.ts). 이번 단계에서는 새 schema와 책임 경계를 먼저 고정한다.

- [x] **E0-01 — Input·Run·Turn·Part·ContextRevision 계약 확정** `[신규 계약]`
  선행: 없음. 완료: 내부 ID와 provider call ID, 입력 상태·Run binding, Run 생성 전 입력 이벤트의 owner/sequence, attempt/terminal·불확실 상태를 정의하고 자체 contract fixture로 확인한다.
- [x] **E0-02 — 공개 API·event 버전 호환 확정** `[개선]`
  선행: E0-01. 완료: 기존 `run.submit` receipt와 busy 의미를 유지하고, 새 commands·capabilities·v1 consumer projection·unknown version 거부를 명시한다.
- [x] **E0-03 — 순차 DB migration 체계 정리** `[개선]`
  선행: E0-02. 완료: 현재 DB v1을 fixture로 유지하고 schema 변경별 migration, 실패 rollback, future DB 거부, 기존 owner·backup 동작을 검증한다. 새 테이블은 각 기능 단계에서 추가한다.
- [x] **E0-04 — 기존 기록·복구 호환 fixture 고정** `[보존·검증]`
  선행: E0-03. 완료: 기존 Run/message/tool/approval/checkpoint·review·ledger를 새 코드로 읽고 terminal과 복원 binding·미확정 격리가 유지되는 것을 확인한다.
- [x] **E0-05 — 엔진 책임과 ports 분리** `[재구성]`
  선행: E0-04. 완료: admission, scheduler, turn executor, context projection, tool runtime, workspace scope의 경계를 정리하고 현재 coding loop의 관찰 가능한 결과를 보존한다.
- [x] **E0-06 — 설정·budget 의미 통일** `[개선]`
  선행: E0-05. 완료: turn allowance와 Run 전체 상한, pending 수/bytes·steer batch·retry·요약 예산을 구분하고 config 병합·runtime 입력 검증을 연결한다.
- [x] **E0-07 — artifact·checkpoint의 저장 계약 확정** `[개선]`
  선행: E0-05. 완료: 참조 identity/hash·producer/model/artifact 상한·retention·부분 결과를 정의하고 기존 review/checkpoint가 새 turn과 연결되는 규칙을 고정한다.
- [x] **E0-08 — 엔진 전용 검증 명령과 첫 회귀 통과** `[개선·검증]`
  선행: E0-06, E0-07. 완료: contracts/engine/harness를 앱 실행 없이 검증하는 entrypoint를 만들고 기존 접수→모델→승인→명령→완료·취소·복구 경로를 통과한다.

## E1 — 영구 입력과 session scheduler

주요 경로: storage, runner의 새 admission/scheduler 경계, contracts, engine dispatch, [JSONL protocol](apps/engine-harness/src/protocol.ts).

- [x] **E1-01 — pending inbox와 session pause 저장** `[신규]`
  선행: E0-08. 완료: 입력 접수와 실행을 분리하는 migration을 적용한다. pending 입력은 active Run/user transcript로 잘못 표시되지 않고 상태·순서가 재시작 후 조회된다.
- [x] **E1-02 — `input.accept`와 exact retry 구현** `[신규]`
  선행: E1-01. 완료: payload/config/delivery identity, receipt, conflict, 동시 중복 접수, commit 후 wake 실패를 검증한다. 접수 event는 입력과 같은 transaction에 기록한다.
- [x] **E1-03 — 입력 조회·취소·backlog 상한 구현** `[신규]`
  선행: E1-02. 완료: `input.list` cursor와 pending cancel, 개수·bytes 한도, 이미 승격된 입력의 취소 거부, 다른 session cursor 거부를 검증한다.
- [x] **E1-04 — session별 실행 소유·wake 병합 구현** `[재구현]`
  선행: E1-03. 완료: 같은 session resume은 동일 실행을 join하고 중복 wake는 중복 provider 작업을 만들지 않는다. workspace effect lease와 maintenance를 함께 검사한다.
- [x] **E1-05 — queue의 FIFO 승격 구현** `[신규]`
  선행: E1-04. 완료: continuation 종료 경계에서 queue 한 개만 새 Run에 연결하고, 입력 승격·사용자 message·event를 원자 기록한다.
- [x] **E1-06 — steer의 안전 경계 반영 구현** `[신규]`
  선행: E1-05. 완료: admission cutoff와 제한된 batch를 적용하고 provider stream/도구/승인 대기 중 입력을 바꾸지 않는다. 다음 turn에만 반영한다.
- [x] **E1-07 — pause/resume와 cancel 의미 구현** `[신규·개선]`
  선행: E1-06. 완료: `session.pause/resume`을 기록한다. Run cancel 후 같은 session의 queue가 자동 실행되지 않고, 대기 입력은 유지·조회·개별 취소된다.
- [x] **E1-08 — workspace 간·session 간 공정성 구현** `[개선]`
  선행: E1-07. 완료: 같은 workspace의 다른 session은 순서 있는 lease 대기를 사용하고, 다른 workspace는 독립 실행한다. 반복 steer가 다른 session을 무한 대기시키지 않는다.
- [x] **E1-09 — 기존 `run.submit` 호환 adapter 구현** `[보존·재구현]`
  선행: E1-08. 완료: 이전 API의 즉시 실행·busy·중복 receipt 결과를 새 admission/scheduler 위에서 보존하고 기존 승인·복원 클라이언트 fixture를 통과한다.
- [x] **E1-10 — inbox 재시작·격리 처리 구현** `[개선]`
  선행: E1-09. 완료: pending/promoted 입력과 interrupted Run을 구분하고, crash·effects-uncertain에서는 자동 promotion/provider/tool 재실행 없이 명시적 resume/복구를 요구한다.
- [x] **E1-11 — JSONL 입력 처리 통합 검증** `[연결·검증]`
  선행: E1-10. 완료: 앱 없이 queue/steer/승인/cancel/resume과 두 session 경합을 재현하고 접수·승격·완료 event 및 DB 기록이 일치한다.

## E2 — 모델 turn·parts·provider

주요 경로: runner, storage, ports, [provider](packages/engine/src/provider/index.ts), [replay](packages/engine/src/provider/replay.ts), contracts.

- [x] **E2-01 — durable Turn·Attempt 저장 구현** `[신규]`
  선행: E1-11. 완료: migration과 dispatch/started/finished/failed/interrupted 경계를 저장하고 input/run/model/config/context 참조를 연결한다. 출력 전후 crash를 구분한다.
- [x] **E2-02 — text/reasoning/tool/media Part 계약 구현** `[신규]`
  선행: E2-01. 완료: 순서·ID·완료 상태를 갖는 parts와 기존 flat content projection을 구현한다. 공개 reasoning와 opaque replay를 분리한다.
- [x] **E2-03 — tool call ID와 정산 경계 구현** `[개선]`
  선행: E2-02. 완료: 내부 invocation ID와 `(turn, providerCallId)`를 매핑한다. 같은 turn 중복은 거부하고 효과 전에 durable proposal을 기록한다.
- [x] **E2-04 — provider event·failure 정규화 확장** `[개선]`
  선행: E2-03. 완료: fragmented input, complete call, usage breakdown, finish 원인, overflow/retryability를 정규화하고 malformed·finish 이후 content를 거부한다.
- [x] **E2-05 — replay의 모델·protocol 호환 구현** `[개선]`
  선행: E2-04. 완료: provider/model/protocol/version binding과 크기 상한을 적용하고 같은 모델 round-trip·모델 변경·미지원 replay를 자체 fixture로 검증한다.
- [x] **E2-06 — delta flush·구독 backpressure 개선** `[개선]`
  선행: E2-05. 완료: bounded batch로 기록하고 commit된 seq와 미확정 fragments를 구분한다. terminal/tool settlement는 즉시 확정하며 느린 구독자가 실행을 막지 않는다.
- [x] **E2-07 — turn·part·event 조회 paging 구현** `[신규]`
  선행: E2-06. 완료: `run.getTurns` 및 parts/artifact 상세 조회를 제한된 cursor로 제공하고 기존 snapshot/events 소비자와 새 조회를 구분한다.
- [x] **E2-08 — 제한된 읽기 도구 병렬 실행 구현** `[개선]`
  선행: E2-07. 완료: effect class가 선언된 읽기 작업만 상한 안에서 병렬 실행하고 모든 outcome 정산 전 다음 turn을 시작하지 않는다. patch/command는 직렬 효과 정책을 유지한다.
- [x] **E2-09 — request·inactivity·Run timeout 정리** `[개선]`
  선행: E2-08. 완료: header/무응답/전체 요청/전체 Run 예산을 구분하고 timeout→abort→tool cleanup→terminal 원인을 검증한다.
- [x] **E2-10 — commit 경계의 provider retry 구현** `[신규]`
  선행: E2-09. 완료: 출력·효과 확정 전의 허용된 실패만 제한 재시도한다. Retry-After·backoff·cancel·총 예산을 적용하고 ambiguous dispatch는 자동 반복하지 않는다.
- [x] **E2-11 — usage·attempt·요약 accounting 기반 구현** `[개선]`
  선행: E2-10. 완료: input/output inclusive totals와 cache/reasoning breakdown·누락 값·retry usage를 구분하고 향후 요약 요청도 같은 accounting으로 연결한다.

## E3 — 모델 입력·긴 대화·기억

주요 경로: [context](packages/engine/src/context/index.ts), [memory](packages/engine/src/context/memory.ts), storage의 모델 이력 query, provider metadata, config.

- [x] **E3-01 — ModelSpec·capability metadata 구현** `[신규]`
  선행: E2-11. 완료: context/output·modalities·tool/reasoning/replay 한도와 정보 출처·시각을 저장하고 unknown을 임의 숫자로 채우지 않는다.
- [x] **E3-02 — bounded model-history DB query 구현** `[개선]`
  선행: E3-01. 완료: 최근 완전한 교환과 context cutoff를 SQL에서 읽고 runner의 전체 `getSnapshot()` hot path를 줄인다. 오래된 메시지 증가에 따른 읽기량을 측정한다.
- [x] **E3-03 — ContextPlan과 포함·생략 근거 구현** `[재구현]`
  선행: E3-02. 완료: 선택 message 범위, instructions/tools reserve, byte/token 추정·출처를 구조화 결과로 반환하고 최신 요청과 tool 쌍을 보존한다.
- [x] **E3-04 — nested 지침 발견·우선순위 개선** `[신규·개선]`
  선행: E3-03. 완료: root/nested AGENTS·사용자 지침을 위치와 provenance로 구분하고 읽기 실패·삭제·일시 unavailable을 다르게 처리한다.
- [x] **E3-05 — ContextRevision·source 변경 기록 구현** `[신규]`
  선행: E3-04. 완료: source identity/hash와 model/agent/config 변경을 저장하고 다음 안전 turn 경계에서 갱신한다. 관찰 실패가 기존 유효 baseline을 지우지 않는다.
- [x] **E3-06 — token·byte·output 예산 통합 구현** `[개선]`
  선행: E3-05. 완료: 기존 byte hard cap과 모델 window/output reserve를 함께 검사하며 추정 tokens와 실제 usage를 구분한다. 현재 exchange가 안 맞으면 명확히 실패한다.
- [x] **E3-07 — semantic memory checkpoint 저장 구현** `[신규]`
  선행: E3-06. 완료: migration으로 원본 범위/cutoff·summary 버전·생성 모델·usage·성공 상태를 저장하고 원본 transcript/replay를 변경하지 않는다.
- [x] **E3-08 — tools 없는 의미 요약 실행 구현** `[신규]`
  선행: E3-07. 완료: Moodcode 자체 요약 지침으로 목표·결정·검증·미완료 작업을 정리한다. summary 호출도 Run 예산·취소·accounting에 포함한다.
- [x] **E3-09 — 검증된 요약만 활성화 구현** `[신규]`
  선행: E3-08. 완료: 빈 요약·불완전 finish·실패·취소에는 이전 revision을 유지하고, 성공 시 recent exchange와 출처를 함께 투영한다.
- [x] **E3-10 — overflow 한 번 복구 구현** `[신규]`
  선행: E3-09. 완료: 출력·tool effect 시작 전 논리 turn에서 1회만 요약 후 request를 재구성하고 두 번째 overflow와 출력 후 실패는 반복하지 않는다.
- [ ] **E3-11 — 큰 tool history의 artifact 투영 개선** `[개선]`
  선행: E3-10. 완료: 이전 결과를 bounded 구조화 요약/참조로 표현하며 active call/result 쌍, warnings와 미완료 작업 정보를 유지한다.
- [x] **E3-12 — 이력 검색·context 진단 구현** `[신규]`
  선행: E3-11. 완료: 원본 이력 검색과 context provenance를 제한된 query로 조회한다. summary가 현재 파일 상태의 증거인 것처럼 표시되지 않는다.

## E4 — 도구·권한·질문

주요 경로: tools, permission, workspace observer, artifact store, context의 skill/reference producers.

- [x] **E4-01 — 공통 ToolRuntime lifecycle 구현** `[재구성]`
  선행: E3-12. 완료: prepare→policy/승인→execute→checkpoint/result→settlement를 공통화하고 현재 hash/fingerprint·cleanup 계약을 보존한다.
- [x] **E4-02 — structured result·artifact 경계 개선** `[개선]`
  선행: E4-01. 완료: data/display/model projection/artifact/truncation/warnings를 분리하고 producer·저장·모델 출력 상한을 각각 적용한다.
- [x] **E4-03 — scoped tool 등록·version identity 구현** `[신규]`
  선행: E4-02. 완료: 중복 이름·overlay·scope 해제와 등록 identity를 관리한다. 모델에 광고한 handler가 교체·해제되면 stale call을 거부한다.
- [x] **E4-04 — expectedHash 기반 exact edit 구현** `[신규]`
  선행: E4-03. 완료: 정확한 span/oldString 교체와 모호한 match 거부, BOM/CRLF 보존, stale hash·동시 외부 편집을 검증하고 기존 patch checkpoint에 연결한다.
- [x] **E4-05 — rename/delete·파일 속성 계약 개선** `[개선]`
  선행: E4-04. 완료: 현재 지원 범위를 명시하고 지원하는 변경의 preview·hash·mode/line ending·부분 결과를 기록한다. 미지원 binary/directory 효과를 성공으로 표시하지 않는다.
- [x] **E4-06 — bounded glob·regex search 구현** `[신규]`
  선행: E4-05. 완료: Git ignore·scan/결과/시간 상한·continuation을 적용하고 잘린 결과와 완전한 결과를 구분한다. regex 실행도 무제한 탐색을 허용하지 않는다.
- [x] **E4-07 — action/resource permission policy 구현** `[신규]`
  선행: E4-06. 완료: configured deny 우선, Plan/Build·agent policy, 도구 effect class를 통합하고 catalog 숨김과 실제 실행 권한을 분리한다.
- [x] **E4-08 — scope 허용 저장·철회 구현** `[신규]`
  선행: E4-07. 완료: path/command/기간·policy version과 허용 범위를 저장·조회·철회하고 prepared request 재검증을 생략하지 않는다.
- [x] **E4-09 — durable question·답변 lifecycle 구현** `[신규]`
  선행: E4-08. 완료: question ID/version/session/run/call binding, 선택·자유 답변·reject·expiry를 기록한다. 취소/재시작 후 stale 답변은 실행을 재개하지 않는다.
- [x] **E4-10 — agent profile과 mode 분리 구현** `[신규·개선]`
  선행: E4-09. 완료: 도구 정책·모델/추론 설정·지침·turn allowance를 갖는 profile을 만들고 mode와 별도로 관리한다. 전환은 안전 경계에 반영한다.
- [x] **E4-11 — skill/reference·session TODO 도구 구현** `[신규]`
  선행: E4-10. 완료: 로컬 skill/reference discovery·bounded context injection과 session task 상태 저장/조회 도구를 구현한다. 대기 입력·실행 결과·사용자 승인과 혼동하지 않는다.
- [ ] **E4-12 — 파일 변경 이벤트·observer/review 연계 구현** `[개선]`
  선행: E4-11. 완료: 내부 도구와 외부 편집의 변경 관찰을 하나의 workspace 변경 계약으로 연결하고 중복·늦은 이벤트·다음 turn 재읽기를 검증한다.

## E5 — 엔진 확장과 실행 backend

E5는 코딩 loop 기반을 만든 뒤 순서대로 확장한다. 초기 검증·품질 개선인 E6-01~E6-04를 함께 진행한다. 웹/데스크톱 화면은 별도 후속 목록으로 관리한다.

- [x] **E5-01 — 외부 도구·plugin scope port 구현** `[신규]`
  선행: E4-12. 완료: 등록/해제·취소·budget·권한·출력과 workspace 자원 수명을 정의하고 로컬 test plugin으로 teardown을 검증한다.
- [x] **E5-02 — MCP 연결 lifecycle 구현** `[신규]`
  선행: E5-01. 완료: stdio/지원 remote transport의 시작·실패·disconnect·abort·종료를 분리하고 coding loop에 직접 orchestration을 넣지 않는다.
- [x] **E5-03 — MCP tools/resources·catalog 갱신 구현** `[신규]`
  선행: E5-02. 완료: schema 검증·permission·structured output·stale registration·bounded resource를 공통 ToolRuntime으로 연결한다.
- [x] **E5-04 — 외부 provider/MCP credential port 구현** `[신규]`
  선행: E5-03. 완료: host가 주입한 credential과 갱신 결과를 reference로 다루며 renderer/journal/command 환경에 원문을 전달하지 않는다. 외부 인증 UI는 별도 범위다.
- [x] **E5-05 — host 명령과 sandbox backend 경계 확정** `[개선]`
  선행: E4-12. 완료: 사용자 권한으로 실행되는 현재 shell의 범위와 파일/네트워크 제한을 제공하는 격리 backend의 capability를 구분하고 지원하지 않는 격리는 명확히 반환한다.
- [x] **E5-06 — PTY create/attach/write/resize/replay 구현** `[신규]`
  선행: E5-05. 완료: user terminal과 모델 명령의 authority·owner를 나누고 output cursor·buffer/terminal 개수 상한·attach 수명을 검증한다.
- [x] **E5-07 — PTY cancel·재시작·종료 처리 구현** `[신규]`
  선행: E5-06. 완료: 부모 종료·분리·process group 정리를 실제 OS에서 확인한다. 저장된 terminal 기록이 살아 있는 프로세스의 증거가 되지 않도록 한다.
- [ ] **E5-08 — Windows process-tree backend 구현** `[신규]`
  선행: E5-05. 완료: Job Object 등 실제 소유·종료 확인 backend와 기존 process port를 연결하고 Windows에서 child tree·timeout·crash를 검증한다.
- [x] **E5-09 — worktree lifecycle 구현** `[신규]`
  선행: E4-12. 완료: create/boot/ready/failure/cleanup을 durable 상태로 기록하고 기존 사용자 수정·branch/path를 보존한다. Git 준비 완료와 실행 완료를 구분한다.
- [ ] **E5-10 — child task·cancel·budget 상속 구현** `[신규]`
  선행: E5-09. 완료: parent/child depth·도구 권한·전체 budget·격리 workspace·부모 취소를 정의하고 detached 작업의 소유권을 명시한다.
- [ ] **E5-11 — child 결과 전달·변경 통합 구현** `[신규]`
  선행: E5-10. 완료: task 결과 입력의 중복 방지와 변경 충돌·preview·검증을 처리한다. 효과·merge를 자동 성공으로 간주하지 않는다.
- [ ] **E5-12 — engine-side LSP/formatter port 구현** `[신규]`
  선행: E4-12. 완료: spawn deduplication·document update·diagnostics·format 결과와 timeout/close를 구현하고 파일 변경 event에 연결한다. 에디터 UI는 후속이다.
- [ ] **E5-13 — 추가 provider·multimodal adapter 검증** `[확장]`
  선행: E3-12, E4-12. 완료: 필요 provider 하나씩 text/tool/reasoning/media·usage·retry·cancel fixture를 통과하고 실제 확인한 capability만 제공한다.

## E6 — 작업 품질·장애·성능·운영

이 단계의 공통 평가 기반은 E0~E4 뒤 먼저 만든다. 확장이 추가될 때 같은 평가에 시나리오를 더한다.

- [x] **E6-01 — 대표 코딩 과업 평가 harness 구축** `[신규·검증]`
  선행: E4-12. 완료: 임시 repository의 작은 수정·버그 수정·여러 파일 변경 과업을 정의하고 expected diff·검사·횟수·시간·usage·실패 원인을 기록한다.
- [ ] **E6-02 — 기본 엔진 실제 모델 과업 검증** `[검증]`
  선행: E6-01. 완료: 명시적 live 검증으로 코드 변경·검사 결과·목표 보존을 확인하고 fixture 성공과 구분한다. 공급자/모델별 실행한 범위만 기록한다.
- [x] **E6-03 — crash·경합·record/effect 경계 검증** `[검증]`
  선행: E6-01. 완료: admission/promotion/dispatch/승인/effect/settlement/review 시점의 강제 종료를 재현하고 기록·격리·자동 재실행 0을 확인한다.
- [x] **E6-04 — 긴 대화·출력·메모리 성능 검증** `[검증·개선]`
  선행: E6-01. 완료: 1천/1만/10만 메시지의 DB 읽기량·대기 시간·메모리·구독 압력을 측정하고 목표값·한계를 근거와 함께 정한다.
- [x] **E6-05 — 전체 엔진 데이터 backup/export/import 개선** `[개선]`
  선행: E6-03. 완료: primary/review/recovery ledger·artifact를 일관된 manifest/hash로 보존·복원하고 schema migration·부분 실패·복구 중단을 검증한다.
- [ ] **E6-06 — 진단·metrics·오류 원인 정리** `[개선]`
  선행: E6-03, E6-04. 완료: queue·turn·retry·summary·cleanup·quarantine·artifact의 관찰 지표와 사용자용 오류를 정리하고 누락 값·표본 범위를 표시한다.
- [ ] **E6-07 — 엔진 CI·OS별 지원 검증 연결** `[신규·검증]`
  선행: E6-05, E6-06. 완료: 엔진 검증을 기본 CI에 연결하고 macOS/Linux/Windows의 실제 pass/skip·미지원 경계를 기록한다. 확장 backend는 해당 E5 항목 완료 후 추가한다.
- [ ] **E6-08 — 확장 통합과 구현 명세 갱신** `[검증·문서]`
  선행: E6-02, E6-07 및 구현한 E5 항목. 완료: 실제 지원 목록·command/schema·복구/성능/OS 한계를 갱신하고 핵심 엔진 배포·host 연결 가능 상태를 정리한다. 미완료 E5는 열린 TODO로 남긴다.

## 다음 작업과 개선 우선순위

첫 세 항목은 **E0-01 데이터·event 계약 → E0-02 API 호환 → E0-03 migration 체계**다. 그 뒤 기존 데이터·복구를 회귀 검증하면서 새 inbox와 scheduler를 구현한다.

OpenCode보다 보강할 기준은 영구 Run/attempt 추적, cancel 후 자동 새 작업 방지, summary/retry까지 포함한 budget, file 효과 승인 binding, 큰 session의 DB 읽기량 제한, 확장 자원의 종료 확인이다. 기존 구현을 전부 폐기하지 않고 이 기준에 맞춰 내부 경계를 하나씩 정리한다.

참고: [엔진 분석](docs/opencode-engine-review/README.md), [독립 구현안](docs/opencode-engine-review/04-independent-engine-plan.md), [라이선스·출처](docs/opencode-engine-review/05-license-and-provenance.md), [현재 구현 상태](docs/moodcode/implementation-status.md).
