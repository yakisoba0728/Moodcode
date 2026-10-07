# Moodcode 후속 엔진 구현 후보

이 문서는 최초12개 큰 묶음의 기록이다. 후속 요청의 현재 기준은 [19개 1:1 비교](one-to-one-comparison.md)와 [20개 구현 상세](implementation-blueprint.md)다. 01~07·09~10의 주제는 유지하고, 초기08은08(예약)/19(PR·CI)/20(batch)으로, 초기11은11(정책)/17(OS enforcement)로, 초기12의 선택 실험은12~16/18과01의 retrieval 보강으로 나눴다. API·작업 번호는 구현된 public contract가 아닌 제안이며 새 작업의 상태는 [작업 목록](implementation-work-items.json)을 따른다.

이 문서는 19개 source review에서 얻은 제안을 Moodcode 자체 계약으로 묶은 구현 순서다. **제안 단계이며 이번 분석으로 새 엔진 기능을 구현하지 않았다.** 후보 원문·원본 SHA·Moodcode 관련 경로는 [catalogue](candidate-catalogue.json)와 각 보고서, 기존 기능은 [baseline](moodcode-baseline.md)을 따른다. 아래 API·레코드 이름은 설계안이다. 기존 엔진에 추가된 export라고 해석하지 않는다.

## 우선 진행할 세 묶음

### MC2-01 저장소 구조 문맥

참고: AIDER-C01, plandex-task-context-map, CONTINUE-C01/C02, CR-C01. 기존 LSP host에 versioned symbol/definition 조회를 추가하는 작은 읽기 계약과 parser 기반 심볼 지도·요청별 문맥 선정을 구분해 진행한다. embedding 의미 검색은 별도 opt-in으로 둔다. 기존 검색·ContextPlan·tool schema 예약을 활용하며 파생 index가 최신 파일 관측을 대신하지 않는다. 예상 비용 **M~L**은 질적 추정이고 벤치마크나 기간 약속이 아니다.

| 작은 작업 | 소유할 계약 | 완료 조건 |
|---|---|---|
| MC2-01a index record·host port | `RepositorySnapshot`에 workspace/path/content hash/parser revision/ignore revision; host 등록 `RepositoryIndexer` | unsupported·parse failure·stale·overflow를 구분; 무등록 parser 실행 0; rename/delete·취소 후 자료 무효화 |
| MC2-01a-LSP 읽기 navigation | 기존 LSP factory의 capability와 문서 hash/version에 결속한 symbol/definition/references 조회 | count/bytes/depth/deadline·workspace·child read-only 범위 유지; rename/replace 실행을 조회 API에 넣지 않음 |
| MC2-01b 심볼/관계 조회 | definition/reference와 원본 line/hash·선정 사유·index generation | 동명 심볼·외부 파일·ignore 경계 독자 fixture; 현재 generation 아닌 위치를 최신 소스로 반환하지 않음 |
| MC2-01c 요청별 구조 projection | 같은 capture의 ContextPlan 안에서 bytes/token/time/file cap을 적용 | history/tool/output 예약 합계 hard cap 유지; 불확실 token 모델은 기존 보수 정책; parser 실패 시 기존 bounded 검색으로 축소 |
| MC2-01d freshness·진단·수용 검증 | 읽기 API와 index generation 진단, 재사용/갱신 이유 | 파일 외부 편집·대규모 저장소·partial build·재시작·취소 검사; index 갱신이 쓰기/명령 권한을 부여하지 않음 |

연결점은 `context/service.ts`, `context/plan.ts`, `context/sources.ts`, `tools/search/index.ts`다. 원본 parser query·ranking 상수·prompt를 port하지 않고 필요한 supported language와 ranking 규칙을 별도 명세한다. 의미 검색을 후속으로 추가한다면 embedding provider·index 저장·자료 전송 선택·모델 revision·source hash를 별도 계약으로 정한다.

### MC2-02 검증 계획·수리·완료 gate

참고: AIDER-C02, plandex-edit-validation-ladder, OHSDK-C3, roo-code-C4, OSWE-C2. 명령·LSP·formatter·checkpoint가 이미 있으므로 새 실행기를 또 만들지 않는다. 새 범위는 **어떤 변경에 어떤 검사를 했고 무엇을 증명했는지**를 영구 기록하고 완료 판단에 연결하는 계층이다. 예상 비용 **M~L**.

| 작은 작업 | 소유할 계약 | 완료 조건 |
|---|---|---|
| MC2-02a 검증 계획 | host 등록 `VerificationPlan` revision·검사 ID·선택 경로·순서·수리 cap | model이 검사 명령/권한을 확장하지 못함; stale plan·checkpoint 거절; 기존 command approval 사용 |
| MC2-02b 결과 receipt | `VerificationReceipt`에 Run/Attempt·파일/checkpoint hash·실제 exit/status·diagnostics·artifact | pass/fail/skipped/unsupported/timeout/cancelled/uncertain 분리; 잘린 로그·수정 중 검사·cleanup unknown을 pass로 기록하지 않음 |
| MC2-02c 제한된 repair | 실패 receipt를 다음 모델 경계에 연결하는 opt-in repair 단계 | 부모 예산 차감; 동일 hash/진단 반복 시 종료; 수리 cap·취소·deny·crash·재전송에 중복 효과 없음 |
| MC2-02d 완료 gate | terminal 기록 전에 필요한 receipt와 결과 schema를 검사 | patch 존재·모델의 완료 선언·Git commit과 test pass 구분; gate 불통과를 명확한 상태로 반환하고 무한 재시도 금지 |

연결점은 `runner/index.ts`, `runner/turn-executor.ts`, `tools/command/index.ts`, `lsp/index.ts`, `formatters/index.ts`, `review/index.ts`다. 기존 Run terminal/recovery를 개편하기 전에 gate의 입력·결과·예외·재시작 규칙을 고정한다. 외부 서비스나 실제 provider 검증은 synthetic 검사와 별도로 완료 표시한다.

### MC2-03 승인형 프로젝트 기억

참고: gemini-memory-inbox, QWEN-C03, GOOSE-C03, K-C02, OSWE-C4, MV-C01. 기존 세션 semantic summary와 skill 읽기를 유지하고, **후보 생성과 활성화**를 분리한다. 예상 비용 **L**.

| 작은 작업 | 소유할 계약 | 완료 조건 |
|---|---|---|
| MC2-03a 후보 저장 | `KnowledgeCandidate`에 workspace/source session·message/hash·scope·target revision·생성 usage | 완료 세션만 bounded 읽기; credential/opaque replay·다른 workspace 제외; 생성만으로 active 지침 변화 0 |
| MC2-03b 읽기 전용 추출 | host opt-in, tools 없는 bounded model 요청과 후보 inbox | budget·cleanup/recovery 유지; 중복 source revision을 dedupe; 추출 실패가 source Run을 재실행하지 않음 |
| MC2-03c publication·철회 | exact candidate hash/target revision에 결속한 승인·CAS·journal | stale 수락 거절; accept/deny/revoke·crash·재전송에서 중복 활성화 0; 기존 skill 수정도 동일 승인 계약 사용 |
| MC2-03d context 연결 | active scope/revision·출처·expiry를 가진 bounded projection | 과거 관찰을 현재 파일 상태로 표시하지 않음; 충돌 기억·삭제 source·권한 철회·예산 초과 결과를 설명 가능하게 기록 |

연결점은 `context/semantic-memory.ts`, `context/sources.ts`, `context/service.ts`, `tools/session/skills.ts`, `session-state/index.ts`, `storage/native.ts`다. model이 추출한 기억에서 새 실행 권한·hook·plugin을 자동 활성화하지 않는다.

## 그다음 확장 순서

| 묶음 | 새 계약과 기존 연결점 | 선행 조건·검증 초점 | 비용 |
|---|---|---|---|
| MC2-04 typed lifecycle | 하나의 hook registry/revision/순서·typed context/deny/stop; 기존 metadata observer 유지 | MC2-02와 request capture 명세; prepare 이전 변환만 허용, 승인 이후 변경 거절, post-effect 실패가 재실행을 만들지 않음 | M~L |
| MC2-05 proposal overlay | 미적용 변경 집합·base hash·proposal revision·review/apply receipt | 기존 exact patch/preview/checkpoint 활용; 다중 파일 외부 편집·partial apply·crash 보존; OS sandbox라는 명칭 사용 안 함 | L |
| MC2-06 live child/team mailbox | sender/member lineage·message ID·durable receipt·read cursor·owner/dependency CAS | 기존 terminal inbox·worktree·budget/deny 상속 유지; 상주 세션과 parent join을 분리; overflow/종료/재시작 시험 | L |
| MC2-07 역할 workflow·recipe | profile/revision별 plan→edit→verify 단계, artifact hash·durable join·parameter/result schema | MC2-02와 기존 child 기반; 상태 전환 CAS·단계 budget·stale 설계·중복 handoff/submit 검사 | L |
| MC2-08 schedule·batch·feedback | occurrence/PR SHA/task attempt identity·claim lease·missed-run 정책 | 기존 durable input 사용; 실제 실행 ownership 확인 없이 lease 만료만으로 재실행 금지; 배포 계정 호출은 별도 검증 | L |
| MC2-09 ACP/remote host | capability·connection epoch·launch binding·request/replay ID·문맥 소유권·approval identity·client 효과 receipt | 기존 host/provider/MCP와 protocol 차이 명세; disconnect·late approval·owner 교체·accepted 효과 uncertainty 검사; client 수신 ack를 실제 효과 완료로 승격하지 않음 | L |
| MC2-10 background job | Run과 별도인 command job owner·로그 artifact·cancel/exit receipt·completion delivery | 기존 PTY/supervisor 포트; Run 종료 이후 물리적 ownership, reconnect·orphan·dup delivery 검증 | L |
| MC2-11 권한·OS 격리 | role file/MCP resource 범위·preflight 판단 출처·실제 OS enforcement capability | 기존 deny 우선·exact approval 유지; role policy와 kernel 격리 구분; 지원 OS 실측이 있어야 enforcement 완료 | M~XL |
| MC2-12 관측·선택 실험 | 고정 journal trajectory/manifest·artifact 요약·결과/효과 epoch 무진전 진단; 이후 semantic embedding/code-mode/fork/video | 단순 진단부터; 원본 receipt 보존·source hash·budget·unknown 표시. 같은 실패 관측이 무조건 재실행을 유발하지 않음; code-mode와 video는 기본 기능으로 묶지 않음 | S~XL |

후보 비용은 구현 범위·외부 의존성·영구 상태·실제 환경 검증의 상대 추정이다. 우선순위는 프로젝트 인기나 README 기능 수를 점수화한 결과가 아니다. 작은 진단·결과 projection은 큰 구현과 독립 진행할 수 있지만 `runner`·`storage`·`contracts` 변경은 담당을 나누고 공통 타입·version·migration 계약을 먼저 고정한다.

## 기존 이월 항목과 완료 기준

이 비교는 기존 E5-13 media/provider 실제 검증, E5-08 native Windows/OS ownership, E6-07 실제 CI, E6-08 지원 명세 확정의 네 열린 항목을 대체하지 않는다. GUI에 새 기능을 노출한 상태도 아니다. 1차 종료 source와 검증 기록은 그대로 보존한다.

후속 묶음 하나를 시작할 때 공통 [독립 구현 수용 조건](independent-contracts.md)에 따라 host API·영구 record·projection·허용 효과·cancel/recovery·예산과 종료 조건을 먼저 작성한다. 독자 fixture와 실제 지원 환경 검증을 통과한 범위만 TODO 완료로 표시한다. 외부 모델/환경이 없으면 해당 항목을 pending으로 남기고 성공으로 간주하지 않는다. 원본과 비슷한 API 이름·UI 설명을 추가한 것만으로 기능 완료를 세지 않는다.
