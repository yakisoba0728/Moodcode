# 일반 provider 결과 불확실성의 명시적 host 결정

G1-18은 DB6의 독립적인 종료 증거를 사용해 결과가 불명확한 일반 호출에 별도 host 결정을 남긴다. 원래 outcome을 성공으로 바꾸지 않으며 원격 서버의 상태나 과금을 확인했다는 뜻이 아니다. 최신 검증 범위는 [검증 보고서](engine-goal-verification.md)를 따른다. private fixture 외의 실제 프로젝트 기록을 대신 승인하지 않는다.

- host API: `getProviderRecoveryPreview(sessionId, attemptId)`와 `acknowledgeProviderRecovery({sessionId,attemptId,requestId,fingerprint,acknowledged:true})`.
- 신규 DB7 `provider_recovery_acknowledgments`: physical storage/workspace binding, exact request identity와 source/cleanup/usage hashes, 독립 decision receipt와 native/v1 원자 audit. 기존 기록은 불변이며 backfill하지 않는다.
- eligible source: terminal failed/cancelled/interrupted Run의 마지막 Turn·최신 ordinary Attempt가 provider dispatch outcome uncertain이고 실제 cleanup confirmed. 현재 Turn은 같은 owner의 provider dispatch uncertainty이거나 startup에서 interrupted로 정산했으며 별도 uncertainty가 없다. 정상 취소에서 Attempt/Turn이 interrupted로 확정되고 cleanup도 확인되면 `PROVIDER_RECOVERY_NOT_NEEDED`다. summary/tool-effect uncertainty를 이 결정으로 덮지 않는다.
- source: exact terminal Run/config·Attempt/Turn·logical request SHA·context revision·promoted user inputs·원래 메시지/부분 출력·도구 관측을 bounded SQL로 고정한다. 전체 session snapshot은 조회하지 않는다. prior completed tools와 current unexecuted proposals는 실제 dispatch/terminal 관측과 결합한다. 실행/효과가 unknown인 도구는 차단한다.
- CAS: decision 직전 context baseline과 immutable refs를 다시 확인한다. decision 이후 mutable head가 달라져도 원래 source/pins가 그대로면 exact retry receipt는 읽기 전용이다. 원래 결과·usage·queue/control·provider retry/activation/resume를 바꾸지 않는다.
- boot: primary open의 Attempt row 고수위를 startup recovery 전에 캡처한다. 같은 boot의 신규 불확실성은 재시작을 요구한다. unknown cleanup·missing legacy proof·다른 effects·live owners·active Runs·maintenance는 실행 허용으로 바꾸지 않는다.
- admission: 유효한 개별 provider 결정만 해당 ordinary uncertain Attempt와 그 정확한 Turn의 blocker에 적용한다. 여러 candidate와 summary·도구/effect blocker가 남으면 계속 차단한다. physical import의 역사 결정은 새 저장소에서 적용하지 않는다.
- 검증: 취소/절대·무응답 timeout/transport·부분 출력/도구 제안, source/context/hash drift·owner·large evidence·rollback·restart·archive·실제 SIGKILL·queue 보존·다른 uncertainty를 독립 fixture로 확인한다. 실제 계정 검증은 임시 결정 뒤 명시적 새 요청 1회만 허용한다.

선택 증거 합산 8MiB, messages 512, current Parts 128, tools 256, immutable source refs/pins 1,024, owner JSON 각각 1MiB, ledger 64KiB를 기본으로 한다. ledger JSON 한도가 pin 개수보다 먼저 적용될 수도 있다. workspace의 provider 결정 검사도 최대 64개 후보와 선택 증거 8MiB를 제한한다. 추가로 provider/summary/Turn·native owner의 선택 본문은 [한 transaction의 공통 8MiB 예산](engine-recovery-evidence-read.md)을 공유한다. 도메인별 논리 제한도 유지하며 모든 SQLite I/O를 이 수치로 보장하지 않는다. provider 결과·서버 중지·과금 확정은 미검증 상태다.

완성된 `tool.call` 제안은 provider 완료를 기다리는 동안 Part로 저장한다. 도구 실행은 유효한 finish 뒤에 시작하므로 통신 오류로 끝난 제안은 interrupted Part와 원래 input으로 남고 ToolRecord나 효과를 만들지 않는다. text·reasoning·media와 prior completed tool도 결정 source에 포함한다. 도구의 일반 metadata 안에 있는 도메인 상태는 엔진 cleanup 증거로 해석하지 않는다.

host는 `getProviderRecoveryPreview(sessionId, attemptId)`의 `eligible` fingerprint를 그대로 다음 요청에 전달한다.

```ts
const preview = engine.getProviderRecoveryPreview(sessionId, attemptId);
if (preview.status === 'eligible' && preview.fingerprint) {
  const receipt = await engine.acknowledgeProviderRecovery({
    sessionId, attemptId, requestId,
    fingerprint: preview.fingerprint,
    acknowledged: true,
  });
}
```

receipt는 원래 uncertain 상태와 별도 결정을 구분한다. `cleanupConfirmed: true`는 해당 요청의 기존 확인된 종료 기록을 가리키며 `providerOutcomeConfirmed`, `providerRetried`, `executionResumed`, `checkpointActivated`는 false다. 같은 exact 요청의 retry는 `duplicate: true`로 원래 receipt를 반환한다. 이 조회는 이후 maintenance/quarantine 중에도 읽기 전용으로 가능하지만 새로운 결정과 실행은 각각의 guard를 통과해야 한다.

핀 목록 SHA와 원래 boot frontier도 fingerprint와 SQL ledger에 결합한다. baseline/source의 원본 메시지와 참조된 context revision을 owner 확인 후 한도 안에서 검사하며, 알려진 typed instruction/provenance label만 별도로 처리한다. 메시지/이전 요약 참조가 빠지거나 변하면 차단한다. 결정 후 새 context head가 생겨도 원래 source와 핀이 유효한 경우에만 admission에 적용한다.

native metrics schema 6의 `providerRecoveryAcknowledgments`는 역사적·현재 무효한 결정도 포함하는 raw SQL count다. `providerAcknowledgmentValidity: null`과 cleanup의 `providerOutcomeConfirmed: null`은 이 집계가 유효성/원격 결과를 검증하지 않았다는 의미다. 실제 실행 가능 여부는 preview와 workspace predicate가 확인한다.

DB7은 DB5의 summary ledger에 V2 pin proof 열도 추가한다. 기존 summary 결정의 body/scope/fingerprint는 보존하지만 V1 결정을 새 실행 허용 근거로 승격하지 않는다. 정확한 역사 receipt 조회와 새 V2 결정의 의미는 [summary 복구](engine-summary-recovery.md)를 따른다. 두 API는 모델 도구·GUI에 노출하지 않는다.
