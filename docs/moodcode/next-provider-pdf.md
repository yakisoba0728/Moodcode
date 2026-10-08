# E5-13 표준 Responses PDF 검증

2026-10-09 Asia/Seoul. 기존 `ResponsesProvider`의 PDF wire를 재구현하지 않고 `scripts/verify-provider-coverage-pdf.mjs`에 실제 native 엔진 검증 경로를 추가했다. 모델 문자열을 추측하지 않는다. `pdfModelIds`, 동일 modelSpec의 `inputFileTypes`, adapter와 Engine 각각의 unknown document token-cost opt-in 계약을 그대로 사용한다.

첫 실제 계정 대상은 `gpt-4.1-mini-2025-04-14`이다. [공식 모델 문서](https://developers.openai.com/api/docs/models/gpt-4.1-mini)는 이 snapshot, image 입력, Responses endpoint를 명시한다. [공식 파일 입력 문서](https://developers.openai.com/api/docs/guides/file-inputs)는 vision 모델의 PDF 처리와 `input_file`/`file_data`를 지원한다. 공급자 파일 크기 허용량과 별개로 Moodcode의 native 512KiB/document, 1MiB combined decoded input, 2MiB serialized request 제한을 유지한다. 계정별 모델 접근 여부와 실제 성공은 중앙 executor의 별도 증거로 판정한다.

검증 fixture는 직접 작성한 비압축 PDF 한 페이지다. 독립 검사는 object 번호·xref offset·stream 길이·page count·font와 content grammar를 대조한다. 기존 28자 토큰은 Courier 24pt의 403.2pt 폭으로, x=72부터 x=475.2까지 612×792pt 페이지의 여백 안에 들어간다. 기대 토큰은 PDF content stream에만 있고 prompt·filename·일반 요청 JSON에는 없다. prompt는 첫 문자부터 마지막 문자까지 모든 문자·밑줄·숫자를 포함하여 유일한 인쇄 줄 전체를 전사하도록 명시한다. fixture 상한은 4KiB/1페이지, provider 요청은 45초/1회이며 native Run은 60초와 provider attempt 1회로 제한한다. 공급자에게 임의 URL이나 `file_id`를 보내지 않는다.

실제 native `importDocument` → v2 `input.accept` → Run/Turn/Part/Attempt → Responses SSE 경로를 사용한다. 저장 원본 blob과 SHA, request/native owner binding, exact recognition, attempt usage, iterator cleanup을 확인한다. 다른 세션의 참조는 Input 생성 전에 거절한다. exact 중복과 request conflict, 재시작, archive export/import는 HTTP 요청 0회이며 원본 Input/Run/Part/Attempt와 blob을 그대로 읽는다. imported session의 paused 상태도 검사한다.

응답은 token과 outer ASCII whitespace만 허용한다. 틀린 token, 16자리 suffix만 반환, 설명·구두점·Unicode 공백, usage 누락 및 HTTP 오류는 실패로 보존한다. native Run의 `completed`만으로 검증 성공을 만들지 않는다. 보고서에는 native 원본 record/hash·정확한 HTTP status·failure code·source/runtime pin을 남긴다. 직접 작성한 합성 probe의 `expectedToken`과 adapter가 credential을 제거한 native `observedText`만 진단에 포함하며 관측 문자열은 UTF-8 128바이트로 제한하고 전체 길이·truncation 여부를 기록한다. credential, PDF base64와 공급자 오류 본문은 출력하지 않는다. 의미 불일치 시 실제 Engine을 종료한 뒤에도 native SQLite와 원본 blob 디렉터리를 보존한다. 이 보존은 cleanup 실패를 뜻하지 않으며 종료·iterator cleanup의 실제 결과를 별도 필드로 남긴다. source/runtime drift나 cleanup 미확정은 성공을 취소하고 검토용 fixture를 보존한다.

`runProviderPdfCoverage({ api, modelId, apiKey, fetch, accountReference, capabilityReference, qualification })`는 중앙 executor용 host 주입 진입점이다. 이 callable lane은 native 증거를 제공하며 자체 `accountVerified`는 false로 유지한다. 중앙 direct executor만 자신의 공식 fetch·계정 reference·동결 source/runtime에 결합하여 account credit을 판정한다. 직접 CLI의 live 모드는 모든 opt-in과 credential 환경변수 reference 및 `--max-requests 1`을 요구한다. 테스트 hook·loader·loopback endpoint는 account credit을 얻지 않는다.

```sh
node scripts/verify-provider-coverage-pdf.mjs --live \
  --model gpt-4.1-mini-2025-04-14 --declare-pdf \
  --allow-unknown-document-token-cost --api-key-env OPENAI_API_KEY \
  --account-reference approved-openai-account \
  --capability-reference https://developers.openai.com/api/docs/guides/file-inputs \
  --max-requests 1
```

일반 PDF의 페이지·객체·압축·active content를 native import가 판정한다는 주장은 하지 않는다. 기존 import는 signature/byte/hash 검사이며 이번 1페이지 구조 검사는 유한 fixture에만 적용된다. 더 넓은 PDF 파싱, Codex PDF, 임의 remote URL, upload/file_id, 다른 계정·모델의 검증은 별도 범위다.

첫 실제 `gpt-4.1-mini-2025-04-14` 요청은 HTTP 200, native `completed`, usage 315 input/10 output, confirmed cleanup이었지만 정확 일치 검증에 실패했다. [원본 보고서](next-provider-pdf-live.json)의 SHA-256은 `0a86b1bcfdeb9e0bbe6cb8f91bff8381720e5a841af4380bb7d5845f41dc7309`이며 수정하지 않았다. 보고서에는 16바이트 native 응답과 기대·관측 hash가 있고 실제 문자열은 없으며 당시 임시 디렉터리가 제거되었다. 따라서 prefix가 생략되었다는 해석은 입증되지 않은 가설이다. 이 실패는 account credit을 얻지 않으며 이후 결과로 대체하지 않는다.

이를 확인 가능하게 만드는 좁은 수정은 prompt 전체 줄 전사 명시, 합성 토큰 진단과 의미 실패 native 증거 보존뿐이다. token grammar와 정확 일치 assertion, opt-in, 요청 상한 1회는 그대로다. 수정 후 source lane 21/21을 통과했으며 이전 기존 Responses/document-input 162/162 결과를 유지한다. endpoint 거절 시 받은 body도 1초 안에 실제 취소하며 취소 미확정 또는 중앙 fetch의 cleanup 미확정은 native `CLEANUP_UNCERTAIN`을 그대로 남긴다. 추가 실제 요청·통합 build·전체 회귀·커밋은 중앙 담당 결과와 결합한다.
