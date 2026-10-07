# 19개 엔진과 현재 Moodcode의 1:1 비교

비교일 2026-10-07. Moodcode HEAD `e8b0d565828f6c0370424152505a9f6a8497482f`, 실제 engine source `464812f7d1af24466f57070663131f5979aeca51`. production 파일의 차이 0을 확인한 고정 기준이다. 19개별 보고서의 source HEAD를 그대로 유지하고 **14개 공통 기능 × 19개 = 266개 대조**와 **후보 75개 전수 매핑**을 작성했다. [기계 판독 데이터](one-to-one-comparison.json), [현재 소스 근거 35개](comparison-evidence.md), [구현 상세](implementation-blueprint.md)를 따른다.

## 판단 방법

| 표시 | 의미 |
|---|---|
| 기구현 | 대표 upstream 동작에 대응하는 엔진 기반 계약이 현재 소스에 있다. 제품 전체/동일 성능/지원 모델 동등성을 뜻하지 않는다. |
| 부분 | 관련 기반은 있으나 비교한 추가 계약·상태·조회/실행 경계가 필요하다. |
| 추가 | 비교한 특정 capability를 추가해야 한다. 해당 기능 범주의 기반 전체가 없다는 뜻은 아니다. |
| 검증대기 | 로컬 계약/일부 구현은 있으나 실제 계정·OS·배포 환경의 증거가 추가로 필요하다. |
| 범위제한 | upstream가 외부/역사적/미분석 경계이거나 현재 근거로 전체 동등성을 판정할 수 없다. |

현재 실행 루프·영구 이력·정확한 승인·child 격리·효과 복구 기반은 이미 있다. 우선 차이는 심볼/구조 탐색, 검사 결과에 결속한 완료, 승인 후 재사용하는 프로젝트 기억이다. live team·workflow·background job·scheduler·ACP는 별도의 영구 상태와 실행 계약을 추가해야 한다. OS 격리와 실제 모델/CI 지원은 환경 증거가 필요한 범위다.

모든 판단은 정적 source/port·등록·effect 경계에 대한 것이다. 확인한 범위에서 더 강한 정확성/권한 binding이 있다는 사실을 제품 전체 우월성으로 일반화하지 않았다. README 주장·optional/default·historical implementation·external dependency를 sourceCondition으로 구분했다. 조사한 source에 특정 API가 안 보인다는 이유로 제품 전체에 기능이 없다고 단정하지 않는다.

기존 1차의 2,594 pass·타입 검사·fixture3/3·Codex live1은 원래 검증 기록이며 이번 비교에서 재실행한 결과가 아니다. 이 문서는 engine 구현·새 goal·GUI 실행을 시작하지 않는다. 실제 OS/provider/CI의 열린 네 항목은 그대로 유지한다.

## 현재 기능별 근거

| 기능 | 현재 Moodcode 계약 | 소스 근거 |
|---|---|---|
| 모델·실행 루프 | 독립 TS engine/host·typed ProviderAdapter와 durable Turn/Attempt. 공급자·모델 ID/retry/capability를 고정한다. | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) |
| 입력·큐·steer | durable queue/steer·exact input dedupe·pause/resume·FIFO/workspace fairness. cron과 team mailbox는 별도다. | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) |
| 문맥·압축·예산 | bounded SQL history·complete exchange·latest anchor·별도 semantic summary·동일 tool/context capture와 hard cap. | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) |
| 저장소 검색·LSP | bounded glob/regex·ignore·LSP 문서 version/hash와 diagnostic/format. 심볼 graph·navigation·vector retrieval은 추가 계약이다. | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) |
| 지침·skill·프로젝트 기억 | nested instruction·session semantic memory·bounded skill/reference 읽기. session 간 승인 publication·활성화/철회는 추가 계약이다. | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) |
| 편집·검토·worktree | exact hash patch/edit/rename/delete·checkpoint/diff·stale restore·격리 worktree. 미적용 proposal overlay와 전용 Git commit receipt는 추가다. | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) |
| 승인·정책 | deny 우선·Plan read/state·Build effect 승인·scope grant revision·opaque prepared fingerprint·승인 후 재검사. | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) |
| 명령·background·격리 | approved run_command·supervisor·POSIX group·host user-owned PTY. 지속 model job/OS file-network sandbox/native Windows 실측은 추가 또는 이월이다. | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) |
| 취소·crash·효과 복구 | parent cancel·provider/tool cleanup·원래 owner의 native/MCP receipt·unknown quarantine·자동 효과 replay 차단. | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) |
| 저장·이력·archive | SQLite native inbox/Turn/Attempt/Part/context/journal·bounded 읽기·archive audit 및 pause import. JSON transcript와 효과 재개를 구분한다. | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) |
| profile·child·team | immutable profile·별도 DB/worktree child/grandchild·budget/deny/cancel 상속·terminal result inbox·승인 merge. live mailbox/역할 join은 추가다. | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) |
| plugin·hook·MCP·ACP | explicit host plugin·metadata prepared/settled observer·scoped MCP stdio/HTTP/discovery/resources. 제어 lifecycle/ACP/remote client effect는 추가다. | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) |
| 검증·진단·자동화 | 명령/LSP/formatter·artifact paging·usage/diagnostics·headless fixture/평가 기반. verification gate·repair workflow·schedule/CI watch는 추가다. | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) |
| 이미지·문서·추가 형식 | image/PDF refs·explicit capability·공유 byte cap·history/archive. 원격 인식/여러 계정·audio/video/output 및 OS/CI 지원 확인은 이월이다. | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) |

## 저장소별 판정 목차

| 저장소 | 기구현 | 부분 | 추가 | 검증대기 | 범위제한 | 후보 |
|---|---:|---:|---:|---:|---:|---:|
| [Aider](#aider) | 7 | 4 | 0 | 0 | 3 | 4 |
| [Plandex](#plandex) | 6 | 5 | 0 | 0 | 3 | 4 |
| [Qwen Code](#qwen-code) | 5 | 5 | 0 | 0 | 4 | 5 |
| [Gemini CLI](#gemini-cli) | 6 | 5 | 1 | 0 | 2 | 4 |
| [Cline](#cline) | 6 | 4 | 0 | 0 | 4 | 4 |
| [Goose](#goose) | 6 | 5 | 0 | 0 | 3 | 5 |
| [OpenHands SDK](#openhands-sdk) | 6 | 6 | 0 | 0 | 2 | 4 |
| [Zoo Code](#zoo-code) | 6 | 6 | 0 | 0 | 2 | 4 |
| [Mistral Vibe](#mistral-vibe) | 6 | 5 | 0 | 0 | 3 | 4 |
| [Kimi Code](#kimi-code) | 7 | 6 | 0 | 0 | 1 | 4 |
| [Kilo Code](#kilocode) | 7 | 4 | 0 | 1 | 2 | 3 |
| [mini-SWE-agent](#mini-swe-agent) | 5 | 3 | 0 | 1 | 5 | 4 |
| [Open SWE](#open-swe) | 4 | 6 | 0 | 0 | 4 | 4 |
| [Roo Code](#roo-code) | 7 | 4 | 0 | 0 | 3 | 4 |
| [Continue](#continue) | 8 | 4 | 0 | 0 | 2 | 3 |
| [SWE-agent](#swe-agent) | 5 | 5 | 0 | 0 | 4 | 4 |
| [구 Kimi CLI](#kimi-cli-legacy) | 7 | 5 | 0 | 0 | 2 | 4 |
| [Crush](#crush) | 8 | 4 | 0 | 1 | 1 | 4 |
| [OpenHands 앱/Agent Canvas](#openhands-app) | 2 | 7 | 0 | 0 | 5 | 3 |

이 수치는 표의 14개 범주에 붙인 판정 개수다. 기능 난이도·업무 성능·실제 지원 환경을 가중한 완료율이 아니며 제품 비교 점수로 사용하지 않는다.

<a id="aider"></a>
## Aider ↔ Moodcode

원본 `Aider-AI/aider` · full SHA `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` · root `Apache-2.0`. 원본 evidence ID는 [Aider 보고서](aider.md)와 [aider.evidence.json](aider.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | Coder 편집 format 선택→LiteLLM completion→text/function/reasoning stream. (확인; AIDER-R01, AIDER-R02, AIDER-R04, AIDER-R05) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | 현재 provider loop 유지; 편집 format별 runner를 복제하지 않는다. |
| 입력·큐·steer · **기구현** | 반사 메시지를 제한 횟수 재전송하는 순차 대화 루프. (확인; AIDER-R03) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | Moodcode durable inbox·Turn/Attempt와 일반 reflection을 구분한다. |
| 문맥·압축·예산 · **기구현** | repo map·읽기/편집 파일·summary·최근 대화로 chat chunk 구성. (확인; AIDER-R06, AIDER-R13) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | hard ContextPlan과 완전 exchange를 보존; summary를 재구현하지 않는다. |
| 저장소 검색·LSP · **부분** | tree-sitter 정의/참조·PageRank·token 맞춤 repo map; 목표 15% 여유 조건. (확인; AIDER-R07, AIDER-R08, AIDER-R09) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | source hash/parser revision 심볼 지도·요청별 선정 추가; 예산은 hard cap 유지. [MC2-01] |
| 지침·skill·프로젝트 기억 · **기구현** | 오래된 대화를 최근 tail과 분리해 요약. (확인; AIDER-R13) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 기존 세션 요약 대응. cross-session 승인 기억은 별도 제안이며 이 경로의 기능이라고 하지 않는다. |
| 편집·검토·worktree · **부분** | 편집 dry-run·반사, edited file auto commit·조건부 undo. (확인; AIDER-R10, AIDER-R15, AIDER-R16) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | exact edit/restore 유지; opt-in commit preview/receipt 추가 후보. 사용자 dirty baseline 자동 commit은 채택하지 않는다. [MC2-13] |
| 승인·정책 · **기구현** | chat 파일 편집 허용, 새 파일 확인·Git ignore 처리. (확인; AIDER-R11) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | deny/Plan/exact hash 승인 유지; chat 포함을 자동 effect 권한으로 쓰지 않는다. |
| 명령·background·격리 · **범위제한** | 편집 후 제안 명령 경로를 확인했지만 물리적 명령 ownership/sandbox 전체는 미검토. (미확인; AIDER-R12) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | 기존 supervisor/PTY·backend capability 기준 유지; 기본 OS 격리 동등성 판단 제외. |
| 취소·crash·효과 복구 · **기구현** | provider 오류 제한 재시도·ContextWindowExceeded/KeyboardInterrupt 경계. (확인; AIDER-R18) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | 현재 durable Attempt/cleanup proof 유지; 원격 효과 취소 성공으로 확대하지 않는다. |
| 저장·이력·archive · **기구현** | Markdown 대화 append, 기록 실패 시 비활성화. (확인; AIDER-R17) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | 현재 SQLite native journal/복구 보존; 단순 transcript append로 치환하지 않는다. |
| profile·child·team · **부분** | 확인된 architect 응답을 별도 editor model/Coder에 전달. (확인; AIDER-R14) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | profile별 planner/editor artifact binding·단계 Run/예산·stale 설계 검사 추가. [MC2-07] |
| plugin·hook·MCP·ACP · **범위제한** | 모델 YAML/metadata 등록 경계 확인; MCP/ACP·일반 lifecycle은 이 범위에서 미확인. (미확인; AIDER-R19) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | 설정 metadata와 executable plugin을 구분; 무리한 protocol parity 요구 제외. |
| 검증·진단·자동화 · **부분** | commit 이후 lint·실패 reflection; auto-test 옵션에 따라 test 실행. (조건부; AIDER-R12) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 검증 plan/receipt·제한 repair·완료 gate 추가. commit과 test pass를 분리. [MC2-02] |
| 이미지·문서·추가 형식 · **범위제한** | 이 보고서에서는 전체 이미지/음성/영상 adapter 수명을 확인하지 않았다. (미확인; 대표 근거 범위 밖) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | Moodcode image/PDF 계약·실제 계정 검증 상태만 기록한다. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **AIDER-C01** · 심볼 관계를 이용한 저장소 구조 문맥 선정 | bounded context·history summary·glob/regex 검색은 구현되어 있다. 확인한 context/search 경로에는 심볼 정의·참조 그래프를 요청별 구조 문맥으로 투영하는 계약이 확인되지 않았다. **추가 계약 필요** | [MC2-01](implementation-blueprint.md#mc2-01) · P1 · 우선 확장 |
| **AIDER-C02** · 명시적 검증 계획과 제한된 수리 단계 | run_command·도구 오류의 모델 피드백·LSP 진단·formatter·checkpoint 연동은 구현되어 있다. 후보는 이 기능들을 대체하지 않고 검증 계획/결과/수리 종료 조건을 명시적으로 기록하는 계층이다. **추가 계약 필요** | [MC2-02](implementation-blueprint.md#mc2-02) · P1 · 우선 확장 |
| **AIDER-C03** · 설계와 편집 모델 역할을 연결하는 선택적 워크플로 | immutable agent profile와 모델 설정, 실제 격리 child, 승인된 read-only delegate_task가 이미 있다. 후보는 서로 다른 profile의 설계 출력→편집 실행을 명시적으로 결속하는 직렬 워크플로다. **추가 계약 필요** | [MC2-07](implementation-blueprint.md#mc2-07) · P2 · 후속 확장 |
| **AIDER-C04** · Run 변경과 연결한 승인형 Git 커밋 기록 | Git worktree·child 변경 통합·hash checkpoint·diff·restore journal은 구현되어 있다. 범용 run_command로 사용자가 Git을 실행할 수도 있다. 후보는 커밋 preview와 실제 commit receipt를 Run 변경에 결속하는 전용 host 계약이다. **추가 계약 필요** | [MC2-13](implementation-blueprint.md#mc2-13) · P3 · 선택/환경 검증 후 확장 |

<a id="plandex"></a>
## Plandex ↔ Moodcode

원본 `plandex-ai/plandex` · full SHA `e2d772072efadbe41d2946d97d79be55532dbab5` · root `MIT`. 원본 evidence ID는 [Plandex 보고서](plandex.md)와 [plandex.evidence.json](plandex.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | CLI TellPlan→Go server role 선택→Chat stream→파일 operation build→다음 iteration. (확인; R01, R02, R03, R04, R05) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | 현재 TS engine/provider/host 분리 유지; 서버/CLI 이중 engine 도입 불필요. |
| 입력·큐·steer · **기구현** | 파일별 active build가 없을 때 큐의 goroutine 시작. (확인; R19) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | 현 inbox/workspace fairness를 보존하고 역할 workflow admission은 별도 상태로 둔다. |
| 문맥·압축·예산 · **부분** | subtask UsesFiles 선택·pending 파일 본문을 context에 우선 적용. (확인; R06, R07) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | 작업별 source manifest·proposal projection 추가; 동일 capture/예약 유지. |
| 저장소 검색·LSP · **부분** | signature/comment/children 기반 file map과 입력 SHA·token 저장. (확인; R08, R09) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | parser/source identity별 repo map과 변경 무효화 추가. [MC2-01] |
| 지침·skill·프로젝트 기억 · **범위제한** | 작업 파일 context/map을 확인; 세션 간 학습 기억 publication은 미확인. (미확인; R06, R09) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 프로젝트 지도와 지속 기억을 구분; 기억 동등성 판단 제외. |
| 편집·검토·worktree · **부분** | 누적 pending 변경 결과·review 이후 CLI 실제 ApplyFiles. (확인; R07, R10, R11) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | 미적용 ProposalSet overlay→exact apply receipt 추가. 기존 checkpoint restore와 구분. [MC2-05] |
| 승인·정책 · **기구현** | CLI 사용자 확인·autonomy 설정 이후 파일/로컬 shell 효과. (확인; R11, R12) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | 현재 exact approval/deny 보존; autonomy 설정으로 권한을 넓히지 않는다. |
| 명령·background·격리 · **기구현** | CLI 프로젝트 root/current env의 로컬 shell 및 정리 설정. (확인; R12) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | 기존 approved command 사용; pending diff sandbox를 OS 파일/네트워크 격리라고 하지 않는다. |
| 취소·crash·효과 복구 · **기구현** | 취소/경합 결과·부분 assistant reply 저장. (확인; R14, R16) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | current effect uncertainty/recovery 유지; 첫 성공 winner가 다른 작업의 물리 정리를 증명하지 않는다. |
| 저장·이력·archive · **기구현** | plan 저장소 Git branch 및 read/write lock. (확인; R17, R18) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | 현재 SQLite/owner/managed worktree 보존; plan branch와 파일 worktree를 구분. |
| profile·child·team · **부분** | architect/planner/coder·StrongModel escalation. (확인; R02, R13) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | 역할 workflow·검증 receipt 기반 escalation 추가; provider retry와 역할 전환 분리. [MC2-07] |
| plugin·hook·MCP·ACP · **범위제한** | 공급자 auth/BaseURL adapter 확인; MCP/ACP/hook 상세는 미검토. (미확인; R20) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | 외부 protocol/등록 기능은 기존 host 계약을 유지한다. |
| 검증·진단·자동화 · **부분** | 모델 valid·문법 검사와 실패 debug 후 재적용 attempt. (확인; R13, R15) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 정적/명령/model 검사 결과를 분리해 bounded repair·완료 gate로 연결. [MC2-02] |
| 이미지·문서·추가 형식 · **범위제한** | 전체 media adapter·원격 인식 품질은 미확인. (미확인; 대표 근거 범위 밖) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | 기존 image/PDF 및 E5-13 실제 검증을 유지한다. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **plandex-task-context-map** · 버전 고정 프로젝트 map과 작업별 파일 문맥 선택 | 부분 구현: bounded ContextPlan·지침 baseline·문서 버전·CAS task는 존재한다. task별 파일 의존성과 syntax map projection 계약은 확인한 경로에 없다. **추가 계약 필요** | [MC2-01](implementation-blueprint.md#mc2-01) · P1 · 우선 확장 |
| **plandex-review-proposal-overlay** · 미적용 변경 집합과 모델 문맥의 proposal overlay | 부분 구현: fingerprint approval·checkpoint 누적 diff·restore·격리 worktree/child merge는 이미 존재한다. 여러 turn의 미적용 제안에 대한 독립 overlay/revision 계약은 별도 후보다. **추가 계약 필요** | [MC2-05](implementation-blueprint.md#mc2-05) · P2 · 후속 확장 |
| **plandex-edit-validation-ladder** · 관측 결과를 남기는 제한된 편집 검증·복구 단계 | 부분 구현: 정확한 hash 편집·formatter/LSP·명령 도구·provider retry는 있다. 제안의 문법/명령 검증을 다음 repair 시도와 묶는 bounded 상태 기계는 별도 후보다. **추가 계약 필요** | [MC2-02](implementation-blueprint.md#mc2-02) · P1 · 우선 확장 |
| **plandex-model-role-routing** · 단계별 모델 역할과 증거 기반 escalation 기록 | 부분 구현: AgentProfiles의 immutable revision·model/tool/config binding 및 durable Turn/Attempt가 있다. 한 작업 안의 계획/편집 검증별 route 선택·escalation 계약은 추가 범위다. **추가 계약 필요** | [MC2-07](implementation-blueprint.md#mc2-07) · P2 · 후속 확장 |

<a id="qwen-code"></a>
## Qwen Code ↔ Moodcode

원본 `QwenLM/qwen-code` · full SHA `d0ddd020c8a64279e290538f84b152fe843ed9d4` · root `Apache-2.0`. 원본 evidence ID는 [Qwen Code 보고서](qwen-code.md)와 [qwen-code.evidence.json](qwen-code.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | 독자 LlmClient/Turn/Chat와 provider lazy adapter·typed streaming. (확인; QWEN-R03, QWEN-R04, QWEN-R05, QWEN-R07) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | 현재 loop/provider capture 보존; Gemini fork 전체를 동일 구현으로 간주하지 않는다. |
| 입력·큐·steer · **부분** | resident continuation을 새 turn에 직렬 연결·leader inbox/teammate queue. (확인; QWEN-R04, QWEN-R13, QWEN-R14) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | durable root input 유지; child continuation·mailbox receipt·member generation 추가. |
| 문맥·압축·예산 · **기구현** | window 사전 압축·hard rescue 실패시 이전 history/count 복구. (확인; QWEN-R06) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | 같은 ContextPlan·complete exchange·semantic attempt publication 보존. |
| 저장소 검색·LSP · **범위제한** | 확인한 memory 검색은 keyword/rarity이며 repository vector index와 다르다. (미확인; QWEN-R10) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | repo semantic 검색이 이 경로에 있다고 주장하지 않는다. |
| 지침·skill·프로젝트 기억 · **부분** | auto extraction/dream·skill review threshold·confirmBeforePersist staging. (조건부; QWEN-R09, QWEN-R10, QWEN-R11) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 후보 추출과 승인 활성화 분리. 기존 skill 직접 수정 예외를 Moodcode 계약으로 채택하지 않는다. [MC2-03] |
| 편집·검토·worktree · **범위제한** | nested scheduler dispatch는 확인했지만 모든 native 편집/복원 preimage는 미검토. (미확인; QWEN-R08) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | 현재 exact edit/restore 보존; repo 전체 편집 동등성 판정 제외. |
| 승인·정책 · **기구현** | scheduler allowed tools/parent identity·resident auto-permission lease. (확인; QWEN-R08, QWEN-R13) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | 기존 deny/예산 상속 유지; 상주 재개가 새 자동 승인 권한을 만들지 않게 한다. |
| 명령·background·격리 · **범위제한** | code-mode는 별도 host process/cap를 쓰지만 모든 shell/OS sandbox 수명은 미확인. (미확인; QWEN-R16) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | QuickJS/Wasm 제한과 물리 OS file/network 격리를 구분. |
| 취소·crash·효과 복구 · **기구현** | provider abort·nested call 정리·interrupted tool turn 확인 필요. (확인; QWEN-R05, QWEN-R16, QWEN-R20) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | 현재 exact effect frontier/uncertainty 유지; synthetic history 복구를 효과 완료로 인정하지 않는다. |
| 저장·이력·archive · **기구현** | 직렬 기록 sink/lease·첫 기록 실패 중단·orphan exchange 조정. (확인; QWEN-R19, QWEN-R20) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | durable native records/raw replay 유지; 오류 보정의 원본 출처를 보존. |
| profile·child·team · **부분** | cold revive·resident continuation·team mailbox·owner board task. (확인; QWEN-R12, QWEN-R13, QWEN-R14, QWEN-R15) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | 실제 child DB/worktree에 live message·owner/dependency CAS·세대별 재개 추가. [MC2-06] |
| plugin·hook·MCP·ACP · **부분** | code-mode nested dispatch·lifecycle hooks·typed MCP call. (확인; QWEN-R16, QWEN-R17, QWEN-R18) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | MCP는 보존; typed lifecycle 먼저, code-mode는 후속 opt-in 실험. [MC2-04, MC2-15] |
| 검증·진단·자동화 · **부분** | structured_output 성공으로 종료하는 별도 경로. (조건부; QWEN-R03) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | schema-valid 출력과 lint/test receipt를 분리; 일반 완료 gate와 결속. |
| 이미지·문서·추가 형식 · **범위제한** | 여러 adapter는 확인했지만 모든 media/protocol 계정 경로는 미검토. (미확인; QWEN-R07) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | provider 수를 모델별 실제 media 지원 개수로 세지 않는다. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **QWEN-C01** · 같은 child 세션에 후속 입력을 보내는 상주 실행 계약 | 격리 child/worktree·예산/deny/cancel 상속·terminal 결과 root inbox delivery·queue/steer·pause/resume는 이미 있다. 후보는 child terminal 결과 통지를 대체하지 않고 같은 agent identity의 여러 Run과 살아 있는 입력 mailbox를 연결한다. **추가 계약 필요** | [MC2-06](implementation-blueprint.md#mc2-06) · P2 · 후속 확장 |
| **QWEN-C02** · 여러 agent의 팀 mailbox와 task owner·의존 관계 | agent profiles, session task CAS, 실제 child와 root 결과 delivery는 구현되어 있다. 후보는 팀 membership·recipient mailbox·task owner/의존성·leader 활동 대기를 추가하는 계층이다. **추가 계약 필요** | [MC2-06](implementation-blueprint.md#mc2-06) · P2 · 후속 확장 |
| **QWEN-C03** · 이력에서 제안한 프로젝트 기억·skill의 승인된 발행 | bounded context·completed-history semantic summary·active-prefix checkpoint·skill_list/skill_read/reference_read는 이미 있다. 후보는 session 요약과 별개인 프로젝트/사용자 지속 기억 및 신규·기존 skill 변경의 publication 계약이다. **추가 계약 필요** | [MC2-03](implementation-blueprint.md#mc2-03) · P1 · 우선 확장 |
| **QWEN-C04** · 제한된 JavaScript로 기존 도구를 조합하는 선택적 code-mode | scoped tool runtime·same capture와 ContextPlan·discover_tools·exact prepare/approval/effect·출력 artifact·MCP/PTY/cancel은 이미 있다. 후보는 그 계약 위에서 실행되는 제한된 orchestration 언어다. **추가 계약 필요** | [MC2-15](implementation-blueprint.md#mc2-15) · P3 · 선택/환경 검증 후 확장 |
| **QWEN-C05** · 승인 binding을 유지하는 lifecycle hook 추가 계약 | host plugin activation/disposal과 prepared/settled metadata 관측 hooks가 이미 있다. 후보는 prompt/session/context/terminal lifecycle 관측과 제한된 다음-turn 제안이다. **추가 계약 필요** | [MC2-04](implementation-blueprint.md#mc2-04) · P1 · 우선 확장 |

<a id="gemini-cli"></a>
## Gemini CLI ↔ Moodcode

원본 `google-gemini/gemini-cli` · full SHA `ef59c532f07fbb3a58dd68bac024ae217e9c73ce` · root `Apache-2.0`. 원본 evidence ID는 [Gemini CLI 보고서](gemini-cli.md)와 [gemini-cli.evidence.json](gemini-cli.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | headless→typed Turn events→Scheduler 도구 실행; Google ContentGenerator 경계. (확인; G01, G02, G04, G18) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | provider 구조 유지; 모든 Gemini 모델 계정 호환성까지 완료로 표시하지 않는다. |
| 입력·큐·steer · **기구현** | 수집한 tool request를 scheduler에 전달. (확인; G02) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | 도구 스케줄링과 durable user queue/steer를 구분; 기존 input 계약 유지. |
| 문맥·압축·예산 · **부분** | context renderer/압축 선택·큰 결과 distillation·커진 요약 거절. (확인; G03, G08, G09) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | 기존 semantic summary는 대응; 개별 artifact-bound 도구 결과 요약 추가 후보. [MC2-12] |
| 저장소 검색·LSP · **범위제한** | 대표 근거에서는 전체 symbol/vector repo index 수명을 확인하지 않았다. (미확인; 대표 근거 범위 밖) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | 기존 regex/LSP 유지; 일반 검색이라는 이름만으로 map 동등성 판단하지 않는다. |
| 지침·skill·프로젝트 기억 · **부분** | trusted JIT 지침·scope skill 우선순위·memory 후보 inbox. (확인; G10, G11, G16) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 승인된 지침 activation/revoke 및 cross-session KnowledgeCandidate publication 추가. [MC2-03] |
| 편집·검토·worktree · **기구현** | Git snapshot·model/UI history·원 tool request checkpoint JSON. (확인; G13) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | 현재 hash checkpoint·exact restore 보존; 두 history와 파일 효과를 같은 rewind로 묶지 않는다. |
| 승인·정책 · **기구현** | 입력 수정 후 policy·승인 및 sandbox 권한 확대. (확인; G06, G07, G20) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | deny/Plan/exact fingerprint 유지; hook rewrite는 prepare 이전 새 승인으로만 허용. |
| 명령·background·격리 · **추가** | sandbox enabled에서 OS별 manager, disabled에서는 Noop; denial 후 추가 권한 요청. (조건부; G19, G20) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | 실제 file/network enforcement backend는 별도 opt-in. Windows Job port와 OS sandbox를 구분. [MC2-17] |
| 취소·crash·효과 복구 · **기구현** | MCP outer abort race와 hook subprocess timeout/강제 종료 시도. (확인; G14, G17) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | Moodcode request-local cleanup·unknown 격리 유지; 로컬 await 종료를 원격 rollback으로 승격 금지. |
| 저장·이력·archive · **기구현** | JSONL append·ENOSPC 비활성화·checkpoint metadata. (확인; G12, G13) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | 기존 DB9/원래 owner proof/archives 유지; 단순 기록 실패 허용을 이식하지 않는다. |
| profile·child·team · **부분** | subagent completion tool이 없으면 protocol 오류. (확인; G15) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | 기존 worktree child에 structured completion/validation gate 확장; live team은 별도 비교. |
| plugin·hook·MCP·ACP · **부분** | BeforeModel/ToolSelection/Tool·command hooks·MCP. (확인; G05, G06, G14, G17) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | metadata observer를 typed lifecycle로 확장; 현재 scoped MCP 구현은 보존. [MC2-04] |
| 검증·진단·자동화 · **부분** | complete_task 호출 자체를 subagent 완료 조건으로 사용. (확인; G15) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 명시적 완료 형식과 실제 검사 pass receipt를 구분하는 gate 추가. |
| 이미지·문서·추가 형식 · **범위제한** | Google SDK adapter가 있으나 이 분석에서 모든 media request/계정은 실측하지 않았다. (미확인; G18) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | image/PDF 기존 구현과 실제 모델 검증 이월을 별도로 표시. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **gemini-memory-inbox** · 세션을 넘는 기억 후보 검토 inbox | 세션별 semantic summary, durable session documents, bounded skill/reference 읽기는 구현되어 있다. 검토한 경계에서 여러 세션의 관찰을 후보로 추출하고 사용자가 workspace 지침/skill로 승격하는 inbox 계약은 확인하지 못했다. **추가 계약 필요** | [MC2-03](implementation-blueprint.md#mc2-03) · P1 · 우선 확장 |
| **gemini-artifact-distillation** · 원본 artifact에 결합된 큰 도구 결과 요약 | bounded ToolResultEnvelope의 display/model/data 분리, ArtifactStore/read_artifact 및 대화 semantic summary는 구현되어 있다. 추가 범위는 개별 큰 도구 결과의 선택적 모델 요약이다. **추가 계약 필요** | [MC2-12](implementation-blueprint.md#mc2-12) · P1 · 우선 확장 |
| **gemini-model-lifecycle-hooks** · host 등록 모델·세션 lifecycle hook | EnginePluginManager와 metadata-only PluginToolHooks.prepared/settled는 이미 구현되어 있다. 추가 범위는 session/model/summary 경계의 제한된 observation 및 명시적 veto다. **추가 계약 필요** | [MC2-04](implementation-blueprint.md#mc2-04) · P1 · 우선 확장 |
| **gemini-os-sandbox** · 실제 OS 격리 capability와 제한된 권한 확장 | Plan/Build deny·durable scope grant·POSIX process-group cleanup·injected Windows Job Object port는 있다. CommandBackendCapability는 fileIsolation=false/networkIsolation=false이므로 OS 파일/네트워크 격리는 별도 추가 계약이다. **추가 계약 필요** | [MC2-17](implementation-blueprint.md#mc2-17) · P3 · 선택/환경 검증 후 확장 |

<a id="cline"></a>
## Cline ↔ Moodcode

원본 `cline/cline` · full SHA `55a133b751b66d42b8a3ffad76c731ad4f51577d` · root `Apache-2.0`. 원본 evidence ID는 [Cline 보고서](cline.md)와 [cline.evidence.json](cline.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | SessionRuntime→매 run AgentRuntime→model stream→prepared tools→종료. (확인; CLINE-R04, CLINE-R05, CLINE-R06) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current engine/host/Attempt 소유 유지;이전 VSCode Task를 현재 기본 코어로 재도입하지 않는다. |
| 입력·큐·steer · **부분** | team queued runs·steer 알림·cron due claim/heartbeat. (확인; CLINE-R12, CLINE-R13, CLINE-R16) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | root durable inbox 유지; team mailbox와 occurrence lease scheduler 추가. |
| 문맥·압축·예산 · **기구현** | smaller/target fit compaction과 basic fallback. (확인; CLINE-R09) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | 기존 bounded history·semantic/native cleanup proof 보존; 압축 실패 retry 범위 구분. |
| 저장소 검색·LSP · **범위제한** | 대표 근거에서는 전체 symbol graph/vector index 구현을 확인하지 않았다. (미확인; 대표 근거 범위 밖) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | 기존 search/LSP를 대응 기준으로만 쓰고 제품 전체 index 부재를 단정하지 않는다. |
| 지침·skill·프로젝트 기억 · **범위제한** | plugin context/skills 등 설정 경계 확인; 자동 기억 publication은 별도 미확인. (미확인; CLINE-R18) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 기존 skill/reference 읽기 유지; 보이지 않는 학습 엔진을 가정하지 않는다. |
| 편집·검토·worktree · **기구현** | checkpoint 복원 전 stash/private ref·reset/clean rollback. (확인; CLINE-R11) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | 현재 exact restore·외부 사용자 변경 보존; shadow Git reset을 일반 rollback으로 이식하지 않는다. |
| 승인·정책 · **기구현** | beforeTool/정규화/정책/approval prepare 뒤 실행. (확인; CLINE-R07, CLINE-R08) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | opaque fingerprint와 deny 우선 유지; shared host에서도 같은 승인 binding 사용. |
| 명령·background·격리 · **범위제한** | 도구 실행 signal/lineage는 확인; 모든 subprocess/OS enforcement는 미확인. (미확인; CLINE-R07, CLINE-R08) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | 읽기 외 resource-aware 병렬은 별도 검증·선택 기능으로 둔다. |
| 취소·crash·효과 복구 · **기구현** | startup abort 전달·generation signal과 steer·실행 abort. (확인; CLINE-R04, CLINE-R06, CLINE-R08) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | 현재 실제 cleanup 관측/unknown quarantine 보존; abort 요청과 종료 증명을 구분. |
| 저장·이력·archive · **기구현** | metadata OCC·transcript/compaction 저장·team 이벤트 batch/requeue. (확인; CLINE-R10, CLINE-R14) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | current native journal 보존. 실패 큐 cap의 older event discard를 무손실 durable 송신으로 가정하지 않는다. |
| profile·child·team · **부분** | live teammate mailbox/readAt·member 검증·delegated SessionRuntime. (확인; CLINE-R12, CLINE-R13, CLINE-R15) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | terminal child inbox 위에 durable send/read receipt·team task owner CAS 추가. [MC2-06] |
| plugin·hook·MCP·ACP · **부분** | local/hub/remote host·hook files·plugins·MCP eager tools. (확인; CLINE-R03, CLINE-R17, CLINE-R18, CLINE-R19) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | typed lifecycle/remote host RPC 추가; eager/discovery·exact MCP receipt는 유지. [MC2-04, MC2-09] |
| 검증·진단·자동화 · **부분** | completion tool 종료·cron lease/timeout/concurrency. (확인; CLINE-R05, CLINE-R16) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | completion validation gate·host occurrence scheduler 추가; 도구 성공을 test pass로 표시하지 않는다. [MC2-08] |
| 이미지·문서·추가 형식 · **범위제한** | provider adapter 경계 확인; 실제 전 모델/media 계정은 미확인. (미확인; CLINE-R20) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | 기존 adapter synthetic/live 기록을 각각 유지; JetBrains 비공개 범위 제외. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **CLINE-C01** · 살아 있는 팀 구성원 간 영구 mailbox와 읽음 영수증 | agent profiles·CAS tasks·queue/steer inbox·terminal child result 중복 제거는 기구현. 팀 membership과 비종료 child 간 mailbox/읽음 영수증은 별도 추가 계약. **추가 계약 필요** | [MC2-06](implementation-blueprint.md#mc2-06) · P2 · 후속 확장 |
| **CLINE-C02** · 예약 실행을 기존 영구 inbox에 연결하는 lease scheduler | 영구 inbox·workspace 공정성·pause/resume·profile revision·durable tasks는 기구현. 날짜/cron/event trigger와 occurrence claim은 별도 추가 계약. **추가 계약 필요** | [MC2-08](implementation-blueprint.md#mc2-08) · P2 · 후속 확장 |
| **CLINE-C03** · 승인 binding을 보존하는 typed lifecycle hook | explicit host plugin 등록·prepared/settled metadata hook은 기구현. run/turn 경계의 context contribution·deny/stop 제어 및 prepare 이전 입력 변환은 추가 계약. **추가 계약 필요** | [MC2-04](implementation-blueprint.md#mc2-04) · P1 · 우선 확장 |
| **CLINE-C04** · 공유 daemon·원격 host의 capability RPC와 재연결 계약 | engine/host 분리·Electron utility ownership·event replay·reload detach·sender 검증은 기구현. 여러 클라이언트의 공유 daemon 및 원격 capability RPC는 추가 계약. **추가 계약 필요** | [MC2-09](implementation-blueprint.md#mc2-09) · P2 · 후속 확장 |

<a id="goose"></a>
## Goose ↔ Moodcode

원본 `aaif-goose/goose` · full SHA `f9c18a81952e8895b6f2d88b0f4569f3975034af` · root `Apache-2.0`. 원본 evidence ID는 [Goose 보고서](goose.md)와 [goose.evidence.json](goose.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | Rust Agent.reply 기존 loop·CLI cancellation 연결; state machine 별도 선택. (확인; G03, G04, G19) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | 현재 TS loop 유지; experimental state machine을 upstream 기본 계약으로 간주하지 않는다. |
| 입력·큐·steer · **부분** | 실험 경로에 steer·foreground child·recipe/stop/compaction 상태 operation. (실험; G06) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | 현 durable inbox 대응; 실험 control operation은 별도 typed workflow와 비교. |
| 문맥·압축·예산 · **기구현** | 원본 visibility를 내리고 agent summary/continuation을 추가. (확인; G08) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | raw/native journal과 separate summary lifecycle 보존; visibility와 데이터 삭제 구분. |
| 저장소 검색·LSP · **범위제한** | chatrecall은 세션 검색/발췌이며 repository symbol map과 다르다. (미확인; G11) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | history 검색을 semantic repo index로 세지 않는다. |
| 지침·skill·프로젝트 기억 · **부분** | global/project Memory MCP category file 및 세션 recall. (확인; G10, G11) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 승인형 project memory publication·revision/출처·revoke 추가; 단순 파일 기억 생성은 기본 금지. [MC2-03] |
| 편집·검토·worktree · **범위제한** | extension tool lease/working directory는 확인; 모든 editor/restore 경로는 미검토. (미확인; G07) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | 기존 exact file 효과·worktree·restore 보존. |
| 승인·정책 · **기구현** | inspector approved/needs_approval/denied·scope tool owner. (확인; G05, G07) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | 현재 effect policy/deny/opaque prepare 유지; prompt 확인 문구를 승인 receipt로 쓰지 않는다. |
| 명령·background·격리 · **기구현** | piped shell timeout/cancel kill/wait·bounded process 경계. (확인; G16) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | supervisor/PTY physical cleanup 유지; 모든 daemon/OS sandbox proof로 확대하지 않는다. |
| 취소·crash·효과 복구 · **기구현** | provider cancellation·shell 정리·ACP active run/cancel token. (확인; G04, G16, G17) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | current accepted effect와 미확정 outcome 보존; 외부 ACP 취소는 별도 receipt 계약 필요. |
| 저장·이력·archive · **기구현** | SQLite BEGIN IMMEDIATE message 저장·conversation 교체. (확인; G09) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | native Turn/Attempt/Part/archive 보존; conversation 교체를 effect replay로 쓰지 않는다. |
| profile·child·team · **부분** | recipe parameters/JSON schema·delegated session·실험 foreground join. (조건부; G12, G13, G14) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | profile recipe/role workflow와 durable child join 추가; legacy child Auto 강제는 채택하지 않는다. [MC2-07] |
| plugin·hook·MCP·ACP · **부분** | extension leases·blocking hooks·ACP server/provider·provider-owned context. (확인; G07, G15, G17, G20) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | typed policy hook·ACP handshake/context ownership 추가; MCP runtime은 유지. [MC2-04, MC2-09] |
| 검증·진단·자동화 · **부분** | recipe structured result schema 및 설정 기반 실행. (확인; G12) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 등록 recipe revision·최종 결과 schema·검증 receipt를 분리해 기록. |
| 이미지·문서·추가 형식 · **범위제한** | README의 provider 수/기능 주장은 있지만 media 전체 실측은 없다. (미확인; G01) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | Moodcode image/PDF와 실제 공급자·모델 매트릭스 검증을 분리. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **GOOSE-C01** · 고정된 레시피와 구조화 결과 계약 | agent profile·로컬 skill·child·제한 retry는 구현됨. 재사용 가능한 parameterized workflow 및 최종 JSON schema 결과 계약은 별도 후보다. **추가 계약 필요** | [MC2-07](implementation-blueprint.md#mc2-07) · P2 · 후속 확장 |
| **GOOSE-C02** · ACP host/외부 agent adapter와 문맥 소유권 | engine/host 분리와 provider retry/cancel/recovery·MCP는 구현됨. ACP 세션 bridge와 provider-owned context를 명시하는 계약은 현재 ProviderAdapter와 별도다. **추가 계약 필요** | [MC2-09](implementation-blueprint.md#mc2-09) · P2 · 후속 확장 |
| **GOOSE-C03** · 승인된 프로젝트·사용자 기억 publication | bounded extractive/semantic memory와 session history 검색은 구현됨. 세션 이력과 별도로 프로젝트·사용자 scope에 게시하는 기억 저장소는 추가 후보다. **추가 계약 필요** | [MC2-03](implementation-blueprint.md#mc2-03) · P1 · 우선 확장 |
| **GOOSE-C04** · 제한된 lifecycle policy와 종료 hook | plugin prepared/settled metadata hooks는 이미 구현됨. session/prompt/stop lifecycle 및 deny-only 정책 hook은 추가 계약이다. **추가 계약 필요** | [MC2-04](implementation-blueprint.md#mc2-04) · P1 · 우선 확장 |
| **GOOSE-C05** · 부모 turn의 durable child join과 구조화 집계 | 실제 worktree child·읽기 전용 모델 delegation·budget/deny/cancel 상속·terminal root inbox delivery·artifact paging은 구현됨. 여러 child의 join 조건을 부모 turn에 고정하는 계약이 후보다. **추가 계약 필요** | [MC2-07](implementation-blueprint.md#mc2-07) · P2 · 후속 확장 |

<a id="openhands-sdk"></a>
## OpenHands SDK ↔ Moodcode

원본 `OpenHands/software-agent-sdk` · full SHA `608a102c637d8d8a999f49d7b04846524bd8bd1c` · root `MIT`. 원본 evidence ID는 [OpenHands SDK 보고서](openhands-sdk.md)와 [openhands-sdk.evidence.json](openhands-sdk.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | LocalConversation→Agent step→LLM generate→ActionEvent→typed observation. (확인; S03, S04, S05, S06, S07, S17) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current provider/Turn/Attempt/tool envelope 유지; SDK 전체 runtime 도입 불필요. |
| 입력·큐·steer · **기구현** | state lock/step 경계 pause·interrupt; 승인 대기 상태. (확인; S04, S10) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | 현재 durable queue/steer·workspace admission 유지; step pause를 inbox 완성으로 간주하지 않는다. |
| 문맥·압축·예산 · **기구현** | condenser의 suffix/system/atomic exchange 보호·context 오류 회복. (확인; S05, S12) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | 기존 complete exchange·summary lifecycle와 동일 source/capture 기준 유지. |
| 저장소 검색·LSP · **범위제한** | 전체 repository symbol/vector search 서비스 수명은 대표 근거 밖이다. (미확인; 대표 근거 범위 밖) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | 기존 regex/LSP 유지; 원본 SDK에 없다고 단정하지 않는다. |
| 지침·skill·프로젝트 기억 · **부분** | skills/MCP/hooks/agent definitions와 project persistent 지침 수집. (확인; S15) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 기존 skill 읽기 대응; host trust activation 및 지속 기억 publication은 별도 확장. |
| 편집·검토·worktree · **부분** | 대화 fork/navigate는 workspace 공유; Docker workspace 선택 가능. (확인; S09, S20) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | 대화 branch와 worktree 분리. opt-in fork를 effects-preserved/read-only로 설계. [MC2-14] |
| 승인·정책 · **기구현** | confirmation 판정·child policy/승인 handler 전달. (확인; S06, S14) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | 현재 opaque exact prepare/approval·deny 상속 유지; handler 없음의 자동 판정과 구분. |
| 명령·background·격리 · **부분** | resource-key tool mutex와 fallback tool-name; 원격 Docker workspace. (확인; S11, S20) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | read batch는 기구현. mutating parallel은 prepared resource sets·conflict locks·OS 실측 후 opt-in. [MC2-18] |
| 취소·crash·효과 복구 · **기구현** | interrupt token·MCP reconnect·server lease guard/state publication. (확인; S10, S16, S19) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | 현재 MCP uncertain/owner frontier 유지; reconnect만으로 미확정 효과를 재실행하지 않는다. |
| 저장·이력·archive · **기구현** | FileStore/EventLog 복원·event ancestry·REST/WebSocket ID reconcile. (확인; S08, S09, S18) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | 현재 SQLite raw records/archive 보존; 새로운 conversation fork source manifest만 추가. |
| profile·child·team · **부분** | 부모 cwd의 delegated LocalConversation·child metrics·policy 전달. (확인; S13, S14) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | 현격리 worktree/DB 유지; role handoff와 durable join 추가 후보. 공유 cwd fallback 자동 채택 금지. |
| plugin·hook·MCP·ACP · **부분** | plugin skills/hooks/MCP·remote conversation·server capability/lease. (확인; S15, S16, S18, S19) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | 원격 host reconnect/capability/approval binding 추가; existing MCP exact owner 보존. [MC2-09] |
| 검증·진단·자동화 · **부분** | budget/반복 guard·stop feedback와 승인 대기 종료. (확인; S04) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | terminal 이전 verification/result gate 추가; stop feedback만으로 test pass 표시 금지. [MC2-02] |
| 이미지·문서·추가 형식 · **범위제한** | Responses/Chat mode 분기를 확인했으나 모든 media capability/계정은 미실측. (미확인; S17) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | Moodcode model-specific image/PDF gate와 실제 계정 검증 이월 유지. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **OHSDK-C1** · 실행 효과와 분리된 대화 분기·fork | checkpoint restore·archive·새 session 생성·격리 child는 기구현. 특정 대화 지점에서 별도 문맥 계보를 만드는 공개 계약은 확인한 기준 소스에서 찾지 못했다. **추가 계약 필요** | [MC2-14](implementation-blueprint.md#mc2-14) · P3 · 선택/환경 검증 후 확장 |
| **OHSDK-C2** · prepared 자원 집합을 사용하는 도구 병렬 실행 | runner.executeCalls는 effectClass=read인 연속 도구를 maxReadConcurrency 아래 이미 병렬 실행하고 그 밖의 호출은 순차 실행한다. 범용 파일·terminal·외부 자원 충돌 scheduler는 추가 범위다. **추가 계약 필요** | [MC2-18](implementation-blueprint.md#mc2-18) · P3 · 선택/환경 검증 후 확장 |
| **OHSDK-C3** · terminal 기록 전 완료 검증 gate | plugin prepared/settled metadata hook, session steer boundary, 일반 retry·coding 검증 도구는 기구현. 완료 판정에서 bounded feedback으로 추가 turn을 요청하는 host gate는 별도 계약이다. **추가 계약 필요** | [MC2-02](implementation-blueprint.md#mc2-02) · P1 · 우선 확장 |
| **OHSDK-C4** · 원격 engine host의 재접속·상태 조정 | engine/host 분리, local utility RPC, snapshot/replay·bounded history, durable owner·uncertainty·취소는 기구현. 인증된 REST/WebSocket 또는 동등한 원격 transport와 container workspace 운용은 확인한 host에서 별도 범위다. **추가 계약 필요** | [MC2-09](implementation-blueprint.md#mc2-09) · P2 · 후속 확장 |

<a id="zoo-code"></a>
## Zoo Code ↔ Moodcode

원본 `Zoo-Code-Org/Zoo-Code` · full SHA `842b37e76d296a6381c182f2dad7822da08b9cbb` · root `Apache-2.0`. 원본 evidence ID는 [Zoo Code 보고서](zoo-code.md)와 [zoo-code.evidence.json](zoo-code.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | extension Task loop·stream native parser·동일 extension를 CLI shim에서 사용. (확인; Z03, Z04, Z05, Z20) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current headless engine 유지; VS Code shim 기반의 별도 core 도입 불필요. |
| 입력·큐·steer · **기구현** | TaskScheduler semaphore의 기본 동시성은 1·대기 취소. (확인; Z13) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | current workspace fairness·durable admission 유지; README 병렬과 기본 동시성을 구분. |
| 문맥·압축·예산 · **기구현** | profile threshold summary와 sliding-window fallback. (확인; Z09) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | current ContextPlan/complete exchange·source-preserving summary 유지. |
| 저장소 검색·LSP · **부분** | source index readiness·Semble/Qdrant 분리·path/line/score·외부 embedding. (확인; Z16, Z17, Z18, Z19) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | versioned index/source hash·hybrid retrieval opt-in 추가; 외부 전송은 host 선택 필요. [MC2-01] |
| 지침·skill·프로젝트 기억 · **범위제한** | 세션 간 기억 publication·skill 자동 학습 전체는 미확인. (미확인; 대표 근거 범위 밖) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 현재 instruction/skill read와 session memory 유지. |
| 편집·검토·worktree · **기구현** | shadow Git checkpoint 및 clean/reset 복원. (확인; Z10) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | current exact patch/restore·사용자 변경 보존; Git reset 기반 전체 rollback은 채택하지 않는다. |
| 승인·정책 · **부분** | 도구 expose policy·mode MCP server allowlist·DCG preflight·승인. (확인; Z06, Z14, Z15) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | 기존 deny/grant 유지; role별 server/resource identity와 exact host verdict 추가. [MC2-11] |
| 명령·background·격리 · **부분** | 명령 syntax·외부 DCG verdict·사용자 승인. (확인; Z06) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | preflight analyzer revision/request digest 추가. verdict allow는 existing approval 우회 불가. [MC2-11] |
| 취소·crash·효과 복구 · **기구현** | abort/dispose Promise·HTTP/terminal 정리·orphan child reconcile. (확인; Z07, Z08) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | current physical cleanup/native frontier 유지; 상태 pair 저장을 crash-atomic이라고 하지 않는다. |
| 저장·이력·archive · **기구현** | TaskHistory와 child-parent pair state 업데이트·stale continuation 검사. (확인; Z08, Z12) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | current native CAS/journal 유지; 파일 순차 pair 저장을 DB transaction 대용으로 쓰지 않는다. |
| profile·child·team · **부분** | mode/profile child 위임·parent 중단·child 완료 후 parent 재개. (확인; Z11, Z12) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | durable workflow stage/join CAS 추가; 실제 worktree/DB·budget/deny 상속 보존. [MC2-07] |
| plugin·hook·MCP·ACP · **부분** | profile/mode별 MCP 서버 expose/execute 판정. (확인; Z14, Z15) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | tool 이름 외 server/resource policy를 captured profile revision에 추가; ACP는 미확인. |
| 검증·진단·자동화 · **부분** | 명령 preflight 및 stale parent continuation. (확인; Z06, Z12) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 승인 verdict 진단과 역할 완료 receipt를 추가; generic 검사 pass 보장은 미확인. |
| 이미지·문서·추가 형식 · **범위제한** | provider model-info 동기화는 확인; 모든 media/계정 수명은 미검토. (미확인; Z04) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | 기존 image/PDF support와 runtime 확인 구분. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **zoo-code-C1** · workspace 소스 증거를 가진 의미 코드 검색 | bounded context·semantic history memory·glob/regex·LSP는 이미 구현. 파일 chunk embedding/index 조회는 별도 계약 후보. **추가 계약 필요** | [MC2-01](implementation-blueprint.md#mc2-01) · P1 · 우선 확장 |
| **zoo-code-C2** · 역할 workflow의 durable child 대기·재개 barrier | versioned profiles, 실제 격리 child/worktree, budget·deny·cancel 상속과 terminal 결과 중복 제거 delivery가 이미 있다. 추가 범위는 역할 단계 및 기다리는 child 집합에 binding된 자동 continuation. **추가 계약 필요** | [MC2-07](implementation-blueprint.md#mc2-07) · P2 · 후속 확장 |
| **zoo-code-C3** · profile별 MCP 서버·resource identity 정책 | MCP stdio/HTTP, server scope 등록·revision, profile tools allowlist, bounded discovery, exact 승인 및 uncertainty recovery는 이미 구현. 추가는 tool 이름과 별도로 관리하는 role별 서버/resource allowlist와 공통 노출 판정. **추가 계약 필요** | [MC2-11](implementation-blueprint.md#mc2-11) · P1 · 우선 확장 |
| **zoo-code-C4** · exact command에 binding된 host preflight verdict | 명령 exact prepare/approval/effect, deny 우선 정책, scope grants, process ownership·cleanup recovery와 metadata plugin hooks는 이미 있다. 추가는 명령 구문/위험 판정의 typed preflight 입력·출력 계약. **추가 계약 필요** | [MC2-11](implementation-blueprint.md#mc2-11) · P1 · 우선 확장 |

<a id="mistral-vibe"></a>
## Mistral Vibe ↔ Moodcode

원본 `mistralai/mistral-vibe` · full SHA `7cb91894c40bb25173abcfa36e5ea2b4b81eb28c` · root `Apache-2.0`. 원본 evidence ID는 [Mistral Vibe 보고서](mistral-vibe.md)와 [mistral-vibe.evidence.json](mistral-vibe.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | Unified Harness가 deterministic 기본; action→runtime→core transition. legacy만 flag 선택. (확인; MV-R01, MV-R02, MV-R03, MV-R04) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current TS engine action/effect 계약 유지; legacy Python loop를 기본 엔진으로 참조하지 않는다. |
| 입력·큐·steer · **부분** | pending action transition·영구 child send_message receipt/admission lock. (확인; MV-R03, MV-R12) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | durable input 보존; child generation별 continuation/mailbox 확장. |
| 문맥·압축·예산 · **기구현** | summary와 replacement budget 검증 후 context 교체; 실패 시 보존. (확인; MV-R07) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | 현 source-bound semantic attempt/publication·hard cap 유지. |
| 저장소 검색·LSP · **범위제한** | 파일 읽기 뒤 AGENTS.md 주입을 확인; repository symbol/vector index는 미확인. (미확인; MV-R10) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | 지침 로딩과 semantic repo search를 같은 기능으로 세지 않는다. |
| 지침·skill·프로젝트 기억 · **부분** | trusted cwd/additional roots의 config/tools/skills/hooks·post-read 지침. (확인; MV-R09, MV-R10) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | project trust activation/revoke·source revision capture 추가; 발견만으로 executable 활성화 금지. [MC2-03] |
| 편집·검토·worktree · **범위제한** | chunk/checkpoint/runtime 저장은 확인; 모든 파일 편집/복원 operator는 미검토. (미확인; MV-R08) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | current exact edit/restore 보존; conversation checkpoint와 파일 undo 구분. |
| 승인·정책 · **기구현** | profile permission modes·rewrite 재검증·첫 deny 중단. (확인; MV-R06, MV-R11, MV-R13) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | current Plan/Build/deny exact approval 유지; smart/auto mode가 기본 권한을 확대하지 않는다. |
| 명령·background·격리 · **기구현** | managed process graceful/force/wait·실패 orphaned; shell tool availability feature gate. (조건부; MV-R14, MV-R17) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | 현재 supervisor/cleanup proof 유지; managed job 추가는 owner가 살아 있는 별도 opt-in 계약. |
| 취소·crash·효과 복구 · **기구현** | abandon/cancel transition·process orphaned·app-server group lifecycle. (확인; MV-R03, MV-R14, MV-R16) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | current unknown 격리 유지; Rust TUI의 group 시작만으로 모든 command cleanup proof라 하지 않는다. |
| 저장·이력·archive · **기구현** | staging content/checkpoint/manifest·fsync 이후 publication. (확인; MV-R08) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | 현 native SQLite/summary journal·archive 보존; 다른 storage format으로 교체하지 않는다. |
| profile·child·team · **부분** | profile source/override·graph/name/admission lock·live child message receipt. (확인; MV-R11, MV-R12) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | current child worktree/DB/budget 위에 member generation/mailbox/continuation 추가. [MC2-06] |
| plugin·hook·MCP·ACP · **부분** | legacy rewrite hooks·ACP adapter·scoped catalogue availability. (확인; MV-R13, MV-R15, MV-R17) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | default/legacy wiring 구분; typed hook/ACP current host port로 구현. [MC2-04, MC2-09] |
| 검증·진단·자동화 · **부분** | pre-tool 재검증/denial과 post-turn hook 경계. (확인; MV-R13) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 기존 tool metadata observer 위에 limited validation re-entry 추가; post-effect 실패 replay 금지. |
| 이미지·문서·추가 형식 · **범위제한** | native/generic completion adapter는 확인; 모든 media recognition/계정은 미실측. (미확인; MV-R04) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | current image/PDF 및 실제 OS/provider 검증 이월 유지. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **MV-C01** · 프로젝트 지침·설정의 신뢰 활성화와 철회 | nested AGENTS.md와 지속 baseline, 명시적 host plugin은 이미 있다. 저장소 단위 신뢰 상태로 지침/config/hooks의 활성화를 함께 gate하는 추가 계약이다. **추가 계약 필요** | [MC2-03](implementation-blueprint.md#mc2-03) · P1 · 우선 확장 |
| **MV-C02** · 승인 이전 lifecycle hook과 제한된 검증 재진입 | Plugin prepared/settled metadata 관측이 이미 있다. 인자 검증·deny·turn 종료 후 검증 피드백을 위한 새 lifecycle 계약이다. **추가 계약 필요** | [MC2-04](implementation-blueprint.md#mc2-04) · P1 · 우선 확장 |
| **MV-C03** · 살아 있는 child의 후속 입력과 mailbox receipt | 격리 worktree child, cancel/deny/budget 상속, 승인된 read-only delegate_task와 terminal 결과 inbox delivery는 이미 있다. ready child 재사용과 running child steer를 위한 추가 계약이다. **추가 계약 필요** | [MC2-06](implementation-blueprint.md#mc2-06) · P2 · 후속 확장 |
| **MV-C04** · 기존 engine host 위의 ACP 세션 adapter | Engine/host 분리와 versioned command/event, durable input·승인·cancel·paging은 이미 있다. ACP 외부 protocol adapter와 capability negotiation이 추가 범위다. **추가 계약 필요** | [MC2-09](implementation-blueprint.md#mc2-09) · P2 · 후속 확장 |

<a id="kimi-code"></a>
## Kimi Code ↔ Moodcode

원본 `MoonshotAI/kimi-code` · full SHA `21406fb4c805cc8c715e6d1f16ad3fb5f25f4fe3` · root `MIT`. 원본 evidence ID는 [Kimi Code 보고서](kimi-code.md)와 [kimi-code.evidence.json](kimi-code.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | native v2 AgentLoop machine→LLMRequester→ToolExecutor·여러 protocol adapter. (확인; K03, K04, K05, K06, K07) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | 현 Turn/Attempt/provider port 유지; pi-tui는 UI이므로 core 대체 대상이 아님. |
| 입력·큐·steer · **기구현** | submit/launched/settled handle·session main agent materialization. (확인; K03, K04, K10) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | current durable input/steer·admission 유지; prompt handle과 원래 input receipt 구분. |
| 문맥·압축·예산 · **기구현** | tool-selected history projection·별도 full compaction·window shrink/retry. (확인; K06, K08) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | 현재 same capture ContextPlan/semantic publication 유지; instructions 32KiB 경고를 hard cap으로 오인하지 않는다. |
| 저장소 검색·LSP · **범위제한** | 별도 semantic repository index/LSP navigation 전체는 미확인. (미확인; 대표 근거 범위 밖) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | current search/LSP 기준만 기록; 새 Kimi의 제품 전체 기능 부재로 쓰지 않는다. |
| 지침·skill·프로젝트 기억 · **기구현** | brand/global/project 지침·plugin prompts/roots. (확인; K09, K17) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 현 bounded instruction/skill 읽기 유지; 세션 간 학습 publication은 별도 비교. |
| 편집·검토·worktree · **부분** | quiescence 검사 뒤 conversation branch undo/replay. (확인; K11) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | 현재 file restore 보존; effect-preserved conversation fork는 추가 opt-in. undo로 파일 효과가 사라졌다고 표시 금지. |
| 승인·정책 · **기구현** | 실행 policy ask/approve/veto·print auto 권한 설정. (확인; K03, K12) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | 현 deny/Build exact 승인 유지; print의 자동 mode를 기본값으로 도입하지 않는다. |
| 명령·background·격리 · **부분** | runtime lease 아래 bounded foreground Bash·background job·POSIX group/Windows taskkill. (확인; K13, K14) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | explicit prepared foreground→job 전환·owner/duration/receipt 추가; Windows physical proof는 E5-08. [MC2-10] |
| 취소·crash·효과 복구 · **기구현** | runtime cleanup/session close·process signal/wait; crash 이후 효과 proof는 제한. (확인; K10, K14) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | native tool/MCP frontier/unknown 격리 유지; restart session과 effect replay 구분. |
| 저장·이력·archive · **기구현** | journal-backed event machine·session materialization·conversation branch replay. (확인; K04, K10, K11) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | current native/raw archive 유지; 새 conversation branch는 source sequence와 별도 ID만 추가. |
| profile·child·team · **부분** | coder/explore/plan profile child·호출자 runtime·권한/user tools 상속. (확인; K15) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | role child resume/handoff 추가; explore Bash prompt만 read-only인 동작은 현 effect deny로 보강. [MC2-07] |
| plugin·hook·MCP·ACP · **부분** | Pre/PostTool·Permission/prompt hooks·plugins·MCP/OAuth·ACP server. (확인; K16, K17, K18, K20) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | typed lifecycle/ACP host 추가; credentials와 capability ownership 유지. [MC2-04] |
| 검증·진단·자동화 · **부분** | 도구 없는 응답 done·Stop continuation/hooks. (확인; K05, K16) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 검증 receipt/result gate·limited continuation 추가; done을 검증 성공으로 보지 않는다. |
| 이미지·문서·추가 형식 · **부분** | video capability gate·계정/protocol cache key·upload persistence. (확인; K19) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | 기존 image/PDF 위에 explicit bounded video 별도 설계. 실제 image/video 모델 인식은 E5-13 검증. [MC2-16] |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **kimi-code-C1** · 승인 binding을 보존하는 lifecycle hook 계약 | plugin prepared/settled metadata hooks와 host factory는 이미 구현됨; prompt/turn/compaction lifecycle 관측과 제한된 veto 계약의 추가 제안. **추가 계약 필요** | [MC2-04](implementation-blueprint.md#mc2-04) · P1 · 우선 확장 |
| **kimi-code-C2** · 승인된 명령의 foreground→background 전환 | command supervisor·PTY·durable tasks·queue/steer와 effect recovery marker는 이미 있음; 실행 중 명령 detach와 task completion inbox 계약의 추가 제안. **추가 계약 필요** | [MC2-10](implementation-blueprint.md#mc2-10) · P2 · 후속 확장 |
| **kimi-code-C3** · 역할별 child task 재개와 최종 handoff 계약 | agent profiles·read-only delegate_task·실제 worktree child·budget/deny/cancel 상속·terminal root delivery는 이미 구현됨; 같은 child의 승인된 후속 turn과 역할 handoff 계약의 추가 제안. **추가 계약 필요** | [MC2-07](implementation-blueprint.md#mc2-07) · P2 · 후속 확장 |
| **kimi-code-C4** · 기존 image/PDF 경계 위의 bounded video 입력 | session-owned bounded image/PDF 입력·history anchors·provider token 정책·archive 검증은 이미 있음; video의 ingest/upload/capability/cache 경계는 후속 제안. **추가 계약 필요** | [MC2-16](implementation-blueprint.md#mc2-16) · P2/P3 · 영상 기능은 선택 확장; 기존 media 계정 검증은 이월 필수 |

<a id="kilocode"></a>
## Kilo Code ↔ Moodcode

원본 `Kilo-Org/kilocode` · full SHA `b1e7f34a4ce9fac0519714116f06fb553e185c56` · root `MIT`. 원본 evidence ID는 [Kilo Code 보고서](kilocode.md)와 [kilocode.evidence.json](kilocode.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | 기본 CLI/IDE는 OpenCode SessionPrompt/Processor·AI SDK streamText; V2 LLM runner 별도. (확인; K03, K04, K05, K06, K07, K08, K19) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current engine/provider capture 유지; 두 엔진 경로의 기능을 하나의 기본 보장으로 합치지 않는다. |
| 입력·큐·steer · **기구현** | session prompt queue·child background 결과 전달·root board. (확인; K05, K11, K12) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | root durable inbox 대응; live board/mailbox만 별도 확장. |
| 문맥·압축·예산 · **기구현** | history prune·chunk fallback·비어 있는 요약 거절·성공시 tail anchor. (확인; K06, K17) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | current complete exchange/latest anchors/source-bound summary 유지. |
| 저장소 검색·LSP · **범위제한** | 모든 repository embedding/symbol index 수명은 대표 근거 밖이다. (미확인; 대표 근거 범위 밖) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | current regex/LSP 유지; memory index를 repository index와 혼동하지 않는다. |
| 지침·skill·프로젝트 기억 · **부분** | enabled memory index·bounded context·명시적 apply와 source/file 결과. (조건부; K13) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | cross-session 후보 승인/revision/activation·revoke를 독립 구현. [MC2-03] |
| 편집·검토·worktree · **기구현** | step snapshot/patch 기록·workspace warp source sync와 변경 적용. (확인; K16, K20) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | current exact checkpoints/worktrees/승인 merge 유지; warp 소유권 계약은 별도 remotehost 범위. |
| 승인·정책 · **부분** | tool approval provenance·규칙 출처·외부 workspace 표시·metadata 변경 후 출처 보존. (확인; K09, K10) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | 현재 강한 binding은 유지; 정책/grant/revision 판단 receipt 진단 추가. [MC2-11] |
| 명령·background·격리 · **범위제한** | sandbox wrapper는 확인했으나 모든 OS enforcement와 command ownership 내부는 미검토. (미확인; K09, K18) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | current fileIsolation/networkIsolation false를 유지 보고; 물리 격리 동등성 판단 제외. |
| 취소·crash·효과 복구 · **기구현** | session tree cancel·drain·실패 tail 제한 복구·event owner claim. (확인; K08, K15, K20) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | current uncertainty/source owner blocker 유지; tail 복구로 원격 효과 안전성을 추정하지 않는다. |
| 저장·이력·archive · **기구현** | durable event/projection immediate transaction·sequence·LLM/tool settlement. (확인; K14, K16, K19) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | current native SQLite identities/raw replay 유지; 제공 event 형식으로 migration하지 않는다. |
| profile·child·team · **부분** | 부모 권한/sandbox 상속·child resume·bounded transactional root board. (확인; K11, K12) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | live child board/member mailbox 추가; 기존격리 worktree/DB/deny 상속 보존. [MC2-06] |
| plugin·hook·MCP·ACP · **부분** | plugin transform/pre-post tool·MCP/attachments/catalogue. (확인; K06, K09, K18) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | typed lifecycle 제안에 통합; existing MCP/native exact receipt/discovery 유지. |
| 검증·진단·자동화 · **기구현** | finish/usage/cost/snapshot patch 기록. (확인; K16) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | current usage/diagnostics 대응. 증거 기반 validation gate는 별도 확장 대상으로 유지. |
| 이미지·문서·추가 형식 · **검증대기** | attachment·큰 결과 projection 경계 확인; 실제 계정/media 인식은 미실행. (확인; K18) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | image/PDF contract는 기구현; provider/model 실제 지원 matrix 검증 유지. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **K-C01** · 살아 있는 child 간 root 단위 공유 board | durable input inbox·task CAS·child worktree·terminal 결과 중복 제거 전달은 이미 있음. 살아 있는 sibling의 수신자 지정 board·읽기 cursor는 추가 계약. **추가 계약 필요** | [MC2-06](implementation-blueprint.md#mc2-06) · P2 · 후속 확장 |
| **K-C02** · 출처와 승인 revision을 가진 프로젝트 기억 publication | 세션 semantic summary·active-prefix checkpoint·bounded context·로컬 skill/reference 읽기는 이미 있음. 세션 밖 사실 승격과 다른 세션에서 승인된 project memory 재사용을 제안. **추가 계약 필요** | [MC2-03](implementation-blueprint.md#mc2-03) · P1 · 우선 확장 |
| **K-C03** · 정책과 grant별 승인 판단 출처 기록 | deny 우선 Plan/Build 정책·reason·policy version·exact approval·durable scoped grant 발급/소비/철회는 이미 있음. 규칙/grant/manual별 관측 metadata를 확장. **기존 기능의 관측/검증 보강** | [MC2-11](implementation-blueprint.md#mc2-11) · P1 · 우선 확장 |

<a id="mini-swe-agent"></a>
## mini-SWE-agent ↔ Moodcode

원본 `SWE-agent/mini-swe-agent` · full SHA `04d809ceab9df28f9adaed044884180159172930` · root `MIT`. 원본 evidence ID는 [mini-SWE-agent 보고서](mini-swe-agent.md)와 [mini-swe-agent.evidence.json](mini-swe-agent.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | Model/Environment/Agent protocol·짧은 query→bash action loop·LiteLLM/Responses. (확인; MSA-R04, MSA-R05, MSA-R06, MSA-R08, MSA-R20) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current typed multi-tool engine 유지; 단순 bash-only 모델로 축소하지 않는다. |
| 입력·큐·steer · **범위제한** | interactive interruption/입력과 실행 loop는 확인; durable user inbox는 미검토. (미확인; MSA-R14) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | current queued input/steer 보존; CLI 입력을 동일 보장으로 세지 않는다. |
| 문맥·압축·예산 · **부분** | metadata를 제외한 linear history·긴 observation head/tail projection. (확인; MSA-R08, MSA-R15) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | current bounded SQL/complete exchange 유지; 오류 관측/생략 이유·원본 journal projection 보강. |
| 저장소 검색·LSP · **범위제한** | bash 명령으로 파일 탐색 가능; 별도 symbol/vector repo service는 미검토. (미확인; MSA-R09, MSA-R12) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | 현재 bounded search/LSP 유지; bash 가능만으로 typed index 서비스 동등성 판단하지 않는다. |
| 지침·skill·프로젝트 기억 · **범위제한** | 프로젝트 기억 publication·skill 수명 전체는 미확인. (미확인; 대표 근거 범위 밖) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | 기존 semantic memory와 bounded references 유지. |
| 편집·검토·worktree · **기구현** | 환경 내 shell command로 편집 가능; command별 새 shell. (확인; MSA-R12, MSA-R13) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | exact prepared edits·file checkpoint 유지; 임의 bash가 preimage 승인 대체하지 않는다. |
| 승인·정책 · **기구현** | confirm/human/yolo·regex whitelist. (확인; MSA-R14) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | current deny/Plan/exact approval 유지; regex나 yolo를 자동승인 기본값으로 쓰지 않는다. |
| 명령·background·격리 · **기구현** | local fresh process·optional Docker exec·cwd/env/output/returncode. (확인; MSA-R12, MSA-R13) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | current supervisor/PTY 유지; 비상주 cwd/env·worktree lifetime를 추가 의미 검증. [MC2-20] |
| 취소·crash·효과 복구 · **기구현** | format error cap·provider retry·partial output 저장·queued futures 취소. (확인; MSA-R06, MSA-R11, MSA-R14, MSA-R17) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | 현 native effect frontier 유지; pending batch 취소가 running process cleanup 증명은 아님. |
| 저장·이력·archive · **부분** | step별 trajectory JSON overwrite·version/config/cost·prediction 저장. (확인; MSA-R07, MSA-R16) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | current journal 유지; source sequence 기반 읽기 전용 trajectory projection 추가. [MC2-12] |
| profile·child·team · **범위제한** | live child/team/role workflow는 이 미니 agent 기본 루프 범위에서 미검토. (미확인; 대표 근거 범위 밖) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | 현재 managed child 보존; 기능이 없다고 repo 전체 단정하지 않는다. |
| plugin·hook·MCP·ACP · **범위제한** | provider class/full import factory 확인; MCP/ACP/lifecycle 전체는 미확인. (미확인; MSA-R18) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | explicit host registration 유지; model에 class import 실행권을 주지 않는다. |
| 검증·진단·자동화 · **부분** | billed FormatError 보존·benchmark thread workers·preds key skip. (확인; MSA-R06, MSA-R08, MSA-R16, MSA-R17) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 오류 classification matrix·source+successful receipt 기반 batch resume 추가. JSON ID skip을 live recovery로 보지 않는다. [MC2-12, MC2-20] |
| 이미지·문서·추가 형식 · **검증대기** | optional regex로 image_url content를 펼치는 adapter. (조건부; MSA-R19) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | 현재 image refs/capability/hash 구현 유지; 실제 provider 인식과 텍스트 regex 자동 추출을 구분. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **MSA-C01** · provider 오류 분류·관측 보존 합성 검증 행렬 | Attempt/Part·usage·부분 tool proposal·제한된 재시도·cleanup uncertainty를 이미 구현했다. 추가 후보는 같은 코딩 loop 오류 경계의 명시적 검증 행렬이다. **기존 기능의 관측/검증 보강** | [MC2-12](implementation-blueprint.md#mc2-12) · P1 · 기존 계약의 진단·검증 보강 |
| **MSA-C02** · 고정 journal sequence의 읽기 전용 trajectory 투영 | durable Run/Turn/Attempt/Part, bounded paging, archive export/import를 이미 구현했다. 작은 코딩 trajectory inspection/export 표현 계약을 추가하는 후보다. **기존 기능의 관측/검증 보강** | [MC2-12](implementation-blueprint.md#mc2-12) · P1 · 우선 확장 |
| **MSA-C03** · 완료 증거와 source identity를 묶는 headless batch 재개 | 기존 headless coding fixture 3개와 영구 입력·실행·budget 상속은 이미 있다. batch result key 존재보다 강한 완료 조건과 재실행 기록 계약을 추가하는 후보다. **추가 계약 필요** | [MC2-20](implementation-blueprint.md#mc2-20) · P2 · 후속 확장 |
| **MSA-C04** · 비상주 명령과 worktree 실행의 상태 수명 검증 | run_command, exact preparation/approval, supervisor/process cleanup, worktree·child budget/deny 상속을 이미 구현했다. 상태 수명과 경계의 추가 검증 후보다. **기존 기능의 관측/검증 보강** | [MC2-20](implementation-blueprint.md#mc2-20) · P2 · 기존 계약의 진단·검증 보강 |

<a id="open-swe"></a>
## Open SWE ↔ Moodcode

원본 `langchain-ai/open-swe` · full SHA `48a8445fc51246e739976c8bf5bdca3c43f27653` · root `MIT`. 원본 evidence ID는 [Open SWE 보고서](open-swe.md)와 [open-swe.evidence.json](open-swe.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **범위제한** | local create_deep_agent middleware 조립; 핵심 graph/LLM loop는 외부 DeepAgents/LangGraph. (외부; OSWE-R04, OSWE-R06, OSWE-R07) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current 자체 engine 유지; imported core 전체를 분석·동등성 검증했다고 하지 않는다. |
| 입력·큐·steer · **부분** | durable runs.create dispatch·model-before queue snapshot·변환 성공 뒤 follow-up 소비. (확인; OSWE-R05, OSWE-R06, OSWE-R11) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | existing inbox/steer 대응; PR/task occurrence receipt는 host integration 계층에 추가. |
| 문맥·압축·예산 · **기구현** | 외부 summary middleware를 감싼 수동/자동 관측·도구 없는 수동 압축. (외부; OSWE-R09) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | Moodcode source-bound summary 유지; 외부 압축 알고리즘 parity 평가는 제외. |
| 저장소 검색·LSP · **범위제한** | skills/read-only backend와 sandbox route 확인; 전체 symbol/vector service는 미검토. (미확인; OSWE-R08) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | repository-context 차이는 실제 분석한 source만 근거로 정한다. |
| 지침·skill·프로젝트 기억 · **부분** | org/private skills route·별도 analyzer의 review style draft/feedback 학습. (확인; OSWE-R08, OSWE-R17) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | approved KnowledgeCandidate publication/revision/revoke 추가; 분석 draft를 바로 active instruction으로 만들지 않는다. [MC2-03] |
| 편집·검토·worktree · **기구현** | thread sandbox 재연결·unreachable 기본 재생성 금지·workflow push fingerprint. (확인; OSWE-R10, OSWE-R14) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | existing worktree/approval 유지; deleted/unreachable distinction을 host recovery 진단에 보존. |
| 승인·정책 · **기구현** | workflow-changing push와 PR publication consent/permission preflight. (조건부; OSWE-R14, OSWE-R15) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | current 모든 효과별 승인 유지; workflow-only gate를 모든 command 승인으로 확대 해석하지 않는다. |
| 명령·background·격리 · **부분** | sandbox background job·monitor·claim/dispatch/delivered marker. (확인; OSWE-R10, OSWE-R12, OSWE-R20) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | durable host-owned command job·delivery receipt 추가. marker와 dispatch 사이 crash dedupe를 강화. [MC2-10] |
| 취소·crash·효과 복구 · **기구현** | thread runs paging/interrupt·타인 follow-up 보존·remaining input 재접수. (확인; OSWE-R19, OSWE-R20) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | current physical cleanup/native frontier 보존; remote cancel request만으로 효과 종료 판정 금지. |
| 저장·이력·archive · **범위제한** | checkpointer TTL/durability=sync config와 외부 runtime dispatch. (외부; OSWE-R04, OSWE-R06) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | Moodcode native journal/archive 보존; 외부 backend의 transaction 보장은 미실측/미검토. |
| profile·child·team · **부분** | subagent/reviewer middleware 조립·read-only 명칭과 publication 도구 혼재. (외부; OSWE-R07, OSWE-R16) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | current read-only effect restriction 유지; 명시적 plan/edit/verify 단계·durable role join 추가. [MC2-07] |
| plugin·hook·MCP·ACP · **부분** | queue/workflow/timeout/limit middleware·동적 MCP group. (확인; OSWE-R07, OSWE-R08) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | current MCP/lifecycle binding 유지; middleware 구성으로 universal 검증 stage graph를 가정하지 않는다. |
| 검증·진단·자동화 · **부분** | model-free scheduler node·opt-in PR head/check/delivery dedupe와 failure feedback. (조건부; OSWE-R13, OSWE-R18) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | PR SHA/watch occurrence→existing inbox 추가; CI unknown/pending을 pass로 표시하지 않는다. [MC2-19] |
| 이미지·문서·추가 형식 · **범위제한** | follow-up image metadata 변환은 확인; actual recognition/protocol 전체는 미검토. (미확인; OSWE-R11) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | current image/PDF source identity와 계정 검증 이월 유지. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **OSWE-C1** · PR revision에 binding한 CI·검토 feedback watch | durable queue/steer·Run/Turn/Attempt·제한 retry·artifact·host plugin/MCP·승인과 recovery는 기구현. GitHub PR head/check/review 상태를 지속 관측하여 다음 실행에 전달하는 공개 host 계약은 확인한 기준 소스에서 별도 범위다. **추가 계약 필요** | [MC2-19](implementation-blueprint.md#mc2-19) · P2 · 후속 확장 |
| **OSWE-C2** · 역할별 소프트웨어 작업 단계와 검증 증거 연결 | agent profiles·session tasks CAS·coding 도구·summary·artifact·격리 child worktree·승인한 변경 통합·root inbox delivery가 이미 있다. todo 완료와 구분된 조사/구현/검증/검토 단계의 durable transition 및 evidence gate는 추가 계약이다. **추가 계약 필요** | [MC2-07](implementation-blueprint.md#mc2-07) · P2 · 후속 확장 |
| **OSWE-C3** · host가 소유하는 지속 background command job | 승인된 command supervisor·PTY·process cancel/cleanup·child 실행·terminal outcome의 root inbox delivery·artifact paging·uncertainty ledger는 기구현. 부모 Run 종료 후에도 host가 소유하며 결과를 접수하는 장기 command job의 durable public lifecycle은 별도 범위다. **추가 계약 필요** | [MC2-10](implementation-blueprint.md#mc2-10) · P2 · 후속 확장 |
| **OSWE-C4** · 저장소 검토 선호의 evidence 기반 초안과 승인 publication | bounded context·semantic memory·agent profile 지침·로컬 skill/reference 읽기·session documents·exact patch/approval가 이미 있다. 역사 review outcome에서 repository별 선호를 학습하고 승인된 revision을 reviewer에 공급하는 lifecycle은 추가 범위다. **추가 계약 필요** | [MC2-03](implementation-blueprint.md#mc2-03) · P1 · 우선 확장 |

<a id="roo-code"></a>
## Roo Code ↔ Moodcode

원본 `RooCodeInc/Roo-Code` · full SHA `b867ec9145750d0ae1ff7f02d35406e9bf2a0b16` · root `Apache-2.0`. 원본 evidence ID는 [Roo Code 보고서](roo-code.md)와 [roo-code.evidence.json](roo-code.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | extension Task 직접 start·명시적 request stack·stream native parser·CLI 동일 bundle. (확인; R03, R04, R05, R06, R20) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current 독립 headless engine 유지; Zoo 추가 scheduler를 Roo에 소급하지 않는다. |
| 입력·큐·steer · **기구현** | top-level active task 교체·request/retry stack. (확인; R03, R04) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | durable inbox/workspace fairness 유지; Task 교체로 accepted 입력이 지워지지 않게 한다. |
| 문맥·압축·예산 · **기구현** | resume 질문·summary/압축·sliding-window fallback·미완료 exchange 보정. (확인; R09, R10) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | current complete exchange/source-native journal 유지; 합성 interrupted 결과를 원래 실행 proof로 사용하지 않는다. |
| 저장소 검색·LSP · **부분** | embedding/Qdrant readiness·path/line/score/top-k 검색; manager cwd 전달 경계 확인. (확인; R17, R18) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | source-bound workspace/index generation 검색 추가; cwd/worktree를 조회 identity에 결속. [MC2-01] |
| 지침·skill·프로젝트 기억 · **범위제한** | project cross-session memory publication/skill learning 전체는 미검토. (미확인; 대표 근거 범위 밖) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | session summary 대응만 기록; 기억 기능 부재 단정 제외. |
| 편집·검토·worktree · **기구현** | shadow Git checkpoint stage/commit·clean/hard-reset restore. (확인; R14) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | exact file restore/user 변경 보존 유지; whole-worktree reset을 기본 복원으로 쓰지 않는다. |
| 승인·정책 · **부분** | mode tool group·edit fileRegex·custom/MCP 예외·UI 승인. (확인; R07, R15, R16) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | current deny/opaque prepared 보존; role file effect 범위와 MCP identity를 profile revision에 결속. [MC2-11] |
| 명령·background·격리 · **범위제한** | terminal release/diff cleanup은 확인; 모든 backend 물리 격리/command tree는 미검토. (미확인; R08) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | current supervisor/PTY cleanup 유지; foreground 앱 취소와 OS 정리를 구분. |
| 취소·crash·효과 복구 · **기구현** | Task abort flag·provider first-chunk race·sync dispose/async cleanup·이력 재개. (확인; R05, R08, R09) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | current provider abort signal/cleanup proof 유지; 직접 createMessage 전달 범위의 한계를 보존. |
| 저장·이력·archive · **기구현** | task 파일 저장·memory lock/debounced index·disk/cache reconcile. (확인; R12, R19) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | native transaction/CAS 유지; parent-child 순차 저장으로 durable atomic 보장을 추정하지 않는다. |
| profile·child·team · **부분** | parent tool-result/metadata 저장 후 child start·child 결과 주입과 parent 자동 재개. (확인; R11, R12) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | role workflow stage CAS·durable wait/join 추가; current isolated DB/worktree 유지. [MC2-07] |
| plugin·hook·MCP·ACP · **기구현** | MCP existence/args·승인 후 execute; role mode 정책. (확인; R16) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | current captured scope/connection/exact native MCP receipt 유지. 전체 ACP/hook은 미검토. |
| 검증·진단·자동화 · **부분** | todo 미완료·child 상태 completion gate·사용자 완료 수락. (확인; R13) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | task revision/changed hash/VerificationReceipt gate 추가; todo 완료만 test 성공으로 보지 않는다. [MC2-02] |
| 이미지·문서·추가 형식 · **범위제한** | provider tools 구성은 확인; 모든 media/model 실제 계정은 미실측. (미확인; R05) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | image/PDF/local 계약과 E5-13 account matrix 구분. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **roo-code-C1** · workspace identity와 source freshness를 고정한 의미 코드 검색 | bounded context·semantic history memory·glob/regex·LSP·bounded tool discovery는 이미 있다. 추가 범위는 파일 chunk 색인과 query/result의 workspace·source·index identity 계약이다. **추가 계약 필요** | [MC2-01](implementation-blueprint.md#mc2-01) · P1 · 우선 확장 |
| **roo-code-C2** · 역할 workflow의 durable child 대기·parent continuation | versioned profiles, 실제 격리 child/worktree, budget·deny·cancel 상속, root inbox의 terminal 결과 중복 제거와 queue/steer·pause/resume는 이미 있다. 추가 범위는 역할 단계와 기다리는 child 결과에 binding된 자동 parent continuation이다. **추가 계약 필요** | [MC2-07](implementation-blueprint.md#mc2-07) · P2 · 후속 확장 |
| **roo-code-C3** · profile revision에 묶인 역할별 파일 effect 범위 | profiles의 tool allowlist, Plan/Build, path/command resource policy·deny 우선·scope grants와 exact 편집 승인은 이미 있다. 추가 범위는 profile의 역할별 파일 범위를 기존 resource policy와 교차 적용하는 계약이다. **추가 계약 필요** | [MC2-11](implementation-blueprint.md#mc2-11) · P1 · 우선 확장 |
| **roo-code-C4** · task revision과 검증 receipt에 묶인 완료 조건 | durable tasks CAS, structured tool result·artifact, Run terminal과 provider/tool lifecycle는 이미 있다. 추가 범위는 host가 지정한 필수 task·검증 receipt에 연결된 완료 admission이다. **추가 계약 필요** | [MC2-02](implementation-blueprint.md#mc2-02) · P1 · 우선 확장 |

<a id="continue"></a>
## Continue ↔ Moodcode

원본 `continuedev/continue` · full SHA `5522c6f44ca0ac3528b37244818fbfa39b5af470` · root `Apache-2.0`. 원본 evidence ID는 [Continue 보고서](continue.md)와 [continue.evidence.json](continue.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | CLI streamChatResponse loop와 IDE Redux→core/tool back-edge는 별도. (확인; CT03, CT04, CT05, CT11, CT12, CT13) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current engine-owned loop 유지; GUI가 tool-loop를 소유하도록 변경하지 않는다. |
| 입력·큐·steer · **기구현** | headless/TUI·JSON resume/fork·compaction 뒤 continuation. (확인; CT03, CT05) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | existing durable queue/steer/pause 유지; resume history와 input receipt 소유권 구분. |
| 문맥·압축·예산 · **부분** | prune/summary·선택 context provider에 IDE/models/query를 전달. (확인; CT09, CT20) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | current hard budget 유지; bounded provenance source manifest port 추가. [MC2-01] |
| 저장소 검색·LSP · **부분** | recent/FTS/vector/repo-map 합성; embed 없는 경우 새 index 미생성. (확인; CT14, CT15) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | source/worktree/index/model generation과 stale invalidation·FTS fallback을 가진 hybrid service 추가. [MC2-01] |
| 지침·skill·프로젝트 기억 · **기구현** | config/agent rules 내용 dedupe·selected skill 본문과 동반 reference. (확인; CT16, CT18) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | current bounded instruction/skill 읽기 보존; provider/source trust marker만 확장. |
| 편집·검토·worktree · **범위제한** | 전체 exact editor/rollback 효과 수명은 대표 근거에서 미검토. (미확인; 대표 근거 범위 밖) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | current preimage checkpoint/restore 보존; git-ai attribution/JSON conversation을 rollback이라고 보지 않는다. |
| 승인·정책 · **기구현** | 승인은 순차 검사하되 허용 tool은 즉시 병렬·headless/Plan Bash/MCP allow. (확인; CT06, CT07) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | current Plan effect deny·exact approval 유지; upstream 자동승인/범용 mutating 병렬 채택 금지. |
| 명령·background·격리 · **부분** | command shell·background job service·출력 reset timeout·child.kill. (확인; CT08) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | 기존 user-owned PTY의 status handle·background 표시·완료 inbox delivery 먼저 확장. [MC2-10] |
| 취소·crash·효과 복구 · **기구현** | stream abort·child kill·beta child Escape/finally globals 복원. (확인; CT04, CT08, CT19) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | physical ownership/cleanup uncertain 유지; global restore는 effect cleanup proof가 아님. |
| 저장·이력·archive · **기구현** | HistoryManager JSON snapshot·mtime 최신 resume. (확인; CT10) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | native original journal/raw replay/archives 유지; 파일 mtime로 execution owner 재발급 금지. |
| profile·child·team · **기구현** | beta subagent가 local history로 동일 loop 실행·전역 permission wildcard allow 교체. (실험; CT19) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | current isolated worktree/DB/deny 상속 유지; global allow 임시 교체는 이식하지 않는다. |
| plugin·hook·MCP·ACP · **부분** | MCP tools/prompts·skill read·context-provider API; hook helper의 실제 wiring 제한. (확인; CT17, CT18, CT20) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | existing MCP 유지; 선택 context provider port 추가. helper 존재만으로 lifecycle 지원 완료 판단 금지. |
| 검증·진단·자동화 · **기구현** | usage/tool outcomes·exit/output 기록. (확인; CT04, CT06, CT08) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | current diagnostics/native usage 유지; headless batch proof/validation gate는 별도 제안. |
| 이미지·문서·추가 형식 · **범위제한** | chat model adapter는 확인; embedding/모든 media/provider 실측은 없음. (미확인; CT12) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | current synthetic/provider live 기록과 모델별 E5-13 pending을 보존. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **CONTINUE-C01** · workspace/index generation에 결합한 혼합 저장소 검색 | bounded context·semantic session memory·정규식 검색·LSP·workspace observer는 구현됨. branch/worktree와 embed identity별 repository index 및 FTS/vector/recent-file 조합은 별도 후보. **추가 계약 필요** | [MC2-01](implementation-blueprint.md#mc2-01) · P1 · 우선 확장 |
| **CONTINUE-C02** · 선택한 context provider의 bounded source manifest | host provider·MCP resources·LSP·nested instructions·skill/reference bounded read·ContextPlan은 구현됨. 사용자 선택 provider/query를 단일 provenance manifest로 capture하는 host 계약이 추가 후보. **추가 계약 필요** | [MC2-01](implementation-blueprint.md#mc2-01) · P1 · 우선 확장 |
| **CONTINUE-C03** · 기존 user-owned PTY의 background 표시와 완료 전달 | user authority PTY·durable terminal journal·attach/replay/cancel/resize·cleanup과 durable inbox는 구현됨. 모델 Bash를 무조건 background로 넘기지 않는다. host 사용자가 시작한 job의 read-only status handle과 완료 delivery 연결이 추가 후보. **추가 계약 필요** | [MC2-10](implementation-blueprint.md#mc2-10) · P2 · 후속 확장 |

<a id="swe-agent"></a>
## SWE-agent ↔ Moodcode

원본 `SWE-agent/SWE-agent` · full SHA `3ea751c087f32b16e039a2233dd6eefecef325d5` · root `MIT`. 원본 evidence ID는 [SWE-agent 보고서](swe-agent.md)와 [swe-agent.evidence.json](swe-agent.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **기구현** | Python model→단일 함수 parser→shell action→SWE-ReX observation. (확인; SWA-R03, SWA-R04, SWA-R06, SWA-R07, SWA-R08, SWA-R11) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current typed multi-tool/provider loop 유지; arbitrary shell bundle 기반 core로 치환하지 않는다. |
| 입력·큐·steer · **범위제한** | task attempt group/benchmark workers는 확인; durable user inbox는 미검토. (미확인; SWA-R17, SWA-R19) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | current input receipts 유지; task retry와 provider retry를 분리. |
| 문맥·압축·예산 · **부분** | old observation/window/tag processor·query snapshot·temporary requery. (확인; SWA-R07, SWA-R13, SWA-R16) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | raw history 보존하며 omission reason/source identity 진단 추가; 원본 message를 편집하지 않는다. [MC2-12] |
| 저장소 검색·LSP · **범위제한** | configured bundle로 shell 탐색 가능; repository index 서비스 수명은 미검토. (미확인; SWA-R09, SWA-R10) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | current bounded search/LSP 보존; tool bundle install을 index 서비스로 도입하지 않는다. |
| 지침·skill·프로젝트 기억 · **범위제한** | 자동 cross-session knowledge publication/skill 수명은 미확인. (미확인; 대표 근거 범위 밖) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | current instructions/session memory·approved publication 제안 구분. |
| 편집·검토·worktree · **기구현** | unique old text 검사·tabs 확장·쓰기 뒤 optional lint warning. (확인; SWA-R20) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | exact UTF-8 preimage/hash/line ending 보존; linter warning을 성공·rollback으로 표시하지 않는다. |
| 승인·정책 · **기구현** | 함수 name/required/extra key·문자열 command filter·bundle upload/install. (확인; SWA-R08, SWA-R09, SWA-R10) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | current typed schema/effect/deny/prepare binding 유지; filter나 hidden name으로 권한 보장하지 않는다. |
| 명령·background·격리 · **기구현** | SWE-ReX persistent session의 cwd/env/interrupt/stop API. (외부; SWA-R05) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | current supervisor/process owner 유지; external runtime의 실제 물리 정리·모든 OS 실측은 제외. |
| 취소·crash·효과 복구 · **기구현** | requery·autosubmission·runtime 실패 patch 수집·새 환경 replay. (확인; SWA-R12, SWA-R14, SWA-R18) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | native frontier 유지; 오류 patch가 terminal 실패를 성공으로 바꾸거나 replay 권한을 만들지 않는다. |
| 저장·이력·archive · **부분** | 정상 step 뒤 trajectory JSON overwrite·config/action replay. (확인; SWA-R13, SWA-R15, SWA-R18) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | journal-sequence trajectory/실패 결과 EvidenceManifest 추가; 명령 replay는 미도입. [MC2-12] |
| profile·child·team · **부분** | task마다 fresh agent·남은 cost·hard reset·reviewer best attempt 선택. (확인; SWA-R17) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | isolated bounded CodingAttemptGroup·검증 plan·read-only advisory reviewer 추가 opt-in. [MC2-20] |
| plugin·hook·MCP·ACP · **부분** | bundle schema/command/render/install와 host environment propagation. (확인; SWA-R09, SWA-R10) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | 기존 registration capture 보존; descriptor/handler manifest 읽기 전용 변화 진단 추가. [MC2-12] |
| 검증·진단·자동화 · **부분** | submit marker/patch·exit status skip·lint warning; test pass invariant는 없음. (확인; SWA-R12, SWA-R14, SWA-R19, SWA-R20) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 실패/중단 coding evidence·strict source/config/verification 기반 batch/attempt selection 추가. |
| 이미지·문서·추가 형식 · **범위제한** | history image/adapter 경계는 일부 확인; 모든 media/protocol 계정은 미실측. (미확인; SWA-R07) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | 현재 image/PDF/model support 범위만 표시; 기존 실제 검증 이월 보존. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **SWA-C01** · history 투영의 source identity와 생략 사유 진단 | 이미 bounded ContextPlan·semantic memory·historical tool projection·active complete exchange가 있다. policy별 source/생략 사유 관측의 추가 계약이다. **기존 기능의 관측/검증 보강** | [MC2-12](implementation-blueprint.md#mc2-12) · P1 · 우선 확장 |
| **SWA-C02** · 실패·중단 코딩 결과의 읽기 전용 증거 manifest | 이미 artifact·checkpoint/restore·archive export/import·native tool recovery frontier·uncertainty 차단이 있다. 산출물과 성공 판정의 별도 manifest를 제안한다. **기존 기능의 관측/검증 보강** | [MC2-12](implementation-blueprint.md#mc2-12) · P1 · 우선 확장 |
| **SWA-C03** · 검증 증거에 묶인 opt-in 코딩 작업 attempt group | 이미 provider Attempt·agent profile·격리 child/worktree·budget/deny/cancel 상속·terminal root inbox 전달이 있다. task 전체 재시도와 read-only reviewer 선택은 별도 workflow 후보다. **추가 계약 필요** | [MC2-20](implementation-blueprint.md#mc2-20) · P2 · 후속 확장 |
| **SWA-C04** · 호스트 도구 등록 manifest의 변경 진단 | 이미 scoped versioned runtime·descriptor digest·bounded discovery·다음 model 경계 capture·exact prepared approval/effect가 있다. 등록 간 독립 관측/회귀 행렬의 추가 제안이다. **기존 기능의 관측/검증 보강** | [MC2-12](implementation-blueprint.md#mc2-12) · P1 · 기존 계약의 진단·검증 보강 |

<a id="kimi-cli-legacy"></a>
## 구 Kimi CLI ↔ Moodcode

원본 `MoonshotAI/kimi-cli` · full SHA `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82` · root `Apache-2.0`. 원본 evidence ID는 [구 Kimi CLI 보고서](kimi-cli-legacy.md)와 [kimi-cli-legacy.evidence.json](kimi-cli-legacy.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **범위제한** | 공개 console은 deprecation gate. 보존된 KimiSoul→Kosong→tools Python 엔진만 비교. (역사; L04, L05, L07, L08, L09, L24) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | 현재 runnable TS engine과 역사적 내부 경로를 분리; successor 코어로 간주하지 않는다. |
| 입력·큐·steer · **기구현** | turn 경계 steer·background manager 입력/heartbeat. (역사; L07, L18) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | current durable inbox/child ownership 유지; historical terminal 이후 재개는 새 occurrence로 다룬다. |
| 문맥·압축·예산 · **기구현** | JSONL checkpoint/rotation·text-only 요약·최근 user/assistant 두 개 suffix. (역사; L10, L12) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | current complete exchange/explicit anchors/raw native provenance 보존. |
| 저장소 검색·LSP · **범위제한** | 기본 file tools/profile 목록은 확인; 전체 symbol/vector service는 미검토. (미확인; L27) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | current repository 기능 상태를 유지; historical source 밖 기능을 추정하지 않는다. |
| 지침·skill·프로젝트 기억 · **기구현** | project 지침/tools/profile 및 persisted system prompt 복원. (역사; L05, L27) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | current source revision/skill bounds 유지; 자동 기억 publication은 추가 후보로 별도 표기. |
| 편집·검토·worktree · **부분** | D-Mail은 기본 비활성·대화 rewind이며 filesystem restore TODO; diff 승인 후 직접 replace. (조건부; L10, L11, L26, L27) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | effect-preserved conversation fork만 opt-in. 현재 exact file restore와 conversation rewind를 분리. [MC2-14] |
| 승인·정책 · **기구현** | pre-tool block·action cache/yolo/afk 승인·plan-file 예외. (역사; L13, L15, L26) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | current exact hash/deny/Plan 정책 유지; broad cached action 승인은 채택하지 않는다. |
| 명령·background·격리 · **기구현** | foreground 직접 process.kill vs background group/taskkill·heartbeat lost. (역사; L16, L17, L18) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | current owned supervisor 유지; foreground/background를 동일 cleanup proof로 간주하지 않는다. |
| 취소·crash·효과 복구 · **기구현** | tool futures cancel/gather·wire drain·background lost 판정. (역사; L09, L14, L18) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | native effect uncertainty·actual owner blocker 보존; heartbeat만으로 process 부재 확정 금지. |
| 저장·이력·archive · **부분** | context/wire JSONL restore와 checkpoint rotation. (역사; L10, L11) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | current native journal 보존; explicit conversation branch lineage/immutable source sequence 추가. |
| profile·child·team · **기구현** | 별도 child Context이지만 session/workdir/approval/runtime 공유. (역사; L19, L20) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | current isolated worktree/DB/deny 상속 유지; shared runtime child를 default로 도입하지 않는다. |
| plugin·hook·MCP·ACP · **부분** | Stop 1회 continuation·pre hooks·MCP·ACP bridge. (역사; L06, L13, L21, L22, L23) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | typed bounded lifecycle/Stop gate·ACP host에 통합; error fail-open은 명시적 host 실패 정책으로 바꾼다. [MC2-04, MC2-09] |
| 검증·진단·자동화 · **부분** | same-step 결과 재사용·cross-step reminder/force-stop·Stop continuation. (역사; L06, L13) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | 결과 digest+effect epoch의 no-progress 진단·검증 receipt 기반 제한 continuation 추가. [MC2-12] |
| 이미지·문서·추가 형식 · **부분** | image/video capability·file byte cap·provider upload/data URL. (역사; L25) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | 기존 image/PDF 유지; 새 video source/model/budget 설계는 successor와도 독립적인 opt-in 후보. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **kimi-cli-legacy-C1** · 효과를 보존하는 명시적 대화 분기 | bounded context·semantic/active-prefix checkpoint·원본 journal·파일 checkpoint restore는 이미 있음. effect-aware context branch와 명시적 cutoff 선택의 추가 계약. **추가 계약 필요** | [MC2-14](implementation-blueprint.md#mc2-14) · P3 · 선택/환경 검증 후 확장 |
| **kimi-cli-legacy-C2** · 기존 동일 읽기 차단을 확장하는 무진전 반복 진단 | runner 동일 read 차단·effect 후 read guard reset·scoped canonical repeat identity·도구 예산이 이미 있음. bounded 결과/실패 반복 진단과 설명 가능한 종료 사유의 추가 제안. **기존 기능의 관측/검증 보강** | [MC2-12](implementation-blueprint.md#mc2-12) · P1 · 우선 확장 |
| **kimi-cli-legacy-C3** · terminal 이전 한 번의 Stop continuation hook | host plugin prepared/settled metadata와 durable queue/steer, exact approval는 이미 있음. Stop lifecycle의 제한된 추가 입력 제안 계약. **추가 계약 필요** | [MC2-04](implementation-blueprint.md#mc2-04) · P1 · 우선 확장 |
| **kimi-cli-legacy-C4** · engine owner와 승인을 보존하는 ACP host adapter | engine/host 분리·durable session/event·approval/cancel·image/PDF와 restore 계약이 이미 있음. ACP transport/capability 협상과 editor binding은 추가 host 범위. **추가 계약 필요** | [MC2-09](implementation-blueprint.md#mc2-09) · P2 · 후속 확장 |

<a id="crush"></a>
## Crush ↔ Moodcode

원본 `charmbracelet/crush` · full SHA `140e8cb9707faa6a68d87d0ecc3a85b9c65e25d5` · root `FSL-1.1-MIT`. 원본 evidence ID는 [Crush 보고서](crush.md)와 [crush.evidence.json](crush.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **범위제한** | Go sessionAgent가 외부 fantasy loop 조립·provider catalog/timeout·stream callback. (외부; R01, R02, R03, R05, R06, R07, R21) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current 자체 loop 유지; fantasy 내부 동작을 이 checkout 검증으로 확대하지 않는다. |
| 입력·큐·steer · **기구현** | dispatch mutex·accepted/queued/active·메모리 map queue. (확인; R05, R06, R26) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | current durable accepted input/lease 보존; process-local queue로 지속성을 낮추지 않는다. |
| 문맥·압축·예산 · **기구현** | 도구 없는 summary·SummaryMessageID·tool 결과 재배치/unknown filtering. (확인; R08, R22) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | current complete exchange/native raw replay 유지; original source 지우는 필터로 치환하지 않는다. |
| 저장소 검색·LSP · **부분** | document symbols·definition/references/call hierarchy 등 읽기 LSP navigation palette. (확인; R13, R27) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | host factory/문서 version/hash/capability를 보존하는 bounded navigation API 추가. [MC2-01] |
| 지침·skill·프로젝트 기억 · **기구현** | 프로젝트/global context file·skill metadata dedupe/disable. (확인; R09) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | current bounded instruction/skill read 유지; repo auto executable 활성화 금지. |
| 편집·검토·worktree · **기구현** | read timestamp stale 검사·diff permission 후 편집. (확인; R15) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | current exact content hash/opaque preview·외부 사용자 변경 보존. timestamp만으로 preimage 대체 금지. |
| 승인·정책 · **기구현** | session/path/action grants·hook allow·non-interactive session auto approval. (확인; R10, R28) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | deny/Plan/exact approval 유지; headless automatic allow는 채택하지 않는다. |
| 명령·background·격리 · **부분** | detached background shell·foreground cancel kill·기본 시간 후 job 반환·shutdown cleanup. (확인; R11, R12, R23) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | approval preview에 job 옵션·owner/lifetime/output cursor·receipt 추가. detached context만으로 cleanupConfirmed 만들지 않는다. [MC2-10] |
| 취소·crash·효과 복구 · **기구현** | Setsid/negative PID/wait 및 shutdown agent/message/background/LSP/MCP 정리. (확인; R12, R23) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | current native crash frontier 유지; startup db resume를 physical process receipt로 보지 않는다. |
| 저장·이력·archive · **기구현** | SQLite WAL/migration/pool·opt-in dir lock; queue/grants는 memory scope. (확인; R19, R26) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | current native execution journal/owner blocking/archives 유지; 대화 DB만으로 effects 재개 금지. |
| profile·child·team · **기구현** | read-only Task/Plan palette·같은 context child session·부모 비용 합산. (확인; R13, R14) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | current worktree/DB·parent budget/deny 상속 유지; navigation read tools만 명시적 추가. |
| plugin·hook·MCP·ACP · **부분** | top-level policy hooks input rewrite/allow·MCP SDK transport/OAuth. (확인; R04, R16, R17, R18) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | typed host hook observe/deny/halt 먼저; rewrite는 prepare 이전 새 fingerprint. child 적용 범위를 explicit 설정. [MC2-04] |
| 검증·진단·자동화 · **부분** | 최근 tool name/input/result signature 반복으로 loop 판정. (확인; R07, R20) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | current duplicate-read를 유지하고 결과 digest+effect epoch 기반 no-progress 진단 추가. [MC2-12] |
| 이미지·문서·추가 형식 · **검증대기** | MCP media conversion·unsupported image filtering. (확인; R18, R22) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | current bounded image/PDF source refs 유지; upstream/현재 모두 실제 계정 인식 성능 실측과 구분. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **CR-C01** · 문서 버전에 묶인 LSP symbol navigation | 기존 LSP manager·diagnostics·formatter·문서 hash/version 동기화가 있다. 확인한 baseline LspManager 공개 API의 symbol/definition/call hierarchy 조회를 추가하는 후보다. **추가 계약 필요** | [MC2-01](implementation-blueprint.md#mc2-01) · P1 · 우선 확장 |
| **CR-C02** · 결과와 효과 epoch를 포함한 반복 상호작용 중단 | 기존 runner는 반복 읽기 identity를 차단하고 효과 뒤에 읽기 집합을 초기화한다. Run/Turn/tool/output 예산도 있다. 읽기 외의 동일 실패·무진전 cycle 관측을 추가하는 후보다. **기존 기능의 관측/검증 보강** | [MC2-12](implementation-blueprint.md#mc2-12) · P1 · 우선 확장 |
| **CR-C03** · 승인과 소유권을 유지하는 session command job | 기존 run_command supervisor·process ownership·cleanup 불확실성 격리와 host PTY·terminal journal이 있다. 모델 command가 명시적으로 job handle을 반환하고 후속 turn에서 조회하는 계약을 확장한다. **추가 계약 필요** | [MC2-10](implementation-blueprint.md#mc2-10) · P2 · 후속 확장 |
| **CR-C04** · 명시적 host 등록의 도구 정책 hook | 기존 EnginePluginManager와 prepared/settled metadata observation hook이 있다. 실행을 차단하는 정책 결정과 외부 hook의 소유권을 추가하는 후보다. **추가 계약 필요** | [MC2-04](implementation-blueprint.md#mc2-04) · P1 · 우선 확장 |

<a id="openhands-app"></a>
## OpenHands 앱/Agent Canvas ↔ Moodcode

원본 `OpenHands/OpenHands` · full SHA `7ea83bab4fe71149b88b5a8a6b9efe9042cb362d` · root `MIT`. 원본 evidence ID는 [OpenHands 앱/Agent Canvas 보고서](openhands-app.md)와 [openhands-app.evidence.json](openhands-app.evidence.json)의 고정 범위를 가리킨다. 표의 현재 Moodcode는 위 기능별 계약과 해당 소스 근거를 공통으로 따른다.

| 기능·판정 | 원본에서 확인한 동작·근거 | 현재 Moodcode 근거 | 개선/구현할 차이 |
|---|---|---|---|
| 모델·실행 루프 · **범위제한** | Agent Canvas TS control plane→외부 Agent Server/SDK; 앱이 native LLM/tool loop를 소유하지 않음. (외부; A02, A03, A04, A05, A08) | [B01](comparison-evidence.md#b01), [B02](comparison-evidence.md#b02), [B03](comparison-evidence.md#b03), [C14](comparison-evidence.md#c14) | current 자체 engine/host 유지; control plane API 조립과 core parity를 분리. |
| 입력·큐·steer · **부분** | 외부 automation dispatch/run cancel API·import backend pin/disabled patch. (외부; A06, A18) | [B13](comparison-evidence.md#b13), [C21](comparison-evidence.md#c21) | occurrence→durable inbox receipt 추가; 외부 scheduler/lease core 검증 여부는 범위 제한. |
| 문맥·압축·예산 · **범위제한** | profile/inline payload는 전달하지만 core context selection/compaction은 SDK 소유. (외부; A02, A10) | [B02](comparison-evidence.md#b02), [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [C15](comparison-evidence.md#c15) | current bounded context 비교를 유지; app 기능으로 요약 알고리즘을 중복 집계하지 않는다. |
| 저장소 검색·LSP · **범위제한** | runtime/workspace 선택은 확인; 실제 code index/search engine 본체는 외부. (외부; A02, A14) | [C16](comparison-evidence.md#c16), [C17](comparison-evidence.md#c17), [C24](comparison-evidence.md#c24) | Moodcode regex/LSP 직접 구현과 별도; 외부 agent index를 소스 확인으로 간주하지 않는다. |
| 지침·skill·프로젝트 기억 · **기구현** | profile/config/hooks/plugins/secrets는 launch payload/LookupSecret reference. (확인; A10, A15) | [B05](comparison-evidence.md#b05), [B06](comparison-evidence.md#b06), [B09](comparison-evidence.md#b09), [C29](comparison-evidence.md#c29) | current immutable profile/credentials 유지; discovered config executable를 renderer가 설치하지 못하게 한다. |
| 편집·검토·worktree · **부분** | client child launch·isolated worktree 선택·scratch 실패 shared fallback. (확인; A14, A16, A17) | [B04](comparison-evidence.md#b04), [B10](comparison-evidence.md#b10), [B12](comparison-evidence.md#b12), [C30](comparison-evidence.md#c30) | current effect owner/worktree 유지; shared fallback은 새 명시적 preview로만 허용하고 client effect receipt 분리. |
| 승인·정책 · **부분** | confirmation payload/response·client tool의 server ack와 browser actual launch 분리. (확인; A10, A12, A17) | [B04](comparison-evidence.md#b04), [C19](comparison-evidence.md#c19), [C20](comparison-evidence.md#c20) | exact approval/client received-dispatched-completed-uncertain contract 추가; ack는 효과 완료가 아님. [MC2-09] |
| 명령·background·격리 · **범위제한** | local stack group/taskkill과 Docker runtime/workspace 선택. (외부; A04, A05, A14, A20) | [C18](comparison-evidence.md#c18), [C26](comparison-evidence.md#c26) | app launcher tree cleanup과 SDK command effect proof를 구분; current backend capability 보존. |
| 취소·crash·효과 복구 · **부분** | local interrupt vs cloud pause·after_seq reconnect·dev helper lease unlink. (확인; A11, A13, A19, A20) | [B03](comparison-evidence.md#b03), [C22](comparison-evidence.md#c22), [C23](comparison-evidence.md#c23), [C30](comparison-evidence.md#c30) | backend tuple에 원 cancel/cleanup binding 고정; UI reconnect/port 미사용이 효과 종료 증명은 아님. |
| 저장·이력·archive · **기구현** | core persistence는 SDK·client는 paged history/seq replay·transient progress 제거. (외부; A02, A12, A13) | [C21](comparison-evidence.md#c21), [C28](comparison-evidence.md#c28), [C30](comparison-evidence.md#c30) | current engine-native sequence/archive 유지; external client replay만 parity라고 하지 않는다. |
| profile·child·team · **부분** | parent/child launch service·browser replay ledger·결과 parent message. (확인; A16, A17) | [B08](comparison-evidence.md#b08), [B10](comparison-evidence.md#b10), [B11](comparison-evidence.md#b11), [C25](comparison-evidence.md#c25), [C27](comparison-evidence.md#c27) | engine-owned child admission/dedupe를 사용; browser ledger를 유일한 durable effect 저장소로 쓰지 않는다. |
| plugin·hook·MCP·ACP · **부분** | backend endpoint/ACP command/model·MCP forwarding·profile/config·secret refs. (확인; A08, A09, A10, A15) | [B07](comparison-evidence.md#b07), [C14](comparison-evidence.md#c14), [C20](comparison-evidence.md#c20), [C23](comparison-evidence.md#c23) | backend ID/connection/capability/credential audience launch binding과 durable client completion 추가. [MC2-09] |
| 검증·진단·자동화 · **부분** | recurring/webhook automation interface·disable/dispatch/cancel API. (외부; A06, A18) | [B04](comparison-evidence.md#b04), [C17](comparison-evidence.md#c17), [C25](comparison-evidence.md#c25), [C28](comparison-evidence.md#c28), [C35](comparison-evidence.md#c35) | host scheduler occurrence/leadership/disabled draft와 existing inbox 결속. 외부 scheduler 정확성은 미검증. [MC2-08] |
| 이미지·문서·추가 형식 · **범위제한** | 앱 payload/ACP와 external SDK/provider 경계 확인; media core는 외부. (외부; A02, A08, A09) | [C14](comparison-evidence.md#c14), [C15](comparison-evidence.md#c15), [C31](comparison-evidence.md#c31), [C32](comparison-evidence.md#c32), [C33](comparison-evidence.md#c33) | Moodcode image/PDF/local source 구현과 외부 agent 인식을 분리. |

### 이 저장소의 후보 전수 매핑

| 후보 | 현재 상태/판단 | 구현 묶음·순서 |
|---|---|---|
| **OHAPP-C1** · backend capability와 시작 요청의 고정 binding | engine/host 분리, getCapabilities, host provider 등록, exact profile revision, credential audience와 local utility RPC는 기구현이다. 여러 local/remote backend를 선택한 상태에서 장시간 시작·승인·후속 요청 전체를 같은 실행 identity에 묶는 control-plane registry는 추가 범위다. **추가 계약 필요** | [MC2-09](implementation-blueprint.md#mc2-09) · P2 · 후속 확장 |
| **OHAPP-C2** · recurring trigger를 기존 durable inbox에 연결하는 host 계약 | queue/steer·pause/resume·FIFO·workspace 공정성·request dedupe·owner recovery는 기구현이다. 시간대가 있는 반복 예약·webhook trigger·job occurrence 이력·scheduler leadership는 추가 host 계층이다. 앱 source에서 외부 scheduler 본체를 검증한 후보가 아니다. **추가 계약 필요** | [MC2-08](implementation-blueprint.md#mc2-08) · P2 · 후속 확장 |
| **OHAPP-C3** · client 효과의 durable 요청·완료 확인 | host plugin prepared/settled metadata, 승인된 read-only child delegation, host write child·worktree owner·budget/cancel 상속, terminal 결과 inbox는 기구현이다. renderer 또는 원격 extension이 처리하는 effect를 단순 publication/ack와 실제 완료로 나누는 공개 계약은 추가 범위다. **추가 계약 필요** | [MC2-09](implementation-blueprint.md#mc2-09) · P2 · 후속 확장 |

## 개선 우선순위

기존 실행/기록/권한/효과 복구를 보존하고 **코드 이해 → 검증 가능한 완료 → 승인된 지식 재사용**을 먼저 보강한다. hook/권한 진단은 공통 기반으로 작은 범위부터 추가한다. live team·overlay·role workflow는 새로운 영구 상태가 있어 그다음이며, remote/ACP·scheduling·background job·PR feedback은 실제 host 환경 검증과 함께 진행한다. 선택적 Git/fork/code-mode/OS enforcement·효과 병렬은 기본 완료 조건과 분리한다.

새 export·테이블·도구 이름은 [구현 상세](implementation-blueprint.md)의 **제안**이다. 후보 75개가 모두 지금 필요한 기본 기능이라는 뜻은 아니다. 원본 root 고지/하위 고지/외부 구현 범위는 [분석 인덱스](README.md)와 개별 보고서의 한계를 유지한다.
