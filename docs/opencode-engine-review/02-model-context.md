# OpenCode 모델·컨텍스트 엔진 검토

기준 소스는 `anomalyco/opencode`의 `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`다. 이 문서는 최신 checkout을 직접 읽어 작성한 동작 분석이며, Moodcode에 원본 구현·프롬프트·테스트를 이식하지 않는다. 세부 읽기 범위는 [coverage 기록](./02-model-context.coverage.json)에 남겼다. 아래 테스트 근거는 테스트 코드의 주장과 fixture 흐름을 읽었다는 뜻이다. 이 검토 작업에서 테스트나 실제 모델 호출은 실행하지 않았다.

핵심 결론은 **모델 통신, 저장된 대화의 모델용 표현, 컨텍스트 수명, 실행 루프를 서로 다른 계약으로 소유해야 한다**는 것이다. OpenCode의 기존 경로는 공급자 호환 기능이 넓고, V2 경로는 대화 순서와 컨텍스트 갱신을 더 명시적으로 다룬다. V2가 기존 기능을 모두 대체한 상태라고 보기는 어렵다. Moodcode는 이미 있는 자체 provider·runner·storage를 유지하면서 빠진 계약을 보강하는 편이 적절하다.

## 1. 실제로 연결된 경로

| 경로 | 모델 호출과 결과 소비 | 중요한 차이 |
|---|---|---|
| 기존 SessionPrompt / SessionProcessor | `session/llm.ts`가 모델·설정·인증·플러그인을 준비하고 기본적으로 AI SDK `streamText`를 실행한다. `llm/ai-sdk.ts`가 공통 LLMEvent로 변환하고 processor가 저장한다. | 여러 공급자·모델별 호환 보정, 사용량·가격, 재시도 상태 등이 여기에 축적되어 있다. |
| 기존 세션의 native opt-in | 같은 LLM 서비스가 gate를 통과한 요청을 `native-request`로 낮추고 `native-runtime`에서 LLMClient로 실행한다. | 세션 도구와 권한은 여전히 OpenCode가 소유한다. native 경로 선택과 native SDK의 전체 지원 목록은 다르다. |
| V2 SessionRunner | Location 범위의 모델 resolver → 컨텍스트 epoch → projected history → typed request → 정확히 한 provider stream → 도구 settlement → DB history reload 순으로 반복한다. | durable 세션 오케스트레이션이 native LLM SDK와 분리되어 있다. 기존 AI SDK 세션 루프를 호출하지 않는다. |

실제 연결 근거: [기존 서비스와 native 선택](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/llm.ts#L85-L114), [기본 AI SDK 호출](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/llm.ts#L224-L378), [V2 provider turn](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts#L173-L284).

`packages/llm` 자체는 세션 루프가 아니다. 입력을 공급자 요청으로 변환하고 한 번의 응답 스트림을 공통 이벤트로 정규화한다. 세션 인증·권한·plugins·다음 turn은 caller 책임이다. `packages/llm/DESIGN.md`는 다음 API에 대한 논의 초안이므로 거기에 있는 run/turn·pricing·정책을 현행 구현으로 계산하지 않았다. [현재 공개 호출](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/llm.ts#L30-L74), [초안 상태](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/DESIGN.md#L1-L15).

## 2. 모델 선택과 공급자 요청 준비

### 기존 경로

request prep는 agent 지정 프롬프트 또는 모델군별 기본 프롬프트, 환경·프로젝트 지침, 사용자 system 입력을 합친다. 옵션 우선순위는 공급자 기본 → 모델 → agent → 선택 variant이며 small 호출은 일반 variant를 제외한다. system·params·headers plugin hooks가 이 사이에 들어간다. OpenAI OAuth는 system을 일반 메시지 대신 별도 instructions 옵션으로 전달한다. [요청 준비](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/llm/request.ts#L56-L146).

도구는 agent와 세션 permission 및 해당 user의 비활성 목록을 통과한 뒤 정렬된다. 일부 Responses 계열은 도구 strict 옵션을 풀고, Copilot의 과거 tool history 호환 때문에 빈 현재 도구 목록을 보완한다. 공급자별 media·reasoning·tool ID·schema·cache 보정은 ProviderTransform에 들어 있다. 이러한 보정을 runner 전체에 퍼뜨리지 않고 어댑터에서 처리하는 경계는 Moodcode에도 유용하다. [도구·header 준비](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/llm/request.ts#L148-L215), [변환 파이프라인](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/provider/transform.ts#L465-L514).

### V2 경로

명시한 모델은 available catalog에서 정확히 찾아야 한다. 없으면 ModelUnavailable, 명시 variant가 없으면 VariantUnavailable이다. 모델 미지정 시 supported default 또는 첫 supported available 모델을 선택한다. agent 선택·모델 resolve·tool materialization은 매 provider turn마다 다시 수행되므로 다음 안전한 turn 경계에서 변경을 적용한다. [선택 규칙](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/model.ts#L104-L218), [매 turn agent/model 재조회](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts#L179-L223).

현재 V2 resolver가 실제로 연결하는 API는 OpenAI Responses, Anthropic Messages, URL이 지정된 OpenAI-compatible Chat 세 가지다. `packages/llm`에 Gemini·Bedrock·Azure 등의 구현이 있어도 V2 runner에서 바로 지원한다는 뜻은 아니다. 최종 catalog API가 `native`라는 태그만 가진 경우도 이 resolver는 거부한다. variant header/body는 얕게 overlay하고, credential의 key metadata만 request body로 보낸다. OAuth metadata는 제외하며 apiKey는 최종 body에서 제거한다. [지원 분기와 credential](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/model.ts#L83-L179), [지원 제약 테스트](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/test/session-runner-model.test.ts#L295-L345).

기존 native adapter gate는 openai/anthropic/opencode 계열 및 세 SDK package, API key 조건을 본다. OpenAI OAuth도 provider fetch override가 있으면 통과한다. 폴더 AGENTS의 OAuth fallback 설명 및 umbrella experimental flag 설명은 실제 gate/flag와 다르다. gate는 message content 형식까지 검사하지 않으므로 선택 후 lowering 실패를 모두 AI SDK fallback으로 돌리는 구조는 아니다. [실제 gate](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/llm/native-runtime.ts#L46-L102), [입력 lowering 제한](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/llm/native-request.ts#L56-L99), [실제 flag](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/effect/runtime-flags.ts#L40-L56).

## 3. 저장된 대화와 모델용 대화는 다르다

공통 요청은 초기 system, chronological messages, tools, generation, providerOptions, transport options로 나뉜다. 메시지 content는 text/media/reasoning/tool-call/tool-result를 구분하고 provider metadata는 별도로 보존한다. 도구 정의와 실행 함수도 다른 값이다. UI transcript를 그대로 JSON 직렬화해 보내는 방식으로는 모델 간 호환이나 tool exchange 원자성을 유지하기 어렵다. [canonical request/message](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/schema/messages.ts#L122-L284).

V2 history는 DB 순서와 최근 완료 compaction, context baseline sequence를 함께 사용한다. compaction 이전에 발생했더라도 현재 baseline 이후의 유효 system update는 필요할 수 있으므로 단순 최근 N개 선택이 아니다. tool 결과는 local이면 tool 메시지, provider-hosted이면 assistant content 안의 공급자 결과로 낮춘다. agent/model switch 기록은 자체로 provider message를 만들지 않는다. [history SQL](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/history.ts#L24-L99), [V2 lowering](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/to-llm-message.ts#L39-L171).

provider continuation metadata는 같은 모델·공급자이고 실패하지 않은 assistant 기록에서 재사용한다. 모델을 바꾸면 reasoning의 보이는 text는 일반 text로 남기고 opaque metadata는 제거한다. OpenAI Responses는 store=false일 때 암호화된 reasoning 상태가 있는 항목만 재전송하고, store=true일 때 item reference를 이용한다. 이를 일반 요약 텍스트와 섞거나 일부만 자르면 이후 turn이 깨질 수 있다. [V2 replay 조건](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/to-llm-message.ts#L70-L112), [Responses reasoning replay](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/protocols/openai-responses.ts#L346-L453).

기존 lowering에는 aborted assistant의 유효 부분 보존, 미완료 도구에 대한 interruption 결과, signed reasoning을 위한 구조 유지, tool-result media를 공급자에 맞춰 별도 user message로 보내는 처리가 있다. 최신 pin에서 이전 분석 commit 대비 이 범위 변경은 **xAI tool-result 이미지 중 PNG/JPEG/WebP 외 형식을 제외하는 처리**다. 전체 공급자 기능이 새로 바뀐 것으로 해석하지 않는다. [기존 도구·reasoning replay](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/message-v2.ts#L254-L428), [최신 xAI 호환 필터](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/message-v2.ts#L165-L169).

현재 V2 tool output의 remote/managed URI materialization은 TODO이며, canonical LLM lowerer에 미해결 URI를 넘기면 모든 media가 정상 실행된다고 보장할 수 없다. 기존 세션과 V2 attachment 기능의 동등성이 완성되었다는 주장을 피해야 한다. [명시 TODO](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/to-llm-message.ts#L39-L46).

## 4. Context Epoch와 지침 갱신

V2는 환경·날짜·프로젝트 지침·agent별 skill guidance·reference 목록을 안정된 source key로 관찰한다. source마다 typed snapshot, 초기 렌더링, 변경 렌더링, 제거 렌더링이 있다. 일시 관찰 실패와 실제 제거를 구분한다. 최초 관찰이 불완전하면 초기화가 막히고 아직 승격되지 않은 prompt는 pending으로 남는다. 이후 실패는 기존 snapshot을 보존하며, 알려진 source가 일시적으로 unavailable이면 전체 baseline 교체도 기다린다. [Context source 계약](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/system-context/index.ts#L31-L89), [초기화·조정·교체](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/system-context/index.ts#L197-L290).

변경은 다음 안전한 provider 경계에서 한 chronological system message로 publish하고 같은 event commit에서 snapshot을 전진시킨다. 초기 baseline 문자열은 유지한다. 완료 compaction을 만나면 최신 complete 관찰로 baseline을 다시 만들고 이전 system update의 cutoff를 조정한다. 따라서 컨텍스트 source의 관찰값, 모델에 실제 전달한 문장, DB 상태의 진도가 엇갈리지 않는 계약이다. [epoch prepare와 commit](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/context-epoch.ts#L40-L78).

지침 발견 동작도 V1/V2가 다르다. 기존 경로는 global AGENTS/CLAUDE fallback, project AGENTS/CLAUDE/CONTEXT, config glob·remote URL 및 읽는 파일 주변 지침을 다룬다. V2 InstructionContext는 global AGENTS와 Location에서 project root까지 발견한 AGENTS만 가져와 typed source로 처리한다. 발견한 프로젝트 지침을 읽지 못한 경우를 unavailable로 구분한다. V1의 모든 지침 옵션이 V2에도 구현됐다고 설명하지 않는다. [기존 발견·remote·근접 지침](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/instruction.ts#L60-L220), [V2 발견과 unavailable](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/instruction-context.ts#L40-L88).

Chronological system update는 모든 API가 system role로 받는 것이 아니다. OpenAI Chat/Responses는 별도 wrapped user content로 표현하고, Anthropic은 특정 모델·역할 경계에서 native update를 허용하며 local tool-call/result 사이 삽입을 거부한다. 엔진의 의미와 wire role을 분리해야 한다. [Chat update lowering](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/protocols/openai-chat.ts#L293-L330), [Anthropic 경계 검사](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/protocols/anthropic-messages.ts#L355-L422).

## 5. 토큰 예산과 compaction의 실제 동작

| 항목 | 기존 경로 | V2 경로 |
|---|---|---|
| 압력 판단 | 직전 usage와 model input/context/output limit로 판단 | system+messages+tools의 JSON 문자열 토큰 추정과 model context limit 비교 |
| 예약 예산 | model input limit이 있으면 configured reserved 또는 기본 reserve를 차감 | output allowance와 buffer 중 큰 값을 차감; 기본 buffer 20,000 |
| 최근 부분 | 설정된 tail turn 수와 token budget에 따라 원래 메시지 tail 보존 | message 단위 serialized tail; 기본 8,000 추정 tokens |
| 오래된 도구 출력 | prune 설정 시 보호 구간 뒤 완료 tool 출력에 compacted marker를 기록 | summary 직렬화에서 도구 출력 최대 2,000 characters; 별도 deterministic pruning은 미구현 |
| 요약 실행 | compaction agent/model, plugin hooks, SessionProcessor를 사용 | 같은 선택 모델로 별도 한 번의 tools 없는 summary request; 최대 4,096 output tokens |
| 활성 경계 변경 | 완료 summary와 compaction part/tail_start 기록을 사용 | 성공한 Compaction.Ended만 새 model-visible checkpoint로 투영 |

근거: [기존 overflow](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/overflow.ts#L8-L33), [기존 tail selection/pruning](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/compaction.ts#L215-L317), [V2 selection·summary·threshold](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/compaction.ts#L123-L242).

Token.estimate는 문자열 길이를 4로 나눈 근사치다. 모델 tokenizer를 통한 정확한 계산이 아니며, 한국어·JSON escaping·이미지 token cost의 정확한 예측을 보장하지 않는다. 모델 context metadata도 필요하므로 context limit이 알려져 있지 않으면 V2 automatic compaction은 건너뛴다. [추정기](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/util/token.ts#L1-L5).

V2는 이전 structured summary를 다음 요약에 합치고 최근 내용을 serialized text로 보존한다. compaction 경계 이전의 signed/encrypted provider replay를 다시 이어 붙이지 않는다. 요약 실패·빈 결과·provider error에는 Ended가 없어서 기존 활성 history 경계를 유지한다. 다만 summary stream이 text를 반환했는지와 provider error 여부는 검사하지만, 이 함수 자체에 모든 terminal-event 완결성을 재검증하는 조건은 없다. 이는 정적 코드에서 추론한 계약의 한계이며 비정상 stream을 재현해 확인한 결함은 아니다. Moodcode에서는 요약 결과의 성공·완결 조건까지 명시하는 것이 좋다. [성공 조건과 commit](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/compaction.ts#L176-L230).

실제 provider가 overflow를 돌려주면 **durable assistant output을 시작하기 전**에만 한 번 요약 후 같은 논리 turn을 재구성한다. 요약 실패나 두 번째 overflow는 일반 failure로 흘리고, 이미 출력·도구 실행이 진행된 turn은 재실행하지 않는다. proactive compaction과 overflow recovery는 별도 경로다. [overflow attempt 경계](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts#L286-L305), [두 번째 recovery 차단](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts#L364-L390).

## 6. LLM adapter·transport·이벤트 계약

native SDK는 semantic protocol, endpoint, auth, framing/transport를 조합한다. route defaults → model defaults → request 순으로 옵션을 합치고, records는 deep merge, 배열·scalar·null은 교체한다. 요청 compile은 cache policy → protocol body 구성 → schema 검증 → transport 준비 순이다. `prepare`는 전송하지 않지만 credential resolution과 signing 같은 준비 작업은 실행될 수 있다. 반환 body는 transport overlay 이전 protocol body이므로 최종 wire body와 같다고 가정하면 안 된다. [옵션·compile](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/route/client.ts#L167-L179), [prepare 반환](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/route/client.ts#L341-L390), [merge 규칙](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/schema/options.ts#L6-L71).

HTTP overlay는 주요 protocol field의 denylist를 적용한 뒤 나머지를 합친다. protocol schema 검증 이후에 적용되며 전체 overlaid body를 원 schema로 다시 검사하지 않는다. Moodcode의 독립 설계에서는 공급자 추가 옵션을 허용할 필드와 실제 전송 직전 검증 범위를 명시해야 한다. [HTTP overlay·auth 순서](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/route/transport/http.ts#L31-L105).

SSE는 incremental decode와 data framing을 수행하고 빈 이벤트 및 DONE marker를 제외한다. native WebSocket은 요청별 연결, 한 번의 request send, bounded 수신 queue, scoped close를 수행한다. pooling·재연결·HTTP fallback을 이 모듈에서 제공하는 것은 아니다. [SSE](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/protocols/shared.ts#L234-L249), [WebSocket 수명](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/route/transport/websocket.ts#L138-L204), [request 전송과 close](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/route/transport/websocket.ts#L226-L260).

이벤트는 text/reasoning block start·delta·end, tool input fragment·complete call·result/error, step finish, finish, provider-error 등을 분리한다. JSON tool arguments는 complete call에서만 실행 가능한 값이 된다. 기존 native adapter에서는 tool call을 내보낸 뒤 도구를 시작하고 결과를 provider stream 뒤에 붙이므로 **provider finish보다 local tool result가 늦을 수 있다**. finish와 모든 side-effect settlement를 한 완료 신호로 처리하면 안 된다. [adapter settlement 순서](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/llm/native-runtime.ts#L103-L137), [동시 도구 fixture 주장](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/test/session/llm-native.test.ts#L543-L600).

`generate` reducer는 terminal finish 또는 provider-error가 있어야 완성된다. provider-error는 정상 response 반환 안의 error finish일 수도 있으므로 Effect error만 검사하면 부족하다. raw `stream`은 generic generate의 terminal 검증을 자동으로 상속하지 않는다. V2 publisher는 finish 자체를 저장하지 않고 step-finish를 통해 settlement를 잡으므로 caller별 완결 조건을 확인해야 한다. [generate 완결 확인](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/route/client.ts#L382-L390), [response complete](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/schema/events.ts#L583-L605), [V2 finish 처리](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/publish-llm-event.ts#L396-L407).

## 7. usage·비용·retry·취소에서 놓치기 쉬운 경계

usage 공통 계약의 input/output는 cache/reasoning을 포함하는 total이다. 비중복 breakdown도 별도로 둔다. 공급자마다 원래 값의 의미가 달라 mapper가 이를 정규화한다. 누락된 usage를 무조건 0으로 바꾸는 것과 provider가 실제 0을 준 것은 구분해야 한다. [usage 정의](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/schema/events.ts#L7-L74), [Responses usage](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/protocols/openai-responses.ts#L503-L519).

기존 경로는 input/cache/reasoning 분리와 모델 context tier별 가격, Copilot의 authoritative billed amount를 계산한다. V2 runner는 Step.Ended에 **cost: 0**을 넣는다. 이는 무료라는 관찰이 아니라 현행 비용 계산 공백이다. 요약 호출의 usage/cost도 현재 compaction 함수가 run accounting으로 저장하지 않는다. Moodcode에서 token/cost 상한을 넣을 때 본 turn, 물리 retry, summary 호출 모두 포함해야 한다. [기존 usage·가격](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/session.ts#L338-L400), [V2 cost 값](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts#L325-L344), [summary 이벤트 처리](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/compaction.ts#L199-L229).

native HTTP executor는 retryable rate-limit/internal status failure를 최대 2회 재시도하며 jitter, Retry-After, 최대 10초 delay를 적용한다. transport 오류와 stream decode 오류는 이 레이어에서 자동 재시도하지 않는다. 기존 SessionProcessor에는 별도의 최대 5회 session retry 정책과 retry 상태가 있어 native opt-in에서는 계층이 겹칠 수 있다. Moodcode는 retry 예산과 retry owner를 한곳에서 정하고, 이미 모델 결과를 commit했거나 effect를 실행한 attempt는 다시 보내지 않는 원칙을 두어야 한다. [executor retry](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/route/executor.ts#L345-L379), [transport retryable=false](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/src/schema/errors.ts#L109-L145), [기존 session retry](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/retry.ts#L183-L205), [processor 재시도](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/processor.ts#L641-L695).

기존 provider fetch wrapper에는 기본 header·SSE inactivity 5분, optional total timeout이 있다. 이 wrapper와 custom fetch 전달은 native/V2에서 완전히 같은 경로가 아니다. V2 명세는 universal provider inactivity/absolute timeout 정책을 의도적으로 미룬다고 적는다. Electron 뒤에서 항상 실행할 Moodcode 엔진은 이미 있는 provider 60초·run 상한을 보존하고 향후 request/header/inactivity/run total 예산을 별도 의미로 확장해야 한다. [기존 timeout](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/provider/provider.ts#L94-L125), [V2 deferred 정책](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/specs/v2/session.md#L153-L165).

기존 stream은 scope 종료 시 AbortController를 abort한다. V2는 provider interruption 후 tool fiber를 취소하고 미정산 도구·활성 assistant를 failure로 수습한다. 모델 통신 취소와 도구 프로세스 종료 확인은 별개이며, 실제 외부 side effect 복원 보장은 이 provider 계약으로 얻어지지 않는다. [기존 abort 수명](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/session/llm.ts#L357-L381), [V2 settlement 수습](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts#L304-L354).

## 8. 정적 테스트 근거와 한계

| 확인한 테스트 경계 | 소스에서 확인한 시나리오 | 이번 실행 |
|---|---|---|
| native runtime selection | OAuth override, 지원 SDK, key 없는 fallback 및 native tool finish/settlement 순서 | 미실행 |
| V2 model / messages | 미지원 API 실패, OAuth metadata 제외, 실패·모델 변경 후 native metadata 제외 | 미실행 |
| V2 context epoch / runner | baseline 유지, agent/model change, 일시 unavailable, compaction rebaseline | 미실행 |
| V2 compaction / overflow | proactive summary·recent record, raw/event overflow 1회, 두 번째 overflow, 요약 실패·중단, 출력 이후 recovery 금지 | 미실행 |
| LLM route/response/executor | 옵션 우선순위, terminal 필요, usage 유지, HTTP 실패 분류·retry | 미실행 |
| 기존 compaction | tail/prune·usage/cost 테스트 존재를 확인; 해당 대형 파일은 일부 구간만 읽음 | 미실행 |

대표 fixture 근거: [V2 baseline·switch·compaction 테스트](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/test/session-runner.test.ts#L741-L1340), [출력 이후 overflow recovery 금지](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/test/session-runner.test.ts#L3205-L3232), [V2 message replay 테스트](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/test/session-runner-message.test.ts#L299-L501), [response terminal/usage 테스트](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/llm/test/response.test.ts#L45-L76).

테스트 이름 목록 전체를 읽은 것과 각 fixture를 전부 검토한 것은 구분한다. 그 차이를 coverage JSON에 기록했다. 프로토콜 종류 전체를 식별했지만 Gemini·Bedrock 모든 branch나 각 공급자 plugin의 동작을 이 문서에서 완독·실행했다고 주장하지 않는다. runner 파일 상단의 compaction TODO는 실제 구현보다 뒤처져 있다. V2 명세 parity 표는 automatic compaction을 complete로 표시하지만 selected-agent system 항목에는 이미 연결된 system prompt를 아직 미완료로 적고 있다. 이처럼 의도·체크리스트와 실제 연결 상태가 다른 경우 실행 경로를 우선했다.

## 9. 현재 Moodcode와의 차이

Moodcode 비교 기준은 이번 검토 시점의 `6d9a952`다. 근거 경로는 같은 저장소의 `packages/engine/src/context`, `provider`, `runner`, `ports.ts`다.

| 영역 | Moodcode에 이미 있는 동작 | 엔진 우선 후속 범위 |
|---|---|---|
| 모델 어댑터 | Responses·OpenAI-compatible·Codex·scripted, 한 provider turn, bounded SSE, 명시 model ID, 취소·timeout | 모델 metadata/capability catalog와 protocol별 typed 옵션; 향후 Anthropic/Gemini는 별도 adapter |
| native replay | providerReplay 저장·검증·바이트 제한 및 provider 전환 시 제외 | model identity/protocol/version도 replay 호환 키로 명시; 공개 reasoning block 이벤트 |
| tool transcript | call/results를 한 블록으로 유지하고 깨진·미완료 exchange는 모델에 dangling result로 보내지 않음 | 이 원자성 유지; media·structured result 도입 시 block 비용과 호환 검사 확장 |
| context budget | UTF-8 직렬화 바이트 상한, tools/envelope reserve, 최신 request+tool 결과 유지, 넘치면 명확한 CONTEXT_LIMIT | 모델 token window·output reserve를 별도 상한으로 추가; 현재 바이트 상한을 token 추정으로 대체하지 않음 |
| 장기 기억 | 오래된 원본에서 최대 8개 excerpt·8KiB extractive memory, 원본은 보존 | versioned semantic summary와 완료 checkpoint; source event 범위·생성 모델·추정/실제 usage·성공 여부 기록 |
| 프로젝트 지침 | root AGENTS를 bounded/no-follow 방식으로 읽고 매 context rebuild에 반영 | 적용 위치별 nested AGENTS, source identity/hash, 변경·삭제·관찰 실패, 적용 순서와 다음-turn 갱신 이벤트 |
| overflow | 로컬 상한 초과 시 failure; provider 오류는 public error로 정리 | provider overflow 분류를 안전한 구조로 보존하고, commit 전 1회 요약 후 attempt 재구성 |
| retry | provider 실패·run 실패 경계 존재; transport/session 자동 retry 루프는 아직 없음 | status/pre-output retry owner·총 예산·cancel·Retry-After·durable notice; ambiguous dispatch/crash 자동 재실행 금지 |
| usage | input/output optional count, turnIndex event | inclusive totals·cache/reasoning breakdown·summary/retry accounting, 가격 추정과 실제 청구값 출처 구분 |
| agent 선택 | Plan/Build engine mode와 자체 기본 지침 | mode와 agent profile 분리, tool 정책·모델/variant·step allowance의 snapshot 및 전환 경계 |

Moodcode 직접 근거: [provider port](../../packages/engine/src/ports.ts), [bounded context](../../packages/engine/src/context/index.ts), [extractive memory](../../packages/engine/src/context/memory.ts), [Responses](../../packages/engine/src/provider/responses.ts), [runner](../../packages/engine/src/runner/index.ts).

현재 Moodcode ProviderEvent는 text.delta/tool.call/usage/finish만 있고 usage에는 input/output만 있다. reasoning replay는 opaque state로 보존하지만 block별 공개 이벤트는 아직 별도 계약이 없다. context replay 호환은 현재 providerId 기준이고 modelId는 저장된 replay 자체의 key에 포함되지 않는다. 새로운 모델 adapter와 memory 계약을 만들 때 이 경계를 먼저 고정하는 것이 좋다.

## 10. 독립 구현 순서와 완료 조건

1. **모델과 provider 계약 확장.** ModelSpec에 context/output limit·supported modalities·tool/reasoning capabilities·estimate provenance를 두고, ProviderEvent에 typed reasoning·usage·failure classification을 추가한다. 실패 classification에는 remote 원문·credential을 공개 데이터로 넣지 않는다. 기존 Responses/Codex replay round-trip을 유지하는 자체 fixture로 검증한다.
2. **ContextPlan을 명시적 결과로 반환.** source identity·적용 지침·완전한 tool exchange·선택/누락 범위·byte/token 추정·output reserve를 함께 계산한다. root/nested 지침과 unavailable/removal을 구분하고 source snapshot을 저장한다. GUI 없이 plan JSON과 DB 이벤트로 검토할 수 있어야 한다.
3. **완료된 memory checkpoint만 활성화.** 원본 transcript를 보존하고 source event cutoff 및 version을 기록한다. tools 없는 summary 호출과 recent exchange 보존 정책을 Moodcode 자체로 정한다. 실패·빈 요약·cancel·불완전 terminal에 기존 context 경계가 그대로 유지되어야 한다.
4. **Overflow와 retry를 경계별로 추가.** assistant 내용 commit/도구 효과 전 attempt만 허용하고 overflow recovery를 논리 turn당 1회로 제한한다. HTTP retry도 총 run 예산에 포함한다. 재시작 후 ambiguous provider dispatch를 자동으로 안전하다고 간주하지 않는다.
5. **실제 작업 품질을 평가.** 최초 사용자 목표 보존, 지침 변경, 모델 교체, 긴 tool 출력, 요약 실패, 한글 context, reasoning replay, 취소와 retry 중단을 작은 자체 시나리오로 검증한다. 공급자 protocol fixture 테스트와 장기 작업 완료 품질 평가는 분리한다.

이 순서는 OpenCode 클래스 이름·Effect 레이어·프롬프트 형식을 재현하자는 제안이 아니다. Moodcode의 durable Run, Node cancellation, SQLite transaction, 명확한 approval 경계를 바탕으로 관찰 가능한 기능 계약을 새로 구현한다. reference checkout은 비교 자료로 유지하며 Moodcode runtime의 dependency나 source vendoring으로 연결하지 않는다.
