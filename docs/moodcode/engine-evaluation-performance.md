# 실제 코딩 평가와 엔진 성능 baseline

두 runner는 계정·토큰·네트워크 없이 임시 Git 저장소와 실제 Engine을 사용한다. `scripted/local`의 미리 작성한 도구 호출은 실행·저장·승인·검증 경로의 deterministic 평가다. 실제 모델이 문제를 발견하고 해결하는 품질 평가 또는 실제 계정 검증이 아니다. 토큰·청구 비용을 관측하지 않으므로 `null`이며, 추정치를 실제 usage로 표시하지 않는다.

## 실행

기존 빌드가 있으면 다음 명령을 실행한다. runner가 빌드를 자동으로 수행하지 않는다.

```sh
node scripts/evaluate-engine.mjs
node scripts/benchmark-engine.mjs --profile quick --runtime compiled
node scripts/benchmark-engine.mjs --profile standard --runtime compiled
```

소스 실행은 저장소의 tsx loader를 명시한다.

```sh
node --import ./node_modules/tsx/dist/loader.mjs scripts/evaluate-engine.mjs --runtime source
node --import ./node_modules/tsx/dist/loader.mjs scripts/benchmark-engine.mjs --runtime source --profile quick
node --import ./node_modules/tsx/dist/loader.mjs --test --test-concurrency=1 packages/engine/src/evaluation/runtime.test.ts packages/engine/src/evaluation/runner.integration.test.ts
```

`--help`와 잘못된 CLI 인자는 Engine import·저장소 생성 전에 처리한다. 옵션 중복, unknown option, 음수·소수·과도한 크기를 거부한다. `--live`는 지원하지 않는다. 출력은 JSON이며 correctness·cleanup·source/runtime 변화 실패 시 exit 1이다. 공유 소스를 편집하는 동안의 `BASELINE_SOURCE_CHANGED`는 task 자체 성공을 지우지 않고 최상위 `passed:false`로 별도 기록한다. 권위 있는 baseline은 소스와 runtime을 동결한 뒤 실행해야 한다.

## 코딩 평가의 합격 조건

기존 `addition-bug`, `empty-list-boundary`, `two-module-change` 세 ID와 `tasks[].passed`를 유지한다. schemaVersion은 2다. `--task`로 하나만 선택하고 `--seed 0..4294967295`로 산술·경계 테스트 입력을 고정할 수 있다. solution 자체는 authored fixture다. seed·fixture hash는 재현 입력이며 native UUID·시각·Git commit SHA가 모든 실행에서 같다는 뜻은 아니다.

각 task는 다음 증거를 실제로 소비해야 성공한다.

1. 새 임시 Git 저장소의 원래 테스트가 실패한다.
2. 실제 ScriptedProvider가 `read_file`, expectedHash에 묶인 `apply_patch`, 등록된 `verify_changes`를 요청한다. 승인 pump는 두 효과 도구만 해당 native fingerprint로 허용하고 verification command도 exact 확인한다.
3. native verification 완료의 `taskVerified:true`, pass receipt, exit 0, confirmed process cleanup 및 actual command checkpoint가 존재한다. 모델의 완료 문구·Run completed만으로 성공하지 않는다.
4. 예상 파일의 바이트가 정확히 일치하고 테스트·미요청 파일과 사용자 staged 변경이 보존된다. Tool/Turn/Part도 실제 native 기록과 일치한다.
5. 같은 Run 요청은 기존 Run을 반환하고 provider를 다시 부르지 않는다.
6. 기본 POSIX lane의 Git commit은 실제 `previewGitCommit` Original을 읽고 exact SHA·선택·검증에 묶인 `commitReviewedChanges` 승인을 소비한다. actual HEAD/변경 파일/confirmed cleanup을 확인한다. 동일 commit 요청은 Original 재생 없이 history duplicate이며 두 번째 commit을 만들지 않는다.
7. Engine close와 reopen 후 완료 Run을 읽어도 provider 재호출이 없다. close 이전 실제 workspace의 native 정리 부채·runtime quarantine·active Run/lease가 없음을 확인하고 원래 Engine close를 join한 뒤 임시 파일을 삭제한다. 읽기 실패·이미 closing·미확정 상태면 삭제하지 않는다.

`--commit none`은 Git commit 단계만 명시적으로 제외한다. Git/verification command의 실제 지원 범위는 POSIX다. Windows에서 승인 commit은 typed unsupported이며 기본 설정은 commit none이다. 이 기본값이 Windows의 native command/verification 지원을 주장하지는 않는다.

잘못된 patch와 승인 거절 negative fixture는 provider가 terminal text를 내더라도 성공률 0이며 commit credit이 없다. 실제 계정·모델 품질 평가를 나중에 추가하려면 별도 명시적 opt-in, exact provider/model/capability, 계정 승인, 최대 요청·비용·실행 budget, 위와 같은 native oracle 및 source-qualified 보고서가 필요하다. 현재 runner에 그런 live adapter를 넣거나 자동 선택하지 않는다.

## 성능 측정 범위

quick은 실제 Run 24개/메시지 256 bytes, warm-up 1회, 측정 5회다. standard는 Run 200개/메시지 1024 bytes, warm-up 3회, 측정 20회다. CLI에서 Run 8..1000, 메시지 256..2048 bytes, sample 3..100, warm-up 0..10 범위로 변경할 수 있다.

이력 생성은 `run.submit`/`waitForRun`이며 대량 SQL fixture 행을 주입하지 않는다. 실제 원본 input와 assistant 메시지, Run/Turn/Attempt/Part·durable 이벤트가 기록된다. 측정은 다음 경로를 분리한다.

| 이름                      | 실제 소비 경로                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| history                   | schema1 `session.getHistory`, 전체 pagination의 Run 중복·누락 확인                                                                                                                                                      |
| modelHistory              | 실제 Engine 소유 store의 bounded `readModelHistory`                                                                                                                                                                     |
| contextRun                | 새로운 실제 Run을 통한 context 구성·provider/native 완료. 매 sample마다 이력이 한 Run 늘어남                                                                                                                            |
| contextObservation        | native `session.getContext`의 저장된 진단 읽기                                                                                                                                                                          |
| metrics                   | native `session.getDiagnostics`의 actual Run/usage 집계                                                                                                                                                                 |
| eventReplay               | actual `subscribeSession`, 사전에 고정한 durable seq fence까지 순서·count 일치 및 subscription 종료                                                                                                                     |
| summary                   | 명시 fixture model window `max(1536, messageBytes × 4)` tokens(quick1536/standard4096)로 실제 소유 Run의 completed-history summary를 유도. 별도 tool-free Scripted stream→durable completed/activated/cleanup confirmed |
| summaryUsage/Attempt/List | Engine의 bounded native summary API 읽기                                                                                                                                                                                |
| storageInspection         | 실제 `getStorageUsage`의 논리 파일 크기·bounded 검사                                                                                                                                                                    |

summary hotpath의 SQL instrumentation은 기존 `storage/fixtures/summary-hotpath-benchmark` 측정 helper만 재사용한다. synthetic row 생성 함수는 사용하지 않는다. `getSummaryUsage`가 full summary text를 물리화하거나 DB write를 하지 않는지 검사한다. SQL 반환 JSON bytes는 물리 I/O bytes가 아니다. summary activation은 실제 1건이며 해당 elapsed 값의 통계적 분포·모델 요약 품질을 주장하지 않는다.

latency는 nearest-rank p50/p95/p99·mean·min/max와 sample 수를 출력한다. timing은 정보형이며 절대 ms 문턱으로 CI를 실패시키지 않는다. 메모리는 sample의 RSS/heapUsed before/after/최대 및 차이이며, allocator peak·메모리 누수 증명·강제 GC 이후 retained size가 아니다. DB/artifact logical bytes도 물리 disk allocation과 구분한다. 측정 결과는 다른 세션·부하·OS·Node·input 크기에 의존한다.

각 보고서는 OS/Node·seed·provider/model·workload 크기·cleanup과 before/after source/runtime manifest를 담는다. engine/contracts production, 실제 source/compiled runtime, runner와 재사용한 SQL helper가 hash 대상이다. 의존성 전체·Node binary·전체 저장소를 attestation했다고 주장하지 않는다. 실제 계정 usage/cost와 실제 모델 task 성공률은 계속 unknown이다.

CLI 크기 상한은 fixture 입력을 제한하며, 모든 조합이 native Engine budget에 들어간다는 보장은 아니다. 과도한 context·summary 작업은 재시도·권한 확대·성공 credit 없이 실패한다. quick/standard가 측정한 baseline 설정이다. 준비용 테스트는 작은 명시 환경으로 실행하며, 등록된 POSIX verification command는 Node 테스트 worker에서 상속되는 `NODE_TEST_CONTEXT`를 명시적으로 제거해 실제 `node --test` 실행을 보장한다.

## 로컬 검증 증거와 통합 경계

2026-10-09 source focused 7/7, strict ES2024/NodeNext/noUncheckedIndexedAccess 검사를 통과했다. 실제 CLI의 세 과제, 잘못된 patch·승인 거절, quick native summary·event replay, CLI preflight·source identity·미확정 cleanup 파일 보존을 포함한다. 보호된 CLI 프로세스에서 credential 파일 읽기·credential 환경 값 읽기·fetch 호출은 모두 0이었다. compiled 실행은 해당 source freeze를 빌드한 뒤 통합 단계에서 별도로 확인한다.

standard의 별도 실제 source 실행에서는 seed Run 200개와 메시지 400개, context 측정·summary를 포함한 총 Run 224개를 생성했다. 각 20-sample 측정과 exact history pagination·3793개 durable event의 각 replay가 완료됐고, summary는 실제 completed/activated/cleanup confirmed였다. native summary source 254개, request 295950 bytes, retained output 113 bytes였으며 usage 읽기의 full summary payload materialization과 SQL write는 0이었다. close/reopen에서 provider 재호출 0·임시 파일 삭제를 확인했다. 이 실행의 before/after 자체 source manifest는 같았으며, 이후 runner의 compiled source pin 보강은 별도 최종 source 회귀로 확인했다. numerical latency·메모리 결과를 제품 SLA로 승격하지 않는다.

중간 실패 로그는 삭제하거나 성공으로 바꾸지 않았다. 초기 source 편집 중의 manifest 변경, Node 테스트 worker 환경 상속에 의한 oracle 오류, standard의 너무 작은 1536-token fixture window를 각각 분리했고, 실제 oracle·명시 window를 고친 뒤 집중 회귀를 통과했다. 제품 엔진의 context·command·approval·cleanup 제한을 완화하지 않았다.

### Cleanup V2 보강

`Engine.close()`의 정상 resolve는 recovery acknowledgment가 아니다. 정리 helper는 DB가 열려 있는 동안 native `hasUncertainWorkspace`와 coordinator의 actual runtime quarantine·active execution을 확인하며, close 자체는 계속 join한다. `engineClosed:true`와 `temporaryFilesRemoved:false`를 구분하고 native/runtime cleanup 관측을 별도 필드로 남긴다. 부채·active owner·관측 불가이면 DB/artifacts와 `retainedDirectory`를 보존하고 task/report를 실패시킨다. 실제 provider iterator의 `return done:false`에서 native uncertain Attempt/cleanup 및 failed Run이 기록되고, 정상 close 이후에도 파일과 재시작의 uncertainty가 남는 회귀를 추가했다. 실제 정상 Run 뒤 runtime-only quarantine도 별도 fixture로 확인한다. 테스트 전용 stub close 실패는 이에 대한 native 증거로 확대하지 않는다.
