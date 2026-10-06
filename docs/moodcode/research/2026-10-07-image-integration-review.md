# 이미지 입력 연결 독립 검토

2026-10-07에 이미지 기능 구현자가 작성하지 않은 검토자가 공개 engine facade, context projection, media storage/transport를 검토했다. 공유 runtime source는 수정하지 않았다. 발견 내용을 root에 전달했고 root/storage 담당이 수정한 뒤 새 로컬 통합 fixture로 계약을 확인했다. 실계정·실모델·앱 실행·외부 공격은 수행하지 않았다.

## 발견 및 수정 확인

| 발견 | 원래 영향 | 적용된 계약과 근거 |
| --- | --- | --- |
| 이미지 이력의 의미 요약 | semantic source JSON이 attachments를 버린 채 text-only summary의 cutoff가 원래 image-bearing Run을 제거할 수 있었다. 이미지 identity도 그 source hash에 포함되지 않았다. | 이미지가 있는 완료 이력은 `SUMMARY_IMAGE_SOURCE_UNSUPPORTED`로 거부한다. summary dispatch/activation을 수행하지 않고 원래 refs를 보존한다. [semantic-memory.ts](../../../packages/engine/src/context/semantic-memory.ts) |
| 이미지 이력의 byte pruning | optional older image block을 빼고 content-only extractive excerpt로 대체할 수 있었다. | 현재 bounded snapshot의 image-bearing blocks를 필수 보존한다. 함께 담을 수 없으면 `IMAGE_CONTEXT_LIMIT`이며 silent text replacement를 하지 않는다. [context/index.ts](../../../packages/engine/src/context/index.ts) |
| 이미지 admission exact retry | 동일 request의 durable receipt를 찾기 전에 blob resolve를 수행해, 이미 완료한 요청도 blob 삭제 후 `IMAGE_STORAGE_FAILED`로 거부됐다. 로컬 통합 fixture에서 수정 전에 재현했다. | v1/v2의 bounded durable lookup과 exact identity 검증을 먼저 수행한다. 같은 요청은 기존 receipt를 반환하고, 다른 내용은 `REQUEST_ID_CONFLICT`, 새 요청의 누락 blob은 명시적으로 거부한다. [engine.ts](../../../packages/engine/src/engine.ts), [storage/native.ts](../../../packages/engine/src/storage/native.ts) |

의미 요약 및 pruning 문제는 원래 소스 흐름으로 확인했다. 수정 후 실제 overflow/byte-budget fixture는 summary를 실행하거나 새로운 허위 turn을 만들지 않고 명시적으로 실패하며 원본 user image refs가 남는 것을 확인한다. full visual summary와 explicit image omission/provenance 정책은 이번 검증 범위가 아니다.

## 독립 실행 증거

[input-media-review.integration.test.ts](../../../packages/engine/src/integration/input-media-review.integration.test.ts)의 8개 fixture가 통과했다.

- 알려진 text-only model metadata는 Input/Run 생성 전에 거부한다. encoder만 구현됐고 model metadata가 unknown인 경우에는 vision capability를 검증됐다고 표시하지 않는다. context estimate는 `imageTokens:null`, `complete:false`와 명시적 warning을 유지한다.
- 동일 image ID를 여러 user turn에 다시 붙이면 occurrence는 각각 계산한다. 실제 provider 요청은 1/2/3/4 occurrence를 보내고 raw blob은 ID별로 한 번 resolve한다. 5번째는 provider 실행 전에 `PROVIDER_LIMIT_EXCEEDED`다. 이는 문서화된 현 정책이다.
- blob을 삭제한 완료 요청의 v1 재조회 및 v2 교차 재조회는 같은 Run/receipt이고 모델 실행은 한 번이다. 새로운 request는 실패하고 prompt를 바꾼 동일 requestId는 충돌이다.
- image-bearing 이력의 overflow 및 작은 byte budget은 refs를 text-only summary/excerpt로 대체하지 않는다. overflow에서는 논리 Turn 하나·primary attempt 하나만 기록하고 summary provider는 호출하지 않는다.
- 진행 중 import를 close하면 commit 이전에는 취소하고 store 종료를 기다린다. image index CAS 이후 close가 도착하면 durable ref/blob 성공을 보존한다. 비동기 admission 중 close는 뒤늦은 Input/Run을 생성하지 않는다.
- 실제 Responses adapter의 mock HTTP 오류 본문에 image base64가 포함돼도 Run error, v1/v2 events, snapshot, ContextRevision, diagnostics에는 그 raw bytes/data URL이 없다. provider wire payload에는 정상적으로 포함된다.

새 8개와 기존 [input-media.integration.test.ts](../../../packages/engine/src/integration/input-media.integration.test.ts) 3개를 함께 source 실행해 **11/11 pass**, source engine `tsc --noEmit`이 통과했다. 공유 전체 gate와 커밋은 root가 수행한다.

## 검토 범위와 보장의 한계

| 경로 | 읽기 수준 |
| --- | --- |
| engine.ts | withImageInputs, constructor capability/validation/wiring, v1/v2 admission, importImage/close를 targeted read |
| context/service.ts, plan.ts, semantic-memory.ts | 전체 읽기 |
| context/index.ts, memory.ts | historyBlocks, context selection/pruning, memory projection 및 source attribution 집중 읽기 |
| media/store.ts, provider.ts, validation.ts | 전체 읽기 |
| storage/index.ts, native.ts, runner/index.ts, turn-executor.ts | ref admission/steer/promotion, owner/receipt, provider request·overflow/attempt 관련 targeted read |
| media tests 및 input-media integration | 관련 fixture 읽기; 새 독립 fixture 직접 실행 |

`maxContextBytes` 및 UTF-8 token estimate는 text/reference metadata의 크기다. 픽셀 token 비용이나 전체 모델 context window의 검증값으로 해석하면 안 된다. transport 전체 request bytes·이미지 decoded bytes·occurrence는 별도 상한이다. `inputModalities:['text','image']`는 adapter encoding 구현 범위이며 임의 model의 실제 vision 성공 증거가 아니다.

필수 이미지 보존은 `readModelHistory`가 반환한 bounded snapshot에 적용한다. 그보다 오래된 DB 이력은 paging에서 빠질 수 있고 diagnostics의 omitted database message/run counts로 표시된다. 세션의 모든 과거 이미지를 영구히 매 요청에 보낸다는 보장은 아니다. 현재 4 occurrence 정책은 오래된 refs를 계속 보존할 때 대화를 명시적으로 막을 수 있다. 별도의 사용자 가시적 media pruning/retention 정책이 필요하다.

MIME/container/header/declared dimensions 검증은 pixel decoder가 아니다. 이미지 의미 이해, 모든 압축 payload 유효성, 실제 계정의 image 요청, Linux/Windows 이미지 IO는 확인하지 않았다. raw bytes는 filesystem blob과 provider wire payload에 존재하며 정상 engine records에는 참조만 남는다. 신뢰된 custom provider/host가 별도로 로그를 쓰는 동작까지 통제하는 보장으로 확대하지 않는다.
