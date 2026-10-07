# Moodcode 메인 엔진 2차 goal

2026-10-07 사용자 요청으로 활성화했다. 구현 출발점은 `8f6cd180bf5a1036cd8eeb8e428452285dccc21d`이며 [20개 구현 상세](../coding-agent-engine-review/implementation-blueprint.md)·[80개 제안 작업](../coding-agent-engine-review/implementation-work-items.json)을 따른다. 기존1차 goal의 종료를 다시 열지 않는다.

## 목표와 순서

MC2-01~20을 자체 TypeScript 엔진에 구현·연결·검증한다. W0 baseline/계약 → W1 저장소 문맥·lifecycle·권한/진단 → W2 검증·W3 승인형 기억 → W4 overlay/team/workflow → W5 scheduler/remote/job/PR/batch → ENV/WX 환경 검증·선택 기능 순서다. 각 범위의 실제 API·파일 이름은 구현 시 결정하고 변경 이유를 기록한다.

[진행 상태](engine-phase-two-progress.json)는 역사적 비교/제안 JSON과 분리한다. 제안 작업을 완료로 바꾸는 기준은 실제 코드·소비 경로·검증 근거이며 API 선언이나 테스트 개수만으로 완료하지 않는다. 작은 통합 범위마다 문서·TODO와 로컬 커밋을 남긴다. 모든80개 작업과20개 범위의 수용 조건이 충족됐을 때만 goal을 complete로 처리한다.

## 보존하는 경계

frozen request/context/tool capture, exact prepare→approval→effect·deny 우선, durable Run/Turn/Attempt/Part, parent budget, child/worktree/DB 격리, 실제 효과 owner/cleanup/uncertainty, archive pause-import를 유지한다. 새 읽기 기능은 현재 profile·host 등록·도구 선택과 문맥/출력 예산을 따른다. 파생 index는 현재 파일의 증거를 재검사하고 쓰기 권한을 만들지 않는다.

계약·runner·engine·native schema/archive는 하나의 통합 순서로 변경한다. migration 번호는 실제 저장 상태를 통합할 때 할당한다. 새로운 framework·upstream 코드/prompt/fixture 복사·GUI 변경·배포/push는 이 goal의 범위 밖이다.

## 검증과 종료

각 작은 작업은 독자 fixture의 stale/source hash·ignore/worktree·취소/timeout·crash/중복·count/byte/budget 경계 중 관련 조건을 통과해야 한다. 기능 묶음 연결 뒤 타입 검사·전체 회귀·headless engine fixture를 실행하고 source SHA와 결과를 기록한다. 실패를 해결하기 전 검증 범위를 축소하거나 skip으로 숨기지 않는다.

synthetic peer와 실제 OS/provider 결과를 구분한다. 선택 기능은 host opt-in/capability gate를 갖추고 실제 지원 환경의 증거를 요구한다. E5-13/E5-08/E6-07/E6-08은 별도 이월 상태로 유지하고 실제 계정/OS/CI 증거가 있는 범위만 닫는다. 미지원·미검증 환경을 지원한다고 표시하지 않는다.

2026-10-07의 [정적 비교](../coding-agent-engine-review/one-to-one-comparison.md)와 SHA/hash 검사는 당시 고정 baseline의 분석 기록이다. 이후 구현으로 현재 파일이 바뀌었다는 사실을 과거 source 근거 위조로 해석하지 않으며, 2차 검증은 새 커밋의 실제 코드에 수행한다. 기존 고정 근거·원본 manifest·비교 후보를 진행 상태로 덮어쓰지 않는다.
