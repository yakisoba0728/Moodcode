# 엔진 첫 통합 검증

2026-10-07. 이 문서와 `engine-foundation-verification.json`은 첫 구현 묶음의 검증 기록이다. 이 파일을 추가한 커밋이 E0-01~E0-04의 구현·검증 커밋이다. 후속 커밋 ID는 병렬 구현 기록에서 연결한다.

완료 범위는 Input/Turn/Attempt/Part/ContextRevision 계약·validator, v1/v2 명시적 API 분리, 순차 DB migration과 고정 v1 데이터·복구 호환이다. 입력 scheduler가 연결되기 전에 계약 작성만으로 queue/steer를 완료로 표시하지 않는다.

함께 준비한 기반은 Run/입력별 budget 계정과 설정 병합, artifact identity/hash/retention·부분 결과 저장, 모델 metadata·context plan·지침 source 관찰, schema2 JSONL transport, 엔진 전용 검증 및 대표 코딩 과업 평가다. 각 기능의 runtime 연결과 후속 완료 조건은 TODO에 열린 상태로 남긴다.

검증 결과:

- `npm run typecheck`: 전체 workspace 통과. Electron 앱은 실행하지 않았다.
- `npm run test:engine`: contracts/engine/harness **1173개 중 1172 통과, 1개 Windows 전용 skip, 실패 0**. 새 계약 16개, artifact 18개와 budget/config/context/transport·migration·호환 fixture를 포함한다.
- `node scripts/evaluate-engine.mjs`: 작은 버그·빈 목록 경계·두 모듈 수정 **3/3 통과**. 임시 Git 저장소에서 승인→read/patch/command→독립 검사와 예상 diff·미요청 파일 보존을 확인했다. provider는 scripted fixture이며 usage 미제공은 null이다.
- `git diff --check`: 통과.

첫 무제한 file concurrency 실행은 종료 코드 137로 중단되어 성공으로 계산하지 않았다. 테스트 runner의 file concurrency를 4로 제한했다. 이후 crash fixture의 timer가 store를 참조하지 않아 SQLite owner가 수거될 수 있는 문제를 수정했다. 살아 있는 owner를 timer closure에서 유지하도록 하고 기존 `DB_LOCKED` assertion을 유지한 뒤 전체를 통과했다.

이번 검증에서는 실계정 모델 요청, GUI, Windows/Linux 실제 실행을 하지 않았다. schema2 JSONL은 opt-in engine 포트가 없으면 `COMMAND_UNAVAILABLE`로 응답하며, native handler capability는 후속 통합 완료 뒤 활성화한다. artifact 저장 모듈 테스트를 기존 command/read/patch producer 연결 완료로 해석하지 않는다.
