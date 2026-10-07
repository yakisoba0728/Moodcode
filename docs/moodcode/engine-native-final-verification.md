# Moodcode 자체 엔진 확장 통합 검증

검증일: 2026-10-07 Asia/Seoul. 환경: macOS arm64 / Node 26.9.0. OpenCode에서 확인한 동작을 자체 계약·구현·fixture로 재구현했다. 이번 작업에서 Electron 앱을 실행하지 않았다. 실제 결과는 [JSON 기록](engine-native-final-verification.json), 진행 기준은 [TODO](../../TODO.md), 연결 명세는 [host API](engine-host-api.md)다.

검증 대상 구현 커밋: `682b1d868f10d666f39c663b1b1fba27c2266266`. 기반 정리 `c2309e7`, 첫 native 통합 `94d2a65`, 확장 연결 `682b1d8` 순서로 로컬 커밋했다. 이 보고서의 이후 수정은 검증 기록 binding이며 구현 코드를 바꾸지 않는다.

지속 개선의 최신 source는 `ad787d6`이며 전체2,501 pass·실패0·조건부2 skip, 코딩 fixture3/3과 같은 source opt-in 실제 Codex child text1회·archive/import 회귀를 확인했다. DB9 MCP·일반 tool crash 격리와 bounded discovery·정확한 schema 예약, 다음 selected working-set 교체는 [goal 검증](engine-goal-verification.md)을 따른다. 아래는 기본 확장 `682b1d8`의 당시 결과를 보존한 기록이다.

## 최종 gate

| 검증 | 실제 결과·범위 |
|---|---|
| `npm run typecheck` | workspace TypeScript 성공. GUI를 시작하지 않음 |
| `npm run test:engine` | **1,527 tests / 1,525 pass / 0 fail / 0 cancelled / 2 OS skip**. contracts·engine·JSONL harness compiled 테스트 |
| 기존 desktop host unit | **170/170 pass**. Node에서 main/preload/worker/renderer의 compiled unit만 실행. Electron GUI E2E 아님 |
| `node scripts/evaluate-engine.mjs` | **3/3 pass**. 작은 산술 버그·빈 배열 경계·두 모듈 변경의 expected diff 및 Node 검사. scripted/local fixture |
| `node scripts/verify-codex.mjs --live` | 현재 로컬 Codex 계정의 **gpt-6.1-sol**. 임시 Git 저장소의 read_file→승인 apply_patch→승인 run_command→완료. 실제 변경·명령 exit 0·cleanup 확인 |
| `node --test .github/scripts/engine-ci.test.mjs` | **2/2 pass**. headless 프로젝트 및 Windows partial selection 검증. 실제 hosted CI 실행 아님 |

실제 Codex 과업은 사용자가 지정한 기존 로컬 인증으로 수행했다. 읽기·수정·명령과 정확히 지정한 임시 fixture만 사용하고 완료 후 삭제했다. 계정 토큰·원문 응답·reasoning ciphertext를 보고서에 기록하지 않는다. Anthropic과 다른 계정/모델의 실제 성공은 이 결과로 추정하지 않는다.

전체 gate의 OS skip 두 개는 native Windows process ownership을 macOS에서 실행할 수 없는 조건이다. 이를 성공으로 바꾸지 않는다. 테스트 수는 이전 [첫 native 통합](engine-native-verification.md)의 1,387개 결과와 구분한다.

## 실제 연결과 회귀

이 단계는 독립 모듈 작성에서 실제 엔진 연결로 진행했다. root가 공용 계약·engine/context/runner를 소유하고 세 에이전트가 실행, 저장/context, 도구/확장별 구현·검증을 병렬 수행했다. 담당 범위와 이전 묶음은 [병렬 기록](engine-implementation-waves.md)에 남긴다.

- 부모·child·grandchild는 실제 독립 MoodcodeEngine/SQLite/격리 Git worktree에서 실행한다. immediate parent의 실제 남은 예산·deadline을 예약하고 root에 nested 소비를 두 번 청구하지 않는다. 잘못된 worktree·과대 prompt의 사전 실패는 부모 예산을 차감하지 않는다. 부모 취소, profile/host 도구 상한과 동적 deny 상속, 정리 뒤 owner 해제를 확인했다.
- 완료한 child의 결과는 root의 durable queue inbox에 동일 request ID로 한 번 접수된다. 닫힌 nested parent 이후에도 결과를 전달한다. child 변경은 direct 및 nested 단계마다 승인 fingerprint·현재 preimage를 확인한 뒤 기존 patch/checkpoint/review로 적용한다. 원래 저장소의 Git HEAD는 움직이지 않는다.
- 실제 stdio LSP fixture와 formatter를 승인한 파일 변경에 연결했다. BOM/CRLF·hash·문서 버전, 다음 provider turn 전 didChange 대기, 지연 poll 중복 제거, 외부 편집과 review.restore 재동기화, 실제 server/descendant 종료를 확인했다. original checkpoint는 복원 이후에도 불변이다.
- 과거 큰 도구 결과는 모델 context에만 제한된 관측 JSON·warnings·artifact owner/hash로 투영한다. 현재 Run의 call/result 쌍과 원본 transcript/replay는 보존한다. 파일이 이후 변경돼도 read_artifact가 과거 원본 bytes를 반환하고 다른 session·변조·expiry·prepared owner 변경은 거부한다.
- 지침의 유효 baseline을 session/workspace scope의 DB 문서에 저장한다. 일시 unavailable과 삭제를 구별한다. ContextRevision 활성화·head CAS·session event는 같은 transaction에 기록하고 실제 Run owner를 연결한다.
- SQL native metrics와 session.getDiagnostics는 전체 primary record count, bounded matching event 창, 관측 usage와 unknown/null을 구분한다. source 내용·provider 원문·credential을 반환하지 않는다. 늦은 handler 등록도 host allowlist를 확장하지 않는다.
- JSONL의 누락된 v1 명령 8개를 연결했다. 18개 공개 명령의 계약 전달과 실제 파일/status/history/metrics·승인 patch/복원·v2 diagnostics를 확인했다. known-disabled·unknown·잘못된 schema 오류와 EOF cleanup을 보존한다.

기본 엔진의 inbox/steer/pause·native records·semantic overflow·질문/tasks·scoped runtime·MCP 승인·macOS PTY·crash/archive·긴 이력 성능도 전체 gate에서 다시 통과했다. 추가 Anthropic adapter의 53개 synthetic fixture는 text/tool·공개 summary·opaque replay·usage·retry/cancel 및 명시적 unsupported media를 다룬다. 미디어 지원이나 실제 Anthropic 계정 성공을 광고하지 않는다.

## 지원과 관측 한계

| 대상 | 확인한 지원·남은 조건 |
|---|---|
| macOS arm64 / Node26 | 실제 headless loop·POSIX process group·PTY·Git child·stdio LSP 검증 통과 |
| Node24·Linux | 코드 baseline·CI lane 구성. 이번 환경에서 새 실제 실행 결과 없음 |
| Windows | portable 계약/SQLite lane 및 fake ownership port 구성. native Job Object binding과 실제 process-tree/timeout/crash 실행 미완료 |
| GUI·앱 배포 | 기존 2026-10-04 기록 보존. 이번 새 엔진 기능의 GUI 연결·새 bundle·서명/공증 검증 없음 |
| 모델·media | 현재 Codex 과업 확인. Anthropic synthetic text/tool 확인. media input/output port와 fixture·추가 실제 계정 검증은 남음 |

CI 파일은 작성하고 로컬 launcher를 확인했지만 이 저장소에 Git remote가 없어 Actions를 실행하지 않았다. CI green 또는 Linux/Windows 지원이라고 표시하지 않는다. [matrix·실패 로그 명세](engine-ci.md)를 따른다.

큰 이력 읽기는 SQL의 bounded window이며 하나의 과도한 현재 Run은 MODEL_HISTORY_LIMIT로 실패할 수 있다. 무제한 transcript를 먼저 가져오지 않는다. [성능 보고서](engine-storage-performance.md)의 p95·메모리 수치는 해당 로컬 fixture의 측정이지 모든 하드웨어의 보장이 아니다.

metrics token 합계는 관측 이벤트 기반이며 main usage의 attempt 식별 누락·cumulative 중복 가능성과 요약 이벤트 창의 한계를 표시한다. physical artifact disk·runtime quarantine·외부 review/recovery ledger를 SQL primary 지표로 추정하지 않는다. [metrics 의미](engine-native-metrics.md)를 따른다.

workspace 변경 ID/버전은 현재 프로세스의 bounded 관찰 baseline이다. 원본 효과 증거는 immutable checkpoint에 남는다. parent terminal만으로 모든 child cleanup이 끝났다고 가정하지 않으며 task wait 또는 engine.close로 종료를 정산한다. cleanup 불확실·dirty worktree·지원 밖 binary/경로는 성공으로 덮어쓰지 않는다.

## 완료와 후속

**71/75 TODO 완료**다. Windows 실제 backend(E5-08), media adapter(E5-13), hosted CI와 OS 지원 검증(E6-07), 그 결과를 반영한 최종 지원 명세(E6-08)는 열어 둔다. E6-08의 현재 host API·schema·복구/성능 문서는 작성했으며 최종 OS 판정이 남았다. 핵심 엔진과 현재 지원한 확장은 macOS의 headless host에서 연결·검증한 상태다.
