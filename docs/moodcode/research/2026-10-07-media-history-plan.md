# Active prefix와 이미지 이력 기억 정책

검토일은 2026-10-07이며 Moodcode 기준은 `64435d7` 이후 공유 작업 트리다. 목표는 원본 transcript·image refs·provider replay를 보존하면서, 호스트가 명시적으로 선택한 요청에서 오래된 이미지의 픽셀 전송만 생략하는 것이다. 이 문서와 새 projection 모듈은 외부 프로젝트의 코드·프롬프트·테스트를 복사하지 않고 현재 Moodcode 계약으로 작성했다.

## 현재 경계

기본 context builder는 image-bearing block을 모두 필수로 취급한다. 텍스트 excerpt가 픽셀을 대신할 수 없으므로 image-bearing history를 문자 요약으로 교체하는 semantic memory 호출은 `SUMMARY_IMAGE_SOURCE_UNSUPPORTED`로 거부한다. 가장 최근 active Run의 원래 user goal, 최신 user/steer, 최신 complete assistant/call-result 묶음은 bounded history에서도 보존한다. 이력 원문과 native replay는 저장소에 남고 active-prefix cutoff는 생성하지 않는다. [현재 context 선택](../../../packages/engine/src/context/index.ts), [summary source 거부](../../../packages/engine/src/context/semantic-memory.ts#L49), [bounded DB history](../../../packages/engine/src/storage/native-history.ts).

입력 image hard cap은 요청당 4 occurrences/decoded 1 MiB, 이미지당 512 KiB다. 같은 exact image reference를 여러 user 메시지에서 반복해도 transport에는 각 메시지의 이미지 block이 존재하므로 occurrence와 decoded 요청 bytes를 반복 가산한다. resolved raw bytes만 exact image ID별로 한 번 공급한다. 따라서 같은 이미지가 5번 등장하면 blob이 하나여도 기본 요청은 `PROVIDER_LIMIT_EXCEEDED`로 거부한다. 이 상한은 공급자 최대값이라는 주장이 아닌 Moodcode의 로컬 보호 예산이다. [transport 검증](../../../packages/engine/src/media/provider.ts), [독립 실제 반복 입력 fixture](../../../packages/engine/src/integration/input-media-review.integration.test.ts).

## 공개 구현에서 확인한 원칙

OpenCode `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`의 compaction은 media attachment를 attachment 표기 텍스트로 serialize하고, retained replay 경로에서도 media file part를 텍스트 표기로 바꾸는 지점을 가진다. Moodcode는 그 동작을 그대로 채택하지 않고 원래 image ID/hash/bytes와 정확한 message identity를 별도 provenance에 남긴다. [공식 serialize](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/compaction.ts#L55-L77), [공식 replay 처리](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/compaction.ts#L479-L490).

Pi `ae92585d3b3e5f1e4b123d14a34314d826d8d9f5` 문서는 raw history와 model-visible projection을 구분하고, 큰 user span의 assistant 경계에서 분리할 수 있음을 설명한다. Tool result를 분리 경계로 삼지 않고 call과 함께 보존한다. 여기서 얻는 설계 원칙은 원본 불변과 complete exchange 단위다. Pi의 retained cutoff나 summary 형식은 복사하지 않는다. [공식 projection·split 설계](https://github.com/earendil-works/pi/blob/ae92585d3b3e5f1e4b123d14a34314d826d8d9f5/packages/coding-agent/docs/compaction.md#L68-L117).

Codex 공개 main은 조회 시점의 SHA `0b863c69f50335acd92164aab971cb58d298c2fe`로 고정했다. 현재 공개 history는 전송용 normalization에서 call/output 정합성과 지원하지 않는 image/audio 처리를 수행하고, 원본 annotation을 별도로 유지한다. Image replacement는 모달리티 미지원 처리이며 오래된 이미지 이력 생략 정책과는 다른 목적이다. Moodcode는 그 parser나 placeholder를 복사하지 않고, 생략이 권한이나 새로운 관측으로 바뀌지 않는 typed provenance를 사용한다. [공식 전송 projection](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/core/src/context_manager/history.rs#L485-L580), [정합성 normalization](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/core/src/context_manager/history.rs#L898-L913), [모달리티 image 처리](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/core/src/context_manager/normalize.rs#L315-L363).

모든 공개 근거는 실제 파일/문서를 읽은 범위에 한정한다. 이들 제품을 실행하거나 계정에 연결하지 않았고 소스의 일반 원칙을 Moodcode의 동작 증거로 사용하지 않았다.

## 구현한 host opt-in 계약

새 [media-history.ts](../../../packages/engine/src/context/media-history.ts)는 filesystem·network·storage mutation이 없는 순수 projection이다.

`validateMediaHistoryPolicy(policy)`는 아래 한 종류만 받아 새 normalized value를 반환한다. 호스트가 정책을 제공하지 않으면 transcript를 clone하고 notice·omission을 만들지 않아 기본 행동을 유지한다. 정책의 각 상한은 기본 hard cap을 높일 수 없다.

| 항목 | 값/상한 | 의미 |
| --- | --- | --- |
| kind/version | `reference-only-older-images` / 1 | 자동 요약과 구분한 명시적 픽셀 생략 정책 |
| maxImageOccurrences | 최대 4 | 같은 ID도 메시지 block마다 가산 |
| maxImageBytes | 최대 1,048,576 | retained block의 decoded bytes 합계 |
| maxMetadataBytes | 최대 16,384 | provenance sidecar와 provider notice의 합계 |
| source messages | 최대 512 | 이미 bounded 조회된 snapshot만 받음 |
| opaque replay 검사 | 4,096 nodes/keys, depth 32 | metadata 탐색의 별도 상한 |

`projectMediaHistory(snapshot, options, signal?)`의 options는 policy, activeRunId다. 반환값은 다음과 같다.

| 필드 | 계약 |
| --- | --- |
| snapshot | 전체 message 순서/ID/text/replay/calls/results를 clone. 선택하지 않은 오래된 user image attachments만 제거 |
| requiredNotice | 생략이 있으면 assistant role의 quoted JSON 관측. 사용자 원문에는 marker를 덧붙이지 않음 |
| provenance | old message/session/run ID, source window ordinal, 원문 content SHA, 모든 old exact image refs |
| requiredTextMessageIds | snapshot 내 최초 goal, current 최초 user, current 최신 user |
| requiredExchangeMessageIds | current Run의 최신 complete assistant 및 contiguous call/result 묶음 |
| diagnostics | 정책/source SHA, source/retained/omitted occurrence, retained decoded bytes/unique ID 수, metadata/notice bytes |

source ordinal은 이 bounded snapshot 안에서의 순서이며 DB 전체의 journal ordinal이나 새 active cutoff가 아니다. 필수 goal/최신 user는 원문 text를 보존하는 요구이고, 오래된 goal의 픽셀까지 필수라는 의미는 아니다. 최신 image-bearing user의 모든 image refs는 항상 필수다. 최신 image-bearing user가 이전 Run에 있고 현재 Run은 text-only여도 최신 이미지 픽셀을 유지한다.

오래된 reference의 provenance는 `pixels: unavailable-in-this-request`, `summarized:false`, `currentFileEvidence:false`를 명시한다. Notice는 `permissionOrInstruction:false`, `pixelScope:historical-message-occurrence`를 갖는다. 같은 exact image가 최신 메시지에서 별도로 전송되는 경우 그 픽셀은 retained occurrence에 있다. 따라서 old occurrence를 생략했다는 관측을 동일 이미지의 픽셀이 요청 전체에 없다는 주장으로 바꾸지 않는다. `older-exact-reference` reason은 이 경우의 identity 관계만 표시하며 이미지의 의미나 모델이 본 사실을 추정하지 않는다.

source의 refs에 ID/hash/bytes/MIME 충돌이 있으면 old pixels를 생략해도 숨기지 않고 거부한다. session 불일치, duplicate message ID, invalid imported refs, 접근자, sparse arrays도 거부한다. 필요한 최신 픽셀이 상한을 넘으면 `IMAGE_HISTORY_REQUIRED_LIMIT`, 전체 provenance/notice를 byte budget에 넣을 수 없으면 `IMAGE_HISTORY_METADATA_LIMIT`을 반환한다. 부분 provenance나 일부 필수 픽셀만 남겨 성공하지 않는다.

opaque replay는 추론하거나 재작성하지 않는다. known image/audio/video-shaped replay는 imported image reference와 같은 예산으로 계산할 수 없으므로 정책 활성 시 `IMAGE_HISTORY_REPLAY_MEDIA_UNSUPPORTED`로 거부한다. 그 외 native reasoning/signature metadata는 원형 clone하고 문자열 속 단어를 이미지 의미로 해석하지 않는다. Replay를 plain transcript나 model-visible summary에 추가하지 않는다.

`metadataTokenEstimate`는 notice의 serialized UTF-8 bytes를 사용한 보수적인 텍스트 추정이다. `imageTokens:null`, `summarized:false`, `activeCutoffCreated:false`를 유지한다. 모델별 이미지 token window를 계산하거나 검증했다고 주장하지 않는다. 전체 context envelope/schema/output reserve와 실제 pixel byte cap은 기존 계층에서도 확인해야 한다.

## Root 연결 계약

Root 담당의 ContextService/ContextRequest/index/engine wiring은 구현 `59d1f42`에 연결됐다. 아래 계약을 실제 ContextService·SQLite 5개, 엔진 6회 입력·재시작 3개, 전체 headless gate와 Codex live 2회로 검증했다. 최신 결과는 [goal 검증](../engine-goal-verification.md)을 따른다. Projection module의 자체 fixture와 engine 연결 검증을 구분한다.

1. EngineOptions에 host-only policy를 두고 생성 시 validateMediaHistoryPolicy로 검증·복제한다. 모델 input, tool result, workspace instruction에서 이 정책을 활성화하지 않는다.
2. 각 safe turn boundary에서 원본 bounded snapshot으로 한 번 파생한다. 이미 attachments가 제거된 projected snapshot에 다시 적용하면 원래 omission provenance를 재구성할 수 없으므로 raw source를 재조회한다.
3. ContextRequest의 mediaHistoryNotice와 requiredHistoryMessageIds를 통해 notice 및 필수 text/complete exchange를 budget selection에 포함한다. Notice 자체가 선택적 오래된 assistant로 pruning되지 않게 required block으로 넣는다.
4. Plan의 selectedMessageIds는 projected message와 대응하되 원래 source message IDs·policy/source SHA·provenance를 diagnostics와 context binding에 기록한다. ContextRevision에는 refs/notice만 들어가고 raw bytes는 resolve 직전 host 경계에서만 공급한다.
5. Semantic summary와 overflow recovery는 원본 request를 사용한다. Media projection으로 attachments가 사라진 메시지를 text-only summary source라고 오인하여 기존 image source 거부를 우회하지 않는다.
6. 실제 dispatch는 retained exact refs만 session owner/hash 검증 후 resolve한다. Blob dedupe는 ID/hash/bytes/MIME가 동일한 기존 의미를 유지하고 transport frame cap을 늘리지 않는다.

같은 image ID를 반복한 다섯 요청에서 이 opt-in projection은 최신 occurrence 1개와 old occurrence 4개의 provenance를 만든다. Resolver에는 기존 blob 하나만 요구하며 새 import/blob를 만들지 않는다. 기본 policy가 없으면 다섯 occurrences는 그대로 남고 기존 request hard cap을 유지한다. SHA가 같다는 이유로 다른 imported IDs를 서로 바꾸거나 권한 identity를 합치지 않는다.

## 별도 active-prefix 기억 연결

이미지 projection 모듈 자체는 prefix text를 줄이거나 active cutoff를 만들지 않는다. 후속 `04031cb`에서 별도 host `activePrefixPolicy`와 원자 checkpoint를 실제 엔진에 연결했다. 이미지 policy를 텍스트 semantic checkpoint의 승인으로 해석하지 않는다. [active-prefix 계약·상한](../engine-active-prefix.md), [최신 실행 근거](../engine-goal-verification.md)를 따른다.

현재 active-prefix 계약은 exact typed text/tool projection의 source message IDs/ordinals/hash, prior checkpoint, Run/complete Turn/final Attempt owner, policy/provider/model identity와 input frontier를 고정한다. hash를 전체 opaque replay나 pixels까지 포함한 원문 hash로 표시하지 않는다. 최초 goal·최신 steer·image-bearing user·최근 complete exchange는 checkpoint 이후에도 원문 anchor로 남는다. 이미지를 실제로 해석한 provider call과 검증된 결과가 없는 경우 “이미지를 보았다”는 사실을 새 summary에 생성할 수 없다.

새 checkpoint는 live owner의 safe boundary에서 필수 byte/output/time 예산과 새 steer arrival을 다시 확인하고, 완전한 tool-free summary·ContextPlan·두 문서 CAS publication이 성공한 뒤에만 활성화된다. 취소·잘린 응답·revision conflict·정리 미확정은 기존 checkpoint를 유지한다. Summary는 과거 관측이며 현재 파일 fact나 승인 grant가 아니다. 이 문서의 최초 22개 media projection fixture를 semantic summary 품질 검증으로 확대하지 않으며, 후속 실제 20/50턴·overflow·취소·Codex 결과는 goal 보고서로 구분한다.

## 검증 범위

[독립 fixtures](../../../packages/engine/src/context/media-history.test.ts) 22개가 source와 별도 esbuild ESM bundle에서 각각 통과했다. 기본 policy clone, exact raw text/refs 불변, 5회 반복 frame 생략, 최신/pinned 필수 보호, count/decoded-byte/metadata 정확 경계, ref/session 충돌, complete pair와 opaque replay 보존, media-shaped replay 명시 거부, 취소, deterministic binding을 검증했다. Mocked Responses HTTP body에서 retained image frame 1개·원래 old user text·quoted notice가 함께 전송됨을 확인했다.

기존 context/agent context/tool history/media provider/media store/input-media review와 합친 source 143개가 모두 통과했고 engine noEmit도 통과했다. 검증은 macOS Darwin arm64/Node v26.9.0의 자체 fixture다. Root의 실제 엔진 wiring·integration fixture·Codex live는 위 최신 goal 보고서에 별도 근거로 기록했다. 공유 full build·전체 suite·커밋·외부 계정 호출·GUI 실행은 수행하지 않았다.
