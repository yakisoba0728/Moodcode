# 04 — 모델 공급자 구현

2026-10-04, Asia/Seoul. 담당 범위 `packages/engine/src/provider/**`와 이 보고서만 수정했다. 공유 contracts/ports, package 설정, facade, Git 상태 변경 명령, 의존성 설치는 수행하지 않았다.

## 구현 파일과 export

- `provider/index.ts`: `ScriptedProvider`, `ScriptedTurn`, `OpenAICompatibleProvider`, `OpenAICompatibleProviderOptions`, `ResponsesProvider`, `ResponsesProviderOptions`를 export한다.
- `provider/scripted.ts`: 고정 `ProviderAdapter` 구현. id는 `scripted`, 생성자는 선택적 `ScriptedTurn[]`. `request.turnIndex`로 시나리오를 선택하고 없으면 마지막 user prompt를 최대 160 Unicode code point로 확인하는 짧은 응답과 `finish:stop`을 반환한다.
- `provider/openai-compatible.ts`: 한 Chat Completions HTTP/SSE turn을 구현한다. 도구 실행, agent loop, 자동 재시도는 수행하지 않는다.
- `provider/responses.ts`: native Responses HTTP/SSE 한 turn과 stateless native output 재생을 구현한다.
- `provider/replay.ts`: native output의 JSON·한도·credential 보호와 normalized assistant 메시지의 일치 여부를 검증한다.
- `provider/helpers.ts`: 공통 JSON 검증, 문자열 credential redaction, 공개 오류 정규화를 공유한다.
- `provider/sse.ts`: 바이트 단위 SSE parser. 청크 경계와 UTF-8·BOM·LF/CR/CRLF, 여러 data line, comment/unknown field, 불완전 프레임을 처리한다. 프레임 한도를 CRLF의 두 바이트까지 적용하며, 줄 저장은 크기가 제한된 byte buffer를 사용한다.
- `provider/*.test.ts`: node:test 단위/로컬 HTTP fixture 테스트.

`ScriptedTurn`은 `{events: ProviderEvent[], delayMs?: number, error?: string}`이다. `delayMs`는 각 event 직전 지연이며 빈 turn에는 한 번 적용된다. `error`는 설정된 event 뒤에 발생하므로 partial 응답과 오류를 재현한다. `callCount`는 iterator 소비 전 `streamTurn` 호출 즉시 증가하고 실패·취소도 포함한다. 입력 fixture와 반환 event는 deep clone하여 다음 실행에 영향을 주지 않는다. AbortSignal은 pre-abort·지연 중·event 사이에 검사하며 원본 abort reason을 반영하지 않는다.

## HTTP adapter 구성과 동작

`new OpenAICompatibleProvider(options?)`의 options:

| 옵션 | 기본값 / 의미 |
|---|---|
| `baseURL` | `https://api.openai.com/v1`; API prefix에 `/chat/completions`를 붙임 |
| `apiKey` | 선택적 주입; 없으면 Authorization header 생략; 환경변수/계정 검색 없음 |
| `id` | `openai-compatible`; 안전한 짧은 식별자로 검증 |
| `fetch` | Node 내장 fetch; transport 실패 fixture 주입 가능 |
| `timeoutMs` | 60,000; HTTP 연결과 전체 stream에 적용 |
| `maxFrameBytes` | 262,144 |
| `maxResponseBytes` | 8,388,608; comment/unknown field도 포함 |
| `maxRequestBytes` | 2,097,152 |
| `maxToolArgumentBytes` | 1,048,576; turn 내 모든 call의 인자 문자열 합계 |
| `maxToolCalls` | 128 |

모든 한도는 양의 safe integer로 검증한다. 모델은 `request.modelId`를 그대로 사용하고 빈 값은 거절한다. POST에 `n:1`, `stream:true`, `stream_options.include_usage:true`를 설정한다. tool schema는 function 형식으로, assistant tool-call history와 tool result는 `tool_calls`/`tool_call_id`로 변환한다. redirect는 거절하며 response는 `text/event-stream`이어야 한다.

`text.delta`는 점진적으로 반환한다. tool delta는 index별로 조립하고, 모든 call의 ID·name·type·중복·완성된 JSON을 검증한 뒤 `tool.call`로 반환한다. `finish_reason`과 `[DONE]`가 모두 있어야 tool call과 마지막 `finish`를 공개한다. 이후 usage chunk를 읽기 위해 `finish_reason`만으로 stream을 종료하지 않는다. usage 미제공을 0으로 추정하지 않고 usage event를 생략하며, 일부 수치만 제공된 경우 제공된 필드만 보존한다.

text-only `length`는 `finish:length`로 반환한다. 도구 인자가 존재하는데 `tool_calls` 외 이유로 종료되면 도구 호출을 공개하지 않고 오류로 끝낸다. 불완전/잘못된 도구 JSON, 중복 ID, finish 후 새 choice, 다중 choice, finish/DONE 누락을 거절한다. `content_filter`와 deprecated/미지원 finish reason은 현재 port가 표현하지 못하므로 명시적 오류로 반환한다.

취소·timeout·소비자 iterator 종료 시 fetch와 reader를 취소하고 listener/timer를 정리한다. 서버 응답 본문·statusText·원본 transport/decoder 오류·cause·abort reason은 공개 오류에 포함하지 않는다. HTTP 오류에는 숫자 status만 남긴다. API key는 JS private field에만 보관하며 요청 JSON에 넣지 않는다. 서버가 주입된 정확한 key를 반환하는 경우 text의 delta 경계와 완성된 도구 문자열/JSON key에서 통상 `[REDACTED]`로 가린다. 치환 표시 내부나 경계에서 짧은 synthetic key가 다시 나타날 수 있으면 ASCII key를 포함하지 않는 `█`를 사용한다. 가린 뒤 중복되는 도구 ID도 공개 전에 거절한다. 이는 주입된 정확한 key 문자열의 보호이며 모든 종류의 비밀값/변형 인코딩을 탐지하는 기능은 아니다.

주요 `EngineError.code`는 `PROVIDER_HTTP_ERROR`, `PROVIDER_TRANSPORT_ERROR`, `PROVIDER_REMOTE_ERROR`, `PROVIDER_CANCELLED`, `PROVIDER_TIMEOUT`, `PROVIDER_MALFORMED_STREAM`, `PROVIDER_INCOMPLETE_STREAM`, `PROVIDER_LIMIT_EXCEEDED`, `PROVIDER_INVALID_CONFIG`, `PROVIDER_INVALID_REQUEST`, `PROVIDER_CONTENT_FILTERED`, `PROVIDER_UNSUPPORTED_FINISH_REASON`이다.

## Responses 후속 구현

`new ResponsesProvider(options?)`는 기존 HTTP 구성 옵션과 같은 기본 한도를 사용한다. 기본 id는 `openai-responses`, endpoint는 API prefix의 `/responses`이며 `maxOutputItems`의 기본값은 256이다. 요청은 명시적인 `request.modelId`, `stream:true`, `store:false`, `include:['reasoning.encrypted_content']`를 사용한다. 사용자·system 텍스트는 role/content, assistant 호출은 native `function_call`, tool 결과는 `function_call_output`으로 변환한다. function tool 정의는 Responses의 flat 형식이며 `strict:false`로 optional schema 필드를 보존한다.

`response.created`와 필요 시 `response.in_progress`, output item/text/refusal/function argument delta와 done, item done, `response.completed`/`response.incomplete`를 처리한다. event의 item ID·output/content index·선택적 sequence number와 terminal snapshot을 검사한다. tool call은 arguments done·item done·완료 lifecycle·전체 인자의 유효한 JSON·usage·replay 검증을 모두 통과한 후에 공개한다. native lifecycle 종료를 사용하므로 Chat Completions `[DONE]`는 요구하지 않는다. text-only max-output-token 종료는 `finish:length`이고 replay를 내보내지 않는다. 잘못된 lifecycle/사용량, 불완전 tool call, content filter, 미지원 output/event는 명시적 오류다. 취소·timeout·reader 정리와 공개 오류의 privacy 정책은 기존 HTTP adapter와 같다.

완료 `finish.replayItems`는 `response.output` 전체를 원래 순서로 반환한다. message의 id/type/phase/content, function call의 id/call_id/name/arguments, reasoning의 summary/content/encrypted_content와 추가 JSON 필드를 보존한다. JSON 깊이·UTF-8 직렬화 크기·item/도구 수·인자 합계·중복 ID를 검사하고 입력 객체와 공유되지 않도록 복제한다. JSON getter/toJSON hook, 잘못된 phase/status/content, 비정상 JSON 인자, redaction 뒤 ID/key 충돌도 거절한다. tool 인자는 JSON escape로 표현된 정확한 API key도 파싱 후 가리며, 변경이 없으면 원래 인자 문자열의 공백·표현을 유지한다. opaque encrypted_content에 주입된 key가 실제로 포함되면 ciphertext를 손상시키지 않고 `PROVIDER_INVALID_REPLAY`로 실패한다. 여러 native text part/item에 걸쳐 credential을 구성하는 경우에도 public text는 가려지고 replay binding 불일치로 도구/finish를 공개하지 않는다.

통합 담당이 추가한 `Message.providerReplay`/`ProviderMessage.providerReplay` 계약을 사용한다. assistant의 `providerReplay.providerId`가 이 adapter의 id와 같으면 bounded replay item과 normalized text/tool call의 일치 여부를 검증한 뒤 native input으로 직접 사용한다. 다른 provider의 replay는 normalized history로 변환한다. 같은 provider의 잘못된 replay는 HTTP 호출 전에 실패한다. `previous_response_id`, conversation, SDK agent loop, 공급자 서버에 저장된 대화 상태는 사용하지 않는다. 최상위 response ID는 stream 일치 검사에만 사용하고 replay에 저장하지 않는다. durable message에 replay를 붙이고 다음 context로 전달하는 작업은 통합 runner/context 담당 범위다.

## 초기 Chat Completions/Scripted 구현 검증

- Node v26.9.0에서 `node_modules/.bin/tsx --test packages/engine/src/provider/scripted.test.ts`: 13/13 통과.
- `node_modules/.bin/tsx --test packages/engine/src/provider/sse.test.ts`: 8/8 통과. 모든 UTF-8/BOM/CRLF 분할 지점, 1 byte 청크, 여러 data line, CR/LF, EOF 미완성, 잘못된 UTF-8, comment 포함 byte 제한, reader 취소·정리를 검증했다.
- 별도 검토 fixture에서 mixed CR/LF/CRLF parser를 문자열 기반 reference와 9,305개 분할 경계에 대해 비교했다. 큰 UTF-8 줄/EOF fixture, 비밀값을 담은 주입 EngineError 13종도 통과했다. 이 검토 fixture는 `/tmp`에서 실행했고 repository에는 추가하지 않았다.
- `node_modules/.bin/tsx --test packages/engine/src/provider/openai-compatible.test.ts`: 실제 로컬 `node:http` server와 injected fetch를 사용하는 34/34 테스트 통과. 요청 직렬화, 점진적 text/완성된 병렬 tool arguments, DONE 전 call 미공개, 부분 usage/usage 미제공, 비밀값을 포함한 HTTP body·statusText·transport 오류·abort reason, malformed/incomplete stream, 제한 초과, timeout·취소·소비자 조기 종료 시 연결 종료를 검증했다.
- `node_modules/.bin/tsx --test packages/engine/src/provider/*.test.ts`: 전체 공급자 테스트 55/55 통과, 실패/취소/skip 없음.
- 공급자 index/source/tests의 별도 타입 검사: `node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext --types node packages/engine/src/provider/index.ts packages/engine/src/provider/openai-compatible.test.ts packages/engine/src/provider/sse.test.ts packages/engine/src/provider/scripted.test.ts` 통과. HTTP 테스트의 asynchronous mutation assertion narrowing과 iterator.return 인자를 수정했으며 ES2023에서도 컴파일된다. 통합 root가 target을 ES2024로 올려도 호환된다. 전체 monorepo build는 통합 담당 범위다.

## 최종 공급자 검증

- `node_modules/.bin/tsx --test packages/engine/src/provider/*.test.ts`: **213/213 통과**, 실패/취소/skip 없음. 기존 Chat Completions 34, Scripted 13, SSE 8에 Responses 114, native replay 18, 공통 redaction 26을 더한 결과다.
- Responses 114개는 실제 로컬 `node:http` server와 injected fetch만 사용했다. flat 요청 변환, native lifecycle 종료, 점진적 text/refusal, interleaved tool 인자와 완료 조건, 부분/missing usage, malformed/unsupported/incomplete stream, UTF-8·UTF-16 경계와 모든 한도, timeout·취소·소비자 조기 종료, HTTP/transport/abort 오류의 비밀값 보호를 검증했다. 두 번의 HTTP 호출에서 native reasoning과 commentary phase/function call을 재생하고 tool output 뒤 final_answer phase를 보존했다. foreign replay fallback, same-provider binding 충돌의 HTTP 전 거절, unsafe ciphertext의 도구 공개 전 거절도 통과했다.
- replay 18개는 native item의 순서·필드·phase·ciphertext 보존과 복제, JSON-only 객체 및 getter/toJSON 거절, cycles/prototypes/depth/정확한 UTF-8 직렬화 크기, 누락/잘못된 한도, secret redaction 뒤 재검증, ID/key 충돌, JSON escape credential, normalized call binding을 검증했다. `1e20` 등의 짧은 숫자 지수 표현이 canonical JSON에서 더 길어지는 경우도 통과했다.
- redaction 26개는 통상 marker 호환성, marker에 포함되는 짧은 synthetic key와 bracket key, 모든 문자열 분할 경계·문자 단위 청크, 보류된 prefix flush, JSON key/value·충돌·own `__proto__` 처리를 검증했다.
- 전체 공급자 `.ts`와 가져온 ports를 별도 temporary directory로 엄격하게 컴파일했다: `node_modules/.bin/tsc --ignoreConfig --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2024 --module NodeNext --moduleResolution NodeNext --types node --rootDir packages/engine/src --outDir <temporary-directory> packages/engine/src/provider/*.ts`. **컴파일 통과**. 임시 디렉터리에 `type:module` package metadata와 기존 `node_modules` 링크를 만든 뒤 `node --test <temporary-directory>/provider/*.test.js`: **213/213 통과**, 실패/취소/skip 없음. 최종 검증 디렉터리는 `<temporary-directory>`이다. 공유 dist/config와 monorepo build는 변경하지 않았다.

## 근거 문서와 범위 제한

OpenAI Docs 스킬을 사용해 공식 [Chat Completions reference](https://developers.openai.com/api/reference/resources/chat), [streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses), [function-calling streaming guide](https://developers.openai.com/api/docs/guides/function-calling#streaming)를 직접 확인했다. 공식 chunk의 delta, tool-call index별 인자 조립, 별도의 usage chunk와 `[DONE]` 순서를 기준으로 구현했다.

후속 구현은 공식 [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events), [Responses create reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create), [function calling guide](https://developers.openai.com/api/docs/guides/function-calling), [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)를 확인했다. lifecycle event, flat function 정의, stateless reasoning 재생과 assistant phase 보존을 반영했다.

실제 공급자/API 계정 호출·모델별 지원·인증 성공은 검증하지 않았다. 실제 API key를 찾거나 외부 유료 endpoint를 호출하지 않았다. 멀티모달·built-in hosted tool output·deprecated function_call·여러 choice·JSON nonstream fallback은 이 구현에 포함되지 않는다. 고정 `TurnRequest`에 model option 필드가 없어 temperature/max_tokens 등의 임의 옵션은 추가하지 않았다. capability 자동 추정이나 공급자별 fallback/재시도도 없다.

공유 replay schema/port 및 public engine facade 변경은 통합 담당이 수행했다. 공급자 담당은 위 공유 파일을 직접 수정하지 않았다.
