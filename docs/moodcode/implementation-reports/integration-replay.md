# Native Responses replay 통합 검증

2026-10-04. 실제 engine facade·SQLite journal/projection·context builder·ResponsesProvider·read_file를 loopback HTTP SSE와 연결해 검증했다. 유료 공급자 호출이나 실제 API 키는 사용하지 않았다.

## 구현 파일

- `packages/engine/src/integration/provider-replay.integration.test.ts`: 실제 임시 Git workspace와 SQLite DB를 사용하는 통합 테스트 1개.
- 기존 `packages/engine/src/integration/engine.integration.test.ts`의 8개 테스트는 수정하지 않았다.

새 export나 공통 계약 변경은 없다. engine·contracts·provider·runner·context 등 담당자 파일, package 설정, stage·commit은 변경하지 않았다. 빌드는 기존 설정으로 생성된 dist와 TypeScript incremental 결과만 갱신한다.

## 검증한 동작

1. native Responses SSE의 created/in_progress, reasoning summary, output item, text delta/done, function arguments delta/done, completed lifecycle을 실제 HTTP transport로 처리한다.
2. 첫 응답의 `reasoning` → `phase=commentary`인 assistant message → `function_call` 순서와 각 원본 ID·status·opaque `encrypted_content`를 유지한다. 함수 인수에는 공백·줄바꿈·Unicode escape·지수/소수 표기를 넣어 JSON 재직렬화가 발생하면 테스트가 실패하도록 했다.
3. runner가 실제 `read_file`를 실행하며 첫 두 줄만 읽고 결과를 저장한다. 두 번째 HTTP input에 앞서 완료된 native 항목들이 원본 형식 그대로 실제 `function_call_output` 앞에 들어간다. 별도 normalized assistant 텍스트나 함수 호출이 중복되지 않는다.
4. 최종 `phase=final_answer`를 포함한 native 응답과 첫 tool turn의 `assistant.providerReplay`를 SQLite snapshot에서 확인한다. engine journal 순서, 두 turn의 message completion, tool execution, 단일 Run terminal을 확인한다. reasoning summary와 ciphertext는 공개 text delta에 포함되지 않는다.
5. engine를 닫고 같은 DB를 다시 열면 messages와 native replay가 동일하다. 완료된 request ID를 재전송해도 HTTP 요청 수가 늘어나지 않는다.
6. 새 후속 Run은 저장된 reasoning·commentary·function call·tool output·최종 answer를 순서대로 HTTP input에 보존한다. 역사에 들어 있는 read call은 다시 실행하지 않는다.

## 실제 실행 결과

| 명령 | 결과 |
|---|---|
| `node_modules/.bin/tsx --test packages/engine/src/integration/provider-replay.integration.test.ts` | 1/1 통과 |
| `node_modules/.bin/tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext --types node packages/engine/src/integration/provider-replay.integration.test.ts` | exit 0 |
| `node_modules/.bin/tsc -b packages/engine --pretty false` | engine 및 참조 contracts 빌드 exit 0 |
| `node --test packages/engine/dist/integration/provider-replay.integration.test.js` | 빌드 결과 1/1 통과 |
| `node --test packages/engine/dist/integration/engine.integration.test.js packages/engine/dist/integration/provider-replay.integration.test.js` | 기존 8개 + 새 1개, 9/9 통과 |

Node v26.9.0 / macOS에서 실행했다. fixture 모델은 SSE 프로토콜과 엔진 연결을 결정적으로 검증하며, 실제 모델의 추론·계정 인증·외부 서비스 호환성이나 Electron runtime 동작의 증거로 취급하지 않는다. 해당 범위는 각 담당 검증 및 이후 실제 계정 연결 단계에 남는다.
