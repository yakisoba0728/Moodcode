# Managed child 저장과 보관의 확인 범위

2026-10-07의 고정 checkout과 Moodcode 임시 엔진을 읽었다. 공개 구현·프롬프트·테스트를 복사하지 않았다. upstream 앱을 실행하거나 제품 전체의 보관 보장을 검증하지 않았다.

OpenCode checkout의 HEAD는 `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`이며 working tree는 깨끗했다. [Session schema](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/schema/src/session.ts)는 parent ID와 location을 별도 기록한다. [Session execution](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/core/src/session/execution.ts)은 해당 location의 runner로 실행을 라우팅하며 이 process가 소유한 active execution의 관측·중단을 구분한다. 이 제한된 읽기는 외부 DB 파일의 소유권이나 자식 아카이브의 원자성을 증명하지 않는다.

Codex checkout의 HEAD는 `0b863c69f50335acd92164aab971cb58d298c2fe`이며 working tree는 깨끗했다. [Writer lock](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/rollout/src/writer_lock.rs)은 thread writer와 파일 publication의 수명을 coordination lock으로 연결한다. [Rollout reference index](https://github.com/openai/codex/blob/0b863c69f50335acd92164aab971cb58d298c2fe/codex-rs/rollout/src/rollout_reference_index.rs)는 파일 후보를 제한한 뒤 내용의 owner를 확인하고, 부분 reference count를 삭제·압축의 근거로 사용하지 않도록 구분한다. Moodcode는 Rust 파일 잠금이나 rollout 구조를 가져오지 않고 자체 SQLite owner lease와 immutable 읽기 계약을 만든다.

Amp·Claude Code의 별도 child 문맥·역할별 도구와 worktree 동작은 [이전 공개 문서 조사](2026-10-07-delegation.md)를 따른다. Pi의 원본 이력과 완전한 exchange 보존은 [이력 조사](2026-10-07-context.md)를 따른다. 이번 확인에서 두 비공개 제품의 실제 DB·보관 구현을 추정하지 않았고 Pi checkout의 SHA를 새로 인증하지 않았다.

Moodcode `53241e712b0cd175621bc658340679eed7b23e47`의 실제 임시 parent/child 엔진은 root task journal에 child Run ID를 남겼지만 child session·물리 DB·artifact 경로를 영속 결합하지 않았다. root archive는 child SQLite를 일반 artifact 파일로 복사했다. 자식 document owner를 바꾸거나 같은 크기의 blob을 변조해도 root archive 검증이 통과했고, root lease를 보유해도 child DB의 독립 writer는 수정할 수 있었다. 이 관측은 baseline fixture의 결과이며 원격 모델 호출이나 실제 사용자 프로젝트의 손상 사례가 아니다.

읽기 전용 SQLite connection도 원래 WAL DB의 sidecar를 만들 수 있음을 임시 파일로 확인했다. 기존 DELETE owner 파일의 read transaction은 Moodcode writer의 exclusive owner 획득을 막았고 원본 파일을 쓰지 않았다. 종료·checkpoint가 확인된 child만 owner lease 아래 private mirror로 복사해 immutable URI로 읽는 범위를 구체화한다. 실제 byte/hash·bounded metadata와 coverage, source/historical 구분은 G1-22의 구현·검증 보고서에서 확정한다. 부분 진단이나 오래된 binding을 cleanup·재실행·소유권 재인증 근거로 사용하지 않는다.
