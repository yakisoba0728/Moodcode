# Repository context contributions

MC2-01c의 연결 범위는 host가 지정한 고정 query/path/range를 실제 모델 문맥에 공급하는 읽기 전용 source다. `RepositoryContextSource`가 관측을 준비하고, `ContextService`와 `planContext`가 문맥 예약·revision·diagnostics를 결합한다. Coordinator의 model lifecycle 이후와 모든 native provider Attempt 직전에도 freshness를 검사한다. frozen projection과 공유 budget 작업인 MC2-01c를 완료했고, MC2-01 전체의 자동 관련 path 선택 및 MC2-01d 실제 semantic LSP/대규모 corpus 품질 검증은 남아 있다. [진행표](engine-phase-two-progress.json)를 따른다.

## Host API와 선택 범위

```ts
const policy = repositoryContextPolicy({
  query: { kind: 'symbols', paths: ['src/example.ts'] },
  slotBytes: 8_192,
  exactRanges: [{
    path: 'src/example.ts',
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 24 },
    },
  }],
});

const engine = createEngine({ dbPath, repositoryContextPolicy: policy });
```

`EngineOptions.repositoryContextPolicy`는 명시적인 host opt-in이다. repository 파일을 읽어 policy를 등록하거나 변경하지 않는다. 첫 연결은 **고정 explicit query**만 지원한다. 기존 tool-history `relevantPaths`의 자동 추출·관련성 ranking은 이 source의 입력으로 자동 연결하지 않는다.

`symbols`는 최대 8개 정확한 workspace 상대 경로를 받는다. `definition`/`references`는 한 경로와 UTF-16 position을 받는다. 자동 snippet 후보는 그 query에 대해 **실제로 관측한 LSP location/symbol range**뿐이다. host의 `exactRanges`는 query의 explicit 경로 안에서만 지정할 수 있다. 지원되지 않는 언어에서도 host exact range를 읽을 수 있으며, 이때 결과는 `host-exact-range`와 `unsupportedPaths`를 함께 기록한다. LSP symbol/관계를 만들어내거나 전체 파일로 자동 대체하지 않는다.

독립 port는 다음 계약을 제공한다.

```ts
interface ContextSourcePort {
  prepare(request: RepositoryContributionRequest): Promise<PreparedRepositoryContribution>;
  assertFresh(contribution: PreparedRepositoryContribution, signal: AbortSignal): Promise<void>;
}
```

준비 결과는 detached/deep-frozen JSON이며 같은 source instance가 만든 메모리 handle만 freshness 검사에 사용할 수 있다. 복사·다른 instance의 handle은 거부된다. host request의 workspace/query/range를 첫 await 전에 복사해 고정한다.

## Manifest, 신뢰와 누락

결과는 repository query generation, query source manifest(HEAD/branch/effective ignore/host routing revision/source hashes), 실제 읽은 추가 source hashes, exact snippet ranges를 보존한다. snippet에는 `sourceHash`, `snippetHash`, UTF-16 `range`, `selectionReason`이 있다. LSP 선택에는 query path/server/document version/document hash/query kind도 포함한다. 해당 source hash는 snippet 일부가 아니라 관측한 전체 파일의 SHA-256이다.

snippet과 symbol name은 `untrusted-repository-data`다. 모델 메시지는 host가 구성한 읽기 전용 **assistant evidence** entry이며 AGENTS.md의 `InstructionSources`나 system instruction으로 승격하지 않는다. explicit query의 관측 범위만 설명하고 `coverage: explicit-query-only`를 기록한다. 동일한 범위는 첫 선택 순서(host exact range 우선)를 유지하며 중복으로 기록한다.

`omissions`의 `repositoryObservations`, LSP의 네 분류, `duplicateRanges`, `emptyRanges`, `snippetBytes`, `selectionLimits`, `contextBudget`는 **항목 수**다. `snippetBytes`는 snippet byte cap 때문에 제외된 범위 수이며 누락된 실제 byte 수를 추정하지 않는다. `message`는 전체 evidence 메시지가 slot에 들어가지 못했음을 뜻한다. `unsupportedPaths`는 별도 배열이다. 큰 범위는 일부 text로 줄인 후 원래 range를 붙이지 않고 전체 범위를 누락한다. 누락이 있으면 `complete: false`다.

| Bound | Value |
|---|---:|
| Query paths | 8 |
| Host exact ranges | 16 |
| Selected snippet ranges | 32 |
| Snippet source files | 16 |
| Snippet UTF-8 bytes | 4,096 |
| Aggregate selected file reads per preparation | 4 MiB |
| Additional serialized message reservation | 16,384 bytes |
| Concurrent operations per source | 8 |
| Complete prepare/freshness deadline | 15 s |
| Session capture cache | 128 |

읽기는 기존 `readExactText`의 canonical root, non-symlink parent, singly linked regular file, bounded UTF-8, no-NUL, inode/time identity 검사를 사용한다. UTF-16 range는 surrogate pair와 CRLF 범위를 엄격히 검사한다. Git ignore와 dependency/build traversal exclusions도 source 선택과 재검증에 적용한다.

## 공유 문맥 예약과 실제 소비

source budget은 `slotBytes`, `maxContextBytes`, 기존 tools/provider `reservedBytes`, 필수 base message array의 `requiredMessagesBytes`, known-or-null `contextWindow`, 기존 `outputTokens`를 함께 받는다. slot은 다음 두 remaining cap과 함께 적용한다.

```text
remaining bytes = maxContextBytes - reservedBytes - requiredMessagesBytes
known conservative window remaining
  = contextWindow - outputTokens - reservedBytes - requiredMessagesBytes
```

`reservations.envelopeBytes`는 evidence entry의 실제 JSON byte 수와 추가 comma를 합한 값이다. 원래 array bracket은 base transcript가 예약한다. 빈 base transcript에는 1 byte 보수적으로 더 예약될 수 있다. JSON escaping/Unicode byte 수를 재산정하며 file text byte 수로 대신하지 않는다. source는 provider output을 생성하거나 Run output budget을 소비하지 않는다. 반환하는 `outputTokens`는 동일한 기존 reserve의 증거이며 다시 더하지 않는다.

`inputEstimate.tokens`는 `null`이다. `utf8ByteUpperBound`는 기존 planner와 같은 text fitting용 보수적 fallback일 뿐 측정한 provider token usage가 아니다. 모델 window가 unknown이면 byte hard cap만 확인한다. image/document의 실제 token cost를 이 source가 계산하거나 검증했다고 주장하지 않는다.

`ContextService.makePlan`은 source를 준비한 후 `planContext(..., { repositoryMessages })`로 전달한다. planner는 evidence bytes를 먼저 예약하고 원래 transcript를 구성한 뒤 첫 non-system message 앞에 evidence를 넣는다. 따라서 tool-call/result 묶음을 쪼개지 않는다. 합쳐진 실제 messages로 plan hash/bytes/input estimate를 다시 계산하고 원래 envelope reserve는 한 번만 더한다.

필수 현재 user/완전한 tool exchange/필수 memory/media anchor를 확보할 수 없다면, evidence 없이 base plan을 먼저 맞추고 그 전체 byte 예약으로 source를 **한 번 다시 준비**한다. slot에 들어가지 못하는 증거는 omission으로 기록하며 필수 input을 줄이지 않는다. base plan 자체가 들어가지 않는 경우는 기존 context/token/media error를 유지한다.

합쳐진 원문은 `ContextRevision.text`에 저장된다. `context.head`의 repository diagnostics는 source hashes/ranges/trust/selection/omission/예약만 저장하고 snippet text와 provider messages를 제거한다. revision `sourceIds`에는 contribution ID, repository generation, 실제 읽은 source path/hash가 포함된다.

## Await, 재시도와 종료 경계

prepare는 before preview, expected-preview query, exact snippet reads, after preview를 결합한다. source/HEAD/branch/effective ignore/host routing 변경은 거부된다. `assertFresh`는 explicit query의 preview, 선택한 target의 ignore/hash, query generation/LSP document version을 다시 관측한 뒤 같은 capture인지 확인한다. 원래 prepare signal과 dispatch signal을 결합하므로 취소된 Run의 handle은 새 signal로 재사용할 수 없다.

`ContextService.assertFresh(sessionId, messages, signal, runId?)`는 session capture의 merged message hash/context revision/Run owner를 검사하고 source freshness를 호출한다. 배열 clone은 같은 exact JSON이면 허용한다. await 중 같은 session이 다른 capture로 교체되어도 거부한다. map의 128개 한도를 넘겨 퇴거된 capture는 fail-closed다. `releaseRepositoryContext(sessionId, runId?)`는 지정한 owner만 제거한다.

현재 actual wiring은 다음 경계를 사용한다.

1. `ContextService.build`의 context revision publication 이전 source freshness.
2. Coordinator `providerTurn`의 awaited `before-model` lifecycle 뒤 native stream 이전 freshness.
3. `TurnExecutor.stream`의 **각 Attempt** dispatch intent/provider 호출 이전 freshness. retry backoff 뒤도 검사한다.
4. Coordinator Run finally에서 session/Run capture release.

stale 결과를 받은 retry는 request messages나 schemas를 새 관측으로 바꾸지 않는다. 이전 Attempt의 실제 cleanup proof를 보존하고 다음 Attempt는 producer 호출 없이 `not-dispatched`로 정리된다. freshness callback은 detached request를 받으며 mutation도 검증해 거부한다. deadline/cancel을 무시하는 peer의 늦은 결과는 채택하지 않고, 그 operation이 실제 종료될 때까지 concurrency lease를 유지한다.

파일·언어 서버를 동시에 잠그는 transaction은 제공하지 않는다. 마지막 관측 이후 외부 변경을 영원히 막는 보장은 없으며, freshness는 명시한 dispatch 경계에서 관측한 snapshot의 일치 증거다. 자동 embedding/vector/network 전송, schema/tool effect, credential 접근은 이 source에서 수행하지 않는다. host가 등록한 LSP 연결만 기존 RepositoryContextService를 통해 사용한다.

## Verification과 남은 범위

source 검증: `repository-contributions.test.ts` 19개, `repository-context-integration.test.ts` 10개. 실제 임시 Git/file/SQLite/LSP peer/TurnExecutor를 사용해 mutation, UTF-16, symlink/ignore, branch/version/hash stale, timeout/late/cancel, caps, merged reservation, exact tool exchange, required-input fallback, capture replace/eviction/release, same-Turn native retries와 cleanup 보존을 확인한다. 현재 Moodcode의 `context/plan.ts` 실제 파일 snippet도 동일한 API로 읽고 hash를 검증한다. LSP peer는 재현 fixture이며 실제 semantic server의 정확도를 증명하지 않는다.

root의 `engine-repository-context.test.ts`는 실제 Engine opt-in/default-21 tools/고정 policy, before-model 변경과 retry 변경의 dispatch 차단을 검증한다. source 검증은 다음 명령으로 실행한다.

```sh
node --import tsx --test \
  packages/engine/src/context/repository-contributions.test.ts \
  packages/engine/src/context/repository-context-integration.test.ts \
  packages/engine/src/context/engine-repository-context.test.ts
```

고정 explicit 선택 이외의 bounded 관련 path 자동 공급, 선택 정책/순위의 품질 검증, 실제 semantic LSP와 대규모 corpus lane은 남아 있다. 현재 이전 benchmark는 LSP 미등록/unsupported 관측의 bounded read 측정이며 semantic indexing이나 cache 성능 개선의 근거가 아니다.
