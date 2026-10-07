# 공개 코딩 에이전트 엔진 비교

2026-10-07. 요청한 목록 18개와 OpenHands 앱 1개, **19개 저장소를 full-history clone하고 저장소마다 별도 서브에이전트로 분석했다.** 메인 실행 루프·문맥·도구/편집·승인·취소·저장/복구·하위 agent·확장·provider 경계를 확인했다. 보고서의 고정 소스 근거는 **395개**, 독립 구현 후보는 **75개**다. 각 저장소의 주요 기능과 확인 한계를 다뤘으며 모든 tracked 파일을 개별 설명하거나 외부 dependency 내부를 분석했다는 뜻은 아니다.

Moodcode의 새 엔진 기능을 이번 작업에서 구현한 것은 아니다. 기존 engine source `464812f7d1af24466f57070663131f5979aeca51`와 비교해 기능 중복을 구분했고, 후보를 12개 작업 묶음으로 정리했다. 첫 순서는 **저장소 구조 문맥 → 검증 계획·제한 수리·완료 gate → 승인형 프로젝트 기억**을 제안한다.

| 읽을 문서 | 내용 |
|---|---|
| [통합 비교](comparison.md) | 저장소별 실제 engine 경계·참고 가치와 기존 Moodcode 대비 추가 계약 |
| [후속 구현 후보](implementation-candidates.md) | 우선 세 묶음의 작은 작업·API/record 설계안·수용 조건 및 전체 순서 |
| [후보 catalogue](candidate-catalogue.json) | 75개 후보의 원본 SHA·관련 Moodcode 경로·우선순위·비용·검증 조건 |
| [공통 구현 계약](independent-contracts.md) | 승인·source freshness·cancel/recovery·budget·effect 소유권 기준 |
| [Moodcode 비교 기준](moodcode-baseline.md) | 이미 있는 기능과 13개 고정 source 근거 |
| [source manifest](source-manifest.json) | clone 경로·HEAD·commit 일시·GitHub 유지보수 관측·root license·고지 파일 inventory |
| [서브에이전트 담당 기록](analysis-sessions.json) | 19개 repo별 별도 담당 agent와 완료 보고서 |
| [정적 근거 검사](verification.json) | HEAD/clean/full history·파일/줄/SHA·permalink·후보/문서 링크·production 변경 여부 |
| [분석 기준](analysis-protocol.md) | 범위·증거·소스와 추론의 구분·독립 구현 원칙 |

## 개별 분석

각 보고서 옆의 `<slug>.evidence.json`에 원본 파일·줄·claim·후보 계약을 저장했다. SHA-256은 evidence에 기록된 값과 함께 최종 verification의 whole-file/range digest를 따른다. 동시 분석 3개로 진행했으며 총 19개의 저장소별 담당 agent를 사용했다.

| 프로젝트 보고서 | 저장소 | root 고지 | 근거 | 후보 |
|---|---|---|---:|---:|
| [Aider](aider.md) | Aider-AI/aider | Apache-2.0 | 20 | 4 |
| [Plandex](plandex.md) | plandex-ai/plandex | MIT | 20 | 4 |
| [Qwen Code](qwen-code.md) | QwenLM/qwen-code | Apache-2.0 | 20 | 5 |
| [Gemini CLI](gemini-cli.md) | google-gemini/gemini-cli | Apache-2.0 | 20 | 4 |
| [Cline](cline.md) | cline/cline | Apache-2.0 | 20 | 4 |
| [Goose](goose.md) | aaif-goose/goose | Apache-2.0 | 20 | 5 |
| [OpenHands SDK](openhands-sdk.md) | OpenHands/software-agent-sdk | MIT | 20 | 4 |
| [Zoo Code](zoo-code.md) | Zoo-Code-Org/Zoo-Code | Apache-2.0 | 20 | 4 |
| [Mistral Vibe](mistral-vibe.md) | mistralai/mistral-vibe | Apache-2.0 | 20 | 4 |
| [Kimi Code CLI](kimi-code.md) | MoonshotAI/kimi-code | MIT | 20 | 4 |
| [Kilo Code](kilocode.md) | Kilo-Org/kilocode | MIT | 20 | 3 |
| [mini-SWE-agent](mini-swe-agent.md) | SWE-agent/mini-swe-agent | MIT | 20 | 4 |
| [Open SWE](open-swe.md) | langchain-ai/open-swe | MIT | 20 | 4 |
| [Roo Code](roo-code.md) | RooCodeInc/Roo-Code | Apache-2.0 | 20 | 4 |
| [Continue](continue.md) | continuedev/continue | Apache-2.0 | 20 | 3 |
| [SWE-agent](swe-agent.md) | SWE-agent/SWE-agent | MIT | 20 | 4 |
| [구 Kimi CLI](kimi-cli-legacy.md) | MoonshotAI/kimi-cli | Apache-2.0 | 27 | 4 |
| [Crush](crush.md) | charmbracelet/crush | FSL-1.1-MIT | 28 | 4 |
| [OpenHands 앱 / Agent Canvas](openhands-app.md) | OpenHands/OpenHands | MIT | 20 | 3 |

## clone과 검증 범위

원본 소스는 `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007`에 보관한다. 19개 전체 Git 이력과 **60,418개 tracked 경로**를 확보하고 각 HEAD를 고정했다. Git LFS 미디어는 포인터로 유지하며 submodule을 재귀 초기화하지 않았다. 미초기화 gitlink는 Cline의 `evals/cline-bench`다. 원본 저장소는 Moodcode Git에 넣거나 runtime dependency로 추가하지 않았다.

최종 정적 검사에서 19개 원본 HEAD·clean·full history, 근거 395개·고정 source 링크 544개·후보 75개·Moodcode baseline 근거 13개가 통과했다. 담당/후보 registry와 문서 링크도 일치하며 production 변경·새 runtime 파일·검사 오류는 0이다. staged diff의 공백 검사도 통과했다.

검사는 `python3 docs/coding-agent-engine-review/verify-evidence.py --output docs/coding-agent-engine-review/verification.json`로 재현한다. original checkout 19개와 Moodcode baseline commit이 필요하다. 근거 파일의 고정 commit 소속·전체 및 구간 SHA·permalink·후보 실제 경로·문서 링크를 검사한다. upstream install/build/test·실제 모델/계정·서비스·GUI·benchmark를 실행한 결과는 아니다. 기존 Moodcode의 1차 테스트 기록은 [현재 구현 상태](../moodcode/implementation-status.md)에 보존한다.

## license·유지보수·외부 엔진 경계

실제 root 고지는 Apache-2.0 10개·MIT 8개·FSL-1.1-MIT 1개다. root 고지와 하위 package·외부 dependency의 허가 범위를 구분한다. manifest의 119개 license/notice/copying filename inventory에는 helper source 경로도 포함되며 전체 배포 의존성 권리 audit가 아니다. 분석·동작 명세만 작성했고 원본 코드·prompt·tool description·fixture·미디어를 복사하지 않았다. 원본을 읽은 분석이므로 clean-room 절차를 주장하지 않는다.

Crush는 현재 FSL source-available이며 경쟁 용도 제한·버전 공개 2년 후 MIT 전환·별도 초기 MIT 고지를 구분한다. Mistral Vibe는 root Apache 고지와 Rust CLI Cargo metadata의 `Proprietary`가 불일치한다. 개별 고지 범위의 확인 없이 전체 project 재사용 가능 여부를 단정하지 않는다.

Roo Code와 구 Kimi CLI는 관측 당시 GitHub archived다. 구 Kimi CLI의 공개 console entry는 새 CLI 이관 안내로 바뀌어, 보존된 Python 엔진 분석과 구분했다. Continue는 README에서 유지보수 중단/read-only를 선언하지만 API archived=false다. SWE-agent의 mini로 이전 안내와 Plandex Cloud 종료도 각각 source repository archive 여부와 구분했다.

OpenHands 앱은 현재 Agent Canvas이며 Python SDK/Agent Server 및 automation backend와 별도 경계다. Open SWE의 DeepAgents/LangGraph, Crush의 fantasy, SWE-agent의 SWE-ReX 등 외부 package 내부는 이번 19개 checkout 전체 분석에 포함되지 않는다. Amp·Claude Code의 비공개 코어도 공개 소스 확인으로 간주하지 않았다.

기존 1차 종료와 OS/provider/CI의 열린 네 항목은 보존했다. GUI 기능 연결이나 새로운 goal 시작은 이번 분석 완료 범위에 포함하지 않는다. 다음 구현의 완료 표시는 독립 계약을 구현·검증한 뒤 추가한다.
