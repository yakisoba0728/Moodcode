# OpenCode 엔진 검토와 Moodcode 독립 구현

2026-10-07, Asia/Seoul. 사용자 요청에 따라 GUI보다 내부 엔진을 먼저 다룬다. OpenCode 소스는 외부 참조 checkout에서 분석하고 Moodcode 런타임에 이식하지 않는다.

참조는 `anomalyco/opencode`의 `dev`, **`4ac0d9c3d169bbe81d9570013effdda3fe24d36e`**다. 커밋 날짜는 2026-10-06이며, 이번 fetch 시점의 `origin/dev`다. 최신이라는 표현은 이 조회 시점에 한정한다.

| 읽는 순서 | 문서 | 내용 |
|---|---|---|
| 1 | [전체 구조](./00-overview.md) | 실제 기존 엔진/V2 경로, 모듈 경계, 현재 Moodcode와의 차이 |
| 2 | [실행·저장](./01-execution-state.md) | admission, steer/queue, turn, event, 취소·복구 |
| 3 | [모델·컨텍스트](./02-model-context.md) | provider stream, history, epoch, compaction, overflow |
| 4 | [도구·권한](./03-tools-permissions.md) | 파일·명령·승인·질문·snapshot·MCP·확장 |
| 5 | [Moodcode 엔진 구현안](./04-independent-engine-plan.md) | 자체 계약, 호환성, 구현 순서, headless 완료 조건 |
| 6 | [라이선스·출처 기준](./05-license-and-provenance.md) | MIT 조건, 별도 저작물·의존성, 원본 복사를 피하는 작업 기준 |

[source-inventory.json](./source-inventory.json)은 Git에 추적된 파일 중 엔진 범위의 경로·해시·줄 수·정적 import 목록을 기록한다. **목록 작성은 파일 전체의 의미를 검토했다는 뜻이 아니다.** 각 `*.coverage.json`은 직접 읽은 파일과 읽은 깊이를 기록하며, [검증 기록](./verification-results.json)은 이를 합쳐 보여준다. 모델별 모든 공급자를 실제 호출하거나 원본 전체 테스트를 실행한 결과로 해석하지 않는다.

원본 206개 경로와 Moodcode 23개 경로의 검토 깊이를 기록했다. 전체/부분/테스트 본문/spec/목록 확인을 구분한다. 엔진 inventory 1,376개 파일의 해시와 보고서의 고정 commit 소스 링크 195개, 로컬 링크 54개를 검사했고 경로·해시·줄 범위 오류는 없었다. 이 검사는 모든 주장의 런타임 정합성이나 원본 전체 정독을 증명하지 않는다.

전체 clone은 `/Users/yakisoba0728/Documents/GitHub/opencode`에 있다. 이전 분석의 checkout은 유지했고, 이번 참조 checkout은 `/Users/yakisoba0728/Documents/GitHub/opencode-engine-reference-4ac0d9c3d1`이다. 원본 소스는 Moodcode Git에 포함하지 않는다. [이전 저장소 전체 분석](../opencode-analysis/README.md)은 2026-10-02 커밋 기준으로 별도 보존한다.

이번 변경은 분석·설계 문서다. Moodcode 앱은 실행하지 않았으며, 계정 인증값·실제 모델 호출도 사용하지 않았다. 구현 여부는 [현재 구현 상태](../moodcode/implementation-status.md)를 따른다. 이 문서에 제안한 새 계약은 아직 구현된 기능이 아니다.
