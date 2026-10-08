# Moodcode 엔진 구현 TODO

갱신일: 2026-10-08, Asia/Seoul. 초기 기준 구현: `6d9a952`, 분석·구현안: `77e16e2`. 직전 검증된 엔진 커밋: `5fd8e82`. 사용자가 확정한 순서는 **자체 엔진을 먼저 구현하고 이후 Electron GUI에 연결**하는 것이다.

상태: G1-29까지 1차 구현·최종 headless 검증을 마쳤고, 현재는 자체 메인 엔진 2차 MC2-01~20의 80개 항목을 구현하는 goal이 active다. 부분 기능이나 예산·턴 종료만으로 goal을 완료 처리하지 않는다. 최신 세부 상태는 아래 MC2 항목과 docs/moodcode/engine-phase-two-progress.json을 기준으로 사용한다.

## 작업 규칙

- `[ ]`는 미완료, `[x]`는 해당 완료 조건과 필요한 검증을 만족한 항목이다. 착수한 항목은 별도로 아래 `진행 중`에 기록한다. blocked 항목은 원인과 해제 조건을 해당 항목 아래에 남긴다.
- 항목 ID는 유지한다. 범위를 나누면 하위 ID를 추가하고, 순서를 바꾸면 선행 조건도 함께 갱신한다. 같은 기능을 여러 문서에서 따로 완료 처리하지 않는다.
- 선행 계약을 합의한 작업은 파일 담당 범위를 나누어 병렬 구현한다. 통합·검증·검토·커밋은 검증 가능한 변경 단위로 진행하고, 완료 항목에 검증 명령·보고서와 커밋을 연결한다. 설계 문서나 독립 모듈 작성만으로 연결되지 않은 실행 기능을 완료 처리하지 않는다.
- OpenCode에서 확인한 동작을 Moodcode 계약과 자체 fixture로 구현한다. 원본 코드·프롬프트·도구 설명·테스트를 이름만 바꿔 가져오지 않는다. 실제 외부 코드 재사용이 필요하면 출처와 고지를 별도로 기록한다.
- 각 단계는 headless engine/harness로 검증한다. 기본 회귀는 fixture를 사용하고, 실제 계정 요청은 명시적으로 분리한다. GUI·서명·앱 업데이트는 이 목록의 구현 범위에 넣지 않는다.

**구현·검증 완료 71/75**. 열린 항목은 **E5-08, E5-13, E6-07, E6-08**이며 각각 아래에 남은 조건을 기록한다. E0-01~04는 [첫 통합 기록](docs/moodcode/engine-foundation-verification.md), 기본 native 엔진은 [첫 native 통합](docs/moodcode/engine-native-verification.md), 확장 연결과 최신 gate는 [최종 headless 검증](docs/moodcode/engine-native-final-verification.md)을 따른다. 담당 범위는 [병렬 엔진 구현](docs/moodcode/engine-implementation-waves.md)에 기록한다.

기반 구현 커밋은 `c2309e7`(계약·migration), `94d2a65`(native 엔진·확장), `682b1d8`(실제 child/LSP/artifact)이다. 1차 최종 구현은 `464812f`이며 전체 gate는 동시성4의 같은 목록에서2,596개 중2,594 pass·실패0·취소0·기존 조건부2 skip, 타입 검사·코딩 fixture3/3이다. 같은 source의 실제 Codex default eager child text1회와 저장/archive/import 회귀가 통과했다. [최신 근거](docs/moodcode/engine-goal-verification.md), [1차 종료 조건](docs/moodcode/engine-phase-one-exit-criteria.md)을 따른다.

## 유지하고 회귀 검증할 기반

| 현재 구현 | 보존할 계약 | 근거 |
|---|---|---|
| SQLite·영구 Run | record/event 원자 commit, terminal 불변, DB owner, request 중복·충돌 | [storage](packages/engine/src/storage/index.ts) |
| 실행·예산 | 같은 workspace의 effectful 실행 독점, 시간·호출·출력 상한, 종료 정산 | [runner](packages/engine/src/runner/index.ts) |
| provider·대화 | 한 turn 통신, 완성된 tool call, tool-call/result 쌍, bounded replay | [ports](packages/engine/src/ports.ts), [Responses](packages/engine/src/provider/responses.ts) |
| 승인·파일 변경 | preview/fingerprint·현재 hash 검증, 변경 전후 checkpoint·부분 실패 기록 | [permission](packages/engine/src/permission/index.ts), [patch](packages/engine/src/tools/patch/index.ts) |
| 명령·취소·복구 | supervisor·effect marker, 종료 미확정 격리, 재시작 후 자동 효과 재실행 금지 | [command](packages/engine/src/tools/command/index.ts), [recovery](packages/engine/src/recovery/index.ts) |
| 변경 복원 | 현재 파일 충돌 검사, maintenance lease, review journal·복구 ledger binding | [review](packages/engine/src/review/index.ts), [audit](packages/engine/src/review/audit.ts) |

이 표는 보존한 계약이다. 최신 검증은 앱을 열지 않고 엔진 전체 회귀·호스트 unit 호환·fixture 평가·명시적 Codex live 과업으로 수행했다. GUI E2E와 bundle의 이전 결과는 이번 엔진 검증과 구분한다. 현재 기능과 한계는 [구현 상태](docs/moodcode/implementation-status.md)를 따른다.

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
- [x] **E3-11 — 큰 tool history의 artifact 투영 개선** `[개선]`
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
- [x] **E4-12 — 파일 변경 이벤트·observer/review 연계 구현** `[개선]`
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
  현재: ownership port와 명시적 unavailable 처리는 구현했다. native Job Object binding과 실제 Windows 실행 호스트가 필요하다. macOS의 fake port fixture·OS skip은 완료 근거로 사용하지 않는다.
- [x] **E5-09 — worktree lifecycle 구현** `[신규]`
  선행: E4-12. 완료: create/boot/ready/failure/cleanup을 durable 상태로 기록하고 기존 사용자 수정·branch/path를 보존한다. Git 준비 완료와 실행 완료를 구분한다.
- [x] **E5-10 — child task·cancel·budget 상속 구현** `[신규]`
  선행: E5-09. 완료: parent/child depth·도구 권한·전체 budget·격리 workspace·부모 취소를 정의하고 detached 작업의 소유권을 명시한다.
- [x] **E5-11 — child 결과 전달·변경 통합 구현** `[신규]`
  선행: E5-10. 완료: task 결과 입력의 중복 방지와 변경 충돌·preview·검증을 처리한다. 효과·merge를 자동 성공으로 간주하지 않는다.
- [x] **E5-12 — engine-side LSP/formatter port 구현** `[신규]`
  선행: E4-12. 완료: spawn deduplication·document update·diagnostics·format 결과와 timeout/close를 구현하고 파일 변경 event에 연결한다. 에디터 UI는 후속이다.
- [ ] **E5-13 — 추가 provider·multimodal adapter 검증** `[확장]`
  선행: E3-12, E4-12. 완료: 필요 provider 하나씩 text/tool/reasoning/media·usage·retry·cancel fixture를 통과하고 실제 확인한 capability만 제공한다.
  현재: Anthropic text/tool·공개 reasoning summary·opaque replay·usage·retry/cancel과 bounded image 입력을 구현했다. Responses/Codex/ChatCompletions image 입력도 연결했고 새 media store/provider fixture 55개를 통과했다. [adapter 명세](docs/moodcode/engine-anthropic.md), [이미지 명세](docs/moodcode/engine-input-media.md)를 따른다. audio/video/file 입력과 media 출력, 모델별 이미지 token budget, 실제 Anthropic 계정 검증은 남았다.

## E6 — 작업 품질·장애·성능·운영

이 단계의 공통 평가 기반은 E0~E4 뒤 먼저 만든다. 확장이 추가될 때 같은 평가에 시나리오를 더한다.

- [x] **E6-01 — 대표 코딩 과업 평가 harness 구축** `[신규·검증]`
  선행: E4-12. 완료: 임시 repository의 작은 수정·버그 수정·여러 파일 변경 과업을 정의하고 expected diff·검사·횟수·시간·usage·실패 원인을 기록한다.
- [x] **E6-02 — 기본 엔진 실제 모델 과업 검증** `[검증]`
  선행: E6-01. 완료: 명시적 live 검증으로 코드 변경·검사 결과·목표 보존을 확인하고 fixture 성공과 구분한다. 공급자/모델별 실행한 범위만 기록한다.
- [x] **E6-03 — crash·경합·record/effect 경계 검증** `[검증]`
  선행: E6-01. 완료: admission/promotion/dispatch/승인/effect/settlement/review 시점의 강제 종료를 재현하고 기록·격리·자동 재실행 0을 확인한다.
- [x] **E6-04 — 긴 대화·출력·메모리 성능 검증** `[검증·개선]`
  선행: E6-01. 완료: 1천/1만/10만 메시지의 DB 읽기량·대기 시간·메모리·구독 압력을 측정하고 목표값·한계를 근거와 함께 정한다.
- [x] **E6-05 — 전체 엔진 데이터 backup/export/import 개선** `[개선]`
  선행: E6-03. 완료: primary/review/recovery ledger·artifact를 일관된 manifest/hash로 보존·복원하고 schema migration·부분 실패·복구 중단을 검증한다.
- [x] **E6-06 — 진단·metrics·오류 원인 정리** `[개선]`
  선행: E6-03, E6-04. 완료: queue·turn·retry·summary·cleanup·quarantine·artifact의 관찰 지표와 사용자용 오류를 정리하고 누락 값·표본 범위를 표시한다.
- [ ] **E6-07 — 엔진 CI·OS별 지원 검증 연결** `[신규·검증]`
  선행: E6-05, E6-06. 완료: 엔진 검증을 기본 CI에 연결하고 macOS/Linux/Windows의 실제 pass/skip·미지원 경계를 기록한다. 확장 backend는 해당 E5 항목 완료 후 추가한다.
  현재: [CI workflow](.github/workflows/engine.yml)와 headless launcher를 구성하고 로컬 launcher 2개 테스트를 통과했다. 이 저장소에는 Git remote가 없어 Actions를 실행하지 못했다. Linux/Windows 및 Node24 hosted 결과를 확인한 뒤 완료 처리한다. [OS별 정확한 범위](docs/moodcode/engine-ci.md)를 따른다.
- [ ] **E6-08 — 확장 통합과 구현 명세 갱신** `[검증·문서]`
  선행: E6-02, E6-07 및 구현한 E5 항목. 완료: 실제 지원 목록·command/schema·복구/성능/OS 한계를 갱신하고 핵심 엔진 배포·host 연결 가능 상태를 정리한다. 미완료 E5는 열린 TODO로 남긴다.
  현재: 지원 목록·host API·schema·복구/성능 한계와 검증 보고서를 갱신했다. macOS headless host 연결은 검증했다. 선행 E6-07의 실제 CI 결과와 OS 지원 명세 확정이 남아 있어 항목을 열어 둔다.

## 다음 작업과 개선 우선순위

2026-10-07부터 사용자 요청으로 지속 개선 goal을 활성화했다. 후속 요청으로 1차 종료를 G1-29 수정과 최종 검증·문서·로컬 커밋으로 고정했다. 원래 E0~E6 75개와 아래 후속 G1은 별도로 관리한다. [목표·근거](docs/moodcode/engine-improvement-goal.md), [종료 명세](docs/moodcode/engine-phase-one-exit-criteria.md)를 따른다.

- [x] **G1-01 — OpenCode/pi/Amp/Claude Code/Codex 비교 근거 정리**: 공개 source commit 또는 공식 문서와 실제 확인 범위를 고정하고 자체 구현 선택을 기록한다.
- [x] **G1-02 — durable attempt usage 연결**: DB3 순차 migration, latest partial snapshot·중복·실패·재시작·archive 및 실제 runner 연결을 검증한다.
- [x] **G1-03 — active Run 이력과 모델 context 경계 개선**: 1k/10k SQL bounded window, 초기/최근 user anchor·최근 완전 exchange, provider byte 한도·누락 진단을 실제 loop로 확인한다.
- [x] **G1-04 — bounded image input 메인 엔진 연결**: host import→inbox→message→refs-only context→모델 전송, owner/hash/CAS/close/archive·unsupported 입력을 검증한다.
- [x] **G1-05 — 승인된 model-driven read-only delegation**: exact approval→pinned Git worktree→실제 child→bounded 결과, 부모 budget·cancel·중복·effect lock과 자동 merge 없음 검증.
- [x] **G1-06 — 독립 통합 리뷰와 전체 headless gate**: 담당을 교차해 snapshot·summary·exact retry·cleanup 결함을 수정하고 전체 회귀 및 로컬 커밋을 남긴다. 최종 gate 1,646개 중 1,644 pass·실패 0·Windows 조건 2 skip, fixture 코딩 평가 3/3.
- [x] **G1-07 — 복합 child/미디어 live 과업 평가**: 기존 Codex 인증과 제한된 임시 fixture로 실제 실행한 모델·도구·diff·usage·cleanup을 기록한다. mocked transport 성공과 구분한다. `verify-engine-extensions.mjs --live`에서 승인된 parent→read-only child→exact retry와 red image 인식 2/2, cleanup 확인. 기존 read→patch→command live도 통과했다. 모델은 현재 Codex `gpt-6.1-sol`이다.
- [x] **G1-08 — artifact/media 디스크·orphan 진단**: bounded 읽기 전용 scan·주 DB owner/ref index·명시적 host API·전체 JSON cap·close 대기를 연결했다. logical path/inode 크기, 관측 시점·불완전 coverage, child index 제외와 active publish→CAS race를 표시하며 삭제하지 않는다. [디스크 명세](docs/moodcode/engine-storage-usage.md), 구현 `59d1f42`.
- [x] **G1-09 — 이미지 이력·active-prefix 기억 정책**: 두 명시적 host 정책의 원본 refs 보존·생략/provenance·exact text/tool source를 연결하고 text-only summary가 pixels 관측을 대신하지 않도록 검증했다. G1-09a/b를 각각 별도 실제 엔진 근거로 확인했다.
- [x] **G1-09a — 명시적 이미지 이력 projection**: host opt-in으로 오래된 pixels 전송만 생략하고 최신 pixels·원문 anchors·complete exchange·필수 quoted provenance를 함께 보존한다. 원본 refs/replay·summary 거부·재시작·byte 실패와 실제 Codex 2회 요청을 검증했다. 구현 `59d1f42`, [정책과 남은 prefix 경계](docs/moodcode/research/2026-10-07-media-history-plan.md).
- [x] **G1-09b — active-prefix semantic checkpoint**: 현재 Run·완료 Turn/Attempt 증거와 별도 summaryAttemptId, exact typed text/tool source/hash·whole exchange chunk·보호된 중간 구멍·두 document/revision 원자 CAS를 연결했다. 20/50턴 관측 nonce on/off, steer/CAS/cancel/close/overflow·출력과 문맥 예산·실패/거부·media·원문 replay/refs를 검증했다. 커밋 후 실제 Codex summary 1회와 최종 답변 1회가 원문이 빠진 nonce를 정확히 회수했다. 구현 `04031cb`, [명세와 상한](docs/moodcode/engine-active-prefix.md). 별도 summary crash lifecycle/usage는 G1-13에서 이어 구현했다.
- [x] **G1-10 — 운영 명세·최신 검증 보고서·commit 연결**: API/schema/도구 지원 목록, 성능 표본, 실제 OS/CI 한계와 최신 구현 commit을 갱신한다. 첫 묶음 구현 `64435d7`과 [검증 보고서](docs/moodcode/engine-goal-verification.md)를 연결했다. 후속 변경 때 같은 근거를 갱신한다.
- [x] **G1-11 — 반복 요청·승인·child hotpath bounded 조회**: primary Run 요청만 exact SQL로 확인하고 maintenance 입장·승인 생성/취소·자식 pending/terminal output의 전체 snapshot 읽기를 줄였다. 신규 실제 7개 통합 fixture는 입장부터 allow/cancel/close까지 whole snapshot 0회이며 queue/steer·충돌 의미를 유지한다. custom legacy store fallback과 read limit 실패를 검증했다. 구현 `59d1f42`.
- [x] **G1-12 — 장수 엔진 지침 cache 수명**: idle LRU 128개·진행 중 observe lease·지속 baseline 재조회로 129번째 세션이 영구 차단되던 문제를 수정했다. 실제 130개 세션, pinned LRU, 128 concurrent observations, 취소/저장 실패 후 slot 반환, 임시 read 실패와 실제 삭제를 검증했다. 구현 `59d1f42`.
- [x] **G1-13 — 별도 summary attempt 수명·사용량**: DB4 typed summary 준비/dispatch/streaming·provider 완료·publication 대기·원자 completed/failed/interrupted/uncertain을 연결했다. 두 family·부분 출력/UTF-8·최신 nullable usage·cancel/close·세 단계 실제 crash·owner/source/CAS·archive·journal rollback을 검증했다. 일반 Attempt 합계와 분리하며 미완료 요약을 자동 요청·활성화하지 않는다. orphan uncertainty의 maintenance-first·다른 session resume와 wrapper/done=false cleanup 결함도 실제 재현·수정했다. 같은 커밋의 실제 Codex 요약 완료·usage·nonce 회수를 확인했다. 구현 `ede1519`, [명세](docs/moodcode/engine-summary-attempts.md).
- [x] **G1-14 — 여러 Run에 걸친 최신 이미지 anchor**: partial index의 세션 최신 image header·exact user/Run preflight와 count/byte 예약, semantic cutoff 위 원문 복원을 연결했다. 새 text-only Run·40턴·재시작·잘못된 owner/ref/ordinal·cap/unsupported provider·raw refs와 실제 frame을 15개 fixture로 검증했다. 실제 Codex 첫 image Run 후 close/reopen→attachment 없는 text Run에서도 old frame/blob 한 개를 전송하고 red를 인식했다. full snapshot 0, raw pixels 저장 없음. 구현 `ede1519`.
- [x] **G1-15 — summary 스트리밍·usage·격리 조회 최적화**: metadata-only usage와 transaction 안의 단일 full record 검증, 동일 usage/progress의 무쓰기 처리, DB5 workspace uncertainty partial index를 연결했다. 이전 커밋의 storage class와 동일한 1k/10k·64KiB 관측 fixture를 비교해 usage의 JS SQL 반환 67,849→2,378 bytes, 중복 usage/progress 202,775→67,849 bytes·write 1→0을 측정했다. 전체 gate의 실제 configured predicate는 첫 미승인 후보 211 bytes·3 query이며 context/snapshot/text를 읽지 않는다. 물리 I/O나 반복 처리량 보장으로 확대하지 않는다. 구현 `29b59a1`, [측정 근거](docs/moodcode/engine-goal-fifth-verification.json).
- [x] **G1-16 — summary uncertainty의 명시적인 host 복구 계약**: DB5 append-only 결정·부팅 frontier·physical storage/owner/source/revision/fingerprint binding과 전용 quiescent lease를 연결했다. exact retry·context head 변화·재시작·archive/import·native/v1 rollback·실제 commit 전후 SIGKILL·다른 실행 격리·durable queue 보존을 검증했다. 원래 uncertainty/usage/부분 출력은 유지하며 결정 자체의 provider retry/activation/resume은 0이다. 임시 fixture 결정 뒤 실제 Codex 새 Run 한 번을 확인했고 프로젝트의 실제 unresolved 기록은 승인하지 않았다. overflow에서 다른 native Turn/Attempt uncertainty가 있으면 차단한다. 구현 `29b59a1`, [계약과 한도](docs/moodcode/engine-summary-recovery.md).
- [x] **G1-17 — 일반 provider Attempt의 durable cleanup 증거**: DB6에서 실제 iterator next/return의 boolean done·owner/request/model/context binding과 별도 상태·원자 journal을 연결했다. consumer close·출력/protocol/저장 실패·타이머·재시작·archive·변조·다른 ordinary uncertainty를 검증했다. exact failed overflow와 unknown summary를 결합하고 Turn 연결 전 실제 SIGKILL 두 경계를 처리했다. 기존 state에서 proof를 backfill하거나 outcome을 성공으로 바꾸지 않는다. 임시 결정 뒤 실제 Codex 한 번의 logical SHA·종료 증거·재시작 보존을 확인했다. 구현 `11da986`, [계약과 한도](docs/moodcode/engine-attempt-cleanup.md).
- [x] **G1-18 — 일반 provider outcome uncertainty의 명시적 host 결정**: DB7의 host preview/ACK와 별도 ledger·native/v1 원자 audit를 구현했다. confirmed cleanup·부팅 전 exact owner/request/context·원래 입력·부분 출력/미실행 도구 제안·immutable source/pins에 결합하고 원래 outcome/usage·queue/control을 보존한다. timeout/transport·SIGKILL 전후·rollback·archive/physical binding·owner/source drift와 다른 blocker를 확인했다. 정상 취소의 확정 interrupted 호출은 NOT_NEEDED이며 missing/unknown cleanup은 차단한다. 임시 결정 뒤 실제 Codex 새 Run 1회와 재시작 보존을 검증했다. 실제 프로젝트 ACK·원래 retry/activation/resume는 수행하지 않는다. 구현 `5d70a22`, [계약](docs/moodcode/engine-provider-recovery.md).
- [x] **G1-19 — workspace 복구 증거의 공유 조회 예산**: provider/summary/Turn·cleanup·native owner가 한 SQLite transaction의 선택 본문 8MiB와 4,096개 raw cache를 공유한다. 통합 admission/resume/maintenance와 custom store fallback, owner/source/CAS·mutation epoch·no-refund·SQL body length guard를 연결했다. 실제 mixed private engine의 각 domain clear와 8.90MB 합산 차단·초과 Part/foreign 원문 반환 0·queue/control 보존을 검증했다. 정확한 `5d70a22` 대비 raw 본문은 60.8% 줄고 query는 24.3% 늘었다. 기존 V1 digest를 유지하며 숫자 순번 9→10 정렬을 수정했다. 전체 2,087 pass·실패 0·2 skip, fixture 3/3과 같은 커밋 실제 Codex 2회가 통과했다. 물리 I/O/처리량 상한으로 확대하지 않는다. 구현 `42218a8`, [공유 조회 계약](docs/moodcode/engine-recovery-evidence-read.md).
- [x] **G1-20 — summary 결정 pin coverage와 이전 요약 참조 보강**: DB7 proof V2에서 pin 목록 SHA·원래 startup frontier를 fingerprint/SQL에 결합했다. baseline-only 원본/이전 summary closure·missing/foreign/future/cycle/oversized refs·ACK 후 원문/중간 요약/Run owner drift·pin 제거와 coordinated digest 변조를 검증했다. 기존 DB5/V1 body/scope와 exact 역사 receipt는 보존하되 V1 admission은 inactive이며 자동 재승인하지 않는다. focused 33개와 실제 overflow-summary 복구 뒤 Codex 새 Run 1회가 통과했다. 구현 `5d70a22`, [호환·한도](docs/moodcode/engine-summary-recovery.md).
- [x] **G1-21 — bounded native PDF 원본 입력의 엔진 연결**: 이미지와 별도 document refs·host import/CAS/blob/index, DB8 최신 PDF user partial index, 표준 Responses input_file과 explicit provider/model MIME·host/provider token-unknown opt-in을 연결했다. PDF 1개/512KiB와 image+PDF occurrence decoded 합계 1MiB를 제한한다. 기본 unknown/미지원 입력은 credential/fetch와 새 admission 전에 거절한다. bounded image/PDF dual anchors·숫자 Run/message 순서, 원문 text를 보호하는 별도 history opt-in, exact receipts/proof/source pins, archive/디스크 진단을 연결했다. 실제 임시 엔진→mock HTTP 17개, 전체 2,206 pass·실패 0·2 skip, fixture 3/3, 같은 커밋 실제 Codex text 회귀 1회를 확인했다. 원격 PDF 인식·완전 parsing/token 계산·Codex PDF·child index 재귀 감사는 완료 범위 밖이다. 구현 `cc1c42b`, [문서 입력 계약](docs/moodcode/engine-input-documents.md). E5-13 외부 검증은 별도로 열린 상태다.
- [x] **G1-22 — 문서를 가진 managed child 저장소의 bounded audit**: root/child immutable binding·실제 close proof·physical owner read lease와 private immutable DB mirror를 연결했다. exact selected index와 root proof가 8MiB/ref/record 예산을 공유하며 unknown/null·취소/close를 보존한다. 기본 내부 child는 standalone snapshot·document refs/blob/hash/exact manifest·capture 경합을 검증하고 import에서 child session을 pause한다. foreign/missing/active/hot/phase gap·typed audit 제거를 거절한다. 외부·nondefault 내부·restored source mapping은 한계를 명시했다. 실제 temp parent/child/grandchild, source/bundle, 전체 2,274 pass·0 fail·2 skip, fixture 3/3과 같은 커밋 실제 Codex child text 1회를 확인했다. 구현 `9bf0e7f`, [저장 계약](docs/moodcode/engine-child-document-storage.md).
- [x] **G1-23 — 실제 child 저장/admission/종료 경계의 crash 검증·수정**: 실제 root/child Git·SQLite의 committed 7경계를 SIGSTOP/SIGKILL하고 재시작·exact retry했다. partial/native/usage/cleanup/ACK·phase/원문 보존과 provider 재호출/child 재생성/mirror 보충/close 추정/자동 owner 해제 0을 확인했다. 독립 실제 복구 6개·owner process 7개도 검증했다. held reader kill 뒤 446,464B 복사본 잔존을 개선해 validated immutable handle은 유지하고 darwin/linux에서 private pathname을 제거한다. post-return kill 잔존 0, copy 도중 262,144B 잔존·hot WAL/여러 lease·read/backup 경계를 구분했다. 전체2,294 pass·0 fail·2 skip, fixture 3/3, 같은 source 실제 Codex child text 1회를 확인했다. 구현 `bd14b32`, [조사](docs/moodcode/research/2026-10-07-child-crash-boundaries.md).
- [x] **G1-24 — exact verified archive의 historical child 문서 조회**: standalone `inspectArchivedChildDocumentStorage`를 public export하고 exact SHA/root native owner/task preflight와 전체 archive audit의 같은 frame·검증된 index를 재사용한다. 선택 cap8/32·전체 child proof32·samples16/128·report32KiB/최소4KiB를 구분하고 samples/partial/null·historical lineage만 반환한다. strict input·실제 nested/11child subset·legacy/external·foreign oversized owner·tamper·counts/report cap·원본/archive stat/SHA 보존을 검증했다. 실제 취소 두 회귀와 observerless 부분 수정, 기존 validate proof deadline 리팩터링 회귀도 수정·보존했다. 새37개를 포함한 전체2,331 pass·0 fail·2 skip, fixture3/3, source `8c07e28`의 실제 Codex child text1회→historical 조회→pause import·임시경로 제거가 통과했다. [계약](docs/moodcode/engine-archive-child-document-inspection.md), [조사](docs/moodcode/research/2026-10-07-archive-child-inspection.md).
- [x] **G1-25 — MCP 원격 도구의 dispatch/outcome 불확실성 영속화**: `4a15286`에서 DB9 exact native owner·실제 outer 승인/proposal·최종 논리 RPC/연결/catalogue를 결합하고 builtin fetch/stdin 직전 synchronous intent·terminal 응답·request-local cleanup을 분리했다. actual accepted timeout/disconnect/cancel3red와 committed-intent callback 실패를 수정하고 unknown의 모델 continuation/새 실행/queue promotion·재시작/archive 차단을 유지한다. 정상 isError/JSON-RPC error·late reply·승인/credential/catalogue·미전송 stdio·구체 reader/body cleanup·async observer·custom transport·SIGKILL2경계·native/v1 rollback을 source/bundle로 검증했다. 원래 provider cleanup/usage·부분 text/reasoning·입력/proposal/승인을 보존하며 기존 ACK가 MCP를 해제하지 않는다. 집중45/76/20과 전체2,402 pass·실패0·조건부2 skip·fixture3/3, 같은 source 실제 Codex child text1회·archive/import 회귀가 통과했다. 원격 abort/rollback·receipt 없는 legacy의 소급 인증·MCP 전용 ACK는 완료 범위 밖이다. [계약](docs/moodcode/engine-mcp-execution.md), [조사](docs/moodcode/research/2026-10-07-mcp-effect-outcomes.md).
- [x] **G1-26 — 일반 native tool의 시작 경계와 crash 격리 보존**: `217f77f`에서 실제 running-intent/execute-entered SIGKILL2red를 수정했다. 같은 recovery transaction에서 기존 MCP pending을 먼저 정산하고 원래 tool/Run/session/workspace·native proposal/Turn/latest Attempt의 bounded owner·SHA를 dual journal에 capture해 tool_effect uncertainty를 보존한다. 미시작3개·exact MCP terminal/not-dispatched+confirmed cleanup2개를 구분하고 callback/effect는 unverified/unknown으로 유지한다. Original provider completed/cleanup/usage·부분 출력/입력/승인, startup2/archive·exact retry·pending queue 및 newRun/resume/maintenance 차단을 검증했다. 신규38개를 포함한 전체2,440 pass·실패0·조건부2 skip, storage98/독립14/actual7 source+bundle·fixture3/3·같은 source 실제 Codex child text1회가 통과했다. Genuine v1은 unchecked이고 과거 interrupted의 소급 인증·전용 ACK·전체 startup I/O 상한은 완료 범위 밖이다. [계약](docs/moodcode/engine-tool-recovery-frontier.md), [조사](docs/moodcode/research/2026-10-07-tool-recovery-frontier.md).
- [x] **G1-27 — bounded tool catalogue/discovery와 정확한 문맥 예약**: `ad787d6`에서 eager 호환을 유지하는 host opt-in과 일반 discover_tools를 연결했다. 현재 scope/profile/allowlist/policy metadata, immutable schema SHA/bytes, clone 전 count/UTF-8 cap, 저장 완료 뒤 다음 모델 경계 선택과 같은 catalogue의 reservation/context/request를 고정한다. Registry 변경 재계획·steer 재확인·overflow 동일 Turn stale 차단·same-batch hidden 거절·기존 MCP exact approval/receipt/uncertainty·child 비상속·Run-local/restart를 검증했다. 실제 MCP40 schema에서 core21 보존, 광고22→23→23/예약10,584→18,968→18,968B/provider3·승인된 peer1로 완료했다. 새61개 포함 전체2,501 pass·실패0·조건부2 skip, runtime38/독립18/helper14/actual15 source+bundle·fixture3/3·같은 source opt-in Codex child text1회가 통과했다. Token/시간/I/O·provider-native tool_search·자동 교체는 완료 범위 밖이다. [계약](docs/moodcode/engine-tool-discovery.md), [조사](docs/moodcode/research/2026-10-07-tool-catalogue-discovery.md).
- [x] **G1-28 — 제한된 도구 작업 집합의 명시적 교체**: `93bfeaa`에서 discover_tools의 optional add/replace를 구현했다. 생략 add 호환, core/always/discover 보존, no-match selected clear, current owner/action fingerprint, clone 전 새 집합 count/UTF-8 cap과 conservative pending 예약을 연결했다. 결과/native Part 저장 뒤 다음 경계에만 교체하고 same-batch 기존 A/신규 B·저장 실패·policy/cancel·accepted MCP timeout·exact retry/restart·HTTP503 retry·child 상한을 보존했다. Helper16/독립22/actual14 source+bundle/noEmit, 새52개 포함 whole2,553 pass·실패0·조건부2 skip·fixture3/3·동일 source Codex child text1회가 통과했다. [계약](docs/moodcode/engine-tool-discovery.md), [조사](docs/moodcode/research/2026-10-07-tool-selection-capacity.md).
- [x] **G1-29 — 기본 eager catalogue와 문맥 예약 동기화, 1차 마지막 필수 수정**: `464812f`에서 같은 opaque capture/예약/ContextPlan/provider schemas/handler와 async·normal boundary·steer의 bounded replan을 연결했다. Empty current guard·고정 overflow stale·same-Turn HTTP retry의 Attempt별 deep clone·원래 cleanup SHA·runtime 없는 Coordinator 호환을 검증했다. Core21·원문 이력·현재 권한·DB9/metrics6을 유지한다. 새41개를 포함한 전체2,594 pass·실패0·취소0·기존2 skip, 예산8/경계10/독립23 source+bundle/noEmit·타입 검사·fixture3/3·동일 source default eager Codex child text1회가 통과했다. 문서·커밋·clean tree 최종 확인 뒤 1차 goal을 완료 처리한다. [계약](docs/moodcode/engine-eager-catalogue-context.md), [구현 전후 근거](docs/moodcode/research/2026-10-07-eager-catalogue-reservation.md), [종료 조건](docs/moodcode/engine-phase-one-exit-criteria.md).

G1-01~29의 구현 커밋과 검토 지점은 [목표·진행 기록](docs/moodcode/engine-improvement-goal.md)에 보존한다. 최신 G1-29 `464812f`는 whole2,594 pass·실패0·조건부2 skip·fixture3/3·같은 source Codex child text1회가 통과했다. 1차는 이 최종 source 검증·인계로 종료한다. 새 G1-30 기능·추가 비교는 시작하지 않는다. 원래 열린 OS/provider/CI4개와 GUI는 2차로 이월한다.

2차의 이월 목록은 **E5-13 media 입력/출력 계약·fixture → E5-08 native Windows 구현 및 OS 호스트 검증 → E6-07 첫 CI 실행 → E6-08 지원 명세 확정**이다. 별도 요청 없이 시작하지 않는다. GUI를 다시 작업하기 전 [host API](docs/moodcode/engine-host-api.md)를 기준으로 새 엔진 기능을 노출할 범위를 정한다. host API가 있는 기능이 현재 GUI에도 노출됐다고 간주하지 않는다.

OpenCode보다 보강할 기준은 영구 Run/attempt 추적, cancel 후 자동 새 작업 방지, summary/retry까지 포함한 budget, file 효과 승인 binding, 큰 session의 DB 읽기량 제한, 확장 자원의 종료 확인이다. 기존 구현을 전부 폐기하지 않고 이 기준에 맞춰 내부 경계를 하나씩 정리한다.

참고: [엔진 분석](docs/opencode-engine-review/README.md), [독립 구현안](docs/opencode-engine-review/04-independent-engine-plan.md), [라이선스·출처](docs/opencode-engine-review/05-license-and-provenance.md), [현재 구현 상태](docs/moodcode/implementation-status.md).

## 1차 종료 상태

G1-29까지 구현·검증했고 남은 로컬 필수 구현은 없다. [종료 명세](docs/moodcode/engine-phase-one-exit-criteria.md)의 최종 문서·커밋·clean tree 확인 뒤 goal을 완료하고 추가 구현을 끝낸다. 담당 작업은 종료했다. 원래 외부 환경의 열린 TODO4개는 2차로 유지하며 실제 프로젝트 unresolved 기록을 대신 승인하지 않는다.

도구 discovery의 실제 baseline과 독립 구현 범위는 [조사](docs/moodcode/research/2026-10-07-tool-catalogue-discovery.md)를 따른다.

## 추가 공개 엔진 분석 — 2026-10-07 사용자 요청

1차 종료 이후의 별도 분석 요청이다. 기존 G1 종료와 열린 OS/provider/CI 항목을 보존하고, 이번에는 source clone·프로젝트별 서브에이전트 분석·독립 구현 후보 정리까지 진행한다. 새 기능의 완료 표시는 구현과 검증 뒤에만 추가한다. [분석 기준과 보고서](docs/coding-agent-engine-review/README.md)를 따른다.

- [x] **A2-R01 — 19개 source clone·HEAD 고정**: 목록18개와 OpenHands 앱1개, 전체 Git 이력·60,418개 tracked 경로, LFS 포인터·비재귀 submodule 범위를 manifest에 기록.
- [x] **A2-R02 — root license·유지보수 상태 확인**: Apache-2.0 10개·MIT 8개·FSL-1.1-MIT 1개를 실제 root 파일과 대조하고 별도 고지 파일의 SHA를 기록. archived/API와 README 유지보수 고지를 구분.
- [x] **A2-R03 — 프로젝트별 서브에이전트 분석**: 각각 메인 엔진·문맥·도구·실행/복구·확장 기능과 Moodcode 비교를 보고서·증거 JSON으로 저장.
- [x] **A2-R04 — 통합 비교·후속 구현 후보와 증거 검사**: 기존 기능과 새 계약을 구분하고 후보마다 출처·우선순위·비용·검증 조건을 정리. HEAD·소스 줄·파일 SHA·변경 범위를 확인.
- [x] **A2-R05 — 현재 Moodcode와19개 전체의1:1 비교·구현 구체화**: 14개 기능×19개=266개 대조, 후보75개 전수 매핑, 현재 소스 근거35개·후보 경로86개를 확인했다. 초기12개 큰 묶음을20개 구현 범위·80개 proposed 작업으로 나누고 API/record·의존성·저장/import·완료 기준·병렬 편집 경계를 작성했다. [비교](docs/coding-agent-engine-review/one-to-one-comparison.md), [구현 상세](docs/coding-agent-engine-review/implementation-blueprint.md), [작업 목록](docs/coding-agent-engine-review/implementation-work-items.json)을 따른다. 문서/출처 검사만 완료했으며 새 엔진 구현·실제 환경 검증·새 goal 활성화는 포함하지 않는다. 기존 이월4개는 유지한다.

## 메인 엔진 2차 구현 — goal 활성화

2026-10-07 사용자 요청으로 새 goal을 활성화했다. [실행·종료 조건](docs/moodcode/engine-phase-two-goal.md), [80개 작업 상태](docs/moodcode/engine-phase-two-progress.json)를 따른다. 기존1차 종료와 환경 이월4개는 유지한다. 아래 항목은 실제 구현·엔진 연결·검증 뒤에만 완료 표시한다.

- [x] **MC2-01 — 저장소 문맥·LSP navigation**: P1 · W1. frozen ContextSource/snippets·공유 byte 예약·native Attempt freshness와 실제 TS7 서버를 연결했다. 512개 모듈 코퍼스·독립 정답·실제 Moodcode 위치·미개방 source/config/branch/worktree 변경·cap/partial/cancel·시간/디스크·실제 종료를 검증했다. 자동 관련 path/ranking과 외부 compiler input의 완전성은 이 지원 범위에 포함하지 않는다. [통합](docs/moodcode/engine-phase-two-native-typescript.md).
- [x] **MC2-02 — 검증 계획·제한 repair·완료 gate**: P1 · W2/W3. 원본 명령 capability·실제 취소 결과/unsupported·같은 Run의 제한 repair와 원래 budget·stalled/blocked·현재 source 및 cleanup에 근거한 task completion을 연결했다. restart/import/late 결과는 자동 재실행하지 않는다. [통합](docs/moodcode/engine-phase-two-w3.md).
- [x] **MC2-03 — 지침 신뢰·승인형 프로젝트 기억**: P1 · W3. 실제 trust/CAS·bounded tools-free 추출·exact SQL/파일/skill publication·전체 문맥 예산 소비와 imported SQL 문서의 별도 acknowledgment/resume/activation을 연결하고 검증했다. 동일한 물리 workspace root에서 새 DB/artifact 저장소로 복원하며 임의 source mapping·자동 imported skill activation은 지원하지 않는다. [생성](docs/moodcode/engine-phase-two-knowledge-generation.md)·[파일 publication](docs/moodcode/engine-phase-two-file-publication.md)·[import 복구](docs/moodcode/engine-phase-two-import-recovery.md). 기존 완료 증거에 맞춰 오래된 TODO 표기를 수정했으며 완료 집계를 추가하지 않는다.
- [x] **MC2-04 — typed lifecycle·policy hook**: P1 · W1/W2. ordered pre-prepare input rewrite·최종 exact approval·원본 base 문맥 보존·전체 ContextRevision/Attempt digest와 opt-in same-Run continuation을 연결했다. 실제 verified receipt/Turn/Attempt/cleanup/command checkpoint·native CAS·원래 예산·stale/retry/post-effect/restart를 검증했다. [구현·검증](docs/moodcode/engine-phase-two-lifecycle-transforms.md).
- [x] **MC2-05 — 적용 전 ProposalSet overlay**: P2 · W4. (a) native proposal/artifact·source/head CAS·paging, (b) readonly diff·실제 pending 모델 문맥, (c) exact host 승인·실제 적용 영수증, (d) partial/cancel·8개 실제 SIGKILL 경계·별도 ACK/resume 완료. 물리 적용은32파일/4MiB이며 더 큰 변경안을 자동 분할하지 않는다.
- [ ] **MC2-06 — 상주 child·팀 mailbox·board**: P2 · W4. (a/b) actual root/child membership·역할/expiry·native bounded mailbox/board·원본 page/receipt/CAS 완료. (c/d) current live Run steer·4개 SIGKILL·child 입력 증명·actor-bound 모델 도구4종·실제 provider admission/취소 검증 완료, terminal 상주 재개·import activation·uncertain ACK/resume은 계속 진행.
- [ ] **MC2-07 — 역할 workflow·recipe·child join**: P2 · W4. (a/b) bounded recipe/schema/DAG·native revision/CAS·고정 all/any join 완료. 실제 readonly planner/reviewer child 실행·결과 관찰·취소·SIGKILL/import 검증을 연결했다. (c/d) editor/validator 효과·승인 merge·역할/모델 변경 요청·전체 파일 freshness·부모 결과 전달 경계는 계속 진행. [구현](docs/moodcode/engine-phase-two-workflows.md).
- [x] **MC2-08 — 예약·webhook occurrence admission**: P2 · W5. 원본 root target/worker·시간대/DST·native cursor/claim/lease/CAS·dedupe와 실제 queue accept/promote/Run 결과를 연결했다. 각 provider 진입 직전 config/profile/catalogue/물리 binding 재검사, 실제 SIGKILL·uncertain no replay·disabled/paused import를 검증했다. 자동 clock polling·network listener·외부 webhook 인증/알림은 host 통합 범위다. [구현](docs/moodcode/engine-phase-two-schedules.md).
- [ ] **MC2-09 — ACP·remote host·client effect 완료**: P2 · W5. a/b의 자체 ACP v1 로컬 stdio·텍스트·same-Attempt 파일 읽기·native 저장/복구를 구현·검증했다. c/d의 효과형 permission/write/terminal·remote host·agent-owned context/load/reconnect는 진행 중이다. [지원 범위](docs/moodcode/engine-phase-two-agent-backends.md).
- [ ] **MC2-10 — session command job·완료 전달**: P2 · W5. 계약(a)·독립 모듈(b)·엔진 연결(c)·검증/문서(d).
- [x] **MC2-11 — role 권한·판단 출처·preflight**: P1 · W1. host CAS 정책 교체·catalogue/prepared 무효화·actual HTTP MCP 및 독립 child worktree/DB의 stale approval effect 0 검증. 외부 운용/Windows 증거는 환경 범위로 유지. [통합](docs/moodcode/engine-phase-two-w2.md).
- [x] **MC2-12 — projection·manifest·무진전·오류 진단**: P1 · W1. 실제 native source/effect writer·bounded coherent evidence·readonly 등록 inspector·advisory·선택 metadata 요약을 연결했다. 추가 모델 호출 없는 요약이며 남은 live budget은 unknown이다. [통합](docs/moodcode/engine-phase-two-native-diagnostics.md).
- [ ] **MC2-13 — 승인형 Git commit 영수증**: P3 · WX. 계약(a)·독립 모듈(b)·엔진 연결(c)·검증/문서(d).
- [ ] **MC2-14 — 효과 보존 대화 fork**: P3 · WX. 계약(a)·독립 모듈(b)·엔진 연결(c)·검증/문서(d).
- [ ] **MC2-15 — 제한 code-mode**: P3 · WX. 계약(a)·독립 모듈(b)·엔진 연결(c)·검증/문서(d).
- [ ] **MC2-16 — media 확대·실제 공급자 검증**: P2/P3 · ENV/WX. 계약(a)·독립 모듈(b)·엔진 연결(c)·검증/문서(d).
- [ ] **MC2-17 — 실제 OS 파일/네트워크 sandbox**: P3 · ENV/WX. 계약(a)·독립 모듈(b)·엔진 연결(c)·검증/문서(d).
- [ ] **MC2-18 — prepared resource 기반 효과 병렬**: P3 · WX. 계약(a)·독립 모듈(b)·엔진 연결(c)·검증/문서(d).
- [ ] **MC2-19 — PR SHA 기반 CI/review feedback**: P2 · W5. 계약(a)·독립 모듈(b)·엔진 연결(c)·검증/문서(d).
- [ ] **MC2-20 — coding attempt group·headless batch**: P2 · W5. 계약(a)·독립 모듈(b)·엔진 연결(c)·검증/문서(d).

### W1/W2에서 완료한 세부 작업

W1/W2에서 완료한12개, native TypeScript·typed lifecycle 연결 포함 현재 누적20개/전체80개. 범위별 남은 조건은 위 항목과 진행 JSON에 유지한다.

- [x] **MC2-01a** — selected source snapshot·hash/host parser routing/ignore revision·generation CAS.
- [x] **MC2-01b** — bounded LSP symbols/definitions/references·stale/unsupported·실제 read tool/host API.
- [x] **MC2-01c** — host-selected evidence 문맥·필수 exchange/도구/출력의 실제 공유 예약·per-Attempt frozen source/context 검사.
- [x] **MC2-02a** — host check/profile/command·idle session CAS·Run source scope·actual selected source plan/영구 저장.
- [x] **MC2-04a** — Run별 typed host hook registry·stage/revision/order/failure policy.
- [x] **MC2-04b** — 실제 모델·도구 경계의 bounded observe/deny/stop·취소/late outcome 영구 기록.
- [x] **MC2-11a** — captured profile·canonical file/MCP resource 역할 규칙·deny 우선/unknown ask.
- [x] **MC2-11b** — trusted allow/deny provenance·dual-journal 영수증·bounded 관측 조회.
- [x] **MC2-11c** — exact command/cwd/source/analyzer revision 사전 검사·승인 유지/실행 직전 재검사.
- [x] **MC2-11d** — physical alias/root·MCP 연결/정책 교체·stale 승인·deny/analyzer 실패·parent/child generation 및 승인 뒤 변경 effect 0.
- [x] **MC2-12a** — bounded native trajectory·digest/partial/usage/source provenance·무실행 관측.
- [x] **MC2-12b** — typed provider 오류 분류·request/cleanup·zero/unknown usage projection.

### W3에서 완료한 세부 작업과 진행 중인 기반

W3 최초 묶음에서는 전체20개 범위 중2개, 세부80개 중15개를 완료했다. [당시 검증 기록](docs/moodcode/engine-phase-two-w3-verification.json)은 커밋2924d34의 소스·검증 근거를 고정한다. 최신 지식 생성 묶음은 아래에 기록하며 전체 goal은 active다.

- [x] **MC2-02b** — pass/fail/skipped/unsupported/timeout/cancelled/uncertain 결과, 원본 command 등록과 실제 취소 중 단일 consumed settlement, 원래 로그·사후 source/cleanup 보존.
- [x] **MC2-02c** — 같은 Run의 최대2단계 repair, 원래 Turn/tool/output/duration/child 예산, 중복 stage 소비 차단·stalled/blocked 판정·frozen ContextPlan control.
- [x] **MC2-02d** — 실제 native 종료·현재 source·required pass·확정 cleanup에 근거한 task completion, retry/steer/등록 교체·late 결과·restart/import 관측과 자동 재실행 차단.
- [x] **MC2-03a** — 실제 trust/source/target/plan에 DB11 native generation owner/output/nullable usage/확정 cleanup을 연결하고 immutable pending 후보를 저장했다.
- [x] **MC2-03b** — 완료 Run 메시지·명시적 파일의 원본 capture, opt-in tools-free 추출, 독립 예산·상한·취소, bounded pending inbox와 reasoning/replay 제외를 검증했다.
- [x] **MC2-03c** — native workspace-document와 실제 파일/skill의 원본 승인 publish/update/revoke·head CAS·dedupe·동시 승인 차단·native checkpoint/receipt·취소/종료 대기·실제 SIGKILL·별도 ACK/resume·archive/import pause를 연결했다. [물리 파일 통합](docs/moodcode/engine-phase-two-file-publication.md)·[검증](docs/moodcode/engine-phase-two-file-publication-verification.json).
- [x] **MC2-03d** — generation의 실제 SIGKILL/partial/uncertainty·명시적 ACK+별도 resume·paused archive import와 실제 active ContextPlan을 연결했다. DB15의 원본 import 이력·별도 복구 승인·새 신뢰 및 물리 binding에 결속한 SQL 문서별 activation/deactivation까지 실제 Attempt/ContextRevision에서 소비한다. 출처/신뢰·만료/철회·공유 budget·child 격리·후속 native uncertainty의 독립 복구·재실행0을 검증했다. [문맥 소비](docs/moodcode/engine-phase-two-knowledge-context.md)·[가져오기 복구](docs/moodcode/engine-phase-two-import-recovery.md).

### W3 지식 생성 통합

세부17개/80개, 범위2개/20개 완료다. [구현 설명](docs/moodcode/engine-phase-two-knowledge-generation.md)과 [검증 기록](docs/moodcode/engine-phase-two-knowledge-generation-verification.json)을 따른다. 기본 비활성 host API로 실제 generation/attempt/candidate를 저장하며 임의 Run/Session·자동 모델 재실행·자동 출판을 만들지 않는다. 실제 source·target·trust 변경, output/observation/event·시간 상한, 반환 실패와 close, 프로세스 SIGKILL, 후보 append/marker 중간 상태, archive 관계·이전 migration 원자성을 검증했다. GUI·라이브 모델·Windows 증거와 기존 외부 환경 이월4개는 포함하지 않는다.

### W3 승인형 게시 통합

별도 opt-in에서 실제 SQL workspace 문서의 게시·기존 revision 수정·논리적 철회와 원래 영수증을 제공한다. 원본 승인 미리보기, 완료 후보 marker, native producer 역사 tuple, 정확한 현재 head, source/trust/binding 재검사와 한 SQL 트랜잭션의 CAS를 사용한다. actual SIGKILL 및 paused archive import를 포함한다. [구현 설명](docs/moodcode/engine-phase-two-knowledge-publication.md)·[검증 기록](docs/moodcode/engine-phase-two-knowledge-publication-verification.json). 파일/skill publication이 남아 MC2-03c는 진행 중이다. 활성 ContextPlan 소비의 후속 검증은 아래에 기록한다. 완료 수17/80·goal active를 유지한다.

### W3 승인 문서 문맥 소비 통합

호스트가 명시적으로 선택한 native SQL 문서를 실제 코딩 ContextPlan·ProviderAttempt와 연결했다. 기본값은 비활성이며 원본 완료 producer/publication/receipt, 현재 postimage, source/trust/profile/만료, paused import를 검증한다. 필수 exchange·repository·지식·output은 같은 실제 serialized 예산을 쓰며 동일 Turn의 retry는 원래 메시지와 ContextRevision을 유지한다. source/head/신뢰 변경·취소는 추가 dispatch를 막는다. 부모 정책은 child에 자동 전달되지 않는다. [구현 설명](docs/moodcode/engine-phase-two-knowledge-context.md)·[검증 기록](docs/moodcode/engine-phase-two-knowledge-context-verification.json). imported knowledge의 명시적 복구가 남아 MC2-03d와 전체 goal은 진행 중이며 완료 수17/80은 유지한다.

### 실제 TypeScript 의미 분석 통합

- [x] **MC2-01d** — host 명시적 native TS7 executable/version과 bounded project source digest를 연결하고 실제 512개 모듈의 독립 정답8개·Moodcode 정답2개를 대조했다. 미개방 dependency/config 변경, UTF-16/BOM/CRLF, partial compile·ignored/outside·참조 상한, branch/worktree/reopen, original RPC 취소·actual FileHandle drain·native PID 종료와 frozen coding Attempt를 검증했다. [구현 설명](docs/moodcode/engine-phase-two-native-typescript.md)·[검증 기록](docs/moodcode/engine-phase-two-native-typescript-verification.json)·[실제 측정](docs/moodcode/engine-phase-two-native-typescript-benchmark.json). 해당 검증 시점18/80·3/20 완료였으며 전체 goal은 active다. 측정된 정답 사례의 정확도를 전체 저장소 품질/자동 ranking/외부 dependency/Windows/OS sandbox 완료로 확대하지 않는다.

- [x] **MC2-04c** — hash-bound 도구 입력 변환은 sole prepare 전에만 적용하며 원본 proposal·final opaque handle·fingerprint exact approval과 eager/discovery capture를 보존했다. model-context는 확인한 base 메시지를 보존하고 whole assistant DATA를 공유 slot에 넣은 뒤 실제 ContextRevision/Attempt를 고정한다.
- [x] **MC2-04d** — actual native verification graph와 primary SQLite CAS에 결속한 opt-in same-Run continuation 최대1회, 원래 turn/tool/output/deadline/child 예산과 per-Attempt source/profile/ledger freshness를 검증했다. post-effect 실패 producer1회, 정상 same-DB restart 후 추가 dispatch0이다. 신규99개·whole3,563중3,561pass/실패0/기존Windows skip2·source403pass·coding fixture3pass. [설명](docs/moodcode/engine-phase-two-lifecycle-transforms.md)·[기록](docs/moodcode/engine-phase-two-lifecycle-transforms-verification.json). 해당 검증 시점20/80·4/20 완료였으며 전체 goal은 active다.

- [x] **MC2-03c 물리 소비 경로** — DB13 파일/skill 게시·철회와 8개 native 테이블, original 실행 marker 예약, current proof와 실제 파일 처리, 불확실 상태 보존 및 명시적 ACK/resume를 연결했다. 신규90개, 전체3,653개 중3,651pass·실패0·기존 Windows skip2, source605pass, scripted coding fixture3pass, 전체 typecheck0. [설명](docs/moodcode/engine-phase-two-file-publication.md)·[기록](docs/moodcode/engine-phase-two-file-publication-verification.json). 해당 검증 시점21/80·4/20 완료였다. MC2-03d imported knowledge의 명시적 재결속·activation은 남아 있으며 MC2-12c/d의 후속 완료 기록은 아래에 있다.

- [x] **MC2-12c/d 실제 native 진단 소비** — DB14 원본 실행 이력·source/effect epoch와 읽기 판단, 한 primary snapshot의 bounded coding evidence, readonly 등록 inspector, opt-in metadata 요약을 연결했다. 승인 거부·취소·stale의 dispatch0, unknown source/usage, 잘린 결과·실패·과거 seq, 실제 SIGKILL·DB migration rollback·archive/import 변조를 검증했다. 신규90개·전체3,743개 중3,741pass/실패0/기존Windows skip2, source810pass, scripted coding fixture3pass, 전체 typecheck0. [설명](docs/moodcode/engine-phase-two-native-diagnostics.md)·[기록](docs/moodcode/engine-phase-two-native-diagnostics-verification.json). 해당 검증 시점23/80·5/20 완료였다. 전체 goal은 active다. LLM 의미 요약은 구현하지 않았으며 metadata 요약은 provider/tool/token 비용0, 남은 live budget은 null이다. MC2-03d import 재결속·activation과 MC2-05~10·13~20은 계속 진행한다.

- [x] **MC2-03d 가져오기 복구 완료** — 원본 native import frontier·ACK·별도 resume·문서별 activation/deactivation과 실제 코딩 ContextRevision/Attempt를 연결했다. 새 generation 불확실성은 별도 복구하며 원래 cleanup=false와 역사 SHA를 보존한다. 신규46개·전체3,789개 중3,787pass/실패0/기존 Windows skip2, source856pass, scripted coding fixture3pass, 전체 typecheck0. [설명](docs/moodcode/engine-phase-two-import-recovery.md)·[검증 기록](docs/moodcode/engine-phase-two-import-recovery-verification.json). 해당 검증 시점24/80·6/20 완료였으며 goal은 active다. 동일 물리 workspace root의 DB/artifact 이전을 지원하고 임의 root/source 매핑·자동 imported skill 활성화는 지원하지 않는다. MC2-05~10·13~20과 별도 환경 이월4개를 이어간다.

- [x] **MC2-05a/b pending 변경안 완료** — DB16 native ProposalSet·immutable revision·전용 BLOB·원본 source/head CAS, bounded readonly diff와 실제 ContextRevision/Attempt 문맥 소비를 연결했다. 변경안은 미적용 DATA로 표시하고 실제 파일·LSP와 구분한다. 공유 문맥 budget·child 격리·동일 Turn retry·stale dispatch0·import pause·재시작·실제 descriptor close drain을 검증했다. 신규70개·전체3,859개 중3,857pass/실패0/기존 Windows skip2, source1,282pass, scripted coding fixture3pass, 전체 typecheck0. [설명](docs/moodcode/engine-phase-two-proposals.md)·[검증 기록](docs/moodcode/engine-phase-two-proposals-verification.json). 해당 검증 시점26/80·6/20 완료였으며 전체 goal은 active다. 이후 MC2-05c/d 완료는 별도 기록을 따른다.

- [x] **MC2-05c/d 변경안 실제 적용·복구 완료** — DB17 native host owner·원본 preview/승인·실제 shared patch producer·checkpoint/afterimage/receipt·head CAS·guard와 별도 ACK/resume을 연결했다. 실제 partial/cancel/descriptor close 실패와8개 SIGKILL 경계, 중복 요청 효과0, 독립 SQL 기록 변조5개와 archive/import를 검증했다. 신규59개·전체3,918개 중3,916pass/실패0/기존 Windows skip2, source1,473pass, scripted coding fixture3pass, 전체 typecheck0. [설명](docs/moodcode/engine-phase-two-proposal-apply.md)·[검증 기록](docs/moodcode/engine-phase-two-proposal-apply-verification.json). 해당 검증 시점28/80·7/20 완료였으며 전체 goal은 active다. 활성 effects marker의 archive export와 임의 guard/root 재결속은 지원하지 않으며 적용된 set의 새 내용은 새 ProposalSet으로 작성한다. Host receipt의 watcher/LSP cache 알림은 별도 개선 항목이며 실제 TypeScript 조회는 디스크 SHA로 갱신한다. MC2-06~10·13~20 및 환경 이월4개를 이어간다.

- [x] **MC2-06a/b 팀·메일박스·작업 owner 완료** — DB18 native immutable revision/CAS·정확한 실제 root/child owner/별칭 역할·generation/expiry·bounded 메시지/원본 page/cursor/receipt·board를 연결했다. 실제 recipient 종료와 alias uncertainty 우회를 차단하고 actual child 입력·Run·요청 SHA·본문을 typed archive reader로 대조한다. 4개 실제 SIGKILL과 import pause/no replay를 검증했다. 신규55개·전체3,973개 중3,971pass/실패0/기존 Windows skip2, source660pass, scripted coding fixture3pass, 전체 typecheck0, source39개 SHA 불변. [설명](docs/moodcode/engine-phase-two-teams.md)·[검증 기록](docs/moodcode/engine-phase-two-teams-verification.json). 현재30/80·7/20 완료이며 goal은 active다. MC2-06c/d의 live steer 기반은 검증했지만 모델 도구·terminal 상주 재개·import activation·uncertain ACK/resume은 남아 있다. schema128행 상한은 유지했고 legacy hash/DB17→18 migration도 검증했다. MC2-07~10·13~20 및 환경 이월4개도 이어간다.

- [x] **MC2-06 current 모델 소비 연결** — 별도 teamModelTools opt-in·실제root/child host actor 선택·고정 catalogue와 원본 ToolContext/Turn/Attempt/승인/멤버·수신자·작업 revision 검사로 모델 도구4종을 연결했다. Read는 readonly 정책, 쓰기3종은 exact native 승인을 적용한다. 실제 child admission 저장 후 provider 시작, 대기 취소 시 호출0/사용량0/confirmed close를 검증했다. 신규28개·전체4,001개 중3,999pass/실패0/기존 Windows skip2, source688pass, scripted fixture3pass, typecheck0, source14개 SHA 불변. [설명](docs/moodcode/engine-phase-two-team-model-tools.md)·[기록](docs/moodcode/engine-phase-two-team-model-tools-verification.json). 아직 terminal 상주 continuation/import activation/uncertain ACK-resume이 남아 MC2-06c/d는 진행 중이고 완료 집계30/80·7/20·goal active를 유지한다. MC2-07 workflow/spec·native reducer/CAS·실제 child 소비는 다음 병렬 구현 중이다.

- [x] **MC2-07a/b workflow·recipe·native join 완료** — DB19 immutable revision/head CAS·고정 all/any dependency·원본 실제 child admission/측정 outcome·readonly planner/reviewer를 연결했다. 실제 native running COMMIT 뒤 provider 시작, child 종료 뒤 원본 admission 유지, 관찰 취소 후 재관찰,4개 SIGKILL·archive paused-import·SQL head/결과 변경 거부를 검증했다. 신규49개·전체4,050개 중4,048pass/실패0/기존 Windows skip2, source737pass, scripted fixture3pass, typecheck0, source32개 SHA 불변. DB19 실제 catalogue130행·cap160·DB18 역사적128행/논리 hash를 확인했다. [설명](docs/moodcode/engine-phase-two-workflows.md)·[검증 기록](docs/moodcode/engine-phase-two-workflows-verification.json). 완료32/80·7/20·goal active이며 MC2-07c/d·MC2-06c/d와 예약 실행 등48개 작업은 남아 있다.

- [x] **MC2-08a/b/c/d 예약 입력 통합 완료** — DB20 native immutable revision/head CAS·원본 root worker/target/lease/claim·DST/시간대·atomic due cursor와 actual queue-only accept/promote/terminal receipt를 연결했다. promotion 및 awaited context 뒤 실제 provider 진입 직전 config/profile/catalogue/물리 pin 검사, 두 worker 경쟁·lease 상실·actual SIGKILL before/after-accept·재시작 no replay·disabled/paused import·재해시된 native graph 위조 거부를 검증했다. 신규45개·전체4,095개 중4,093pass/실패0/기존 Windows skip2, source782pass, scripted fixture3pass, typecheck0, source28개 SHA 불변. DB20 catalogue132행·cap160·DB19 역사/rollback 유지. [설명](docs/moodcode/engine-phase-two-schedules.md)·[검증](docs/moodcode/engine-phase-two-schedules-verification.json). 완료36/80·8/20·goal active이며 MC2-06c/d·MC2-07c/d·MC2-09/10/13~20과 환경 이월4개는 계속 진행한다. 자율 polling·network webhook listener/인증/알림은 host 통합이다.

- [x] **MC2-09a/b 로컬 ACP v1 연결·native 읽기 기반 완료** — DB21 STRICT native revision/head CAS와 실제 original Run/Turn/Attempt·connection epoch/PID·준비된 파일 읽기·승인/deny·Part/output·pipe delivery를 연결했다. 실제 root SIGKILL·default-off 재시작·paused import·supervisor 종료·SQL admission/영수증 실패·같은 Attempt 중복 spawn·source drift·foreign genuine owner 재결속·lifecycle 파일/줄 변경을 검증했다. 신규61개·전체4,156개 중4,154pass/실패0/기존 Windows skip2, source843pass, scripted fixture3pass, typecheck0, source38개 SHA 불변. DB21 catalogue134행·cap160·DB20 역사/rollback 유지. [설명](docs/moodcode/engine-phase-two-agent-backends.md)·[검증](docs/moodcode/engine-phase-two-agent-backends-verification.json). 완료38/80·8/20·goal active. c/d의 permission/write/terminal·HTTP/인증·agent-owned context/load/reconnect, MC2-06c/d·07c/d·10·13~20 및 환경 이월4개는 남아 있다.

- [x] **MC2-10 기존 사용자 터미널 관찰·완료 전달 기반** — DB22 native job/output/delivery revision/head CAS, 실제 original PTY source·birth·journal inode·root owner, 고정 UTF-8 page/cursor·loss gap과 genuine cleanup outcome을 연결했다. 관찰 취소는 사용자 PTY에 영향을 주지 않는다. 실제 queue intent→accept→receipt, 중복 전달·SQL 실패 후 uncertainty, 현재 profile/catalogue 및 재시작/paused-import를 검증했다. PTY 취소의 별도 백그라운드 그룹 누락과 supervisor 상실 후 거짓 cleanup 확인도 수정했다. 신규44개·전체4,200개 중4,198pass/실패0/기존 Windows skip2, source899pass, scripted fixture3pass, typecheck0, source31개 SHA 불변. DB22 catalogue136행·cap160·DB21 역사/rollback 유지. [설명](docs/moodcode/engine-phase-two-jobs.md)·[검증](docs/moodcode/engine-phase-two-jobs-verification.json). 승인된 새 명령/preflight/lease·output artifact/model consumer·원자적 inbox 전달·추가 crash/detach/EPERM은 남아 MC2-10a/b/c/d 모두 진행 중이며 완료38/80·8/20·goal active를 유지한다.

- [x] **MC2-10 원자적 native 입력 전달·승인된 Run 명령 관찰 보강** — Root의 terminal 완료 intent/input/input.accepted/receipt를 같은 거래에 저장하고 COMMIT 뒤에만 publish/wake한다. 실제 승인된 built-in run_command의 원본 context·Run/Turn/Attempt/Tool·준비된 명령·PID·bounded output/sealed artifact/checkpoint를 native CAS 문서 및 source/process/closed/document 이벤트에 연결했다. 실제 Tool/Part 종료 뒤에만 관찰을 완료하며 저장 실패는 결과 중복 없이 uncertainty를 유지한다. 실제 Root SIGKILL·paused import·SQL rollback·출력 파일 inode 교체·PID/completion 재해시 거부·정상 lifecycle 입력 변환을 병렬 구현/검증했다. 신규40개·전체4,240개 중4,238pass/실패0/기존 플랫폼 skip2, 직접source1,016개 중1,014pass/실패0/기존 플랫폼 skip2, fixture3pass/live0, typecheck0, source48개 SHA 불변. DB22 catalogue136·cap160 유지. [설명](docs/moodcode/engine-phase-two-atomic-command-jobs.md)·[검증](docs/moodcode/engine-phase-two-atomic-command-jobs-verification.json). 별도 host approval/lease·background 소유권 이전·parent 종료 후 lifetime·모델 output consumer·owned command 완료 inbox·잔여 EPERM/backpressure는 남아 MC2-10a/b/c/d와 goal을 진행 상태로 유지한다. 완료38/80·8/20·환경 이월4개 변동 없음.
