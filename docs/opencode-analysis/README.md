# OpenCode 저장소 분석

OpenCode의 엔진, 구현, TUI와 주변 패키지가 어떻게 연결되는지 이해하기 위한 분석이다. 저장소를 전체 clone해 코드 구조와 실행 진입점을 확인한 뒤, 아래 8개 세션이 같은 소스 커밋을 기준으로 세부 분석을 완료했다. 이번 작업의 중심은 OpenCode 자체의 동작과 설계다.

[구조 종합 분석](./00-overview.md)은 8개 보고서의 주요 결론, 실행 경로와 구조도, 교차 확인한 질문과 검증 범위를 연결한다. 세션 8개 모두 오류 없이 완료했으며, 보고서와 coverage 파일 8쌍을 확인했다. 영역별 보고서의 커밋 고정 소스 링크 2,017개는 파일 존재와 줄 범위를 검사했고, 참조 링크 누락은 없었다. 점검 결과는 [verification-results.json](./verification-results.json)에 기록했다.

분석 완료는 모든 파일의 완독이나 전체 실행 검증 완료를 뜻하지 않는다. 각 coverage 파일에 표본 조사·제외·미검증 범위를 명시했고, 실제 실행한 제한 테스트와 테스트 소스 독해를 구분했다. 실제 모델 호출, TUI·서버 통합 실행과 전체 빌드는 이번 분석에서 검증하지 않았다.

## 분석 기준

- 원본 저장소: https://github.com/anomalyco/opencode
- 소스 checkout: /Users/yakisoba0728/Documents/GitHub/opencode
- 브랜치: dev
- 커밋: 907b3bc518fa48e90e8ec24dd327d13eee71c36c
- 커밋 날짜: 2026-10-02
- 분석 시작 날짜: 2026-10-04 Asia/Seoul
- clone 방식: 일반 git clone. shallow clone이 아니며 Git 이력과 원격 브랜치 refs를 포함한다.
- HEAD에서 추적 중인 파일: 6,646개
- HEAD까지의 커밋: 15,847개
- 세션 설정: gpt-6.1-sol, ultra
- 결과 디렉터리: /Users/yakisoba0728/Documents/GitHub/Moodcode/docs/opencode-analysis

## 1차 확인 결과

루트 package.json은 Bun 1.3.14와 TypeScript 모노레포를 구성한다. 기본 개발 명령은 packages/opencode/src/index.ts로 진입한다. 이 진입점은 여러 CLI 명령과 TUI 명령을 등록하며, TUI 명령은 worker를 생성하고 별도 패키지의 화면 코드와 연결한다.

현재 TUI는 packages/tui에 있다. OpenTUI와 SolidJS를 사용하며, app.tsx가 renderer와 provider를 구성한다. SDK context는 API 요청과 이벤트 구독을 제공하고, sync context는 메시지, 세션, 승인, 질문 등의 상태를 화면용 reactive store에 반영한다.

packages/opencode의 기존 구현과 packages/core, packages/llm, packages/protocol, packages/server, packages/client, packages/cli로 분리된 구현이 함께 존재한다. packages/cli의 기본 명령은 daemon transport를 확보한 뒤 TUI를 호출한다. 따라서 문서나 디렉터리 이름만으로 기능의 실제 사용 여부를 판단하지 않고 진입점과 import, runtime layer 연결을 확인해야 한다.

V2 SessionV2는 SessionExecution과 연결되며, 현재 로컬 실행 구현은 SessionRunCoordinator와 LocationServiceMap을 통해 SessionRunner에 실행을 전달한다. CONTEXT.md와 루트 AGENTS.md에는 durable input admission, steer/queue, provider-turn boundary, Context Epoch 등의 계약이 정리되어 있다. 각 계약의 실제 구현 수준은 담당 세션이 코드와 테스트로 검증한다.

루트 AGENTS.md는 Schema에서 Core와 Protocol, 이어서 Server로 향하는 의존성 방향을 요구한다. Client는 Schema와 Protocol에 의존하고, sdk-next는 Client, Core, Server를 조합한다. API 생성 코드와 구현 코드의 소유 경계를 따로 확인해야 한다.

현재 공용 checkout에는 의존성을 설치하지 않았다. 일반 shell PATH에서 Bun을 찾지 못했으므로, 실행 검증 여부는 각 보고서에 별도로 기록한다. 이는 소스 분석을 시작하는 데 영향을 주지 않는다.

## 세션별 담당 범위

| 세션 | 담당 범위 | 보고서 |
|---|---|---|
| 01-engine | 에이전트 엔진과 세션 실행 | [OpenCode 엔진과 세션 실행 분석](./01-engine.md) |
| 02-tools | 도구 실행과 파일 및 프로세스 관리 | [OpenCode 도구 실행과 권한 분석](./02-tools.md) |
| 03-models | LLM 프로바이더와 인증 및 스트리밍 | [OpenCode 모델 연동과 스트리밍 분석](./03-models.md) |
| 04-tui | TUI 렌더링과 입력 및 사용자 경험 | [OpenCode TUI 구현과 상호작용 분석](./04-tui.md) |
| 05-data-api | 영속 저장과 이벤트 및 서버 계약 | [OpenCode 데이터 저장과 API 분석](./05-data-api.md) |
| 06-extensions | 설정과 플러그인 및 외부 도구 통합 | [OpenCode 설정과 확장 기능 분석](./06-extensions.md) |
| 07-clients | 웹 및 데스크톱과 공유 UI | [OpenCode 웹과 데스크톱 클라이언트 분석](./07-clients.md) |
| 08-build-ops | 모노레포 구성과 CLI 및 배포 운영 | [OpenCode 빌드와 테스트 및 운영 분석](./08-build-ops.md) |

각 세션의 구체적인 경로와 질문은 [analysis-plan.json](./analysis-plan.json)에 기록한다. 경계에 있는 기능은 호출자와 제공자 양쪽의 계약을 설명하되, 같은 세부 구현을 중복 조사하는 대신 주 담당 범위와 교차 확인할 위치를 명시한다.

## 분석 방법과 산출물

각 세션은 이 계획과 analysis-plan.json에서 자신의 항목을 읽고, 원본 checkout의 AGENTS.md 및 해당 하위 지침을 확인한다. git rev-parse HEAD로 분석 기준이 일치하는지 검증한 뒤, 담당 범위의 소스, package manifests, 관련 테스트와 명세를 함께 조사한다. README나 파일 목록을 요약하는 수준에서 멈추지 않고 주요 호출 경로를 실제 코드로 추적한다.

공용 소스 checkout은 모든 세션이 같은 내용을 참조하는 읽기 전용 분석 대상으로 유지한다. 보고서와 보조 자료는 본인에게 지정된 파일명 또는 같은 접두사의 파일에 저장한다. 공용 checkout의 브랜치, 소스, lockfile, node_modules를 변경하는 대신 필요한 실행 검증은 독립 임시 환경에서 수행할 수 있다. 실제 provider 호출은 이 분석에 필요하지 않다.

한국어 Markdown 보고서는 다음 내용을 주제에 맞는 문단, 표, Mermaid 도식으로 설명한다.

1. 담당 영역의 목적과 전체 구조에서의 위치, 패키지 및 핵심 모듈의 책임.
2. 실제 진입점과 주요 호출 흐름. 사용자 입력, 상태 변화, 이벤트와 결과의 이동.
3. 핵심 타입과 데이터 구조, Effect 의존성과 자원 수명, 동시성 및 취소, 오류와 재시도.
4. 기존 구현과 V2 구현의 차이, 호환 계층, 실제 연결 여부와 미완료 사항.
5. 중요한 구현 선택과 그에 따른 제약. 관찰된 사실과 해석을 구분한다.
6. 관련 테스트의 검증 범위와 대표 시나리오. 테스트를 읽은 경우와 실행한 경우를 구분한다.
7. 조사한 경로, 생성 파일과 자산의 처리 방식, 아직 확인하지 못한 부분과 다른 세션에 넘길 질문.

중요한 사실은 커밋이 고정된 GitHub 소스 링크에 줄 번호를 붙여 근거를 제공한다. 예: https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/core/src/session/execution/local.ts#L18 . 인용한 줄 번호와 함수 이름을 실제 파일에서 확인한다. 명세에 적힌 요구사항과 현재 구현을 혼동하지 않는다.

각 보고서 옆에 <세션 ID>.coverage.json을 저장한다. source_commit, area, reviewed_paths, sampled_paths, excluded_paths와 제외 이유, unverified_points, cross_area_questions를 포함한다. 산출물은 깊이 있는 설명에 필요한 분량으로 작성하고, 긴 소스 복사와 자명한 코드 설명은 줄인다. Moodcode 구현이나 새 제품 설계는 이번 분석의 산출물에 포함하지 않는다.

완료 시 해당 세션의 최종 답변에는 핵심 발견, 보고서의 절대 경로 링크, 실행 검증 여부와 남은 질문을 간결하게 정리한다.
