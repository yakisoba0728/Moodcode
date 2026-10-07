# 실제 실행 관측과 제한된 진단 증거

이 구현은 실제 coding Run의 실행 관측을 DB14에 기록하고, host가 한정된 증거를 조회하도록 연결한다. 진단은 승인, 재실행, 복구, 검증 완료의 권한을 발급하지 않는다. Run의 `completed`와 task 검증 성공은 별개다.

```ts
createEngine({
  dbPath,
  diagnosticObservations: true,
  diagnosticSourceLimits: { files: 128, durationMs: 1000 },
});
```

`diagnosticObservations`는 기본값이 off다. opt-in한 실제 실행 경계에서만 물리 source를 읽고 native 관측을 기록한다. `diagnosticSourceLimits`는 기본 한도를 낮출 수 있고, 늘릴 수 없다. 기본값은 entries 8,192개, files 1,024개, 전체 읽기 16 MiB, 개별 파일 2 MiB, depth 32, duration 1,500 ms다. in-flight capture는 최대 8개, 유지하는 원본 capture는 최대 128개다.

물리 source의 scope는 workspace 파일 전체에서 Git metadata와 host가 지정한 정확한 저장소 경로를 제외한 범위다. ignored 파일과 binary도 실제 byte를 읽어 hash에 반영한다. canonical root, physical identity, 실제 Git HEAD·branch·repository context를 함께 확인한다. symlink·hardlink·unsafe 경로, byte/count/depth/time 한도, 읽기 실패, 관측 중 확인된 변경은 `completeness: 'unknown', sha256: null`로 남긴다. 취소와 close는 원본 descriptor 읽기를 끝까지 정산한다. 파일 본문은 진단 DTO에 넣지 않는다.

source SHA가 전체 요청 결과를 설명할 수 없는 읽기도 있다. `.git/index` 같은 Git metadata, Engine DB·WAL·artifact를 명시적으로 읽거나, host 저장소 제외 경로를 포함하는 recursive scope는 unknown이다. 경로 alias도 보수적으로 판별한다. 실제 core registration의 원본 reference만 source 관측에 연결하며, 같은 이름·schema의 custom tool이나 custom result에 적힌 source/effect 주장은 proof로 인정하지 않는다.

여러 파일의 읽기와 외부 writer 사이에 portable OS atomic snapshot을 제공하지는 않는다. 관측한 inode·timestamp·membership 변경은 거부하고 원본 capture를 재검증하지만, Node의 검사와 외부 변경 사이 모든 race를 없앴다고 주장하지 않는다. source 관측은 tool의 원본 prepared input, 승인, producer 자체의 physical guard를 대체하지 않는다.

DB14의 `diagnostic_execution_observations`는 workspace/session/Run/tool/Turn/Attempt의 실제 native owner에 묶이고, `diagnostic_effect_epochs`는 workspace별 보수적인 실행 clock이다. 승인과 현재 policy·catalogue·role/preflight·prepared identity 검사 후, 원본 producer 호출 직전에 dispatch와 epoch를 같은 native transaction에 기록한다. 관측 await 뒤에도 currentness를 다시 확인한다. 마지막 commit callback과 유일한 producer 호출 사이에는 await가 없다.

read/state는 epoch를 올리지 않는다. write/execute/network/unknown은 dispatch 때 한 번 올린다. 이 값은 실행을 시도한 경계이며, 성공한 write 수나 실제 변경된 파일 수가 아니다. 승인 거부, dispatch 전 취소·stale은 관측과 epoch를 만들지 않는다. source를 알 수 없어도 기존 permission을 허용으로 바꾸지 않으며, unknown source를 동일한 파일을 읽었다는 repeat proof로 사용하지 않는다. 동일 read 제한은 원본 input, full source, effect epoch를 함께 사용하므로 실제 외부 변경 뒤에는 새 read를 허용한다.

settlement는 실제 tool outcome과 source afterimage를 기록한다. capped/paged read, 잘린 output·artifact, 실패는 `resultComplete: false`다. 강제 종료나 미정산 원본 dispatch는 restart에서 interrupted/unknown으로 보존하고 `sourceAfter: null`, `resultComplete: false`로 둔다. producer를 재실행하거나 별도의 cleanup·task success 근거를 만들어내지 않는다.

Host 조회 API는 다음과 같다. page는 원본 history의 선택 범위이며 전체 Run history를 보장하지 않는다.

```ts
engine.getExecutionObservations({
  workspaceId,
  runId,
  afterOrdinal: 0,
  throughOrdinal,
  limit: 100,
  maxBytes: 1048576,
});
// { items, next, throughOrdinal, bytes }

engine.getCodingEvidence(runId, {
  afterSeq: 0,
  throughSeq,
  limit: 100,
  maxBytes: 65536,
  execution: { afterOrdinal: 0, throughOrdinal, limit: 100, maxBytes: 1048576 },
  includeSummary: true,
});

engine.getStallObservation(
  { sessionId, runId, afterSeq: 0, throughSeq, limit: 100 },
  { window: 8, threshold: 3 },
);

engine.inspectToolRegistration("read_file", "engine");
```

`getExecutionObservations`는 한 page에 최대 100행·1 MiB를 읽으며 foreign Run/workspace 선택을 거부한다. `getCodingEvidence`는 원본 Run 설정, bounded session journal, native 실행 관측을 하나의 동기 primary SQL read snapshot에서 읽는다. 한 SQL snapshot이어도 요청한 과거 seq window보다 현재 Run 상태가 새로울 수 있다(`mutableRunStateMayBeNewerThanJournal: true`). 결과는 최대 64 KiB이고 record를 whole 단위로 생략하며 cursor와 omission/truncation metadata를 보존한다. raw prompt/result/file body, credentials, replay, attachment byte는 내보내지 않는다. 반환 값은 `coding`, `execution`, `budget`, `summary`, `coverage`, `manifestSha256`을 포함하는 immutable `native-coding-evidence-manifest-v1`이다.

`budget`은 원래 Run의 configured limits/budgets만 제공한다. 실제 live budget account의 남은 권한을 얻지 않았으므로 `remaining: null`, `remainingReason: 'native-budget-account-authority-not-available'`, `providerRetryAuthority: false`다. 이를 남은 예산이 0이거나 추가 retry를 허용한다는 의미로 해석하면 안 된다. token usage의 nullable 값을 임의의 billed total로 바꾸지도 않는다.

`includeSummary: true`는 관측된 상태 수, partial output 수, unknown source 수를 결정적으로 집계하는 `extractive-diagnostic-metadata-v1`을 반환한다. 이 조회가 쓰는 provider call·tool call·generated token은 모두 0이다. LM 기반 의미 요약·distillation은 구현하지 않았고, 이 inspector에서 별도 generation을 admit하지 않는다. 기본값이면 `summary: null`이다.

`getStallObservation`은 원본 실행 경계의 input/result/full source/effect epoch가 같은 read를 선택된 window에서 비교한다. 불완전·잘린 관측과 non-read에는 unknown이 가능하다. signal이 `possible-stall`이어도 `policy: 'advisory-only'`, `automaticAction: 'none'`, `retryAuthority: false`, `taskSuccess: 'not-assessed'`다. inspector가 Run을 멈추거나 도구를 재실행하지 않는다.

기존 `getAttemptManifest(runId, { source?, ...page })`는 호환 API로 유지된다. host가 `source`를 주더라도 `kind: 'host-declared'`, `filesystemVerified: false`다. 해당 호환 API는 Run/journal을 별도로 읽고, 새 `getCodingEvidence`의 coherent native snapshot이나 실제 physical source proof라고 주장하지 않는다.

등록된 tool의 current metadata는 Engine의 `inspectToolRegistration(toolName, scopeId = 'engine')` 또는 runtime의 `inspectToolRegistration(scopeId, toolName)`으로 조회한다. 정확한 scope의 현재 등록을 읽고 registry/policy revision, 원본 registration revision·SHA, schema SHA·byte 수, description SHA·UTF-8 byte 수, effect class, exact approval 여부, manifest SHA를 immutable `tool-registration-manifest-v1`로 반환한다. scope composition을 따라 다른 scope를 찾지 않는다. raw schema·description·handler는 노출하지 않으며 catalogue를 materialize하거나 prepare/execute/revalidate/policy evaluation을 호출하지 않는다.

registration SHA는 host가 발급한 해당 Entry의 비영속 identity hash다. 같은 등록의 조회에서는 유지되고, 같은 이름·schema로 다시 등록하면 달라진다. 실행 코드 본문의 hash나 restart 뒤의 durable identity라고 주장하지 않는다. 반환 manifest의 `authority`는 observation-only이며 실행·승인·source freshness를 증명하지 않는다. 기존 `captureRegistration`의 원본 handle·`assertRegistrationCurrent` 검사와 별개로, manifest 복사본이나 hash 자체에는 producer 권한이 없다.

archive/import는 historical execution rows와 epoch를 검증·보존한다. import된 history는 당시 원본의 증거이며 현재 filesystem·trust·cleanup 권한이 아니다. import는 기존 pause 계약을 유지하고 자동 provider/tool replay를 시작하지 않는다. imported knowledge의 명시적 activation과 identity remap, 이후 context 재소비를 완료하는 MC2-03d recovery 범위는 아직 남아 있다.

신규 90개를 포함한 전체 engine 검사 3,743개 중 3,741개 통과, 실패 0, 기존 Windows skip 2를 확인했다. Source 회귀 810개와 scripted coding fixture 3개, 전체 typecheck도 통과했다. [실제 검증 기록](engine-phase-two-native-diagnostics-verification.json)에 32개 frozen source/test SHA와 검사 로그 hash를 보존한다. MC2-12c/d를 완료해 현재 23/80·5/20이며, 전체 goal은 active다.
