# 엔진 리팩터링 감사 계획 실행 결과

갱신일: 2026-10-12, Asia/Seoul. 브랜치 `codex/engine-refactor-audit`, 기준 `main` `2e64f32`, 계획 기록 `96fca4f`. 세부 근거·실행 ID·부분 적용 사유는 [실행 기록](engine-refactor-execution.json), 승인된 계획과 결정 57개는 [감사 계획](engine-refactor-audit-plan.json)에 있다.

## 결과

| 항목 | 결과 |
|---|---|
| 작업 패키지 268개 | 적용 250, 부분 적용 17, 불필요 1(앞선 단위가 이미 처리) |
| 최종 로컬 gate (`a4e60a6`) | tsc build, DB23 catalogue 비교 동일, diff check, 이번 실행이 건드린 compiled 테스트 437개와 media·hardening script 묶음: 5,145 pass, 코드 실패 0, Windows 전용 skip 3 |
| 최종 hosted CI (`a4e60a6`) | Engine headless 6/6, Desktop packages 3/3, native Windows 2/2 성공 |
| `engine.ts` | 2,830줄 → 1,496줄 (facade 분리는 부분 적용) |

공개 API·command schema, DB23, 오류 코드, 승인·cancel·unknown·no-replay·budget 계약은 승인된 결정이 바꾼 부분만 바뀌었다. 바뀐 부분은 각 커밋 본문과 실행 기록의 contract 메모에 있다.

## 압축·주석 목표

감사 계획 실행만으로는 제품 코드·주석 줄이 줄지 않았다(공용 모듈·분리한 협력 객체와 doc comment가 삭제분을 상쇄). 2026-10-12에 줄 수·주석 축소 작업(21개 파일 분할, `16fd9b1..b3848eb`)을 따로 실행했다. `packages/engine/src` 제품 코드(테스트·fixture 제외) 기준이다.

| 지표 | `main` | 축소 전 | 축소 후 |
|---|---|---|---|
| 줄 | 134,028 | 134,820 | 132,319 |
| 주석 줄 (`//`, `/*`, `*`로 시작) | 1,504 | 2,072 | 1,676 |
| 파일 | 365 | 409 | 409 |

축소 작업은 검증·오류 코드·메시지·SQL을 지우지 않았다. 문자열 literal 비교에서 사라진 literal은 0개다. 로컬 전체 compiled suite 5,523 pass·실패 0, hosted CI는 11/11 성공(native Windows Node 26 accounting flake 1회 재실행). 주석 줄은 아직 `main`보다 172줄 많다.

## 실행 중 발견해 고친 것

| ID | 내용 |
|---|---|
| F-01 | Seatbelt가 `.git/worktrees`, `.git/rebase-merge`, `core.hooksPath`, config include 대상 쓰기도 막는다. 백그라운드 보안 검토가 U005에서 발견 |
| F-02 | HFS+ 무시 문자로 만든 `.git`/`node_modules` 별칭 거부, file-action 상위 경로 realpath 확인 |
| F-03 | 프로젝트 소스 스캔이 무시되지 않은 비정규 이름에서 실패로 닫힌다 |
| F-04, F-05 | wave 1 수정 후 기대값이 옛 동작이거나 hosted runner에서 시간 한도가 빠듯했던 테스트 4건 (테스트만 수정) |
| F-06, F-07 | wave 3 공용 helper 전환이 바꾼 settle 시점(child cleanup race)과 copy chunk 크기(256 KiB → 1 MiB) 복원 |

2026-10-11 08:02 KST에 `git bisect run`이 테스트에 `GIT_DIR`를 넘겨 fixture의 `git init`이 공유 저장소를 `core.bare=true`로 바꿨다. 몇 분 안에 되돌렸고 ref·hook·index 변경은 없었다. 이후 bisect는 수동으로 한다. `5e57e19`의 native Windows Node 26 실패 1건은 재실행 성공으로 timing flake로 기록했다.

## 남은 것

- 브랜치를 `main`에 합칠지와 방식 결정
- 부분 적용 17개 패키지 (사유는 실행 기록의 `partialOrNotNeeded`)
- 주석 줄이 `main`보다 172줄 많음(더 강한 파일별 축소는 선택)
- native Windows Node 26 accounting 테스트 flake 관찰(최근 7회 중 2회, 재실행 성공)
- 기존 TODO 항목(R-CI-HOSTED-02 `fixture-retention`, PERF-GIT-02 등)은 그대로다
