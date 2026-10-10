# 04 — 모델 공급자 구현

2026-10-04, Asia/Seoul. 초기·Responses 담당 범위는 `packages/engine/src/provider/**`와 이 보고서였고, 후속 Codex 인증 작업에서 `packages/engine/src/auth/codex.ts`와 해당 테스트가 추가되었다. 공유 contracts/ports, package 설정, facade, Git 상태 변경 명령, 의존성 설치는 수행하지 않았다.

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
| `baseURL` | `https://api.openai.com/v1`; API prefix에 `/chat/completions`를 붙임; `apiKey`가 있으면 HTTPS 또는 loopback HTTP만 허용 |
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

## Responses 후속 공급자 검증

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

## 기존 Codex 인증을 사용하는 후속 구현

사용자가 지정한 기존 Codex ChatGPT 인증을 사용하는 `provider/codex.ts`와 인증 helper `auth/codex.ts`를 추가했다. 공개 API는 `CodexProvider`, `createCodexProvider(options?)`, `CodexProviderOptions`, `getCodexAuthStatus(options?)`, `CodexAuthStatus`, `CodexAuthOptions`이다. 공급자 id는 `codex`로 고정한다. 내부 `createCodexCredentialReader`/`CodexCredential`은 engine facade에서 export하지 않는다. facade와 GUI 연결은 통합 담당 범위다.

공식 [Codex authentication](https://developers.openai.com/codex/auth), [SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [SIWC preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)를 검색한 뒤 페이지를 직접 확인했다. Codex 문서는 `auth.json` 또는 OS credential store와 Codex 자체의 토큰 갱신을 설명한다. 새 SIWC plan grant는 public Responses API 경로를 사용하므로 기존 Codex 로그인 토큰과 audience·경로가 같다고 가정하지 않았다.

설치된 Codex 0.160.0에 대응하는 공식 commit `a956835d020762cb2b570053af06f643a11c0ecc`의 [provider 선택](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/model-provider-info/src/lib.rs#L421)과 [응답 경로 결합](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/codex-client/src/provider.rs#L55)을 확인했다. 기존 ChatGPT 인증의 목적지는 **`https://chatgpt.com/backend-api/codex/responses`**로 고정했다. [인증 헤더](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/model-provider/src/bearer_auth_provider.rs#L31)를 따라 access token은 Authorization Bearer, account ID는 ChatGPT-Account-ID로만 전달한다. Moodcode 자체 attribution인 `originator:moodcode`, `User-Agent:Moodcode/0.1.0`을 사용한다. custom endpoint/baseURL/header/credential/id override를 거절하고 redirect를 금지한다. public API로 자동 fallback하지 않는다.

CodexProvider는 기존 ResponsesProvider를 turn마다 구성하는 private fetch wrapper다. 요청의 system input은 developer로 변환하고 `instructions:""`, `store:false`, `stream:true`, 전체 context의 input 배열, encrypted reasoning include를 보낸다. 빈 instructions와 developer input의 조합은 공식 [native client](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/client.rs#L902)에서 확인했다. 기존 standard route의 [flat function tool 테스트](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/tools/src/tool_spec_tests.rs#L119)에 맞춰 function tool 형식을 유지한다. wrapper로 커진 최종 요청도 byte limit을 다시 검사한다. Moodcode context, runner의 tool 실행·승인·agent loop와 `codex` replay binding을 그대로 사용하며 app-server/stdio agent loop를 실행하지 않는다.

인증은 `CODEX_HOME` 또는 `~/.codex`의 `auth.json`을 매 turn 다시 읽는다. auth_mode chatgpt만 사용하고 인증 파일에 쓰거나 refresh token을 교환·회전하지 않는다. 최대 128 KiB, regular file, symlink 거절/O_NOFOLLOW, open 전후 inode·device·크기·수정 시각 일치, 읽는 동안 취소, 엄격한 UTF-8·plain JSON·깊이 검증을 적용한다. access JWT의 exp를 로컬 힌트로 검사하되 서명/실제 계정 권한을 검증했다고 주장하지 않는다. missing/expired/unreadable/invalid/unsupported는 static `CODEX_AUTH_*` 오류이고 취소 reason·파일 경로·원본 오류는 공개하지 않는다. 인증 buffer는 정리 시 지운다. access/account/refresh/id 문자열은 private credential closure에만 두고 일반 JSON·inspect에 포함하지 않는다.

`getCodexAuthStatus()`는 `{state, modelId?}`만 반환한다. 기본 모델은 bounded local config의 top-level model 또는 모델 캐시의 valid slug에서 조회한다. 다른 config/cache 필드와 token/account 정보는 반환하지 않는다. 실제 로컬 조회에서 **`{"state":"ready","modelId":"gpt-6.1-sol"}`**만 출력했다. ready는 안전하게 읽을 수 있는 로컬 인증 상태이며 실제 inference entitlement 확인은 아니다.

ResponsesProvider에 private `redactionSecrets` 옵션을 추가해 access/refresh/id/account 문자열을 모두 기존 text/tool/replay 보호 경로에 적용했다. 도구 인자에 JSON escape로 표시된 credential도 가린다. opaque reasoning ciphertext에 어느 credential이든 포함되면 도구/finish 공개 전에 실패한다. bearer token은 HTTP header에만 넣으므로 기존 API key의 4 KiB 제한을 변경하지 않고 Codex 토큰은 최대 32 KiB까지 지원한다. 인증값을 DB/journal/renderer/log/테스트 파일에 기록하는 동작은 추가하지 않았다.

## Codex 후속 최종 검증

- `provider/codex.test.ts`: **33/33** 소스·컴파일 ESM 통과. 주입한 fetch만 사용해 고정 OpenAI 경로·헤더·요청, custom destination 거절, 5 KiB access token, turn마다 파일 재읽기와 무수정, auth 오류·취소, native lifecycle/usage/한도, 모든 credential의 text/tool/replay/ciphertext 보호, 두 turn의 reasoning/commentary/tool result/final_answer 재생을 검증했다.
- `auth/codex.test.ts`: **45/45** 소스·컴파일 ESM 통과. synthetic temporary auth/config/cache만 사용해 상태 metadata, 만료·형식·크기·regular file/symlink·취소, private credential inspection, refresh 파일 교체의 다음 use 반영, 모델 slug 선택·비밀값 필터를 검증했다.
- 공급자와 인증 전체: `node_modules/.bin/tsx --test packages/engine/src/provider/*.test.ts packages/engine/src/auth/*.test.ts`: **291/291 통과**, 실패/취소/skip 없음. 기존 213개도 변경 후 통과했다.
- 전체 provider/auth `.ts` 및 imported ports를 `--ignoreConfig --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2024 --module NodeNext --moduleResolution NodeNext --types node --rootDir packages/engine/src --outDir <temporary-directory>`로 컴파일했다. **엄격한 컴파일 통과**, 별도 ESM `node --test`로 **291/291 통과**. 최종 임시 검증 경로는 `/var/folders/zr/vy43gthn00q9wntc4xvs_k8h0000gn/T/moodcode-codex-verified-ucbfnzp0`이다. 공유 dist/config/npm/Git은 수정하지 않았다.

실제 모델·계정 inference 요청은 공급자 담당이 실행하지 않았다. 공식 runtime 경로와 local ready 상태를 확인했고 실제 모델 probe는 통합 담당이 수행한다. OS keyring-only 인증, 이 앱의 독립 로그인/refresh, 새 SIWC grant, custom proxy route는 이번 범위에 포함되지 않는다.

## 실제 Codex 응답 shape에 따른 호환성 수정

통합 담당의 실제 최소 모델 probe는 HTTP 200을 받았으나 기존 generic Responses 검증에서 `PROVIDER_MALFORMED_STREAM`으로 끝났다. 통합 담당이 원본 응답·토큰·헤더 값을 저장하거나 전달하지 않고 event key/type/status/배열 shape만 제공했다. 확인된 차이는 Content-Type 헤더 생략, message added의 `status:completed`와 빈 content, 모든 text/content/item done 뒤 terminal completed의 빈 `output:[]`였다. sequence·응답 status·item identity·완료 lifecycle은 제공된 형태대로 검증한다.

`ResponsesProvider.streamProfile:'codex'`를 제한적으로 추가했다. 이 profile은 id `codex`와 정확한 `https://chatgpt.com/backend-api/codex/responses`에서만 생성할 수 있다. CodexProvider 내부에서만 선택하고 호출자가 profile을 override하면 거절한다. generic/default/명시적 `responses` profile은 이전 검증을 유지한다. Codex profile은 Content-Type이 실제로 없을 때만 header 검사 예외를 적용하고, SSE bytes·JSON event·native lifecycle 검증은 그대로 수행한다. 명시적인 잘못된 Content-Type과 임의 JSON body를 받아들이지 않는다.

added의 `status:completed`를 허용해도 item이 done 상태가 되지는 않는다. `arguments.done`, `text.done`, `item.done`과 최종 lifecycle이 여전히 필요하다. completed terminal의 output이 비었을 때에만 모든 output index의 검증된 `item.done` snapshot을 원래 순서로 수집한다. snapshot 누락·index gap·incomplete item·잘못된 인자/identity는 계속 거절한다. terminal에 full output이 있으면 이전 snapshot/binding 검증을 수행한다. 수집한 native output도 기존 크기/JSON/credential/replay binding 검사를 통과한 뒤에만 도구와 finish를 반환한다. 일반 Responses 동작을 완화하지 않았다.

- Codex 테스트 **51/51** 통과: 18개 native-profile 회귀 사례를 추가했다. 관찰된 세 shape를 함께 재현하고 reasoning·phase·function replay 재구성, args/item done 이후에도 terminal 전 도구 미공개, full output 충돌, 잘못된/missing done, 일반 JSON 거절, 취소·reader 정리·한도·credential 보호를 확인했다.
- Responses 테스트 **139/139** 통과: 25개 strict/profile 회귀 사례를 추가했다. 기본 profile, Codex id/경로지만 profile 생략, 명시적 `responses` profile의 엄격한 header/status/output 검사와 codex profile의 origin/path/id/enum 제한을 확인했다.
- 공급자·인증 전체 소스 **334/334**, 별도 컴파일된 ESM **334/334** 통과. 실패/취소/skip 없음. 엄격한 ES2024/NodeNext compile도 통과했다. 최종 검증 경로: `/var/folders/zr/vy43gthn00q9wntc4xvs_k8h0000gn/T/moodcode-codex-native-verified-xd_6jcsc`.

후속 수정에서도 공급자 담당의 실제 인증/모델 계정 호출은 없었다. 관찰된 shape를 synthetic fixture로 재현했으며 실제 provider 재시도는 통합 담당이 수행한다.

## 통합 담당의 실제 모델 probe 결과

2026-10-04, Asia/Seoul. 통합 담당이 호환성 수정 후 실제 Codex 계정으로 최소 텍스트 probe를 재시도했고 다음의 sanitized 결과만 전달했다: authState `ready`, model `gpt-6.1-sol`, expected static sentinel `MOODCODE_OK`와의 정확한 일치 `verified:true`, normalized events 3개, `finish:stop`. 해당 모델·계정의 이 요청에서 완료 inference와 native stream 정규화를 확인했다. 토큰·계정 값·응답 원본을 공급자 담당에게 전달하거나 기록하지 않았고 인증 파일도 수정하지 않았다.

공급자 담당의 최종 로컬 검증은 소스·컴파일된 ESM 각각 **334/334 통과**와 엄격한 ES2024/NodeNext 컴파일 통과다. 이후 provider/auth 코드 변경이 없어 테스트를 반복하지 않았다. 통합 담당의 임시 Git fixture에서 자체 engine의 native read/patch/command 실호출 검증은 진행 중이며, 위 최소 텍스트 성공으로 그 tool flow까지 통과했다고 간주하지 않는다.
