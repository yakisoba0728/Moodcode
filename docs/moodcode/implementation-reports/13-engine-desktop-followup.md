# 탐색·대화·복구 후속 구현

2026-10-04. 이전 데스크톱 구현(7673567) 이후 실제 탐색 출력 초과와 대화 표시 문제를 개선하고 긴 대화·복구·모델 설정을 연결했다. 기존 자체 엔진과 Electron utility 소유 구조를 유지한다.

## 동작

| 범위 | 최종 동작 |
|---|---|
| 탐색·출력 | shell 없이 Git의 중첩 `.gitignore`·negation 적용, `.venv`·캐시 기본 제외, 파일·검색·목록 continuation, 남은 tool 출력 예산, 최종 답변 공간 확보 |
| 에이전트 행동 | Plan/Build 기본 지침, 사용자·AGENTS 우선, native 읽기·검색 우선, 좁힌 후속 요청 안내, 동일 read fingerprint 반복 차단, 승인된 효과 후 재읽기 허용 |
| 대화 표시 | GFM 표·선언 언어 코드 강조·원문 복사·긴 코드 페이지, lazy 도구 결과, 저장소 경계를 검사한 파일·줄 이동, 오류 코드·원인·다음 행동 |
| 오류·복구 | 읽기 전용 상태 진단, user fingerprint/확인, 기존 engine close acknowledgment, 별도 utility의 실제 lease·PID/group 재검증, 두 DB 백업·무결성 검증, immutable journal binding acknowledgment와 재연결 |
| 긴 대화 | 최근 작업 단위 20개 이력 페이지, 최신 실행·취소 상태 별도 유지, 출처가 있는 기존 메시지 발췌와 완전한 최근 tool exchange, 실제 usage/context 표시 |
| 모델 설정 | bounded Codex cache 메타데이터, 모델별 추론 강도, 설정·command·runner·Responses body 전달, 로그인 상태·목록 새로고침 |

## 경계와 한도

Continuation은 workspace·입력·스캔 snapshot hash를 HMAC으로 묶는다. 최대 2 KiB이며 같은 utility 프로세스 수명에서만 유효하다. 실제 파일/결과가 바뀌거나 토큰이 잘못되면 새 페이지를 요청한다. hard scan 한도·읽기 실패가 있는 불완전한 스캔에는 다음 토큰을 주지 않는다. GUI 목록은 100개씩, 화면에는 최대 2,000개를 모으며 그 이후 하위 폴더로 범위를 좁힌다.

Tool output은 실제 남은 Run budget 안에서 반환하고 초기 Run 출력 한도의 1/4(최대 4 KiB)를 답변용으로 남긴다. 설정한 전체 output/context/turn/time 한도는 유지한다. 잘린 읽기 결과는 UTF-8을 보존하는 JSON이며, tool 실패도 모델이 읽을 수 있는 bounded JSON이다. 명령의 원문 artifact와 checkpoint를 보존한다.

CodeBlock은 처음 80줄/8 KiB, 확장 시 최대 400줄/32 KiB씩 렌더링한다. 원문 전체 복사는 1 MiB까지이며 더 큰 결과는 현재 표시 페이지를 복사한다고 표시한다. 복사는 사용자 클릭에서 typed preload→main→OS clipboard로 완료를 기다린다. HTML은 실행하지 않고 위험 URL과 저장소 밖 파일을 열지 않는다. 줄 이동은 전체 파일을 줄 배열로 펼치지 않고 제한된 페이지를 보여준다.

`session.getHistory`는 1..50개의 작업을 요청할 수 있고 GUI는 20개를 쓴다. 페이지는 4 MiB 이내로 오래된 Run 그룹을 제거하며 단일 거대 기록은 일부 표시임을 명시한다. pending 승인 preview는 자르지 않는다. native replay를 SQL 단계에서 GUI 응답에서 제거하고 원본 DB에는 남긴다. `session.getMetrics`는 최신 2,000개의 usage/context 이벤트에 한정하고, 없는 token 값은 null/미제공으로 표시한다. context는 실제 직렬화 JSON bytes이며 추정 token 수나 계정 quota를 만들지 않는다.

Context 발췌 요약은 최대 8 KiB/8개 원본 메시지이며 ordinal·message ID·Run ID·role·생략 여부를 포함한다. 이전 주장을 검증된 현재 파일 상태로 취급하지 않도록 assistant 역사 데이터로 표시한다. 원본 journal과 encrypted/native provider replay를 수정하거나 새 tool 결과로 재생하지 않는다. semantic 요약과 전체 이력 검색은 후속 범위다.

## 복구

진단은 고정 main-pinned 경로의 DB·WAL/journal을 identity/content 검사와 함께 사본에 읽는다. 원본 대화·복원 DB·effect marker·owner lock을 변경하지 않는다. 복구는 renderer가 넘긴 파일 경로를 받지 않으며 fingerprint와 명시적 확인만 받는다. source file당 256 MiB, 총 512 MiB, 10초·고정 파일 수 한도를 적용한다.

유휴 상태의 현재 host가 소유한 owner lock은 실제 close acknowledgment 뒤에 해제한다. 별도 worker는 primary/review owner lease와 effect/source write lease를 다시 획득한다. 살아 있는 PID/group, EPERM, group PID 미기록, begun restore는 차단한다. started restore는 먼저 정상 재연결에서 interrupted로 기록한 뒤 진단한다. process에는 signal 0으로 존재만 확인하며 종료 신호를 보내지 않는다.

백업은 `artifacts/recovery/<id>/primary.sqlite`, `review.sqlite`에 만들고 schema·integrity·foreign key·byte·SHA-256을 검증한다. audit publication 전에 경로 identity를 재검증한다. acknowledgment는 `<canonical DB>.recovery.sqlite`에 exact operation binding/state/outcome hash를 기록한다. 원본 Run·review row·terminal event는 수정하지 않는다. 실제 종료가 확인된 active marker만 해제한다. 사용자 확인 후 재시작 시 해당 exact 복원 격리를 해제하고 도구를 자동 재실행하지 않는다. completed uncertain restore도 재시작 시 다시 격리한다.

대화 DB 백업 버튼은 native save dialog에서 정한 목적지에 primary DB를 저장한다. 별도 review/ledger 복사까지 포함하는 일반 export/import 기능은 제공하지 않는다. 복구 자동 백업에는 primary/review를 함께 보존한다.

## 검증

전체 compiled 테스트 수와 실제 실행 결과는 [verification-results.json](../verification-results.json)에 기록한다. 새 테스트는 실제 SQLite·Git·owned child process를 사용하고 `.gitignore` 예외, UTF-8 페이지, stale token, 예산을 적용한 실제 coding loop, 발췌/native replay, pending preview, 늦은 history 응답, consent/ownership/backup·ledger binding을 검증한다.

- 기존 Electron E2E: read→patch 승인→command 승인→완료, reload·denial·cancel·restore 충돌·worker crash 재연결.
- `scripts/test-desktop-conversation.mjs`: 실제 GFM·highlight·lazy 결과·80/400줄 페이지, native 원문 복사와 기존 clipboard 전체 MIME 복구, 10,000줄 파일의 relative/inline/absolute 줄 이동과 저장소 경계. 모델 요청 0.
- `scripts/test-desktop-history-recovery.mjs`: 25개 기록 20/5 paging, 최신 실행 중지 유지, active recovery 차단, 실제 중단 복원→확인→두 DB 백업·integrity·hash→재연결·full restart. 원본 row·terminal·파일 불변, 자동 실행 없음, 네트워크 요청 0.
- native settings: safeStorage·0600·키 미반환·삭제·dialog 오류·Codex 전환. 공급자 요청 0.
- macOS arm64 package: 실제 `.app`/utility/SQLite/renderer, packaged fixture override 무시, ASAR command supervisor exit 0와 cleanup 확인.

이 단계에서는 실제 계정 요청을 추가하지 않았다. 기존 실제 Codex 모델·GUI·도구 loop 검증은 이전 단계 결과로 보존한다. `.app`은 서명되지 않은 개발용 앱이다. 모든 GUI 검증은 임시 userData·Git 저장소를 사용하고 앱·데이터를 정리했다. 사용자의 정상 Moodcode 앱은 닫힌 상태로 유지했다.

PTY, MCP, worktree 병렬 실행, 제품 subagent, LSP/편집기, 앱 자체 Codex 로그인·토큰 갱신, 서명·공증·업데이트·Windows process tree는 후속 범위다.
