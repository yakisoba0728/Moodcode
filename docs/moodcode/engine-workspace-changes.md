# 워크스페이스 변경 관찰과 도구 귀속

`WorkspaceChangeHub`는 워크스페이스 파일의 관찰된 상태와 도구가 저장한 체크포인트를 연결한다. 파일을 수정하거나 포맷터를 실행하지 않는다. 외부 편집기 변경과 도구 변경을 하나의 `changeId`·`documentVersion`으로 관리하며, 체크포인트와 현재 파일 내용을 별도로 확인한다.

## 호스트 연결

- `watch(workspace, { signal? })`는 최초 관찰을 완료한 뒤 반환한다. 같은 워크스페이스 ID·루트의 중복 호출은 하나의 watcher를 공유한다.
- `recordCheckpoint({workspace, sessionId, runId, toolCallId, turnId?, attemptId?, checkpoints, signal?})`는 도구 소유권과 체크포인트 콘텐츠 해시를 검증하고 현재 파일을 다시 읽는다.
- `subscribe(workspaceId, afterSeq?, signal?)`는 변경 이벤트를 순서대로 전달한다. `replay`는 보존 중인 이벤트를 페이지로 반환한다.
- `getDocument(workspaceId, path)`는 관찰된 해시·바이트 수·문서 버전을 반환한다.
- watch의 `close()`와 Hub의 `close()`는 poll, 실행 중인 관찰, 대기 중인 작업 및 구독을 정리한다.

`RunCoordinator.onToolCheckpoint`는 도구 실행과 cleanup이 정산된 뒤 immutable 체크포인트의 복사본과 실제 실행 소유권을 전달한다. 콜백은 시간 제한을 가지며, 실패는 `workspace.observation_failed`로 기록한다. 관찰 실패가 완료된 도구 효과를 다시 실행하거나 실제 cleanup uncertainty를 성공으로 바꾸지 않는다.

LSP 연결은 구독의 `type === 'change'`만 `LspManager.fileChanged`로 전달한다. `attribution`은 이미 알려진 변경에 소유권이 추가된 사건이므로 같은 문서 버전의 LSP 알림을 다시 보내지 않는다.

## 변경 규칙

첫 스캔은 이미 존재하는 파일을 문서 버전 1로 등록하고 변경 이벤트는 만들지 않는다. 새 파일은 버전 1의 생성 이벤트를 가진다. 이후 수정·삭제·재생성은 같은 경로의 버전을 증가시킨다.

체크포인트가 먼저 처리되면 현재 해시가 `afterHash`와 일치하는 전이를 기록한다. 뒤늦게 watcher가 같은 파일 상태를 관찰해도 새 변경을 만들지 않는다. 외부 관찰이 먼저 처리되면 동일 경로·`beforeHash`·`afterHash`의 기존 변경에 도구 소유권을 추가하고 `attribution`을 발행한다. 정확히 같은 체크포인트 재전달은 멱등적이며 ID를 다른 콘텐츠나 소유권으로 재사용하면 거부한다.

체크포인트 이후 외부 프로세스가 파일을 덮어썼다면 현재 내용을 도구에 귀속시키지 않는다. `CHECKPOINT_CHANGE_SUPERSEDED`를 기록하고 실제 현재 상태를 외부 변경으로 관찰한다. 이미 기록된 다른 시작 해시의 전이를 오래된 체크포인트로 덮어쓰거나 같은 현재 상태의 문서 버전을 중복 증가시키지 않는다. 보존된 과거의 정확한 전이에는 늦은 소유권 정보가 연결될 수 있으며, 이는 현재 파일이 그 과거 상태라는 주장과 구분한다.

## 범위와 제한

기본 상한은 워크스페이스 8개, 문서 4,096개, 대기 작업 64개, 구독 16개다. 체크포인트 배치는 파일 128개·콘텐츠 8 MiB 이하이며, 최근 체크포인트 32개만 멱등성 캐시에 남긴다. 이벤트 이력은 1,024개·256 KiB, 구독 대기열은 각각 64 KiB로 제한한다. 호스트는 상한을 낮출 수 있다. 느린 구독자는 `WORKSPACE_CHANGE_BACKPRESSURE`로 종료되며 다른 구독과 도구 실행을 막지 않는다. 이미 삭제된 이벤트를 요청하면 `WORKSPACE_CHANGE_CURSOR_EXPIRED`가 발생한다.

관찰 대상은 정확한 상대 경로의 단일 링크 일반 UTF-8 파일이며 파일당 1 MiB 이하이다. Git 메타데이터·의존성 디렉터리, 심볼릭 링크, 바이너리·과대 파일 및 불안정한 읽기는 `incomplete`로 표현한다. 읽지 못한 파일을 삭제로 보고하지 않는다. canonical 루트의 inode/device도 재확인하므로 같은 경로의 워크스페이스 교체를 기존 소유권으로 관찰하지 않는다.

Hub의 `seq`, 변경 ID, 문서 버전 및 귀속 이력은 현재 프로세스의 bounded 관찰 상태다. 재시작 시 새 baseline을 만든다. 내구성 있는 원본 효과 증거는 기존 Run·도구·체크포인트 저장소에 남는다. watcher의 coalescing이나 상한 때문에 모든 외부 중간 상태를 복원한다고 주장하지 않는다.

## 검증

실제 임시 Git 저장소 기반 focused 테스트 9개가 도구 선행/외부 관찰 선행, 지연 poll 중복 제거, 실제 현재 해시 재검증, 생성·삭제·재생성, 소유권·해시 충돌, 과거 전이 오귀속 방지, root·symlink 교체, 이력/구독 byte bound, 취소·close 및 listener 정리를 확인했다. native 실행 테스트에는 도구 정산 후 콜백 호출과 관찰 실패가 효과 결과를 보존하는 검증을 추가했다.

부모 Run은 자식 예약을 실제 남은 `turns`·`toolCalls`·`outputBytes`·deadline과 비교한다. 예약된 절대 상한은 부모 후속 소비에서 차감하며 환급하지 않는다. 자식은 실제 부모 signal을 공유한다. 취소 시 즉시 신호를 받고, 정상 완료 시 provider·도구 정산 이후 신호를 받는다. 실제 reasoning·summary·model handoff 소비량을 `getRunUsage`로 조회한다. 이 API의 terminal usage는 최근 256개만 보존하며, 보존하지 않은 실행의 소비량을 transcript로 추정하지 않는다.
