# 메인 엔진 1차 구현 종료 조건

2026-10-07 사용자가 1차 구현의 종료 조건과 goal 수정을 요청했다. 이 문서가 현재 실행 범위와 완료 판정의 기준이다. 이전의 무기한 지속 개선 요청은 **G1-29 수정과 최종 검증을 마치는 1차 엔진 구현**으로 좁힌다. [TODO](../../TODO.md), [목표·진행 기록](engine-improvement-goal.md), [최신 검증](engine-goal-verification.md)을 함께 갱신한다.

## 수정한 목표

Moodcode 자체 메인 엔진의 로컬 headless 1차 구현을 완료한다. 이미 검증한 실행·저장·컨텍스트·도구·권한·MCP·child·복구 계약을 유지하고, G1-29의 eager 도구 catalogue와 문맥 예약 불일치를 수정한다. 최종 소스를 동결한 뒤 전체 타입/엔진 검사, 코딩 fixture 3개, 기존 Codex 인증을 이용한 제한된 실제 모델 회귀를 통과시킨다. 지원 범위와 이월 항목을 문서화하고 로컬 커밋 및 깨끗한 작업 트리를 남기면 goal을 완료 처리하고 추가 구현을 종료한다.

## 완료 판정

아래 조건을 모두 충족해야 1차를 완료한다.

| 조건 | 필요한 증거 | 최종 검증 근거 |
|---|---|---|
| 기존 엔진 구현 고정 | G1-01~28의 구현·검증·로컬 커밋과 기존 host 계약 보존 | source `464812f`의 원래 whole manifest·권한·저장·cleanup 회귀 통과; DB9/metrics6 유지 |
| 마지막 필수 수정 | G1-29의 byte cap 실패 및 known model window 계획 불일치 수정, 실제 최신 예약 대조군 회귀 | 같은 capture/current guard·예약·계획·provider/handler 연결 완료; 예산8/경계10/독립23 source+bundle/noEmit 통과 |
| 실행 경계 유지 | catalogue/예약/문맥/provider/handler 일치, 제한된 재계획·steer·취소·동일 Turn retry, 권한·cleanup·저장 회귀 통과 | 새41개 및 기존 Attempt177·discovery 경계29·output budget4 회귀 통과; 각 Attempt 사본·원래 request SHA·empty/static 호환 확인 |
| 최종 전체 검사 | 동일 final source에서 `npm run typecheck`, 전체 `npm run test:engine`, `node scripts/evaluate-engine.mjs` 3/3 | `464812f`: 타입 검사 통과, 전체2,594 pass·실패0·취소0·기존2 skip, 코딩 fixture3/3 |
| 제한된 실제 모델 검사 | 동일 final source에서 기존 Codex child text 1회, confirmed cleanup·저장/archive/import 검사와 임시 fixture 제거 | `464812f`: default eager 도구0·예약24B·actual child text1회, natural confirmed cleanup·historical/archive/import pause·fixture 제거 통과 |
| 검토 가능한 인계 | 최신 검증 JSON/MD·TODO·상태/host 명세 일치, source/docs 로컬 커밋, `git status --short` 비어 있음, 담당 작업 종료 | source175 pin·이전 JSON 원본 보존·G1-01~29 완료·원래71/75와 열린4개 유지·담당 종료; 최종 문서 커밋/clean tree audit 후 goal 전환 |

전체 엔진 검사는 실패0·취소0이어야 한다. 기존 OS 조건부 skip2개는 원인을 그대로 기록하며 목록을 축소하거나 skip을 늘려 완료를 만들지 않는다. 1차 지원 범위에서 알려진 실행·권한·저장·복구 결함 또는 실패한 필수 검사가 남으면 완료할 수 없다. 실제 모델 검사의 범위는 도구0개인 child text 회귀이며 실제 자율 코딩·원격 PDF/MCP 동작으로 확대하지 않는다.

G1-29는 마지막 필수 구현이다. 새 G1-30 항목·상위 엔진 기능 비교·별도 성능 탐색을 시작하지 않는다. 최종 검사에서 발생한 1차 범위의 회귀를 수정하는 작업은 계속한다. 이 문서의 종료 조건은 진행 중인 담당 작업에도 적용한다.

## 2차로 이월할 범위

- Electron GUI 연결·새 엔진 기능의 화면 노출·GUI E2E·제품 UX.
- E5-08 Windows process-tree backend, E5-13 다른 provider/실제 multimodal 계정 검증, E6-07 hosted CI와 OS별 지원 검증, E6-08 그 결과를 반영한 지원 명세 확정. 열린 TODO4개를 완료로 표시하지 않는다.
- 원격 PDF 인식과 parser/token 계산, provider-native tool search, 다른 외부 계정·서비스·배포, 측정하지 않은 성능 보장 및 추가 기능.

현재 로컬 macOS arm64 / Node26.9.0 검증을 다른 OS·Node 버전의 실행 증거로 사용하지 않는다. 실제 프로젝트의 unresolved 기록을 대신 승인하거나 원래 실행을 자동 재시도하지 않는다.

## goal 처리

최종 검증 JSON을 작성한 시점의 goal 상태는 `active`다. 위 검증 증거를 문서와 함께 로컬 커밋하고 source pin·링크·TODO·clean tree·담당 종료를 마지막으로 확인한 뒤에만 `update_goal({ status: 'complete' })`를 호출하고 완료 결과를 보고한다. 이후 새 구현은 사용자의 별도 요청으로 시작한다. JSON의 active 값은 이 마지막 상태 전환 이전 관측 시점이며 실시간 goal 상태를 대신하지 않는다.

현재 제공된 goal 도구는 생성·조회·상태 변경을 지원하고 활성 goal의 objective 문구 수정은 지원하지 않는다. 따라서 앱에 저장된 기존 objective 문구는 그대로이며, 이번 사용자 지시에 따라 실제 작업 범위와 종료 판단은 위 수정 목표를 따른다. 미완료 goal을 완료 처리해 문구만 바꾸는 방식은 사용하지 않는다.
