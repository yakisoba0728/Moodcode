# Anthropic Messages provider

확인일: 2026-10-07. 구현은 Moodcode의 `ProviderAdapter` 계약을 사용하는 독립 HTTP/SSE adapter이며 Anthropic SDK나 OpenCode 코드를 가져오지 않는다. 테스트 데이터는 직접 작성한 가짜 protocol event와 loopback HTTP 응답이다. 실제 계정, 모델, API key를 사용한 호출이나 capability 검증은 수행하지 않았다.

## 사용과 host 경계

`AnthropicProvider`, `AnthropicProviderOptions`, `ANTHROPIC_PROVIDER_CAPABILITIES`, `anthropicModelSpec`을 export한다. provider 등록과 기본 공급자 선택은 engine host의 책임이다. 이 adapter 추가는 기본 provider를 바꾸지 않는다.

```ts
const provider = new AnthropicProvider({
  id: 'anthropic',
  apiKey: hostResolvedApiKey,
  maxTokens: 4096,
  thinking: 'adaptive',
  publicReasoningSummary: false,
});
const model = anthropicModelSpec(hostSelectedModelId);
```

API key는 host가 주입한 값만 사용하며 환경 변수, Codex/Claude 계정 파일, 브라우저 토큰을 탐색하지 않는다. 기본 API prefix는 `https://api.anthropic.com/v1`이며 host가 HTTPS 또는 loopback HTTP prefix를 명시할 수 있다. URL의 사용자명·암호·query·fragment와 redirect를 허용하지 않는다. key는 private field와 `x-api-key` header에만 두고 진단에 포함하지 않는다. 추가 host 비밀은 `redactionSecrets`로 지정할 수 있다. 요청에는 `anthropic-version: 2023-06-01`과 `stream: true`를 넣는다. 인증·Messages 요청 형태의 근거는 [Messages API](https://platform.claude.com/docs/en/api/messages/create)다.

요청마다 `modelId`가 필요하다. `maxTokens` 기본값 4096은 adapter의 요청 ceiling이며 특정 모델의 최대 출력 능력을 뜻하지 않는다. `anthropicModelSpec`은 실제 encoding 구현 범위인 text/image/client-tool/replay 및 host의 thinking 선택만 표시하고 `contextWindow`, `maxOutputTokens`는 `null`로 둔다. 실제 모델별 지원과 window 정보는 host가 별도 확인해야 한다. catalog 응답에서 제공하는 `max_input_tokens`와 `max_tokens`의 의미는 [Models API](https://platform.claude.com/docs/en/api/models/retrieve)에 명시돼 있으나 여기서는 catalog 호출을 하지 않는다.

## 메시지와 도구

현재 `ProviderMessage.content`는 문자열이다. 앞쪽 system 메시지는 top-level `system` text block으로 옮긴다. assistant의 정규화된 tool call은 `tool_use`로, tool 결과는 user 메시지의 `tool_result`로 보낸다. 연속된 같은 role은 합치며 여러 도구 결과가 있을 때 결과 block을 일반 user text보다 앞에 유지한다. tool result가 없는 call, 알 수 없는 result ID, 잘못된 role, 대화 중간 system, 마지막 assistant prefill은 dispatch 전에 거부한다.

도구 catalog에는 일반 client tool의 name/description/object input schema만 보낸다. server tool, computer use, server-side web search, code execution, MCP connector, compaction/fallback block은 이 adapter의 실행 계약에 포함하지 않는다. 알 수 없는 top-level metadata event는 byte 제한 안에서 무시하지만 알 수 없는 content block이나 delta는 명시적 오류다. 실행 권한과 실제 도구 효과는 기존 runtime/runner가 결정한다.

SSE에서는 `message_start` → content block start/delta/stop → `message_delta` → `message_stop`을 검증한다. `input_json_delta.partial_json`은 UTF-8 byte 한도 안에서 조립하고 종료 후 모든 call의 JSON object, ID, 이름을 검증한다. terminal stop, usage, replay 및 reader 정리가 확인된 뒤에만 `tool.call`과 `finish`를 내보낸다. 중간에 정상 call이 하나 있어도 뒤 call이 잘못됐으면 어느 call도 공개하지 않는다. 프로토콜과 누적 usage의 근거는 [Streaming messages](https://platform.claude.com/docs/en/build-with-claude/streaming)다.

2026-10-07에 user image reference와 dispatch 직전 resolved bytes의 별도 port를 추가했다. 검증된 이미지 입력은 base64 `image` source로 전송하고 텍스트 경로는 유지한다. [이미지 입력 경계](engine-input-media.md)에 owner/hash/MIME/budgets와 미검증 범위를 설명한다. 음성·영상·파일 입력과 모든 media output은 여전히 미지원이며 output block은 `PROVIDER_UNSUPPORTED_OUTPUT`이다. capabilities의 기존 `media: false`는 output media/생성 지원이 없음을 나타내며 `inputModalities`는 text/image encoding을 표시한다.

## 공개 reasoning과 native replay

기본 thinking 요청은 `adaptive` + `display: omitted`다. `publicReasoningSummary: true`일 때만 `display: summarized`로 요청하고 이 공개 요약을 `reasoning.delta`로 보낸다. 원문 thinking을 요청하는 manual enabled/budget 모드는 제공하지 않는다. omitted 계약에서 nonempty thinking text가 오면 요약으로 추정하지 않고 거부한다. legacy 모델은 host가 `thinking: disabled`를 고를 수 있지만 모델별로 adaptive 또는 disabled가 거부될 수 있다. 이 adapter는 모델 ID로 지원 여부를 추측하지 않는다. 공개 요약과 display 설정의 근거는 [Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)다.

`reasoningEffort`의 `low`, `medium`, `high`, `xhigh`, `max`는 `output_config.effort`에 같은 값으로 전달한다. `none`, `minimal`, `ultra`는 다른 수준으로 묵시 변환하지 않고 거부한다. 각 수준의 실제 모델 지원은 [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)의 모델별 계약을 따른다.

thinking block의 signature와 `redacted_thinking.data`는 암호화된 continuation 상태로만 취급한다. text/reasoning event, tool input, display/model-content projection, HTTP 진단에 내보내지 않는다. 완료된 응답의 `finish.replayItems`를 통해 기존 runner의 전용 `ProviderReplay` 저장 경로에 전달한다. 요약이 켜져 있으면 공개 요약만 thinking text로 저장하고 signature는 그대로 보존한다. provider ID + model ID + display/thinking별 protocol + version 1 binding이 모두 일치하고 replay의 정규화된 text/tool calls가 실제 저장 메시지와 같아야 재사용한다.

native replay는 text/tool_use/thinking/redacted_thinking의 제한된 필드만 받는다. 암호화 상태에 host 비밀이 포함돼 있거나 인증된 summary를 redaction으로 변경해야 하면 `PROVIDER_INVALID_REPLAY`로 거부한다. 암호화 상태를 임의로 고쳐 정상이라고 표시하지 않는다. 일반 text/tool JSON은 credential redaction을 적용하며 text block 경계에 걸친 비밀도 정규화된 공개 text와 replay가 같도록 처리한다.

도구 round trip에서 thinking/signature를 보존해야 한다는 근거는 [Thinking tool workflows](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows)다. 최신 일부 모델은 signature를 이전 system/tools/history prefix에 바인딩한다. Moodcode가 context를 요약하거나 도구 구성을 바꾸면 서버가 HTTP 400으로 replay를 거부할 수 있다. adapter는 원본 history를 숨겨 두거나 beta drop-block 정책을 몰래 적용하지 않는다. 해당 prefix 변경과 mode/protocol 변경의 host 정책은 후속 통합 범위다. 서버의 prefix binding 동작은 [API errors의 thinking block validation](https://platform.claude.com/docs/en/api/errors)에 설명돼 있다.

## usage, 종료와 실패

usage는 delta마다 더하지 않고 마지막 누적 값을 사용한다. `inputTokens`는 일반 `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`다. metadata가 요청됐을 때 `cachedInputTokens`에는 cache read만 넣는다. output에는 billed thinking도 포함될 수 있으므로 공개 요약 길이로 `reasoningOutputTokens`를 추정하지 않는다. usage 정의의 근거는 [Messages API usage](https://platform.claude.com/docs/en/api/messages/create)다.

| Anthropic stop_reason | Moodcode 결과 |
| --- | --- |
| end_turn, stop_sequence | finish stop |
| tool_use | 검증된 client tool call 후 finish tool_calls |
| max_tokens, model_context_window_exceeded | finish length; 부분 text는 유지하고 call/replay는 보류 |
| refusal | PROVIDER_CONTENT_FILTERED |
| pause_turn, 알 수 없는 값 | PROVIDER_UNSUPPORTED_FINISH_REASON |

`model_context_window_exceeded`는 성공 응답의 출력 truncation이며 요청 거절 오류와 구별한다. 서버 tool continuation을 나타내는 `pause_turn`은 일반 stop으로 바꾸지 않는다. 의미의 근거는 [Stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)다.

HTTP 오류는 remote message/body/cause를 제거하고 status 및 최대 60초 Retry-After만 유지한다. SSE의 rate-limit/api/timeout/overload type은 각각 429/500/504/529 HTTP 실패 계약으로 정규화한다. adapter의 `retryableHttpStatuses`는 `[429, 500, 503, 504, 529]`지만 자체 재시도는 없다. 기존 TurnExecutor가 첫 공개 event 이전의 실패, attempt budget, 취소, cleanup 확인에 따라 재시도한다. 출력 후 실패는 재시도해 중복 응답을 만들지 않는다. Anthropic 상태와 SDK retry 동작의 근거는 [API errors](https://platform.claude.com/docs/en/api/errors)다.

HTTP 400/413의 오류 본문은 최대 8192 byte만 검사하며 명시적 structured context overflow code가 있는 경우에만 `PROVIDER_CONTEXT_OVERFLOW`다. 일반 Anthropic `invalid_request_error`에는 원인별 code가 없을 수 있어, prose가 “prompt is too long”처럼 보여도 자동 요약/재시도로 추측하지 않고 HTTP 400을 유지한다. request-too-large 413도 context overflow로 취급하지 않는다. 모든 Anthropic 400을 자동 복구한다고 주장하지 않는다.

요청 timeout 기본 60초, cleanup 기본 1초, frame 256KiB, response 8MiB, request/replay 각각 2MiB, 전체 도구 argument 1MiB, 도구 128개, output block 256개다. JSON은 plain bounded data/depth/node 제한을 적용한다. caller abort, timeout, iterator return 모두 owned reader와 fetch signal을 정리하고 원래 caller의 abort listener를 제거한다. cancellation이 끝나지 않는 body는 제한 시간 뒤 `CLEANUP_UNCERTAIN`으로 보고하여 성공이나 executable call을 공개하지 않는다. host가 주입한 fetch 자체가 abort를 무시하면 늦게 도착한 response를 별도 정리하지만 원격 서버의 실제 처리 여부까지 보장할 수는 없다.

## 확인된 검증 범위

`anthropic.test.ts`의 synthetic fixture 53개가 macOS arm64 / Node 26.9.0에서 source 실행과 독립 JavaScript bundle 실행으로 통과했다. scoped engine noEmit typecheck도 통과했다. 한 loopback HTTP server fixture는 실제 POST/header/body/반복 요청의 stateless 동작을 확인한다. 나머지는 UTF-8/SSE byte split, 여러 JSON fragment, 전체 call validation, 부분/실패 종료, 공개 요약과 암호화 replay 분리, cache usage, credential redaction, HTTP/SSE 오류, bound, abort, timeout, reader cleanup, non-cooperative transport를 검증한다.

```sh
./node_modules/.bin/tsx --test packages/engine/src/provider/anthropic.test.ts
./node_modules/.bin/tsc -p packages/engine/tsconfig.json --noEmit
```

실제 Anthropic endpoint 호출, 모델 capability/catalog 확인, Linux/Windows 실행, GUI 통합, provider 기본값 변경은 이 검증에 포함하지 않는다. provider barrel 등록과 전체 engine 회귀는 root 통합 단계에서 수행한다.
