# MC2-03d — 승인된 workspace 지식의 실제 ContextPlan 소비

Moodcode 자체 TypeScript 엔진의 native workspace-document publication을 실제 코딩 요청 문맥과 연결한다. 생성 후보나 inbox 조회가 문맥 사용 권한을 부여하지 않는다. 호스트가 선택한 현재 승인 문서만 원본 출처·trust·실제 postimage head를 확인한 뒤 모델에 보낸다.

## 호스트 사용 방법

```ts
const engine = createEngine({
  dbPath,
  knowledgeContextPolicy: {
    documentKeys: ['project.architecture'],
    slotBytes: 8192,
    // 필요할 때만 실제 admitted profile id와 immutable revision을 제한한다.
    // profiles: [{ id: 'builder', revision: approvedProfile.revision }],
  },
});
```

설정이 없으면 추가 지식 문맥은 꺼진다. 이 설정은 publication이나 generation을 승인하지 않으며 두 기능의 별도 opt-in/원본 preview/명시적 host approval을 유지한다. 최대 4개 exact document key와 16KiB serialized supplemental message 상한을 적용한다. 최대 16개의 exact profile id/revision 선택을 허용한다. 설정은 bounded plain JSON으로 검증하고 깊은 복사·고정한다. 저장소 지침이나 모델 응답은 selector, profile, budget을 바꿀 수 없다.

child 엔진은 부모의 `knowledgeContextPolicy`를 자동으로 물려받지 않는다. 부모 저장소의 물리적 binding과 지식 선택은 child의 별도 저장소에서 권한으로 사용하지 않는다.

## 실제 소비와 provenance

`KnowledgeContextSource`는 primary SQLite의 한 동기 read transaction에서 actual current document head → active document revision → completed publication/receipt → 정확한 recorded candidate → completed native generation/attempt/cleanup → original plan/trust를 읽는다. 과거 producer tuple의 증명과 현재 소비 허가를 구분한다. publication 이후의 현재성은 실제 active postimage head/revision/publication/body SHA로 검사한다. generation 당시 target preimage를 다시 현재 target으로 요구하지 않는다.

현재 physical database/artifact/workspace root, import pause, original trust revision의 현재 allow 상태, trust source 파일, original candidate source 파일·완료 Run/message, candidate/plan/trust 만료를 추가로 검사한다. 호스트가 profile을 제한한 경우 실제 저장된 Run profile의 exact id/revision을 사용한다. 빠진 문서, 철회, 만료, 변경된 source/trust, paused import와 선택되지 않은 profile은 bounded omission으로 관찰한다. 손상된 producer/receipt/head tuple은 실패로 처리한다.

문서 전체를 read-only assistant supplemental JSON 하나에 넣는다. 본문은 instruction/system message나 tool authority가 되지 않는다. 문서를 잘라 넣거나 새 provider 요약을 호출하지 않는다. 하나의 문서가 맞지 않으면 해당 문서 전체를 생략한다.

필수 current exchange·완전한 tool exchange·media/document anchor·verification continuation·derived memory/profile/guidance의 실제 serialized reservation을 먼저 계산한다. repository contribution, knowledge contribution, optional older history가 같은 context byte/model estimate/output reserve를 사용한다. supplemental entry의 JSON escape와 comma 비용까지 계산하고 envelope/output을 중복 예약하지 않는다.

실제 coding `ContextRevision.text`는 전체 요청 messages의 serialized 원본을 저장하고, `sourceIds`에는 exact contribution/policy/document/publication/receipt/producer/source manifest 식별자를 담는다. 실제 `ProviderAttempt.contextRevisionId`, request digest와 cleanup 기록이 이 소비 경로를 연결한다.

## dispatch·재시도·수명

`ContextService.assertFresh`는 처음 준비한 original capture, session/Run owner, revision, 전체 messages hash를 확인한다. 포함된 지식은 매 Attempt dispatch 직전과 retry backoff 이후에도 현재성을 다시 검사한다. 검사 중 취소나 revision/source/head/trust 변경이 있으면 dispatch를 막는다. 동일 Turn의 retry 메시지를 새 head로 바꾸지 않는다. 다음 명시적 safe context build에서만 새 현재 문서를 선택할 수 있다.

primary metadata는 getter 호출 전에 행마다 64KiB, 한 snapshot 전체 1MiB 상한을 확인한다. 모든 선택 문서의 동기 source/trust I/O가 끝난 뒤 만료를 다시 검사해 뒤쪽 문서 검사 중 앞쪽 문서가 만료되는 경우도 차단한다. context capture는 active+pending 합계 128개, 지식 source 원본 capture는 256개로 제한하고 같은 session의 동시 prepare는 거절한다.

capture는 문맥 교체, 실패한 construction, Run 종료 시 해제한다. instruction baseline이나 semantic summary는 철회·만료·paused 지식을 다시 활성화하는 경로가 되지 않는다.

## 검증 기록과 남은 범위

통합 검증 결과와 source/test identity는 [이 단계의 검증 기록](engine-phase-two-knowledge-context-verification.json)에 저장한다. 이전 publication/generation 검증 기록은 해당 커밋의 역사적 증거로 유지한다.

최종 검사: TypeScript 통과, 전체 engine 3,429개 중 3,427개 통과·실패 0·기존 Windows skip 2, 관련 source 571개 모두 통과, scripted coding 평가 3개 모두 통과. 이번 native source 24개·실제 Engine 문맥 34개·planning/capture 11개 회귀를 포함한다. 손상된 trust-head JSON과 null workspace도 raw 예외 대신 typed 오류로 거절하며 getter·port 호출 0을 검증했다.

이번 단계는 native workspace-document의 active projection이다. 실제 filesystem/skill-file publication backend(MC2-03c)와 imported knowledge의 명시적 복구(MC2-03d)는 별도로 남아 있다. archive의 historical getter는 읽을 수 있지만 paused import가 generation/publication/active context 권한을 얻거나 provider·queue를 자동으로 재개하지 않는다. 지원되지 않는 Windows 실제 command/Job Object 등 기존 E5-13/E5-08/E6-07/E6-08 환경 증거 부채도 유지한다. 전체 목표는 계속 active다.
