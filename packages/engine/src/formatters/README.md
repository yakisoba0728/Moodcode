# Formatter 경계

`FormatterRegistry.register(id, formatter)`는 명시적 호스트 formatter callback을 등록한다. callback은 관찰된 파일의 text와 취소 signal을 받아 새 text를 반환한다. 실행 파일·shell command는 모델 입력으로 지정할 수 없다. 이 port는 text 변환 계약이며 호스트 callback 자체의 OS 동작을 sandbox하지 않는다. 비협조 callback은 cancel/5초 timeout 뒤에도 반환할 수 있으나 그 결과를 파일에 적용하지 않는다.

`propose`는 일반 UTF-8 text를 nofollow로 읽고 hash를 고정한다. formatter 결과는 1 MiB 이내, NUL/무효 UTF-8가 없어야 한다. 반환 전 등록 identity와 현재 파일 hash를 다시 검사한다. `createFormatTool`은 proposal을 기존 승인·checkpoint patch에 연결한다. LSP 결과도 `createLspFormatTool`로 같은 patch 경로에 연결한다.

`applyTextEdits`는 UTF-16 line/character를 실제 관찰된 문서에 엄격하게 대응한다. 범위 밖 offset, surrogate pair 중간, 역전 범위, 겹치는 edit와 같은 위치의 모호한 insertion을 거부한다. 128 edit/1 MiB 결과 이내다. 변경하지 않은 BOM/CRLF는 그대로 남는다. formatter가 명시적으로 바꾼 text의 개행은 결과대로 사용한다.

fixture 4개는 UTF-16/BOM/CRLF와 range 오류, 승인 전 파일 보존 및 checkpoint, 취소/등록 해제, 외부 preimage 변경·binary 결과 거부를 확인한다. 실제 설치된 formatter나 사용자 파일을 실행하지 않는다.
