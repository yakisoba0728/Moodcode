# 동일 Engine 인스턴스의 유한 장기 실행 검증

`packages/engine/src/resilience/persistent.ts`의 `verifyEnginePersistentSoak`와
`scripts/verify-engine-persistent-soak.mjs`는 N-01의 계정 없는 실행 경계다.
기존 `verify-engine-resilience.mjs`의 3~60회 독립 fixture 반복과 별도다.
실제 Engine, SQLite, 임시 committed Git 저장소, ScriptedProvider와 native
`input.accept`, `input.cancel`, `approval.decide`, owned command API를 사용한다.
이 문서의 명령은 실행 가능 프로필이며 30분·여러 시간 실행 완료의 근거를 대신하지 않는다.

## 실행

소스 실행에서는 supervisor가 fixture cwd에서도 같은 loader를 읽도록 절대 경로를 사용한다.

```sh
node --import "$PWD/node_modules/tsx/dist/loader.mjs" \
  scripts/verify-engine-persistent-soak.mjs --runtime source \
  --report /tmp/moodcode-persistent-quick.json

node --import "$PWD/node_modules/tsx/dist/loader.mjs" \
  scripts/verify-engine-persistent-soak.mjs --runtime source --profile long \
  --duration-ms 1800000 --max-cycles 10000 --max-samples 128 \
  --seed 20261009 --report /tmp/moodcode-persistent-30m.json
```

build 후에는 `node scripts/verify-engine-persistent-soak.mjs --profile long`으로
compiled runtime을 사용한다. 소스·compiled runtime 및 CLI 파일 identity가 실행 전후
같아야 한다. 장기 qualification은 변경하지 않는 checkout에서 실행한다.

| 제어            | 기본/상한                                                 |
| --------------- | --------------------------------------------------------- |
| quick           | 실제 관찰 1초, 최대 cycle 6                               |
| long            | 실제 관찰 30분, 최대 cycle 10,000                         |
| duration        | 1초~8시간; setup·정산·reopen은 별도 유한 경계             |
| cycle           | 3~50,000                                                  |
| 입력            | 기본 `4 × maxCycles + 4`, 최대 200,004 unique native 입력 |
| 입력 bytes      | 기본 64 MiB, 최대 128 MiB; 실제 UTF-8 prompt bytes        |
| payload         | seed를 포함하는 고정 크기 64~8,192 bytes, 기본 1,024      |
| resource sample | 8~256, 기본 128                                           |
| native command  | 전체 DB 최대 91; 기존 128-job ledger 상한 유지            |
| 개별 경계       | 기본 10초, 1~30초                                         |
| JSON report     | 최대 2 MiB                                                |

부하는 duration 전체에 분산한다. 입력 ceiling에 도달하면 새로운 입력을 멈추고
같은 Engine의 timed 관찰을 요청 duration까지 계속한다. 실제 cycle 수, 마지막 cycle의
elapsed time과 `loadStoppedBy`를 보고하므로 idle 관찰을 지속적인 최대 부하로 표기하지 않는다.
seed는 bounded payload를 결정하며 랜덤 sleep이나 assertion 변경에 사용하지 않는다.

## 실제 검증 경계

worker의 동일 Engine과 main session에 native 이력을 누적한다. 완료 cycle은 Original
승인 전 spawn 부재, 승인/fingerprint/Run/Turn/Attempt/Tool 소유, 같은 Run의 steer 승격,
다른 Run의 queue 승격, 정확한 중복 receipt, 승격 전 cancel, budget/config 보존,
실제 command PID/PGID와 artifact 내용 hash를 검사한다. text cycle의 steer 내용은
provider가 실제 받은 prompt hash와 대조한다. 합성 journal/row나 Mock ToolContext를 만들지 않는다.

현재 owned command 취소는 Run을 cancelled로 정산하고 Tool을 interrupted로 남긴다.
native job은 `COMMAND_JOB_NATIVE_RESULT_UNCERTAIN`으로 uncertain이며 실제 프로세스 종료만으로
`CLEANUP_PENDING`을 해제하지 않는다. 이 취소 사례는 같은 Engine/SQLite 안의 두 번째
committed Git workspace/session에서 실행한다. 그 backlog와 uncertain receipt를 보존한 채
main workspace는 원래 coordinator/DB effect-lock admission을 통과할 때만 계속한다.

중간에 main session을 pause하고 native queue 하나를 남긴 뒤 Engine을 close/reopen한다.
전체 native digest와 취소 workspace의 receipt가 유지되고 provider 호출·process launch가
없어야 한다. 명시적 resume 후 원래 queue만 실행된다. 이후 같은 worker의 두 번째 Engine이
같은 main session 이력을 계속 늘린다. 마지막에 실제 승인된 command가 running인 상태에서
worker를 SIGKILL한다. supervisor의 실제 cleanup과 effect lock 해제를 관측한 후 동일 DB를
세 번째 Engine으로 연다. recovery가 추가하는 다섯 native event의 종류·순서·소유를 검사하며
나머지 row 수를 보존한다. 이후 wake·resume 거부·close 사이에는 전체 native digest가 같아야 한다.

두 uncertain workspace 모두 resume을 거부해야 하고 재생성된 provider의 호출 수와 추가
process launch는 0이어야 한다. provider iterator cleanup와 command effect cleanup는
별도 필드다. ScriptedProvider의 token/cost 미관측은 `null`로 남긴다.

## report와 보존

`kind: engine-persistent-soak`, `schemaVersion: 1`의 report는 다음 실제 관측을 담는다.

- `samples`: worker/Engine instance/PID/elapsed, RSS·heap·external·ArrayBuffer,
  `/proc/pid/fd` 또는 lsof numeric FD, ps의 descendant PID/PPID/PGID 상태,
  SQLite primary/WAL/SHM/effect DB bytes와 native row count, artifact files/bytes/content hash.
  process sample에서는 측정용 direct-child ps를 제외한다.
- `load`: 실제 입력·byte·cycle·provider·command 수, 각 native job/source hash와 취소 workspace
  identity/Original approval/backlog/물리 cleanup/`cleanup-pending` 결과.
- `gracefulCheckpoint`, `crashCheckpoint`: 전체 native digest, DB integrity/foreign-key 검사,
  recovery event, uncertain job, immutable source approval, unknown usage, no-replay 결과.
- `summary.workerGrowth`: 같은 worker PID의 baseline~crash-ready resource 차이와 peak.
  recovery host 메모리는 worker 성장 계산에 섞지 않는다. 차이는 측정값이며 leak/SLA 판정이 아니다.
- `cleanup`: worker exit, recovery Engine close, 실제 command PID/group 부재, 관측된 owned
  survivor 부재를 native cleanup 확인 여부와 별도로 기록한다.

정상적인 fault 검증 성공도 native cleanup debt가 남는다. `passed: true`는 예상 unknown,
격리, no replay와 물리 종료를 검증했다는 뜻이다. 완료·active cancel·text steer 세 cycle과
8개 이상의 resource sample은 짧은 duration에서도 필수이며 실제 경계 시간이 duration을 넘을 수 있다.
`nativeCleanupConfirmed: false`,
`databaseRemoved: false`이며 `retainedEvidencePath`에 SQLite/artifact/Git fixture를 남긴다.
보존 사유는 `expected-uncertain-command-no-recovery-acknowledgment`다. 실패도 fixture를 남기며
역사적 PID/PGID나 report/marker를 근거로 signal을 보내지 않는다. supervisor/Original native owner가
종료를 확정하지 못하면 실패와 존재 관측을 남긴다.
자동 삭제·recovery acknowledgment·replay는 이 harness의 기능에 포함하지 않는다.

POSIX owned `run_command`와 로컬 scripted provider만 포함한다. Windows JobObject, PTY,
외부 계정·모델 품질·청구 비용 및 GUI는 별도 검증 경계다.

## focused 검증

```sh
node --import "$PWD/node_modules/tsx/dist/loader.mjs" --test --test-concurrency=1 \
  packages/engine/src/resilience/persistent.integration.test.ts \
  scripts/verify-engine-persistent-soak.test.mjs
```

native 이력/Original 승인/취소 unknown/실제 SIGKILL·reopen·no replay, 입력 ceiling 이후
실제 duration 관찰, 실제 Engine close 실패의 DB 보존, CLI invalid/import/I/O failure 및
실패 report 저장을 검사한다. source 전체 회귀·OS CI·실제 장기 결과는 통합 qualification에서 기록한다.
