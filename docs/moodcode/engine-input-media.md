# 이미지 입력 저장소와 provider 경계

`ImageAttachmentStore`는 host가 제공하는 bounded `Uint8Array`만 받아 immutable blob과 reference를 만든다. model tool이나 문자열 URL/path로 이미지를 불러오는 기능은 없다. `kind`, MIME, byte count, SHA-256, opaque ID가 reference의 전부이며 파일 경로와 base64를 공개하지 않는다.

```ts
const images = new ImageAttachmentStore({
  directory: join(artifactDir, 'input-media'),
  documents: sqliteStore,
});
const attachment = await images.import(sessionId, imageBytes, 'image/png', signal);
// SubmitInput/AcceptInput/Run/Message에 attachment 참조만 전달한다.
const resolvedImages = await images.resolve(sessionId, [attachment], signal);
// ProviderMessage.attachments와 TurnRequest.resolvedImages를 dispatch 직전에 연결한다.
```

`documents`는 `getSession`, `getWorkspace`, `getSessionDocument`, `putSessionDocument`의 구조적 port다. SQLite session document `input_images`에는 version 1, `{sessionId, workspaceId, workspaceRoot}` owner, accepted reference 배열만 저장한다. import와 resolve마다 현재 세션/workspace와 document owner를 비교한다. 같은 workspace의 다른 세션도 기존 이미지를 읽을 수 없다. import가 반환한 reference나 resolve 결과를 변경해도 SQLite index는 바뀌지 않는다.

| 보호 예산 | 기본 상한 |
| --- | --- |
| 이미지 한 개의 원본 bytes | 512 KiB |
| 입력/dispatch에 전송하는 image occurrence | 4개 |
| 입력/dispatch decoded bytes 합계 | 1 MiB |
| 세션 index에 등록되는 이미지 | 32개 / 16 MiB |
| 선언된 한 변 / pixel 수 | 8192 / 16,777,216 |

host는 `limits`로 상한을 더 낮출 수 있다. 고정 hard bound보다 높일 수는 없다. 초기 값은 자체 resource 보호 정책이며 vendor 한도가 아니다. 요청의 예전 user 메시지에 남은 이미지도 dispatch 예산에 포함한다. 동일 reference를 여러 user turn에서 다시 보내면 occurrence·bytes를 각각 계산하고 `resolvedImages`는 ID별로 하나만 받는다. history 이미지를 조용히 제거하거나 text로 대체하지 않는다. 이미지가 많아 한도를 넘으면 명시적으로 실패하며 history pruning 정책은 host가 선택해야 한다. 이미지 token 비용과 모델별 vision capability는 별도 정보가 없으면 unknown이다.

import는 caller bytes를 첫 await 이전에 복사하고 MIME/header/container/declared dimensions를 검사한다. 관리 directory와 기존 ancestors는 symlink를 거부하고 root dev/ino를 고정한다. blob은 생성한 이름만 사용하고 mode 0600으로 만든다. staging write/fsync 후 hardlink로 기존 destination을 덮어쓰지 않고 publish하고 staging link를 제거한 뒤 directory를 fsync한다. 최종 SQLite CAS가 성공해야 ref를 반환한다. 경쟁하는 index revision은 최대 8회 fresh CAS로 재검증하고 count/bytes 상한을 다시 적용한다.

이것은 SQLite와 filesystem을 하나의 transaction으로 묶는 구현이 아니다. blob publish 이후 CAS 이전에 crash가 나면 unindexed orphan이 남을 수 있다. 일반 실패나 commit 이전 취소는 생성한 동일 inode만 정리하고 index에 ref를 남기지 않는다. CAS 이후 취소는 이미 durable한 import 성공을 반환한다. 자동 orphan GC/retention/deletion API는 이번 구현 범위가 아니며 세션 index 한도는 누적 등록 이미지에 적용된다. blob을 삭제하는 maintenance는 ref index와 admission 중인 파일을 함께 고려해야 한다.

resolve는 ref의 정확한 모든 필드와 index를 비교하고 O_NOFOLLOW로 단일 hardlink의 regular file만 연다. ref.bytes를 기준으로 bounded buffer를 할당하고 hash, size, descriptor/path identity, mtime/ctime, MIME 구조를 확인한다. 마지막으로 현재 owner/index와 취소를 다시 확인하고 canonical base64를 반환한다. 원본 이미지의 가용성은 매 dispatch에서 재검증하므로 삭제·교체·손상은 새 요청을 실패시킨다. 같은 OS 사용자 또는 신뢰된 host가 storage directory와 SQLite 전체를 동시에 조작하는 경우를 격리하는 sandbox는 아니다.

MIME은 PNG/JPEG/WebP/GIF로 제한하고 GIF/APNG/WebP animation을 거부한다. 검사 범위는 bounded container와 header이며 pixel decoder가 아니다. SVG, HTML, remote URL, 사용자 path, file ID, audio/video/document 입력은 지원하지 않는다. PNG 압축/CRC와 JPEG/WebP compressed payload의 완전한 유효성은 보장하지 않으며 실제 모델 요청에서는 provider가 추가 검증할 수 있다. 로컬 resize/metadata 제거/decoder 실행은 없다.

provider 공용 projection은 user role의 attachment만 허용하고 각 ref와 resolved entry의 ID/MIME/bytes/hash를 정확히 비교한다. base64 길이·alphabet·padding·재인코딩 일치를 확인하고 decoded bytes의 hash/MIME/구조도 다시 검증한다. 누락·중복·unused resolved entry, extra path/property, 비정규 base64, role mismatch, 잘못된 hash는 dispatch 전에 실패한다. 이 projection 자체에는 SQLite가 없으므로 session ownership은 engine wrapper의 `resolve(sessionId,...)`가 담당한다.

| Adapter | 이미지 입력 형태 | 출력 media |
| --- | --- | --- |
| Responses | user `input_image` + MIME data URL | 미지원 |
| Codex | 고정 host endpoint를 유지한 Responses delegate | 미지원; 실제 계정 이미지 실행 미검증 |
| Chat Completions compatible | user `image_url.url` + MIME data URL | 미지원 |
| Anthropic Messages | user image/base64 source | 미지원 |
| Scripted | `PROVIDER_UNSUPPORTED_INPUT` | 실제 이미지 처리 없음 |

이미지 없는 기존 text/native replay 요청 shape는 유지한다. adapter `inputModalities`와 Anthropic host metadata는 encoding 구현 범위이며 모든 지정 모델이 vision을 지원한다는 뜻이 아니다. 이미지 출력 block은 `PROVIDER_UNSUPPORTED_OUTPUT`이며 journal/display/model-content에 image bytes를 넣지 않는다. 실제 provider/model capability는 host 설정과 추후 별도의 검증이 필요하다.

archive는 artifactDir 전체를 opaque regular-file tree로 캡처하므로 `artifactDir/input-media` 배치를 사용한다. SQLite session document와 media blob이 같이 복원된다. `stateDirectory/input-media`처럼 artifacts의 sibling에 놓으면 현재 archive에서 빠진다. restore가 session/workspace identity 또는 root를 바꾸면 owner rebinding을 검증한 별도 migration이 필요하고 기존 document를 임의로 재소유할 수 없다. artifact prune는 UUID artifact directory만 대상으로 하므로 input-media tree를 지우지 않는다.

검증은 macOS arm64/Node 26의 실제 SQLite·filesystem fixture와 synthetic/mock HTTP로 수행했다. 새 store 24개/provider 31개 및 기존 5 provider 회귀를 포함한 source 346개가 통과했다. 이미지 파일의 실제 모델 인식, 외부 계정, production Codex credential, Linux/Windows 실행은 검증하지 않았다. [조사 근거](research/2026-10-07-media.md)와 `media/store.test.ts`, `media/provider.test.ts`가 재현 가능한 근거다.
