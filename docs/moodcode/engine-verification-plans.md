# 검증 계획과 결과 영수증 기반

`verification/{types,plans,receipts,index}.ts`는 MC2-02의 durable plan·receipt 기반이다. `host.ts`와 `tool.ts`/`execution.ts`를 통해 실제 엔진의 등록·idle CAS·명령 준비·exact approval·process/checkpoint/log/cleanup 관측에 연결했다. repair 모델 호출·completion gate는 후속이며 `completed` Run의 기존 의미를 유지한다. 모델이 작성한 테스트 통과 주장은 receipt가 아니다. [통합 상태와 검증](engine-phase-two-w2.md)을 따른다.

## 계획

`VerificationCheckRegistry.register`는 host가 check ID와 정확한 command·canonical absolute cwd·workspace·profile ID/revision·check source revision·timeout·output ceiling·required 여부를 등록한다. 외부 callback은 받지 않는다. `VerificationPlanService.create(sessionId, runId, expectedDocumentRevision, selection)`의 selection은 check ID 목록·source identity·선택적인 최대 repair 수만 받는다. command/profile override나 미등록 check ID는 거절한다.

계획은 초기 최대 16 checks, Run당 최대 3 source 계획, 기본 최대 2 repairs로 제한한다. 초기 repair 수와 execution budget은 후속 계획에서 증가하거나 초기화되지 않는다. budget은 Run ceiling의 고정 projection이며 실제 예약이 아니다. 실행 연결은 기존 Run/parent `BudgetAccount`로 남은 시간·tool/output·artifact 예산을 검사하고 소비해야 한다.

`VerificationSource`는 SHA-256·host source revision·기준 checkpoint ID를 결속한다. 이 모듈이 filesystem이나 checkpoint 원문을 검증하는 것은 아니다. root 실행 연결이 같은 source 범위를 관측하고 checkpoint 소속을 확인해야 한다. host registration의 `sourceRevision`은 check 정의의 revision이며 workspace source revision과 구분한다.

## 저장

`verification.run.<Run-ID digest>` session document가 authoritative plan/history/receipt 기록이다. 문서 최대 192 KiB, receipts 최대 48개다. 기존 DB schema와 session document journal/CAS를 사용한다. 모든 일반 mutation은 `SqliteStore.putActiveRunDocument`를 통해 active Run 검사와 document CAS를 한 primary transaction에서 수행한다. 터미널 또는 cancelling Run에는 late 결과를 저장하지 않는다.

`verification.index`는 최대 64 Run의 discovery metadata다. index 예약과 per-Run document는 다른 CAS이므로 예약 후 publication 실패 시 plan이 없는 index entry가 남을 수 있다. index 존재로 실행·통과를 판정하지 않는다. `list`는 metadata만 paging하며, 실제 상태는 `get(sessionId, runId)`로 확인한다. terminal Run의 index entry를 명시적으로 `forgetIndexEntry`해도 per-Run 원본 기록은 지우지 않는다. 전체 세션 snapshot은 사용하지 않는다.

## 결과 lifecycle

1. `VerificationReceiptService.begin`이 exact check·plan digest·source before·toolCall ID·prepared fingerprint를 결속해 `prepared`를 저장한다.
2. `dispatch`가 현재 source와 등록 정의를 다시 확인하고 durable intent를 저장한다. 이 메서드는 명령을 실행하지 않는다.
3. 기존 prepare→policy→exact approval→execute 경계가 실제 command를 실행한다. 실행 전 actor가 원래 Run 권한·captured profile·실제 cwd 소속·예산을 검사해야 한다.
4. `settle`에 execution owner의 command/cwd/profile/fingerprint·before/after source·exit/signal·checkpoint·cleanup digest/scope·원본 log artifact refs·output accounting을 전달한다.

결과는 `pass`, `fail`, `skipped`, `unsupported`, `timeout`, `cancelled`, `uncertain`, `stale`을 구분한다. source 변경 시 exit 0을 그대로 보존하고 결과는 `stale`이다. cleanup confirmation 또는 그 execution evidence가 불명확하면 `uncertain`이며, source 변경 여부도 별도 유지한다. 신호를 받은 종료·cancel·timeout·미시작 상태를 통과로 승격하지 않는다. skipped/unsupported는 process effect를 주장할 수 없다.

원본 로그는 최대 4개의 immutable artifact reference로 결속한다. session/Run/tool 소속이 다르면 거절한다. partial/truncated logs와 output bytes 미관측 `null`을 그대로 보존한다. 로그가 잘렸다는 사실과 실제 process exit 판정은 별개다. plan/receipt 저장 모듈은 파일을 열거나 producer를 재실행하지 않는다. 아래의 actual execution slice가 기존 producer의 결과·성공한 checkpoint publication·실제 원본 log read를 관측해 그 값만 전달한다.

## 재시작과 남은 연결

읽기만으로 unresolved check를 재실행하지 않는다. native Run recovery 이후 또는 import의 `recovery_required` pause에서 `recoverPending`을 명시적으로 호출하면 prepared/dispatched를 `uncertain`으로 바꾼다. live active 결과나 일반 user pause는 이 administrative conversion으로 덮어쓸 수 없다. 늦은 실제 결과는 기존 settled receipt를 다시 쓰지 못한다. 불확실성을 해결하는 별도 host recovery 판단 없이 새 check execution을 시작하지 않는다.

archive는 기존 session documents를 보존하며 import가 session을 recovery pause로 둔다. 계획의 absolute cwd/profile/source를 새 환경에 자동 재결속하지 않는다. host registration과 source provenance를 새로 확인해야 한다.

실제 사용은 `verificationTools:true`, `registerVerificationCheck`, `configureVerificationSession(sessionId, expectedRevision, {checkIds,sourcePaths,maxRepairs})`다. 기본 core와 actual command producer를 유지하며 모델은 `verify_changes({checkId})`만 호출한다. Run 시작은 source 범위를 고정하고 첫 검증 prepare가 현재 source plan을 만든다. `getVerificationState`는 bounded durable 계획/영수증을 조회한다. source 바뀐 새 계획도 원래 repair/Run ceilings를 늘리지 못한다.

required receipt completion decision과 제한 repair/controller는 남아 있다. Native user cancel 이후 late publication은 active guard로 거절되므로 pending identity와 `CLEANUP_UNCERTAIN` 종료를 유지한다. terminal `recoverPending`은 이를 uncertain으로 바꾸며 실제 관측되지 않은 cancelled receipt를 만들지 않는다. 단독 active execution owner의 실제 cancelled/timeout/process-group cleanup 관측과 이 native cancellation publication 경계는 구분한다. MC2-02 전체 완료를 표시하지 않는다.

검증은 실제 SQLite CAS/재시작, 정확한 등록·scope·source, record/index bounds, source 변경, 원본 ArtifactStore log 보존, terminal 직전 원자 publication 거절, crash recovery, archived pending/import pause, getter/proxy 거절을 포함한다.

## 도구와 실제 결과 계약

`createVerificationTool(host)`의 host는 `plans`, `receipts`, `getRun`, `sourceObservation(context, signal)`, `commandRuntime`, `captureCatalogue(context)`, `artifacts`다. artifacts는 실제 `ArtifactStore`, Promise 또는 지연 getter를 받는다. commandRuntime의 `run_command`는 엔진의 원래 `createCommandTool` 등록이어야 한다. 임의 plugin 응답이나 모델 protocol fields는 이 producer 계약을 대신할 수 없다.

model input은 exact `checkId` 한 개뿐이다. command·cwd·profile·source paths·receipt override와 accessors/proxies를 거절한다. parent profile이 `run_command`를 허용하고 등록된 check의 profile ID/revision과 일치해야 한다. build mode가 아니면 실행할 수 없다. deferred discovery에 명령이 아직 없을 때 도구가 visibility나 권한을 추가하지 않는다.

실제 `ScopedToolRuntime.resolve(catalogue, 'run_command').prepare`가 반환한 opaque handle을 보관한다. verification fingerprint는 plan/check digest·source·inner fingerprint/preview·current catalogue·축소된 limits를 결속한다. 승인 preview는 원래 command/cwd, role ask/deny 및 command preflight 관측을 포함한다. `requiresApproval`은 항상 true이며, check ID만으로 명령 자원 권한을 추정하지 않는다. 실제 parent runtime의 approval fingerprint는 이 preview를 다시 결속한다. receipt의 `preparedFingerprint`는 그 안의 verification producer handle identity다.

실행은 그 원래 handle만 한 번 소비한다. durable intent 직전 `commandRuntime.assertPreparedCurrent`로 current policy·role resources·preflight를 검사하고, 비동기 검사 뒤 계획·catalogue·source를 다시 확인한다. source/preflight가 바뀐 기존 handle은 재사용하지 못하며 새 tool call과 exact approval이 필요하다. nested context는 owner IDs·signal·budgets·execution lock을 유지하고 timeout/output limits만 `min(check, current Run)`으로 낮춘다. checkpoint callback은 원래 publication이 성공한 후에만 캡처한다. 별도 Coordinator나 두 번째 tool/output budget 소비를 추가하지 않는다.

cleanup evidence hash는 실제 producer의 종료/cleanup 관측과 성공적으로 저장된 command checkpoint의 결속이다. 원래 POSIX process group 밖의 모든 효과가 사라졌다는 증명은 아니다. checkpoint publication이나 실제 producer outcome을 잃으면 pending identity를 `producer-without-outcome`의 `uncertain`으로 기록하며 error.details를 증거로 읽지 않는다. terminal/cancelling guard가 receipt publication을 거절하면 pending 상태를 그대로 보존한다.

원래 stdout/stderr 로그는 returned paths를 canonical artifact directory 안에서 no-follow open하고 inode·size·mtime·ctime·hard-link 수를 확인한 실제 bounded bytes만 ArtifactStore에 수입한다. returned managed refs도 소속과 실제 저장 hash를 읽어 검사한다. 로그/producer evidence가 불완전할 때 `executionComplete=false`를 남겨 exit 0을 통과로 승격하지 않는다. 일부 로그가 먼저 저장됐다면 그 부분 증거를 보존한다. source-after와 evidence 검사는 각각 최대 1초의 별도 signal로 관측한다. 취소된 process signal을 source-after 검사에 재사용하지 않는다.

모델 출력 첫 줄에는 receipt ID·check ID·status·sourceStale·persistence가 나온다. 여유 예산이 있으면 실제 `read_artifact` 계약의 artifactId/runId/toolCallId와 선택적인 turnId/attemptId를 완전한 입력으로 제공한다. 남은 예산에는 기존 command model prefix를 UTF-8 bytes 기준으로 담는다. 원래 producer의 stdout/stderr byte accounting을 바꾸지 않으며, 별도 metadata가 original/retained/omitted command model bytes와 header/reference omission을 기록한다. 원본 로그 refs는 native result envelope에도 결속된다. 아주 작은 출력 한도로 header 전체가 들어가지 못할 때 그 사실을 명시한다. 이 문자열은 completion proof가 아니며 completion/repair controller가 durable receipt를 다시 검증해야 한다.

추가 집중 source 검증은 실제 command tool 23개와 evidence/projection 7개가 각각 통과했다. 정확한 승인과 원래 handle 한 번 소비, process nonzero/timeout/cancel·source 변경, 원본 ArtifactStore/native `read_artifact` 왕복, current preflight 변경 거절, log substitution/hard-link/symlink/foreign owner 거절, bounded lazy evidence getter, Unicode output cap 등을 포함한다. cleanup uncertainty는 실제 process 효과 뒤 producer fault fixture로 관측했으며 OS-wide cleanup failure를 재현했다고 주장하지 않는다. source supervisor가 임시 저장소에서 loader를 찾을 수 있도록 focused command tests는 absolute tsx loader 경로로 실행한다. 전체 suite/host integration 증거와 종료 판단은 root의 별도 gate 보고를 따른다.
