# 요약 uncertainty의 명시적 host 결정

요약 provider의 cleanup을 확인하지 못한 기록은 `uncertain`, `cleanupConfirmed: false`, `publication: discarded`로 보존한다. DB5의 `summary_recovery_acknowledgments`는 원래 기록을 바꾸지 않고, 정확한 불확실 요청에 대한 host의 결정을 별도로 저장한다. 이 API는 요약 provider를 재요청하거나 후보 memory/context를 활성화하지 않는다.

## 대상과 결정

host는 `getSummaryRecoveryPreview(sessionId, summaryAttemptId)`로 owner와 source가 결합된 preview를 조회하고, `eligible` 상태의 fingerprint를 명시적 결정에 전달한다.

```ts
const preview = engine.getSummaryRecoveryPreview(sessionId, summaryAttemptId);
if (preview.status === 'eligible' && preview.fingerprint) {
  const receipt = await engine.acknowledgeSummaryRecovery({
    sessionId, summaryAttemptId, requestId,
    fingerprint: preview.fingerprint,
    acknowledged: true,
  });
}
```

같은 엔진에서 새로 생긴 불확실 요청은 재시작을 요구한다. 부팅 전에 저장된 summary 행의 고수위를 startup recovery 이전에 캡처하므로, startup에서 streaming 요청을 uncertain으로 정산해도 같은 경계를 유지한다. 원래 Run이 terminal이고, 요약의 owner/provider/model과 source 증거가 유효해야 한다. 다른 활성 Run·명령 cleanup·파일 복원·일반 provider/Turn uncertainty는 요약 결정으로 해제하지 않는다.

fingerprint는 정확한 attempt revision, 제한된 usage와 source, owner, 결정 당시의 memory/active-memory/context head, 물리 DB·artifact 저장소를 결합한다. 결정은 동일 트랜잭션 안에서 다시 검증한다. ledger와 v1/v2 audit 중 하나라도 저장에 실패하면 전부 롤백한다. 같은 requestId와 fingerprint의 재전송은 원래 receipt를 반환하며 `duplicate: true`로 표시한다.

요청을 검증한 뒤 사본을 고정하므로 lease를 기다리는 동안 호출자가 원본 객체를 바꿔도 owner가 달라지지 않는다. 기존 exact receipt 조회는 읽기 전용이며 이후 workspace가 사용 중이거나 별도 격리 상태여도 원래 결과와 request conflict를 우선 확인한다. 이 조회가 현재 실행을 허용하거나 새로운 결정을 저장하는 것은 아니다.

## 보존과 후속 작업

원래 summary state·usage·부분 출력·context revision·session pause·대기 입력은 결정으로 수정하지 않는다. receipt의 `cleanupConfirmed`, `providerRetried`, `checkpointActivated`, `executionResumed`는 모두 false다. host 결정은 원격 provider의 종료나 과금 결과를 확인했다는 뜻이 아니다.

결정 API는 scheduler의 대기 ticket을 정리하되 durable inbox와 control을 보존하고, workspace idle wake를 호출하지 않는다. 새 `run.submit`이나 host의 명시적 resume이 후속 작업을 시작한다. 별도 실행 문제의 runtime quarantine은 그대로 유지한다.

새 작업이 context head를 바꿔도 이미 결합한 불변 attempt·usage·source의 결정은 유지된다. archive/import는 ledger를 보존하지만 DB/artifact 경로와 파일 identity가 달라지므로 원래 결정을 새 저장소의 실행 허용 근거로 사용하지 않는다. source나 owner의 불변 증거가 바뀌면 보수적으로 차단한다.

native metrics schema 4는 `recovery.uncertainSummaries`를 계속 보고하며 `summaryRecoveryAcknowledgments`에 저장된 결정 수를 따로 표시한다. 후자는 archive된 또는 더 이상 유효하지 않은 결정도 포함한다. `summaryAcknowledgmentValidity: null`은 물리 저장소·source 유효성을 이 SQL 집계만으로 판단하지 않았다는 의미다. 현재 실행 허용 여부는 preview와 admission predicate가 확인한다.

## 적용 범위

preview는 source messages 최대 512개·Turns/Runs 최대 128개를 검사하고, 선택한 attempt·usage·source·context 증거에 2MiB 예산을 적용한다. workspace의 기존 ACK 유효성 검사는 최대 64개 후보이며 선택한 ledger·source·pinned revision 증거에 8MiB 예산을 적용한다. ledger 한 행의 JSON 한도는 64KiB다. 상한을 넘거나 완전한 근거를 확인하지 못하면 차단한다. 이미지 pixels·현재 파일 재해석·전체 snapshot을 복구 근거로 읽지 않는다. 이 예산은 선택한 기록 증거를 계수하며 owner 확인용 추가 조회·metadata를 포함한 모든 SQL 반환량이나 SQLite 물리 I/O의 상한은 아니다.

API는 host 엔진에만 연결하고 모델 도구나 GUI에 노출하지 않는다. 사용자가 잠든 동안 프로젝트의 unresolved 기록에 결정을 대신 내리지 않는다. 검증은 임시 저장소의 명시적 fixture 결정만 사용한다. 요약으로 끝난 별도 pre-run 요청을 우선 대상으로 하며, 일반 Turn/Attempt까지 uncertain인 overflow 복구는 별도 cleanup 증거 계약을 요구한다.

[요약 수명과 사용량](engine-summary-attempts.md), [host API](engine-host-api.md), [최신 검증](engine-goal-verification.md)을 함께 따른다.
