# Moodcode 읽기 전용 모델 위임 독립 검증

검증일: 2026-10-07. 대상은 `delegate_task`의 실제 기본 엔진 연결과 부모/자식 실행·승인·예산·Git 준비·복원 경계다. 기준 checkout은 `fe56ee6` 이후 공유 작업 트리이며, 아래 수정은 아직 별도 커밋된 상태를 가정하지 않는다. 외부 프로젝트 구현·프롬프트·테스트를 복사하지 않고 Moodcode의 현재 계약으로 fixture를 작성했다.

검증 환경은 macOS Darwin arm64, Node v26.9.0, Git 2.55.0이다. 실제 temporary Git 저장소, 기본 MoodcodeEngine, 별도 child engine/SQLite, 실제 archive export/import를 사용했다. provider는 독립 합성 stream fixture이며 외부 계정·실제 모델·GUI·자동 병합 호출은 없다. 전체 workspace build/test나 다른 OS 검증은 수행하지 않았다.

## 확인 결과

기본 등록 21번째 도구가 실제 `delegate_task`이며 Build 모드에서 정확한 요청별 승인을 요구한다. 명시적인 configured allow와 넓은 session grant가 있어도 승인을 생략하지 않는다. 승인 전에 child task, worktree, child provider 호출을 만들지 않는다. Plan 모드에서는 catalogue에서 제외하고 모델이 강제로 요청해도 준비 효과를 발생시키지 않는다. 근거: [기본 도구 등록](../../../packages/engine/src/engine.ts#L224), [runtime exact approval](../../../packages/engine/src/tools/runtime/index.ts#L100), [독립 승인 fixture](../../../packages/engine/src/integration/delegation-review.integration.test.ts#L46).

자식은 `list_files`, `read_file`, `search_files`, `glob_files`, `regex_search` 중 현재 부모의 실제 capability, profile, catalogue, read effect 교집합만 받는다. provider/model 변경, 명령 실행, 수정, 또 다른 모델 위임을 요청할 수 없다. pinned HEAD의 committed 파일을 별도 worktree에서 읽으며 부모의 미커밋 파일은 포함하지 않는다. 자식은 부모의 같은 policy 인스턴스와 고정 profile을 사용하지만 grant·artifact·SQLite는 독립 엔진 소유다. 뒤늦게 읽기 도구를 등록해도 승인된 allowlist가 늘어나지 않는다. 근거: [위임 검사](../../../packages/engine/src/child-tasks/delegation-host.ts#L38), [child 옵션 상속](../../../packages/engine/src/child-tasks/engine-host.ts#L303), [allowlist fixture](../../../packages/engine/src/integration/delegation-review.integration.test.ts#L127).

승인 대기 시간은 부모의 deadline을 소비한다. 현재 남은 turns/toolCalls/outputBytes/durationMs와 해당 tool timeout에 allocation이 맞는지 준비 시점과 실제 실행 직전에 확인한다. 승인 중 HEAD가 바뀌면 checkout 전에 거부한다. 정확한 기존 요청은 이미 예약한 예산을 다시 차감하지 않고 같은 child 결과에 연결된다. 서로 다른 내용에 같은 request ID를 사용하면 거부한다. 근거: [allocation 검사](../../../packages/engine/src/child-tasks/delegation.ts#L32), [실행 재검사](../../../packages/engine/src/child-tasks/delegation-host.ts#L58), [대기 시간 fixture](../../../packages/engine/src/integration/delegation-review.integration.test.ts#L68), [기존 정확 재요청 fixture](../../../packages/engine/src/integration/delegation.integration.test.ts).

부모 취소와 child deadline은 실제 child provider signal 및 pending child approval에 연결된다. 취소된 approval의 저장 상태는 `expired`이며, 늦은 allow로 실행을 재개하지 않는다. 관찰된 child 종료와 엔진 정리가 끝난 뒤 worktree owner를 해제한다. 비동기 start 실패나 정리 미확정 상태는 `uncertain`으로 보존하고 owner를 유지한다. recover는 재실행·환급·자동 결과 전송을 하지 않는다. 근거: [child dispatch/정리](../../../packages/engine/src/child-tasks/index.ts#L624), [취소](../../../packages/engine/src/child-tasks/index.ts#L718), [pending approval fixture](../../../packages/engine/src/integration/delegation-review.integration.test.ts#L76), [비동기 start 실패 fixture](../../../packages/engine/src/integration/delegation-review.integration.test.ts#L106).

Git 준비는 해당 엔진의 실제 serial tool row, workspace/root/lock identity, live Build Run, 같은 요청 지문의 allowed approval에 속한다. 다른 실행의 effect marker를 덮어쓰거나 해제하지 않는다. 실제 Git 작업 후 journal 관찰이 실패하면 marker와 관리 경로를 남긴다. 반대로 생성 완료가 확인된 worktree 이후 일반 오류에서는 파일을 남기고 자신이 소유한 확정 marker만 해제한다. 근거: [호스트 owner 검사](../../../packages/engine/src/child-tasks/delegation-host.ts#L23), [Git 효과 처리](../../../packages/engine/src/child-tasks/delegation-host.ts#L70), [독립 생성 후 실패 fixture](../../../packages/engine/src/integration/delegation-review.integration.test.ts#L138), [기존 journal 미확정 fixture](../../../packages/engine/src/integration/delegation.integration.test.ts).

safe checkout은 명령별 Git 옵션으로 hooks, filters, fsmonitor, 자동 maintenance/gc, lazy fetch, replace objects, submodule 재귀를 제한한다. 설정 값의 shell 명령을 읽어 조합하지 않으며 bounded name probe에서 해석하지 못한 driver/hook 이름을 거부한다. 기존 fixture에서 실제 합성 hook/filter marker가 만들어지지 않고 원래 Git config가 유지되는 것을 확인했다. 근거: [safe-checkout 구현](../../../packages/engine/src/worktrees/safe-checkout.ts), [실제 checkout fixture](../../../packages/engine/src/worktrees/safe-checkout.test.ts).

반환값은 최대 8 KiB의 관찰 JSON이며 task journal의 summary 자체는 최대 4 KiB다. 내용은 신뢰되지 않은 자식 관측으로 표시하고 현재 파일 상태의 확증이나 새 권한으로 취급하지 않는다. 위임 경로에서는 결과 inbox 전달, 새 input 생성, 자동 queue promotion, 파일 병합, Git commit을 실행하지 않는다. 호스트 API의 명시적 `deliver`와 `merge_child_changes`는 별도 기능이다. 근거: [결과 projection](../../../packages/engine/src/child-tasks/delegation.ts#L39), [기존 모델 위임 fixture](../../../packages/engine/src/integration/delegation.integration.test.ts).

## 검토 중 발견하여 수정한 문제

### 1. Archive 이후 과거 worktree 경로가 새 engine의 journal validation을 깨뜨림

완료된 실제 child를 export/import한 뒤 같은 child 요청에 연결하면 처음에는 `INVALID_WORKTREE_JOURNAL`이 발생했다. session document의 `engine.worktrees` root가 원래 artifactDir에 묶여 있는데 새 manager는 새 artifactDir 아래 경로를 요구했기 때문이다. `EngineChildren.start`가 terminal child의 정확한 durable 요청 확인보다 recover를 먼저 호출하여, 이미 끝난 결과 연결도 이 경로 검증에 걸렸다.

수정 후에는 정확한 durable terminal child를 recovery 전에 조회한다. 완료·실패·취소·불확실 결과의 조회는 실행 재개가 아니므로 child provider를 다시 호출하거나 예산을 예약하지 않는다. unfinished task만 recovery로 관찰하며 자동 dispatch하지 않는다. 근거: [durable child 조회 순서](../../../packages/engine/src/child-tasks/engine-host.ts#L145).

Importer는 검증된 manifest의 원래 artifactDir 아래 기본 managed worktree 경로만 새 artifactDir로 옮겨 기록한다. `ownerId`, `device`, `inode`를 다시 취득하거나 새 소유권으로 승인하지 않는다. 삭제되지 않은 record는 `uncertain`, 오류는 `WORKTREE_ARCHIVE_RELOCATION`, relocation metadata의 `ownershipVerified`는 false가 된다. relocated worktree의 verify/cleanup/merge 준비는 `WORKTREE_RELOCATION_UNVERIFIED`, 새 child 실행은 `CHILD_WORKTREE_NOT_READY`로 거부한다. 완료된 과거 결과는 조회할 수 있고, 새 승인된 위임은 fresh worktree를 만든다. 외부의 사용자 지정 worktree directory는 이 기본 경로 remap에 포함되지 않으며 import가 명시적으로 거부한다. 근거: [archive remap](../../../packages/engine/src/storage/archive.ts#L268), [relocation 거부](../../../packages/engine/src/worktrees/index.ts#L496), [실제 archive 독립 fixture](../../../packages/engine/src/integration/delegation-review.integration.test.ts#L146).

Fixture는 실제 파일이 복사된 사실과 과거 inode/device/owner 불변, 같은 과거 child ID·provider 호출 수·inbox 수 유지, 거부된 old-worktree 새 실행의 예산 미차감, fresh delegation 1회 정상 실행을 함께 확인한다. 원래 checkout의 Git 등록을 archive 복원으로 재연결했다고 주장하지 않는다.

### 2. 동기 configureChild 계약에서 Promise/thenable 반환을 무시함

`configureChild`는 동기 설정 계약이지만 이전 호출은 반환값을 무시했다. Promise를 반환하면 설정 완료 전 model admission이 시작될 수 있고, 실패한 Promise는 관측되지 않은 rejection으로 남을 수 있었다. TypeScript의 void callback만으로 async 함수 반환을 런타임에서 막을 수 없다.

허용된 한 호출 지점에 런타임 검사를 추가했다. Promise/thenable 반환은 rejection을 관측하고 `INVALID_CHILD_CONFIGURATION`으로 admission 전에 거부하며 생성한 child engine을 닫는다. dispatch 경계의 보수적인 계약에 따라 task는 `uncertain`, worktree owner는 유지한다. rejected Promise와 rejected thenable 둘 다 실제 fixture에서 childRunId와 child model 호출이 없음을 확인했다. 근거: [동기 훅 검사](../../../packages/engine/src/child-tasks/engine-host.ts#L339), [독립 비동기 설정 fixture](../../../packages/engine/src/integration/delegation-review.integration.test.ts#L116).

## 파일별 확인 범위

`complete`는 현 소스의 전체 파일을 읽은 범위, `targeted`는 아래 실행 경계에 필요한 함수/구간만 읽은 범위다. 의존 패키지 전체를 모두 검토했다는 뜻은 아니다.

| 파일 | 범위 | 직접 확인한 경계 |
| --- | --- | --- |
| `child-tasks/delegation.ts` | complete | 입력 제한, 승인 지문, opaque prepared handle, budget, 결과 projection |
| `child-tasks/delegation-host.ts` | complete | 실제 owner/approval, current catalogue, checkout lock, start/join |
| `child-tasks/engine-host.ts` | complete | actual child engine/options, durable admission, cancellation, approvals, close, 동기 setup |
| `worktrees/safe-checkout.ts` | complete | local HEAD 조회와 명령별 Git 옵션, config name bound |
| `child-tasks/index.ts` | targeted | start/reservation/dispatch/wait/cancel/deliver/recover/close, terminal 결과 제한 |
| `worktrees/index.ts` | targeted | journal identity, create/claim/release/verify/cleanup/recover, relocation guard |
| `child-tasks/merge.ts` | targeted | terminal parent identity 검사, worktree verify 이전 경계; 실제 병합은 수행하지 않음 |
| `tools/runtime/index.ts` | targeted | catalogue capture/resolve, exactApproval, grant 우회 방지, prepare/execute |
| `tools/command/execution-lock.ts` | targeted | marker inspect/acquire/release/불확실 소유권 보존 |
| `engine.ts` | targeted | 기본 도구 등록과 immutable host allowlist 적용 |
| `storage/archive.ts` | targeted | 실제 export/import fixture, importer worktree path remap/불확실 처리 |
| `agents/index.ts`, `runner/input-scheduler.ts` | targeted | profile pinning·apply, legacy submit/복구 pause 경계 |
| `delegation.test.ts`, `safe-checkout.test.ts`, `delegation.integration.test.ts` | test | 기존 명세 전체 읽기 및 실행 |
| `children.integration.test.ts` | test/targeted | 5개 기존 integration 실행, 현재 상속/취소/예산 동작 확인 |
| `delegation-review.integration.test.ts` | test | 독립 작성한 10개 실제 엔진 fixture 전체 |

## 실행 검증

| 테스트 묶음 | Source | 별도 compiled |
| --- | ---: | ---: |
| delegation 단위 | 5/5 | 5/5 |
| safe checkout | 3/3 | 3/3 |
| 기존 실제 delegation integration | 6/6 | 6/6 |
| 기존 parent/child integration | 5/5 | 5/5 |
| 독립 delegation review integration | 10/10 | 10/10 |
| 합계 | 29/29 | 29/29 |

`tsx --test`로 source를 실행했다. 별도 compiled 검증은 shared dist를 수정하지 않고 `node_modules/.cache/moodcode-delegation-review/compiled`에 esbuild ESM bundle을 만들고 contracts source alias로 동일 5개 묶음을 각각 실행했다. engine TypeScript noEmit와 `git diff --check`도 통과했다. 테스트는 Windows/Linux, 실제 계정 provider, 비협조적 외부 서비스 전체, 실제 GUI 동작을 검증한 결과가 아니다.

## 남아 있는 명시적 제약

- worktree 및 도구 allowlist는 OS filesystem sandbox가 아니다. trusted host의 자체 handler가 effect를 정확히 선언하고 경로 제한을 지켜야 한다.
- host 설정 hook는 동기로 끝나야 한다. 이미 시작한 임의 host 비동기 작업을 엔진이 강제로 중단할 수 있다는 계약은 없다.
- archive로 복사한 과거 checkout을 자동으로 다시 소유하거나 Git에 등록하지 않는다. 외부 source repository가 사라졌다면 fresh delegation도 진행할 수 없다.
- 실행 시작/정리 미확정의 예약량은 자동 환급하지 않고 owner를 유지한다. 이후 explicit recovery/보존 정책이 필요하며, 이 검토에서 임의 owner 해제는 하지 않았다.
- 합성 provider를 통한 headless correctness를 확인했다. 실제 모델이 읽기 전용 위임을 적절히 선택하는 품질과 공급자별 네트워크 취소는 별도의 실제 환경 검증 영역이다.
