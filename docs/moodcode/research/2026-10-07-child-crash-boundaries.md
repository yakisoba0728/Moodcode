# Child crash 경계와 읽기 수명 조사

2026-10-07, Moodcode source `9bf0e7f`와 앞서 고정한 공개 checkout을 읽었다. G1-23의 실제 SIGKILL 검증·reader 수명 개선은 `bd14b32`에서 완료했으며 결과는 [최신 검증](../engine-goal-verification.md)으로 확정한다. 공개 구현·프롬프트·테스트를 복사하지 않는다.

OpenCode `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`의 [Session execution](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/execution.ts)은 해당 process가 소유한 active 실행과 location runner를 구분한다. 같은 checkout의 [V2 LLM runner](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/runner/llm.ts)는 주석에서 durable status·continuation recovery와 retry policy를 별도 후속 범위로 표시한다. 이것은 그 파일의 구현 상태·주석을 읽은 결과이며 legacy V1이나 제품 전체의 crash 지원을 판정한 결과가 아니다.

Codex `0b863c69f50335acd92164aab971cb58d298c2fe`의 [Writer lock](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/rollout/src/writer_lock.rs)은 thread writer의 획득·publication·guard 정리를 coordination namespace로 연결한다. Guard drop 코드와 stale 파일 검사는 공개 소스에서 확인했지만 Codex 자체에 SIGKILL을 가하거나 서버 실행 종료를 검증하지 않았다. Amp·Claude Code의 비공개 영속 저장 구현은 추정하지 않는다. 이전 [위임 조사](2026-10-07-delegation.md)와 Pi [이력 조사](2026-10-07-context.md)의 제한을 유지한다.

Moodcode의 준비/admission/종료는 한 commit이 아니다. 실제 경계는 다음과 같다.

| 단계 사이 | 보존할 증거 | 재시작에서 금지할 추론 |
|---|---|---|
| root prepared → child prepared mirror | partial binding 또는 binding 부재 | mirror 자동 보충·typed owner 인증 |
| child durable Run → root/child admitted | exact request/Run ID와 phase 차이 | provider 자동 dispatch·close proof 발급 |
| 실제 child partial dispatch | native 부분 출력·usage·cleanup·기존 ACK | 완료 결과·원격 취소·billing 확정 |
| child terminal → close → root task outcome | terminal child 원문과 root close/task 상태 | 결과 재구성·unknown task 완료 승격 |
| root outcome → worktree release | 결과·usage·close와 남은 owner | 자동 owner 해제·실행/삭제 권한 인증 |

정상 close 뒤 재시작이나 Map의 write exception fixture는 실제 강제 종료와 구분한다. SIGSTOP 상태의 SQLite owner가 다른 writer를 막는지 먼저 확인하고, 부모 테스트가 SIGKILL한 뒤 reopen·exact retry·phase/native 증거·call/effect/ACK count를 확인한다. Root의 interrupted 복구와 명시적인 child journal recover도 구분한다. Task가 terminal이어도 문서 감사의 complete는 worktree cleanup 완료를 뜻하지 않는다.

[SQLite URI](https://www.sqlite.org/uri.html)는 `immutable=1`에서 읽기 전용으로 열고 locking/change detection을 생략한다고 명시한다. 그래서 원래 변경 가능한 child DB에 이 옵션을 붙이지 않는다. [Node SQLite backup](https://nodejs.org/api/sqlite.html#sqlitebackupsourceDb-path-options)은 열린 attached source DB를 이름으로 지정할 수 있다. 현재 웹 문서는 Node 26.10.0을 표시했으며 이번 로컬 실행은 Node 26.9.0이다.

별도 authored temp SQLite 실험은 macOS arm64/Node26.9에서 private immutable attachment를 연 뒤 pathname을 unlink하고도 1,048,597 bytes의 원문 조회와 `backup(source:'child')`가 성공하고 source SHA가 유지됨을 확인했다. 로그는 `/tmp/moodcode-g123-anonymous-mirror-experiment.log`다. 이것은 실제 child reader의 검증을 대체하지 않으며 Linux·Windows·복사 도중 중단까지 성공했다고 주장하지 않는다. 열린 reader 반환 이후 큰 임시 복사본이 hard kill 뒤 pathname으로 남는 범위를 줄일 후보로 검증한다.

실제 child reader의 열린 handle 조회/backup·여러 lease·writer 재획득을 확인했고, 반환 뒤 kill의 pathname 잔존 0과 복사 도중kill의 partial 262,144B 잔존을 구분했다. 원본 DB/owner/artifact stat·SHA는 reader에서 변경하지 않았다. 일반 stale 검색·자동삭제는 추가하지 않았다. [최신 검증](../engine-goal-verification.md)의 실제 로그/SHA·OS 범위를 따른다.
