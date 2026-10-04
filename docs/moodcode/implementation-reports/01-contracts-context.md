# 01 계약 검증·Context 구현 보고서

2026-10-04, Asia/Seoul. 담당 구현과 scoped 검증을 완료했다. 고정 contracts/ports, package 설정, facade와 다른 담당 경로는 수정하지 않았다.

## 구현 파일과 export

- `packages/contracts/src/validation.ts`: `validateCommand(value: unknown): CommandEnvelope`, `normalizeSubmitInput(value: unknown): SubmitInput`.
- `packages/contracts/src/validation.test.ts`: 계약 검증 테스트 11개.
- `packages/engine/src/context/index.ts`: `buildContext(request: ContextRequest): Promise<ProviderMessage[]>`.
- `packages/engine/src/context/context.test.ts`: context 테스트 39개(예약 용량 회귀 7개와 native replay 회귀 11개 포함).

통합 담당자가 contracts public entry에 `export { validateCommand, normalizeSubmitInput } from './validation.js';`를 추가하고 facade에서 context entry를 연결하면 된다. validation은 public entry의 re-export와 순환하더라도 top-level에서 `DEFAULT_LIMITS`를 읽지 않도록 구현했다. 초기 구현은 공통 타입/API 변경 없이 완료했고, 후속 통합 오류 수정에는 통합 담당자가 추가한 optional `ContextRequest.reservedBytes`를 사용한다.

## 입력 검증

9개 명령을 고정 facade payload와 같은 필드 목록으로 검증한다: `workspace.open`, `session.create`, `session.list`, `session.getSnapshot`, `run.submit`, `run.cancel`, `approval.decide`, `review.getDiff`, `events.subscribe`.

JSON object envelope·schemaVersion=1·비어 있지 않은 command ID·명령별 required/optional field를 검사한다. 알 수 없는 envelope/payload/config/limits 필드, 배열·class instance·getter·symbol·숨겨진 필드, 잘못된 문자열·enum·숫자와 NUL을 거절한다. 직접 JS 호출의 revoked/throwing Proxy도 고정 메시지의 `EngineError`로 변환한다. null-prototype JSON object는 허용하며 own data property만 복사한다.

`run.submit` config 누락과 생략된 config 하위 필드는 providerId=`scripted`, modelId=`local`, mode=`plan`, `DEFAULT_LIMITS`로 채운다. 부분 limits도 기본값과 병합한다. 명시적 undefined/null은 JSON 입력으로 허용하지 않는다. prompt 원문·공백을 유지하고 config/limits의 새 객체를 생성한다. 기본값을 생략한 입력과 명시한 입력, config key 순서가 다른 입력은 같은 정규화 JSON을 만든다. `events.subscribe.afterSeq` 누락은 0이다.

오류 코드는 `INVALID_INPUT`, `UNKNOWN_COMMAND`, `UNSUPPORTED_SCHEMA_VERSION`이다. details는 고정 schema path만 포함하고 입력값·알 수 없는 필드 이름·native reflection 오류 원문은 복사하지 않는다. API key 전용 필드나 credential 저장/로그 경로를 추가하지 않았다.

문자열 한도는 UTF-8 bytes 기준으로 ID·title·provider/model ID 256, workspace path 4,096, prompt 131,072, approval fingerprint 512다. ID/title/identifier/fingerprint는 제어문자를 거절한다. budget은 각각 1 이상인 safe integer이며 다음 상한을 적용한다.

| Budget | 상한 |
|---|---:|
| maxTurns | 128 |
| maxToolCalls | 1,024 |
| maxDurationMs | 3,600,000 |
| toolTimeoutMs | 600,000 |
| maxOutputBytes | 1,048,576 |
| maxContextBytes | 4,194,304 |

전체 Run deadline과 도구 timeout은 별개의 한도이므로 둘 사이의 대소 관계를 강제하지 않는다. deadline을 더 작게 설정해도 나머지 기본값이 유지된다. 실제 남은 시간과 tool timeout의 결합은 runner 책임이다. `afterSeq`는 0~`Number.MAX_SAFE_INTEGER`다. 이 상한은 현재 구현의 구체적 정책이며 향후 구성 가능한 정책으로 확장할 수 있다.

## Context 동작

저장 messages를 순서대로 provider message로 변환한다. assistant tool calls와 바로 뒤의 tool results를 하나의 블록으로 취급하며 call ID·동일 session/Run·완전한 결과 집합을 검사한다. 잘못되거나 미완료된 호출은 tool metadata/result를 내보내지 않고 assistant 설명 텍스트만 유지한다. orphan·다른 session/Run·중복 결과를 제외하며, 이미 완성된 블록 뒤의 orphan이 정상 결과를 삭제하지 않는다. tool input은 유한 JSON 값만 깊은 복사하고 cycle·과도한 깊이를 거절한다.

컨텍스트는 provider messages 배열 전체를 JSON으로 직렬화한 UTF-8 bytes를 계산한다. role·content·tool call/result ID·tool input·JSON escaping과 배열 구분자도 포함한다. 통합 후 추가된 `ContextRequest.reservedBytes?: number`로 runner가 도구 스키마와 wrapper 용량을 예약하면 실제 message 한도는 `config.limits.maxContextBytes - reservedBytes`다. 예약 생략은 0이며, 음수·소수·비유한 값·safe integer가 아닌 값·runtime 비숫자는 `CONTEXT_LIMIT`로 거절한다. 예약 후 message 배열 최소 2 bytes도 남지 않으면 즉시 실패한다. 원본 config는 변경하지 않는다.

runner의 예약 계산은 `Buffer.byteLength(JSON.stringify({messages: [], tools: schemas}), 'utf8') - 2`다. 빈 배열 2 bytes를 제외한 값이므로 `messages JSON bytes + reservedBytes`가 최종 `{messages, tools}` bytes와 정확히 일치한다. 최신 요청+schemas가 충분히 들어갈 때 오래된 history를 더 줄여 첫 provider 호출 전의 불필요한 budget 실패를 방지한다.

최근 user와 그 뒤의 모든 정상 assistant/tool 블록은 현재 요청의 필수 suffix다. 이 suffix가 예약 후 한도를 넘으면 `CONTEXT_LIMIT`로 실패하며 이미 실행한 tool result를 잘라 재실행을 유도하지 않는다. 남는 용량에 project instructions와 오래된 history suffix를 넣고, 이전 tool 블록은 통째로 제거한다. mandatory overflow 오류 details는 원래 `maxContextBytes`, `reservedBytes`, 남은 `availableContextBytes`, message의 `requiredBytes`를 구분한다.

workspace root `AGENTS.md`만 읽는다. raw read와 최종 system content를 각각 최대 32 KiB로 제한하고, 전체 context 여유가 적으면 codepoint 경계를 지킨 instruction prefix와 truncation 표시를 넣는다. 파일이 없거나 비정규 파일·symlink이면 생략한다. open에 `O_NOFOLLOW | O_NONBLOCK`을 사용하며 lstat/open의 inode/dev를 재확인한다. NUL이 포함된 instruction 파일은 생략한다. nested AGENTS는 읽지 않는다.

AbortSignal을 구성 시작·history 순회·파일 await 전후·반환 직전에 확인하고 `CANCELLED`로 실패한다. workspace/session 불일치는 `INVALID_CONTEXT`, 예상하지 못한 instruction I/O나 파일 교체는 `CONTEXT_INSTRUCTIONS`다. 메시지 내용이나 native I/O 오류 원문을 에러에 복사하지 않는다.

## 실제 검증

환경: macOS, Node `v26.9.0`. 설치되어 있는 local tsx/TypeScript만 사용했고 의존성 설치·외부 provider 호출·실제 credential 탐색은 하지 않았다.

```sh
node_modules/.bin/tsx --test packages/contracts/src/validation.test.ts packages/engine/src/context/context.test.ts
```

초기 공동 검증 결과: **32 passed, 0 failed, 0 skipped**. validation 11개, context 21개. 기본값·필드 순서·부분 limits·각 상한/상한+1·UTF-8 경계·getter/Proxy·비밀값 sentinel 미노출, 정상 tool 연결·다른 Run/session·중복/orphan·완성 블록 뒤 orphan, 현재 요청/tool suffix 보존·이전 블록 단위 제거·정확한 JSON byte 경계·큰 AGENTS·외부 symlink·사전 취소·입력 불변성을 확인했다.

```sh
node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/contracts/src/validation.ts packages/contracts/src/validation.test.ts packages/engine/src/context/index.ts packages/engine/src/context/context.test.ts
```

최종 결과: **exit 0**. 전체 monorepo build와 facade/runner 통합 검증은 통합 담당자에게 남겼다. TypeScript 7은 command-line 파일 검사 시 `--ignoreConfig`가 필요하다.

### 후속 통합 수정: 도구 스키마 용량 예약

messages 배열만 기존 budget에 맞추면 runner의 `{messages, tools}` 검사에서 첫 provider 호출 전에 실패하는 경우를 재현했다. 현재 요청+tools는 충분히 들어가지만 오래된 history를 더 줄여야 하는 경우다. `reservedBytes`를 먼저 검증·차감한 뒤 기존 instruction/history fitting을 수행하도록 변경했다. 실제 wrapper 예약 공식과 UTF-8 schemas를 사용하는 회귀 테스트에서 예약 전 object overflow와 예약 후 정상 범위 진입을 확인했다.

```sh
node_modules/.bin/tsx --test packages/engine/src/context/context.test.ts
node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/engine/src/context/context.test.ts
```

후속 결과: **context 28 passed, 0 failed, 0 skipped; scoped TypeScript exit 0**. 기존 21개를 유지하고 다음 회귀 7개를 추가했다.

- 예약 생략·명시적 undefined·0의 동일 동작과 frozen config 불변성.
- UTF-8 tool schema+wrapper 실제 용량 예약 후 오래된 history를 줄여 전체 object를 한도 안에 유지.
- 최신 user가 들어가는 정확한 남은 byte 경계와 1 byte 부족한 오류/details.
- 음수·소수·NaN·Infinity·string·null·boolean·object·unsafe integer 예약값 거절.
- 빈 messages 배열도 최소 2 bytes 필요하며 예약이 전부 소진한 경우 실패.
- 예약 후 남은 공간에 `AGENTS.md` 지침을 줄이고 최신 user를 유지.
- 현재 user+완전한 tool 그룹의 정확한 경계와 1 byte 초과 시 실패하며 그룹 전체 보존.

이 후속 작업에서는 runner·ports·공통 설정을 수정하지 않았다. runner가 동일 catalog로 예약을 전달하는 변경과 다음 전체 suite는 각 담당자/통합 담당자가 검증한다.

## 범위와 한계

- provider messages 출력 bytes를 제한하고 호출자가 `reservedBytes`로 도구 스키마·wrapper 공간을 예약한다. 실제 schemas와 동일한 예약 계산은 runner 책임이다. 공급자별 wire encoding/token 수는 이 JSON budget과 별개다.
- 고정 SubmitInput에는 attachment가 없으며 root instruction만 지원한다. nested instruction 우선순위와 summarization은 추가하지 않았다.
- 필수 current suffix가 커지면 압축·부분 절단 대신 실패한다. 이는 실행 결과를 보존하기 위한 의도적인 동작이다.
- 파일 읽기는 작은 고정 buffer로 제한하고 await 전후 취소를 확인한다. 진행 중 kernel file read 자체에 AbortSignal을 전달하지 않는다.
- macOS local fixtures에서 검증했다. Windows, FIFO 교체 race·동시 파일 교체·mid-read 취소를 강제로 재현한 검증, 실제 supplier API는 수행하지 않았다.
- snapshot 전체 history를 순회한다. 아주 큰 세션의 DB pagination·요약·메모리 최적화는 별도 작업이다.
- API key 형태의 전용 필드는 거절한다. 일반 prompt와 프로젝트 지침은 사용자 텍스트로 취급하며 credential 추정·redaction 기능은 포함하지 않는다.

## 추가 단계: layered config service

신규 소유 경로는 `packages/engine/src/config/**`다. `index.ts`에서 다음 API와 타입을 export한다.

```ts
loadConfig(options?: LoadConfigOptions): Promise<ResolvedConfig>
interface LoadConfigOptions {
  userConfigPath?: string;
  workspaceConfigPath?: string;
  signal?: AbortSignal;
}
interface ResolvedConfig {
  readonly runConfig: ResolvedRunConfig;
  readonly providers: Readonly<Record<string, ConfigProviderMetadata>>;
}
```

`ConfigFile`, `ConfigProviderMetadata`, `ResolvedRunConfig`도 export한다. JSON 파일 형식은 실행 설정과 provider 메타데이터를 분리한 다음 구조다.

```json
{
  "providerId": "openai-compatible",
  "modelId": "explicit-model",
  "mode": "plan",
  "limits": { "maxTurns": 4 },
  "providers": {
    "openai-compatible": {
      "baseURL": "https://example.invalid/v1",
      "apiKeyEnv": "MOODCODE_API_KEY"
    }
  }
}
```

우선순위는 defaults < user file < workspace file다. 각 파일을 독립적으로 검증한 후 병합하므로 잘못된 하위 파일이 상위 override에 가려지지 않는다. 실행 설정은 `@moodcode/contracts/validation`의 `normalizeSubmitInput`을 재사용한다. limits와 provider별 metadata는 필드 단위로 병합하며, final runConfig/limits/providers/각 metadata/result를 모두 freeze한다. provider map은 null-prototype이어서 `__proto__`, `constructor` 같은 유효 ID도 일반 own key로 보존한다.

설정 경로는 명시적으로 받은 값만 사용하고 상대 경로는 현재 cwd를 기준으로 resolve한다. `~`·환경변수 확장·기본 설정 파일 탐색·파일 생성은 하지 않는다. 파일이나 부모가 존재하지 않으면 해당 layer 없이 기본값을 사용한다. 파일과 모든 부모의 symlink, 비정규 파일, 비-directory 부모는 거절한다. macOS `/var`처럼 symlink인 시스템 경로도 거절하므로 호출자가 canonical 경로를 전달해야 한다.

각 파일의 stat과 실제 read를 65,536 bytes로 제한하고 MAX+1 buffer로 읽는 도중 커진 파일도 감지한다. open에는 `O_NOFOLLOW | O_NONBLOCK`을 사용하고 inode/dev·읽기 전후 size/mtime/ctime·부모 경로를 재확인한다. UTF-8은 fatal decoding 후 JSON.parse하며 invalid UTF-8/JSON의 native 오류 원문을 반환하지 않는다. 실제 파일 읽기 전후와 layer 경계에서 AbortSignal을 확인하고 열린 handle은 finally에서 닫는다. signal은 native brand를 확인하고 자체 getter override 대신 native aborted getter로 읽는다.

provider metadata는 `baseURL`, `apiKeyEnv`만 허용한다. baseURL은 최대 2,048 UTF-8 bytes의 HTTP(S) URL이고 username/password/query/fragment를 거절한다. apiKeyEnv는 최대 128자의 ASCII 환경변수 이름이다. provider ID는 계약의 identifier 검증을 재사용하며 파일별·resolved provider 수는 최대 64개다. credential 원문 필드와 알 수 없는 필드는 거절한다. `process.env`를 조회·변경하지 않고 provider 생성·네트워크 호출·값 실행·DB 저장도 하지 않는다.

오류는 기존 `EngineError`이며 code는 `CONFIG_INVALID`, `CONFIG_JSON`, `CONFIG_FILE_LIMIT`, `CONFIG_FILE_TYPE`, `CONFIG_IO`, `CANCELLED`다. details는 source=`options`/`user`/`workspace`와 고정 schema field만 포함한다. 입력 값·알 수 없는 key/provider 이름·설정 파일 경로·native 오류 원문을 복사하지 않는다.

root integration: engine public entry에 config export를 연결하고 `createEngine({ ..., defaults: resolved.runConfig })`로 전달할 수 있다. CLI의 명시적 override 우선순위와 provider adapter factory/credential 환경변수 조회는 통합 담당자가 별도로 연결한다. 이 단계에서는 public contracts·ports·root facade·package 설정을 수정하지 않았다.

### Config 실제 검증

`packages/engine/src/config/config.test.ts`에 실제 임시 files를 사용하는 테스트 22개를 추가했다. 실행은 설치되어 있는 local tsx/TypeScript와 Node `v26.9.0`으로 수행했다.

```sh
node_modules/.bin/tsx --test packages/engine/src/config/config.test.ts
node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/engine/src/config/config.test.ts
```

결과: **22 passed, 0 failed, 0 skipped; strict TypeScript exit 0**. defaults/파일 미존재/빈 JSON object, 필드별 deep merge와 원본 파일 불변성, invalid 하위 layer, budget 상한과 초과, unknown/credential fields, prototype ID, provider 수 64개, UTF-8 정확한 65,536 byte 경계, invalid UTF-8/JSON, URL 인증/query/fragment 거절, env-name 경계, 실제 env sentinel 조회/쓰기 0회, 파일값 미실행, direct/parent symlink·directory·FIFO·비-directory 거절, native I/O 메시지 redaction, 상대 경로, malformed options와 native signal brand, accessor 비실행, await 경계 취소를 확인했다. FIFO는 macOS `mkfifo`로 실제 생성하여 검증했고 fixture는 모두 정리했다.

별도로 scoped source/tests를 `--rootDir packages/engine/src --outDir .tmp-config-tests.OFRDk6`와 위의 strict compiler 옵션으로 emit하고 다음 명령을 실행했다.

```sh
node --test .tmp-config-tests.OFRDk6/config/config.test.js
```

결과: **emit exit 0; compiled tests 22 passed, 0 failed, 0 skipped**. 이 컴파일러만 만든 임시 출력 디렉터리는 이후 제거했고 부재를 확인했다. 공유 dist/package/root build 설정은 변경하지 않았다.

추가 단계 한계: 부모 검사와 file open은 Node의 경로 기반 API이므로 동시에 ancestor 디렉터리가 교체되는 상황의 원자적 차단을 보장하지 않는다. 개별 file identity와 경로 재검사로 일반적인 교체를 감지한다. 진행 중 kernel file I/O 자체를 AbortSignal로 취소하지 않고 bounded await 전후에 확인한다. Windows와 강제 race 재현은 별도 검증 대상이다. provider URL path·provider/model ID 같은 허용된 일반 문자열을 credential로 추정하거나 redaction하지 않으며, 전용 credential 값 필드는 지원하지 않는다.

## 추가 단계: native provider replay context

통합 담당자가 추가한 `ProviderReplay { providerId, items: JsonObject[] }`와 `Message/ProviderMessage.providerReplay`를 context에서 연결했다. context entry/public API는 그대로이고 config service와 함께 담당 경로만 수정했다. provider adapter·runner·storage 연결은 다른 담당자가 소유한다.

완료된 assistant text 및 완전한 assistant tool-call/result 블록에서, 현재 선택된 `request.config.providerId`와 replay providerId가 같으면 opaque output items를 깊은 복사하여 전달한다. item array 순서·phase·encrypted content·알 수 없는 미래 item field·중첩 JSON을 변경하지 않는다. 빈 items와 빈 assistant text도 유효한 replay를 보존한다. 이 metadata 전체가 기존 JSON byte budget 및 reservedBytes 계산에 포함된다. 큰 현재 encrypted state가 한도를 넘으면 `CONTEXT_LIMIT`이고, 이전 블록은 tool 결과와 replay를 함께 통째로 제거한다.

toolCalls가 dangling·불완전·잘못된 형태라 provider-visible 호출을 제거할 때는 해당 assistant의 replay 전체도 제거한다. reasoning/function-call native 조각만 남기는 fallback은 하지 않는다. 설명 text는 기존 정책대로 남긴다.

다른 provider의 유효 replay는 metadata 검증 후 output에서 완전히 제외한다. 따라서 암호화된 native state를 다른 transport에 전달하거나 byte budget으로 계산하지 않고 normalized text/tool-call/result history만 사용한다. 선택된 provider ID와 adapter 등록 ID를 동일하게 구성하는 책임은 root factory에 있다.

replay envelope의 필드는 정확히 providerId/items다. providerId는 비어 있지 않은 최대 256 UTF-8 bytes 식별자이고 제어문자를 거절한다. items는 plain JSON object들의 배열이며 finite 숫자·dense 배열·plain object·최대 객체 깊이 64를 요구한다. undefined/function/bigint/symbol/class/cycle/accessor/숨겨진 field·reflection 오류를 `INVALID_CONTEXT`로 거절한다. descriptor로 복사해 getter/toJSON을 실행하지 않으며 `__proto__`도 안전한 own data property로 보존한다. 원본 replay와 snapshot은 변경하지 않는다.

같은 session replay는 malformed surrounding content/runId나 user/tool 역할에서도 message 필터 적용 전에 검사한다. 이미 소비하는 tool-result 경로도 동일하게 검사한다. 손상된 오래된 metadata가 나중에 budget trim 대상이거나 foreign-provider 데이터여도 조용히 제거하지 않고 명확한 오류를 낸다. 외부 session rows는 기존 정책대로 컨텍스트에서 제외한다. error message에는 native state·값·reflection 원문을 복사하지 않는다.

### Replay 실제 검증

```sh
node_modules/.bin/tsx --test packages/engine/src/context/context.test.ts
node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --skipLibCheck --types node packages/engine/src/context/index.ts packages/engine/src/context/context.test.ts
```

결과: **39 passed, 0 failed, 0 skipped; scoped strict TypeScript exit 0**. 이전 28개를 유지하고 replay 회귀 11개를 추가했다. 동일-provider phase/item 순서와 opaque field·깊은 복사, 완전한 도구 교환, empty replay/text, incomplete call 전체 metadata 제거, metadata+reserved 정확한 용량 경계/이전 블록 단위 trim, 큰 current encrypted state의 1 byte overflow, provider 전환 시 큰 state 제외와 normalized byte 경계, malformed envelope/JSON 30가지, accessor/reflection/toJSON 비실행, 손상된 message 및 tool-result role, foreign session 제외를 확인했다.

별도로 context source/tests/필요한 type-only ports를 고유한 임시 출력 디렉터리로 emit하여 `node --test <isolated-output>/context/context.test.js`를 실행했다. 결과: **emit exit 0; compiled tests 39 passed, 0 failed, 0 skipped**. 해당 컴파일러의 임시 출력만 정리했다.

최신 추가 단계는 config 22개 + context 39개, **소스 61개와 컴파일된 JavaScript 61개 모두 통과**했다. 전체 monorepo build/suite 및 실제 native Responses transport·SQLite 저장/재시작 replay는 root/각 담당자의 통합 검증 대상이다. 이 단계에서는 실제 provider·credential·외부 비용 호출을 사용하지 않았다. opaque item의 provider별 의미론 검증은 adapter 책임이며 context는 JSON/envelope·논리 message/tool group의 무결성을 검사한다.
