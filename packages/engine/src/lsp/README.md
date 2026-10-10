# Engine LSP port

공식 [LSP 3.18 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.18/specification/)과 [initialize/encoding 정의](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.18/general/initialize.md)를 확인하고 필요한 경계만 자체 구현했다. Content-Length JSON-RPC, initialize/initialized, UTF-16 document sync와 진단·formatting, shutdown/exit를 지원한다. protocol version negotiation은 없으며 실제 server capability를 확인한다.

호스트는 `LspManager.register(serverId, factory)`로 명시적으로 server를 등록한다. workspace/server당 startup promise를 공유하므로 동시 파일 요청이 중복 spawn하지 않는다. 한 caller의 취소는 공유 startup을 취소하지 않는다. factory는 manager 소유 AbortSignal을 받고, manager 종료 후 늦게 생긴 connection도 close한다. 기본 startup/request는 5초, cleanup은 1초이며 constructor에서 bounded deadline을 지정할 수 있다. 미확정 종료는 `LSP_CLEANUP_UNCERTAIN`으로 드러난다. 시작 실패나 연결 종료로 닫힌 server는 cleanup deadline이 지나기 전까지 같은 실패를 반환하고, 그 뒤의 호출에서 새로 시작한다. 교체된 server의 정리도 manager 종료 때 확인한다.

`StdioLspConnection.open({ command, args?, cwd, env? })`는 명시한 absolute executable과 argv만 실행한다. shell을 쓰지 않는다. 기본 환경은 PATH와 Windows SystemRoot만이며 stderr를 보관·반환하지 않는다. framing은 4 KiB header/1 MiB message, pending request 32개, listener 16개로 제한한다. JSON node/depth 상한을 넘는 응답은 그 요청만 `LSP_FRAME_LIMIT`로 거부하고, 상한을 넘는 notification은 버리며 연결은 유지한다. JSON batch/잘못된 UTF-8/중복 Content-Length를 거부한다. 요청 cancel/timeout은 `$/cancelRequest`를 보내고 늦은 reply를 다른 요청에 연결하지 않는다. server→host request는 capability unavailable로 응답하고 applyEdit/executeCommand를 실행하지 않는다.

POSIX에서는 전용 process group에 TERM/KILL을 보내며 부모가 먼저 종료되어 남긴 descendant도 정리한다. Windows는 direct child 종료만 제공한다. Windows process-tree 종료 보장은 별도 backend 검증 없이 주장하지 않는다. 등록된 language server 자체가 실행할 수 있는 OS 권한을 이 transport가 sandbox하지는 않는다.

`updateFile(workspace, serverId, exactPath, languageId, signal)`는 안전하게 관찰한 UTF-8 text의 hash와 UTF-16 version을 관리한다. full 및 incremental sync에서 전체 범위 replacement를 지원한다. 문서는 128개, 문서 하나 512 KiB, workspace/server 합계 8 MiB 이내이다. UTF-8 position encoding, text sync None, open/close 미지원은 명시적으로 거부한다. `fileChanged`가 created/changed/deleted event를 받아 sync/close와 watched-files notification을 연결한다. 자동 filesystem watcher는 없다. 엔진의 checkpoint/revert/호스트 파일 관찰자가 이 메서드를 호출해야 한다.

진단은 등록 workspace의 열린 정확 URI만 받고, document version/hash에 묶인다. 과거/future version, 다른 URI, 무효 range와 budget 초과를 버린다. version 없는 진단은 첫 version에서만 허용한다. 갱신 후 unversioned 결과의 최신성을 증명할 수 없어 보수적으로 제외한다. 128 diagnostic/64 KiB, message 4 KiB 이내다. 모델 입력에는 호스트가 이 snapshot을 명시적으로 선택해야 한다.

`formatting`은 synchronized version과 실제 파일 hash가 응답 뒤에도 일치할 때만 proposal을 반환한다. server capability가 없으면 unsupported이다. UTF-16 range·겹침·surrogate/CRLF 경계를 확인하고 최대 128 text edit를 text로 합성한다. `createLspFormatTool(manager)`는 이 proposal을 승인 및 기존 checkpoint patch에 연결한다. formatting 요청 자체는 파일을 수정하지 않는다.

실제 stdio fixture와 host fake 테스트가 spawn dedup, doc update/현재 진단, BOM/CRLF format/checkpoint, cancel/timeout, malformed/oversized frame, server 편집 요청 차단, 환경 격리, POSIX descendant 종료, startup late cleanup, unsupported capability, 외부 파일 변경, shape 상한 초과 응답, crash와 startup 실패 뒤 재시작을 확인한다.
