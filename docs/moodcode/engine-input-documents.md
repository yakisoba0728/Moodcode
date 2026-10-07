# PDF 원본 입력의 엔진 계약

Moodcode는 원본 PDF를 이미지 입력과 별도로 보관한다. `engine.importDocument(sessionId, bytes, signal?)`는 세션과 workspace 소유자에 결합된 참조를 반환한다. command에는 이 참조의 `documents` 배열만 넣는다. filename, 경로, URL, base64 및 인증 정보는 참조에 포함하지 않는다.

```ts
interface InputDocumentAttachment {
  id: string; // doc_<32 lowercase hex>
  kind: 'document';
  mimeType: 'application/pdf';
  bytes: number;
  sha256: string;
}
```

한 입력 및 실제 provider 요청은 PDF 1개, PDF당 512KiB까지 허용한다. 이미지와 PDF의 decoded byte 합은 요청의 모든 occurrence를 합쳐 1MiB까지다. 같은 참조를 반복해도 occurrence 예산이 늘어나지 않는다. 세션에는 최대 32개/16MiB를 import할 수 있다. 별도의 provider 직렬화 요청 상한은 base64와 텍스트, 도구 schema 등을 포함한다.

## 지원을 선택하는 host

표준 `ResponsesProvider`에는 `pdfModelIds`로 모델 ID를 명시한다. 엔진 `modelSpecs`에도 같은 provider/model의 `inputFileTypes: ['application/pdf']`를 명시한다. 어느 쪽도 모델 이름으로 지원을 추측하지 않는다. 누락된 모델 정보는 unknown, `[]`는 미지원이다. `supportsInputFile(modelId, mimeType)`는 공급자의 설정을 확인하는 순수 조회다.

PDF의 텍스트와 페이지 이미지 토큰 비용은 로컬에서 완전히 추정하지 않는다. 기본값은 `DOCUMENT_TOKEN_COST_UNKNOWN`으로 거절한다. 이 제한을 수락하려면 엔진과 Responses 옵션에 각각 `allowUnknownDocumentTokenCost: true`를 지정해야 한다. 둘 중 하나라도 빠지면 새 input/Run/attempt를 만들기 전에 거절한다. 옵션을 켜도 완전한 모델 token window 검증을 보장하지 않는다. diagnostics의 `documentTokens`는 `null`, `complete`는 `false`이며 텍스트와 참조 metadata 추정만 제공한다.

```ts
const provider = new ResponsesProvider({
  id: 'openai-responses',
  baseURL: 'https://api.openai.com/v1',
  apiKey: hostKey,
  pdfModelIds: [hostVerifiedModelId],
  allowUnknownDocumentTokenCost: true,
});
// EngineOptions.modelSpecs must also declare that exact provider/model's PDF support.
// EngineOptions.allowUnknownDocumentTokenCost must separately be true.
```

표준 Responses는 user content에 `input_file`, `filename: <document-id>.pdf`, `file_data: data:application/pdf;base64,...`를 보낸다. 공급자 credential 조회/fetch 전에 참조, signature, byte/hash, 전체 입력 예산 및 capability를 검사한다. 현재 Codex 고정 backend, Anthropic, Chat Compatible, Scripted의 PDF 입력은 거절한다. Codex의 기존 텍스트·이미지 지원을 PDF 지원으로 확대 해석하지 않는다.

## 저장과 실행

원본은 `artifactDir/input-documents/<id>.blob`, CAS index는 `session_documents`의 `input_documents` kind에 저장한다. index는 version/owner/documents를 가지며 owner에는 session ID, workspace ID 및 canonical root가 들어간다. bytes를 await 전에 복사하고 bounded positional read, hash·signature, inode·size·single-link, symlink/root 교체 및 index revision을 확인한다. blob publication 뒤 index CAS가 실패하면 이번 publication을 정리한다. close는 import 취소와 정리를 기다린다.

검사는 `%PDF-1.0`~`%PDF-1.7` 또는 `%PDF-2.0` header signature까지다. PDF 전체 파싱, 암호화·페이지·객체 유효성, active content, decompression 상한 또는 토큰 수를 판정하지 않는다.

v1 `run.submit`, v2 `input.accept` 및 queue/steer promotion은 `documents`를 input/Run/user Message에 그대로 결합한다. 필드 생략과 명시적 빈 배열의 request identity는 서로 다르다. exact 역사 receipt는 현재 capability를 다시 적용해 변형하지 않는다. 새 provider dispatch에서는 세션 owner, 현재 blob/index 및 capability를 다시 확인한다. 직접 coordinator를 사용하는 host도 dispatch 전 동일 검사를 거치며 로컬 거절의 실제 iterator cleanup은 확인된 상태로 정산한다.

## 대화 이력과 요약

DB8은 최신 PDF user 조회용 partial index만 추가한다. 이전 Run, ledger, ACK, usage 또는 v1 digest를 다시 쓰지 않는다. bounded model history는 최신 image/PDF user를 각각 독립 owner로 유지하고 숫자 message/Run 순서와 최근 완전한 tool exchange를 보존한다. 원문 전체 session snapshot을 읽어 anchor를 복구하지 않는다.

기본 정책은 선택한 PDF 원본 참조를 모두 보존하며 요청 count/bytes를 초과하면 거절한다. host가 `documentHistoryPolicy: {kind:'reference-only-older-documents',version:1}`를 선택하면 최신 PDF만 전달한다. 오래된 PDF user의 원문 텍스트는 필수로 남기고 exact refs/content SHA와 `unavailable-in-this-request`를 별도 assistant provenance notice에 기록한다. notice는 권한이나 현재 파일 관측 증거가 아니다. 원본 journal을 수정하지 않는다. provenance와 notice의 합산 상한은 기본 16KiB이며 더 좁힐 수 있다.

텍스트 semantic summary는 document-bearing source를 거절한다. active-prefix summary는 document users를 coverage 밖에 보호한다. PDF context 상한 초과도 active-prefix 재계획 경로에 들어가며 새 후보의 provenance와 context SHA는 같은 후보로 교체된다. `document-policy/source/message` source labels는 복구 결정에서 인정된 형식으로 검사하고 원본 message의 owner·SHA를 pin한다. ACK가 document refs 변조를 허용하지 않는다.

## 보관·진단과 검증 범위

아카이브는 primary document index와 blob hash/signature, input/Run/Message/inbox의 정확한 참조 및 SQL/payload owner를 함께 검사한다. 실패하면 archive를 publish하지 않는다. import는 원본 참조를 복원하고 새 물리 저장소 binding을 사용한다. child 저장소 내부 PDF index의 재귀 검사는 현재 범위 밖이다.

`getStorageUsage()`는 root document index의 관측 시점과 `root-input-documents-only` coverage를 제공한다. 파일 후보를 읽기 전용으로 기록하며 자동 삭제하지 않는다. index 이후 publication/CAS가 진행될 수 있어 후보가 삭제 가능한 orphan이라는 보장은 없다. 물리 I/O 또는 전체 tree 탐색량의 절대 상한으로 확대하지 않는다.

실제 임시 SQLite 엔진→mock HTTP, import/owner/CAS/cancel/tamper, exact retry, 재시작, archive와 긴 tool 이력, 이미지 회귀를 검증한다. 이 fixture는 실제 원격 모델의 PDF 이해·페이지 해석 또는 계정 허용 여부를 확인하지 않는다. [공식 문서 조사](research/2026-10-07-documents.md), [host API](engine-host-api.md), [현재 검증](engine-goal-verification.md), [열린 TODO](../../TODO.md)를 함께 확인한다.
