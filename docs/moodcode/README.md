# Moodcode 구현 계획

갱신일: 2026-10-07, Asia/Seoul. 자체 엔진과 Electron 앱의 첫 구현·통합 검증을 완료했고, 이전 단계에서 실제 Codex 모델 연결과 macOS arm64 개발용 패키지도 검증했다. 현재는 GUI보다 내부 엔진 확장을 우선한다. 현재 구현은 [구현 상태](./implementation-status.md), 새 엔진 제안은 [OpenCode 엔진 검토와 독립 구현안](../opencode-engine-review/README.md)을 따른다.

Moodcode는 로컬 Git 저장소에서 코드를 읽고 수정하며 명령을 실행하는 데스크톱 코딩 에이전트다. 사용자가 확정한 방향은 **Electron 데스크톱 앱**, **Moodcode 자체 엔진 구현**, **GUI보다 내부 엔진을 먼저 개발**하는 것이다. OpenCode 분석은 구현 계약과 화면 설계의 참고 자료로 사용한다.

| 문서 | 내용 |
|---|---|
| [제품·화면 명세](./product-spec.md) | 사용자 흐름, 화면 구성, 첫 버전의 기능과 완료 조건 |
| [아키텍처](./architecture.md) | 프로세스, 패키지, 엔진 루프, 상태·이벤트·저장·취소 계약 |
| [엔진 구현 명세](./engine-spec.md) | GUI 없는 실행 구조, 모듈 책임, 첫 구현의 입출력·완료 조건 |
| [Electron·Tauri 비교](./desktop-framework.md) | Electron 선택 기록, 비교 근거와 배포 시 실행 확인 |
| [구현 순서](./implementation-plan.md) | 엔진부터 개발하는 단계, 첫 작업 묶음과 검증 조건 |
| [병렬 구현 작업](./parallel-implementation.md) | 파일 담당 범위, 공통 port와 세션별 작업 계약 |
| [구현 세션 목록](./implementation-sessions.json) | 10개 세션의 ID·담당 경로·보고서 |
| [구현 상태와 검증](./implementation-status.md) | 현재 구현 범위, 전체 테스트와 Electron 실행 증거, 남은 작업 |
| [엔진 구현 TODO](../../TODO.md) | 새 엔진 구현 75개 항목, 선행 작업·완료 조건·진행 상태. 후속 구현의 진행 기준 |
| [최신 OpenCode 엔진 검토](../opencode-engine-review/README.md) | 고정 원본 분석, 라이선스·출처, Moodcode 내부 엔진 확장 계약 |
| [OpenCode GUI 분석](../opencode-analysis/07-clients.md) | 웹 앱, Electron, 세션 UI, diff·파일·터미널 구현의 근거 |

## 결정 상태

| 항목 | 상태 | 내용 |
|---|---|---|
| 사용 형태 | 사용자 확정 | 로컬 저장소와 명령 실행 중심의 데스크톱 앱 |
| 엔진 | 사용자 확정 | 세션·모델 호출·도구·승인·취소·저장을 직접 구현 |
| 데스크톱 프레임워크 | 사용자 확정 | Electron |
| 개발 순서 | 사용자 확정 | GUI보다 내부 엔진부터 구현 |
| 제품 우선순위 | 확인 중 | 초안은 작업 과정과 변경 검토 중심. 병렬 작업·자유로운 구성도 선택 가능 |
| 엔진 언어·저장소 | 구현·검증 | TypeScript + Node, 내장 node:sqlite. Electron API를 엔진에서 직접 사용하지 않음 |
| GUI 기술 | 구현·검증 | React + TypeScript + Vite. 현재 후속 작업은 엔진 우선 |
| 첫 개발·실행 검증 OS | 구현·검증 | macOS arm64. 공개 지원 OS는 별도 결정 |
| 첫 모델 연결 | 구현·검증 | 기존 로컬 Codex 인증을 사용하는 provider와 실제 텍스트·tool loop 검증. 앱 자체 로그인·갱신은 후속 범위 |
| 모델 transport | 구현·검증 | fetch/HTTP SSE, Chat Completions·Responses·Codex adapter. 로컬 fixture와 이전 단계의 실제 Codex 검증 |
| 화면 배치 | 제안 | 작업 흐름 중심 / 변경 검토 중심의 두 배치 비교 |

스택·범위·화면 제안은 사용자 확정 사항과 구별한다. 실제 소스는 contracts·engine·harness에 있으며, 완료와 검증 범위는 구현 보고서 및 통합 검증 기록을 따른다.

현재 소스는 `contracts`, 독립 `engine`, 개발용 harness와 Electron desktop 앱을 포함한다. harness는 GUI 없이 엔진을 검증하는 진입점이며 TUI 제품을 먼저 만드는 범위는 아니다. 새 입력·turn·컨텍스트·도구 계약은 엔진과 harness에서 먼저 검증하고 이후 앱에 연결한다.

초기 제품·아키텍처·단계 문서는 최초 설계를 보존하고 있어 일부 완료 표시가 과거 상태다. 실제 구현·검증 여부는 최신 구현 상태 문서를 우선하며, 2026-10-07 엔진 검토의 제안은 아직 구현된 기능으로 표시하지 않는다.
