# Active Run의 의미 요약 기억

`EngineOptions.activePrefixPolicy`는 진행 중인 하나의 Run에서 오래된 완전한 실행 묶음을 요약하는 명시적 host 옵션이다. 옵션이 없으면 기존 동작을 유지한다. 완료된 이전 Run의 `context.memory`와 분리된 `context.active_memory`를 사용하며 GUI 설정에는 아직 연결하지 않았다.

```ts
const engine = createEngine({
  dbPath,
  providers,
  activePrefixPolicy: {
    kind: 'active-prefix-semantic',
    version: 1,
    maxSourceMessages: 128,
    maxSourceBytes: 32_768,
    maxOutputBytes: 8_192,
    keepRecentTurns: 2,
    maxCoveredMessages: 512,
  },
});
```

호스트는 plain object와 지원하는 own data property만 전달한다. 객체는 검증 후 복사·고정되며 owned child도 같은 검증된 정책을 사용한다. source messages 1–128, source bytes 256–65,536, output bytes 1–16,384, 최근 Turn 1–16, 누적 coverage 1–1,024까지 허용한다. source message 상한은 누적 coverage 상한 이하여야 한다.

## 원본과 출처

storage는 원본 DB에서 exact text·tool arguments·모델에 기록된 tool result·완료/실패/거부 결과·warning/artifact references를 조회한다. 이미 축소된 context excerpt를 완전한 관측으로 취급하지 않는다. `text-and-complete-tool-observations-v1`의 `factsSha256`는 그 projection의 정확한 JSON을 hash한다. opaque replay, 비공개 reasoning, image pixels, 읽지 않은 artifact 내용은 hash나 요약 사실에 포함하지 않는다.

Native completed Turn과 마지막 completed Attempt, terminal tool Part와 실제 내부 invocation의 owner·인수·결과를 확인한다. 같은 provider call ID를 서로 다른 Turn에서 재사용해도 각 Turn의 내부 invocation으로 구분한다. 실패/거부된 도구는 그 결과를 역사적 실패/거부로 기록하며 성공으로 바꾸지 않는다. raw Part/tool payload를 JavaScript로 반환하기 전에 count·aggregate byte probe를 적용한다. SQLite의 내부 물리 읽기량까지 이 상한으로 보장하지는 않는다.

초기 목표, 최신 user steer, image-bearing user, 최근 완전한 Turn, 출력 media가 있는 실행 묶음은 보호한다. 앞부분의 exact covered message ID만 provider projection에서 제거하고 보호된 중간 구멍은 유지한다. 기존 checkpoint가 보호했던 최근 묶음이 커져 초기 ContextPlan이 실패해도 다음 완전한 checkpoint가 그 묶음 일부를 요약해 들어갈 수 있으면 한 번 재계획한다. 최신 필수 입력 자체가 넘는 경우에는 계속 실패한다. 새 Run은 이전 Run의 active cutoff를 상속하지 않는다.

summary는 historical derived memory이다. 과거 파일 변경이나 검사를 현재 파일 상태의 증거로 표시하지 않는다. `ContextDiagnostics.activePrefix`에 checkpoint/summary revision, policy/facts/manifest hashes, covered/protected IDs와 summary usage를 남긴다. 원문 메시지·tool transcript·provider replay·image refs는 수정하거나 삭제하지 않는다.

## 예산과 활성화

요약은 별도의 tool-free provider 요청이다. shared Run의 summary call·출력·시간 예산을 소비하고 logical Turn, 일반 provider Attempt, input allowance를 새로 만들거나 늘리지 않는다. 이미 관측한 text delta는 local summary output cap으로 거부되더라도 공유 Run output budget에 반영한다. DB4의 typed summary attempt는 prepared→dispatch/streaming→provider 완료와 publication 대기를 기록하고 원자 activation 안에서만 completed로 바뀐다. 별도 latest summary usage와 부분 출력은 실패·취소·close·재시작 뒤에도 보존하며 일반 Attempt 합계에 포함하지 않는다. 과금액은 알 수 없다. [요약 수명 명세](engine-summary-attempts.md)를 따른다.

정책 source cap보다 실제 request 예산이 작으면 시스템 프롬프트·owner metadata·기존 기억의 envelope, JSON string escaping의 상계와 알려진 모델의 output reserve를 먼저 예약한다. 그 안에 들어가는 가장 이른 완전한 exchange 묶음만 선택한다. 한 exchange 자체가 넘으면 문자열을 자르거나 일부 coverage로 저장하지 않고 거부한다. source와 실제 serialized provider request를 각각 검사한다.

prepare 단계에서 기존 active memory/head document revision, complete boundary, promoted 최신 user와 pending steer frontier를 고정한다. provider가 정상 stop·비어 있지 않은 text·확인된 cleanup을 완료해도 아직 기억은 활성화하지 않는다. candidate 기억, 보호된 입력, 이전 Run 기억, agent profile, media notice, tool schemas와 output reserve를 포함한 실제 ContextPlan이 먼저 들어가야 한다.

한 SQLite transaction에서 source/owner/frontier/CAS를 다시 확인한 뒤 immutable summary revision과 provider context revision, 두 document, v1/v2 summary 완료·context 활성화 event를 함께 commit한다. immutable summary revision에는 checkpoint metadata 전체의 hash도 bind한다. source가 바뀌거나 저장에 실패하면 어느 한쪽 revision/document만 남기지 않는다.

일반 Turn 경계에서 source/CAS가 바뀌면 소비한 summary를 재시도하지 않고 최신 bounded snapshot으로 한 번 재계획한다. context를 기다리는 동안 들어온 steer는 다음 dispatch 전에 제한된 loop로 승격·재계획하며 연속 유입이 16회 재계획을 넘으면 typed failure로 중단한다. 취소, 불완전·잘린 응답, 출력/정리 실패에는 이전 checkpoint를 유지한다.

provider overflow recovery는 같은 Turn의 아직 출력하지 않은 failed Attempt와 확인된 iterator cleanup 증거를 따로 전달한다. 그 recovery 중 source/frontier가 바뀌면 해당 recovery를 중단하고 stale request를 재전송하지 않는다. iterator cleanup을 확인할 수 없으면 일반 HTTP retry도 거부하고 uncertainty로 기록한다. 새로운 user 입력을 기존 Turn의 input provenance에 덧붙여 같은 Attempt를 재사용하지 않는다.

## 범위와 검증

DB migration은 추가하지 않았다. 별도 summary journal의 prepared/dispatched 기록과 기존 Run crash recovery를 사용한다. 프로세스 중단 후 미공개 candidate를 자동 활성화하거나 provider를 재시도하지 않는다. 전용 summary interrupted/uncertain record API는 아직 제공하지 않는다.

전체 Run metadata는 최대 1,024 messages/Turns, source 128 messages, pending steer manifest 64 IDs와 고정 byte cap 안에서 조회한다. cap을 넘은 source는 unavailable이며 모든 과거 관측의 요약을 보장하지 않는다. media-bearing sources를 text-only 요약으로 대체하지 않는다. 이미지 이력 전송 정책과 함께 사용할 때에도 원문 refs와 필수 provenance를 보존하며 pixels를 관측했다고 추정하지 않는다.

`context/active-prefix.test.ts`, `storage/active-prefix.test.ts`, `integration/active-prefix.integration.test.ts`가 실제 SQLite/ContextService/engine 연결을 검증한다. 20·50턴 실제 `read_file` fixture는 첫 관측의 임의 nonce를 quoted source에서만 얻고 마지막 요청에 유지하며 비활성 대조군에서는 빠지는 것을 확인한다. CAS, steer, 취소·exact retry, source/request/output/context cap, 원문 replay, 출력 media 보호, denormalized owner, 증분 기억과 커진 protected suffix를 검증한다.

`node scripts/verify-active-prefix.mjs --live`는 별도 opt-in이다. 20번의 fixture-directed local read 뒤 실제 Codex summary 한 번과 실제 최종 답변 한 번으로 출처·기억 전송과 모델 recall을 확인한다. 모델이 20턴 코딩 전략을 스스로 선택한 평가로 표시하지 않는다. 최신 전체 gate·구현 commit·실제 요청 결과는 [검증 보고서](engine-goal-verification.md)를 따른다.
