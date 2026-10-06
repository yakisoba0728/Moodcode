# Managed worktree 경계

`WorktreeManager`는 명시한 Git ref를 SHA로 고정한 뒤 detached worktree를 만든다. 부모 checkout의 미커밋 내용은 옮기지 않는다. branch 생성·reset·commit·강제 삭제는 수행하지 않는다. 관리 디렉터리는 canonical 부모 workspace 밖이어야 하며 symlink 조상을 거부한다.

호스트는 `{ directory, documents, boot?, bootTimeoutMs? }`로 생성한다. `documents`는 기존 session document CAS port이다. `create({ sessionId, requestId, workspace, reference? }, signal)`의 같은 요청 ID와 같은 입력은 기존 기록을 반환한다. 동시 요청도 Git 준비를 중복 실행하지 않는다. 요청 입력은 비동기 관찰 전에 복제한다.

`engine.worktrees` document는 `creating → booting → ready`와 실패·정리 상태를 보관한다. Git dispatch 전에 creating, boot callback 전에 inode/device를 포함한 booting을 저장한다. 준비와 boot의 완료는 작업 실행 완료를 의미하지 않는다. Git 부분 실행·취소·boot timeout은 uncertain으로 남기고 경로를 보존한다. `recover(sessionId)`는 끊긴 creating/booting/cleaning을 uncertain으로 바꾸며 Git을 다시 실행하지 않는다. `close()`는 진행 중 create/boot를 취소하고 1초 내 종료를 확인하지 못하면 `WORKTREE_CLEANUP_UNCERTAIN`을 반환한다. boot 기본 deadline은 30초다.

`verify(record, signal)`는 journal ownership, root/base identity, inode/device, canonical path, Git common directory를 검사한다. 변경 내용을 안전하게 제거할 수 있다는 보장은 별도이다. `cleanup`은 관찰 시점의 owner/revision이 유지되고, detached HEAD가 기준 SHA이며, tracked/untracked/ignored 변경이 없을 때만 `git worktree remove`를 호출한다. `--force`를 쓰지 않는다. 이동한 HEAD와 사용자 branch, 새 커밋, dirty 파일을 보존한다.

`claimOwnership(sessionId, id, ownerId)`는 ready worktree를 실행 하나에 배정한다. owner가 있으면 cleanup을 거부한다. `releaseOwnership`은 해당 실행의 종료를 확인한 호스트만 호출한다. uncertain owner는 재시작으로 지워지지 않는다. 관리자 복구 시에도 실제 실행 종료를 먼저 확인해야 한다.

Git 명령은 기존 shell 없는 `runGit`을 사용한다. 일반 Git 설정과 checkout hook의 실행은 사용자 Git 환경에 속하며, 이 모듈이 OS sandbox를 제공하지 않는다. worktree 생성과 정리는 모델의 임의 경로 입력을 그대로 실행하는 도구가 아니라 명시적 호스트 API이다.

검증: 실제 임시 Git 저장소 9개 fixture는 생성/boot 실패/재시작/dirty 및 커밋 보존/취소·timeout/위조 base identity/동시 요청을 확인한다. 사용자 저장소나 계정에 접근하지 않는다.
