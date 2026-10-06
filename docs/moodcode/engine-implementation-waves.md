# 엔진 병렬 구현 기록

2026-10-07 사용자가 전체 엔진 TODO의 병렬 구현을 승인했다. 진행 기준은 루트 `TODO.md`이며 GUI는 실행하지 않는다. 구현과 fixture 검증은 Moodcode 자체 코드로 작성한다.

## 첫 작업 묶음

| 담당 | 항목 | 쓰기 범위 |
|---|---|---|
| engine_execution_review | E0-01·02 | contracts/src, engine/src/ports.ts, engine-contracts-v2.md |
| engine_context_review | E0-03·04 | engine/src/storage, engine-migrations.md |
| engine_tools_review | E0-07·E4-02 기반 | engine/src/artifacts, engine-artifacts.md |
| 주 세션 | E0-05·06·08, 통합 | engine 구성·config, harness, scripts, TODO 및 검증 기록 |

에이전트는 담당 파일의 구현·검증을 보고한다. 주 세션이 공용 빌드·전체 회귀와 커밋을 담당한다. 항목의 모든 완료 조건이 만족되기 전에는 체크하지 않는다. 선행 기능 없이 작성한 확장 모듈은 연결 준비 상태로 기록한다.

## 합의한 계약

- 기존 `SCHEMA_VERSION=1`, `EngineEvent`와 `run.submit`을 보존한다.
- 새 입력은 실제 Run이 생성되기 전에 접수할 수 있다. 가짜 Run을 생성하지 않는다.
- 별도 v2 session event journal은 session/input을 owner로 사용하며 Run/Turn/Attempt 연결은 존재할 때만 추가한다. v1 journal과 cursor는 섞지 않는다.
- `turnAllowance`는 새 사용자 입력이 반영된 뒤의 logical turn 허용량, `maxTurns`는 Run 전체 절대 상한이다. `maxToolCallsPerTurn`과 Run 전체 `maxToolCalls`를 별도로 적용한다.
- 신규 API capability는 실제 dispatch·저장·조회·취소 경로가 연결된 뒤 활성화한다.
- 이전 데이터 읽기, 승인 fingerprint, checkpoint/restore binding, 불확실한 효과의 격리를 유지한다.

## 검증과 한계

첫 묶음은 [통합 검증](./engine-foundation-verification.md)을 통과했다. E0-01~04만 완료 처리하며 설정/artifact/context/transport 기반의 후속 연결은 진행 중이다. 실계정 요청과 OS별 실제 실행은 fixture 결과와 구별한다. 현재 호스트에서 확인하지 못한 Windows 실행이나 외부 서비스 연결을 완료로 표시하지 않는다.
