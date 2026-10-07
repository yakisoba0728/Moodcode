# 엔진 비교와 Moodcode의 확장 범위

2026-10-07의 고정 checkout을 비교한다. 엔진 진입점·모델 호출·도구 실행·종료·저장·복구 경로를 읽은 정적 분석이며 제품 실행·성능 측정 결과는 아니다. 저장소별 전체 SHA와 관측 시점은 [manifest](source-manifest.json), 소스 줄과 확인 한계는 아래 개별 보고서를 따른다. 목록 18개와 OpenHands 앱 1개는 **19개 저장소**이며 19개의 서로 독립적인 엔진이라는 뜻은 아니다.

## 저장소별 참고 가치

| 저장소 | 확인할 엔진 경계 | Moodcode에 참고할 동작 | root 고지와 주요 주의점 |
|---|---|---|---|
| [Aider](aider.md) | Python Coder·편집 format·LiteLLM | 심볼 관계 기반 repo map, 제한된 lint/test 수리, planner/editor 역할 | Apache-2.0. 기본 auto-test는 꺼져 있고 commit 이후 lint 경로가 있음 |
| [Plandex](plandex.md) | Go server의 plan/build와 CLI의 실제 적용·명령 실행 | 적용 전 변경안 overlay, 작업별 프로젝트 문맥, 검증 단계 | MIT. Cloud 종료 고지는 저장소 전체 archived와 구분 |
| [Gemini CLI](gemini-cli.md) | TypeScript chat·typed scheduler·도구 lifecycle | 기억 검토 inbox, 큰 결과 요약, hook, 실제 OS sandbox | Apache-2.0. MCP의 로컬 대기 취소가 원격 효과 rollback을 증명하지 않음 |
| [Qwen Code](qwen-code.md) | 독자 LLM chat·subagent runtime·team board | 상주 child 후속 입력, 팀 메시지, 기억/skill 제안, code-mode | Apache-2.0. Gemini 계열이지만 현재 독자 구현을 확인 |
| [Cline](cline.md) | `@cline/agents` AgentRuntime와 `@cline/core` SessionRuntime/hosts | 팀 mailbox, 예약 실행, typed lifecycle hook, 공유 host | Apache-2.0. 공개 SDK와 비공개 JetBrains plugin 구분; 팀 이벤트 큐는 무손실 journal 보장이 아님 |
| [Goose](goose.md) | Rust Agent·tool router; 실험 state machine은 별도 | recipe와 구조화 결과, ACP, 기억 publication, child join | Apache-2.0 및 별도 고지. `GOOSE_STATE_MACHINE` 기본 false |
| [OpenHands SDK](openhands-sdk.md) | Python LocalConversation·Agent step·typed event/observation | 대화 fork, prepared 자원 기반 병렬화, 완료 gate, 원격 host | MIT. 대화 fork가 workspace/worktree 격리를 뜻하지 않음 |
| [Zoo Code](zoo-code.md) | TypeScript extension Task와 CLI shim·TaskScheduler | 의미 코드 검색, durable 역할 재개, profile별 MCP 범위 | Apache-2.0. scheduler 기본 동시 실행 수는 1 |
| [Mistral Vibe](mistral-vibe.md) | Python Unified Harness가 기본; legacy AgentLoop 분리 | 지침의 신뢰 활성화, hook, child mailbox, ACP | root Apache-2.0. Rust CLI Cargo metadata의 `Proprietary`와 불일치가 있어 하위 범위 별도 확인 필요 |
| [Kimi Code](kimi-code.md) | TypeScript AgentLoopService·LLMRequester·ToolExecutor | 명령의 background 전환, 역할 child handoff, hook | MIT; VSCode app 하위 Apache-2.0 고지 별도. pi-tui 사용은 UI 경계; conversation undo와 파일 복원 구분 |
| [Kilo Code](kilocode.md) | 기본 CLI/IDE의 OpenCode 계열 SessionPrompt·SessionProcessor; V2 runner 별도 | 공유 board, 승인형 프로젝트 기억, 승인 판단 출처 | MIT. 서로 다른 engine 진입점을 하나의 기본 경로로 섞지 않음 |
| [mini-SWE-agent](mini-swe-agent.md) | Python 짧은 bash 도구 루프·환경·trajectory | 오류 관측 검증, trajectory 투영, 증거 기반 batch 재개 | MIT. JSON 완료 ID로 batch를 건너뛰는 기능과 살아 있는 Run 복구 구분 |
| [Open SWE](open-swe.md) | TypeScript 서비스·sandbox middleware와 외부 DeepAgents/LangGraph | PR revision별 CI feedback, 명시적 단계 증거, background job | MIT. 외부 engine dependency는 이번 19개 소스 분석 범위 밖; standalone AgentServer 배포 조건 별도 |
| [Roo Code](roo-code.md) | TypeScript extension Task·직접 child 생성; CLI 동일 bundle shim | 의미 검색, 역할별 파일 범위, durable continuation, 완료 gate | Apache-2.0, GitHub archived. Zoo의 추가 scheduler 기능을 역으로 적용하지 않음 |
| [Continue](continue.md) | TypeScript CLI 도구 루프와 IDE Redux→core 루프 분리 | 혼합 검색·context provider·background 결과 전달 | Apache-2.0. README 유지보수 중단·read-only 고지와 API archived=false 구분 |
| [SWE-agent](swe-agent.md) | Python model/parser/action·SWE-ReX 환경·history processor | 도구 오류 분류, 환경 세대, 증거 기반 종료·trajectory | MIT. README의 mini로 이전 고지와 GitHub archived 여부 구분 |
| [구 Kimi CLI](kimi-cli-legacy.md) | 현재 entry는 deprecation gate; Python Soul·Kosong·Kaos는 보존된 역사적 경로 | 역사적 context checkpoint/rewind, 후속 메시지·승인 경계 | Apache-2.0·NOTICE, GitHub archived. 현재 TypeScript 구현으로 간주하지 않음 |
| [Crush](crush.md) | Go sessionAgent와 외부 fantasy loop·도구/승인·session 저장 | LSP symbol navigation, 무진전 반복 관측, command job·정책 hook | **FSL-1.1-MIT source-available**. 현재 버전의 경쟁 용도 제한·버전별 2년 후 전환·별도 초기 MIT 고지 구분 |
| [OpenHands 앱](openhands-app.md) | Agent Canvas TypeScript host/control과 별도 Agent Server·automation package 연결 | backend launch binding, trigger admission, client 효과 완료 확인 | MIT. Python SDK·외부 agent 자체 engine과 별도 저장소 |

이 표의 license는 root 고지이며 전체 배포 의존성의 권리를 보증하는 분류가 아니다. [분석 기준](analysis-protocol.md)처럼 원본은 Moodcode 바깥에 보관하고, 코드·프롬프트·fixture를 Moodcode에 복사하지 않았다. 소스 관찰과 그로부터 제안하는 독립 계약을 구분한다.

## 기존 구현을 보존하며 확장할 축

비교 기준은 Moodcode engine source `464812f7d1af24466f57070663131f5979aeca51`다. 자세한 기구현 근거는 [baseline](moodcode-baseline.md)을 따른다. 표의 새 계약은 이번 작업에서 구현된 기능이 아니다.

| 축 | 이미 있는 Moodcode 계약 | 추가할 계약 | 대표 제안 근거 |
|---|---|---|---|
| 저장소 문맥 | bounded context·glob/regex 검색·history 요약·LSP 문서 동기화 | source hash와 parser revision을 가진 심볼 지도·요청별 파일 선정; versioned LSP navigation | AIDER-C01, plandex-task-context-map, CONTINUE-C01/C02, CR-C01; 의미 검색은 zoo-code-C1, roo-code-C1 |
| 검증과 완료 | 명령·LSP·formatter·tool feedback·checkpoint | 검증 계획, changed hash에 결속한 결과, 제한 수리, terminal 완료 gate | AIDER-C02, plandex-edit-validation-ladder, OHSDK-C3, roo-code-C4, OSWE-C2 |
| 프로젝트 기억 | 세션별 semantic memory·skill/reference 읽기 | 추출 후보 inbox와 별도 승인 publication·철회 | gemini-memory-inbox, QWEN-C03, GOOSE-C03, K-C02, OSWE-C4 |
| lifecycle 확장 | host 등록 plugin·prepared/settled metadata observer | 모델/turn/종료 경계의 typed 관측·context contribution·deny/stop | CLINE-C03, QWEN-C05, gemini-model-lifecycle-hooks, MV-C02, kimi-code-C1, kimi-cli-legacy-C3, CR-C04 |
| 적용 전 변경안 | exact 편집 승인·hash checkpoint·복원 | 여러 변경의 미적용 overlay·검토 revision·최종 apply receipt | plandex-review-proposal-overlay |
| 상주 팀 협업 | 격리 child·root terminal inbox·budget/deny 상속 | 살아 있는 child mailbox·읽음 receipt·team task owner/dependency CAS | CLINE-C01, QWEN-C01/C02, MV-C03, K-C01 |
| 역할 workflow | immutable profile·read-only model delegation·host write child | 설계 artifact→editor→validator 단계·durable join/handoff | AIDER-C03, plandex-model-role-routing, GOOSE-C05, zoo-code-C2, roo-code-C2, kimi-code-C3 |
| recipe·예약 실행 | durable input·FIFO/fairness·task CAS | versioned parameters/result schema·occurrence ID/lease/missed-run 정책 | GOOSE-C01, CLINE-C02, OHAPP-C2 |
| host와 외부 agent | engine/host 분리·MCP·utility process·event replay | ACP/원격 host의 capability/connection epoch/context ownership·launch binding; client 수신 ack와 효과 완료 receipt 분리 | GOOSE-C02, MV-C04, CLINE-C04, OHSDK-C4, kimi-cli-legacy-C4, OHAPP-C1/C3 |
| 명령 장기 실행 | PTY·process ownership·cancel/cleanup·Run recovery | Run 종료 후에도 소유권이 있는 job·foreground/background 전환·delivery | kimi-code-C2, OSWE-C3, CONTINUE-C03, CR-C03 |
| 권한·물리적 격리 | Plan/Build·deny·scope grant·exact fingerprint | OS enforcement capability, role별 파일/MCP 자원 범위, preflight 판단 출처 | gemini-os-sandbox, roo-code-C3, zoo-code-C3/C4, K-C03 |
| 관측과 외부 feedback | native journal·diagnostics·artifact paging·같은 읽기 반복 차단 | 고정 sequence trajectory·큰 결과 요약·PR SHA별 CI feedback·결과/효과 epoch 기반 무진전 진단 | MSA-C01/C02/C03, SWA-C01/C02/C04, gemini-artifact-distillation, OSWE-C1, CR-C02 |
| 선택적 실험 | 동일 tool capture와 context 예약 | 제한 code-mode, prepared 자원 병렬화, 대화 fork, video | QWEN-C04, OHSDK-C1/C2, kimi-cli-legacy-C1/C2, kimi-code-C4 |

서로 다른 프로젝트가 같은 항목을 제안해도 구현 한 개로 합칠 수 있다. 예를 들어 모든 hook 후보를 각기 별도 hook 시스템으로 만들지 않고, 하나의 versioned lifecycle 계약으로 정리한다. mailbox는 이미 있는 terminal inbox를 유지하면서 새 계약을 더하며, semantic map은 최신 파일 자체를 읽고 확인하는 절차를 대신하지 않는다.

## 완료·취소·복구에서 확인한 차이

README의 병렬 실행·자동 복구·완료 설명만으로 실제 보장을 추정하지 않았다. Zoo의 기본 scheduler는 serial이고, OpenHands의 conversation fork는 같은 workspace를 사용한다. Aider의 map 예산에는 목표 대비 허용 여유가 있어 Moodcode의 hard context cap과 같은 계약이 아니다. SWE 계열의 patch 제출·batch skip·trajectory replay는 검사가 통과했거나 물리적 효과가 crash 뒤 안전하게 재개된다는 증거가 아니다.

취소에서도 로컬 await의 종료, provider 요청 취소, 원격 도구 효과 중지, 프로세스 정리를 따로 봤다. Gemini MCP의 outer abort race나 Roo의 Task AbortSignal 전달 범위로 원격/물리적 정리 성공을 확정하지 않는다. 이는 해당 제품의 실행상 취약점을 재현했다는 의미가 아니라, 읽은 source에서 확인할 수 있는 보장 범위의 구분이다. Moodcode의 accepted effect·receipt·cleanup uncertainty·중복 replay 차단을 후속 기능에서도 유지한다.

우선 구현 순서와 작은 작업 계약은 [독립 구현 후보](implementation-candidates.md), 저장소별 모든 후보는 [catalogue](candidate-catalogue.json), 공통 수용 조건은 [independent contracts](independent-contracts.md)를 따른다. 실제 OS/provider/CI의 기존 열린 네 항목은 이 비교로 완료되지 않는다.
