# MC2-03c: 승인한 파일·skill 게시

Moodcode의 독립적인 host knowledge generation으로 만든 pending candidate를 실제 파일에 게시·갱신·철회하는 경로다. 기존 workspace-document 게시와 함께 MC2-03c의 물리 파일 소비 경로를 제공한다. 다른 프로젝트 코드나 prompt를 복사하지 않았으며 fixture의 생성 결과와 검증 자료는 자체 작성했다.

`EngineOptions.knowledgeFilePublication: true`가 필요하다. 생성 자체는 기존 `knowledgeGeneration: true` 계약을 따른다. 기본값은 꺼져 있다. 모델 응답이나 candidate가 파일 권한을 자동으로 얻지 않으며, host가 원본 preview에 대해 `approved: true`를 전달해야 한다. 별도 coding Session/Run/Turn/tool/approval ID를 만들지 않는다.

## 실제 host API

- `captureWorkspaceKnowledgeTarget(workspaceId, path)`는 동기 물리 관찰과 native revision을 함께 읽는다. revision은 파일 자체나 부모 디렉터리의 device/inode/mode가 바뀔 때만 올라가며, 형제 항목 생성·삭제로 바뀌는 부모 디렉터리의 mtime/ctime만으로는 올라가지 않는다. 같은 경로의 prepared/dispatched owner가 있는 동안 관찰이 바뀌면 `KNOWLEDGE_FILE_BUSY`로 거부한다. 파일 철회 후에도 양의 absent revision을 유지한다.
- `previewWorkspaceKnowledgeFilePublication({ workspaceId, candidateId, expiresAt? })`와 `previewWorkspaceKnowledgeFileRevocation({ workspaceId, publicationId, expiresAt? })`는 원본 물리 관찰, before/after 전문, SHA, native head, 역사적 생성 증거를 묶는다. 디렉터리나 파일을 만들지 않는다.
- `publishWorkspaceKnowledgeFile` / `revokeWorkspaceKnowledgeFile`은 `{ workspaceId, requestId, approved: true, preview, signal?, budget? }`를 받는다. 원본 preview의 동일 객체만 유효하다. 복사·다른 Engine·해제된 preview는 실행 권한이 없다.
- `getWorkspaceKnowledgeFilePublication`, `getWorkspaceKnowledgeFilePublicationReceipt`, `getWorkspaceKnowledgeFileTarget`, `listWorkspaceKnowledgeFilePublications`는 workspace 범위의 이력을 조회한다.
- `releaseWorkspaceKnowledgeFilePublicationPreview`는 실행하지 않은 원본 관찰을 해제한다.
- `previewWorkspaceKnowledgeFileRecovery`, `acknowledgeWorkspaceKnowledgeFileRecovery`, `resumeWorkspaceKnowledgeFileAfterRecovery`는 불확실한 native frontier를 명시적으로 승인하고 별도로 재개한다. 승인 입력은 `{ workspaceId, requestId, approved: true, preview, reason }`이다.

## 실행·저장·복구

파일 처리 전에 현재 물리 root/storage, source, trust, target/head와 역사적 candidate/plan/generation/attempt/usage/cleanup을 대조한다. `prepared` native owner를 먼저 저장한 다음, 고유한 원본 공통 실행 marker의 예약을 primary DB에 기록하고 실제 `effects.sqlite` 잠금을 획득한다. 잠금이 사용 중이면 예약 전에 거부하고 owner를 취소한다. 예약 후 잠금 획득이나 dispatch 전 잠금 해제가 실패하면 marker가 남았을 수 있으므로 owner를 uncertain으로 남긴다. `dispatched`를 durable하게 저장한 뒤에만 mkdir/write/rename/unlink를 실행한다. 모든 실제 descriptor와 작업을 기다린 후 postimage/checkpoint/receipt/head를 하나의 primary transaction에서 저장한다.

파일 효과 이후 저장에 실패하면 성공 영수증을 만들지 않고 실제 checkpoint와 불확실 상태를 남긴다. 같은 request ID는 원래 완료 영수증만 반환하며, pending/dispatched/uncertain 요청을 자동 재실행하지 않는다. 기존 실행 owner나 workspace lease가 있는 동안 동시 승인은 거부되고, 완료 후 오래된 target 승인은 CAS에서 거부된다.

DB13은 파일 관찰·head·publication·checkpoint·receipt·recovery acknowledgment·workspace barrier 7개 테이블과 실제 실행 guard 테이블을 추가한다. legacy candidate에 workspace/id unique index를 추가해 새 composite FK의 실제 scope를 보장한다. migration은 원자적이며 기존 생성·coding 기록을 변경하지 않는다. archive 검증은 새 테이블의 bounded metadata와 역사적 관계를 검증하고 logical hash에 포함한다. import는 기존 knowledge pause를 유지하며 파일 효과나 모델 호출을 재실행하지 않는다.

정상 종료는 원본 preview/read/apply 작업과 workspace lease를 모두 기다린다. 강제 종료 후 일반 prepared owner는 효과 없이 취소하고, dispatch 또는 실제 잠금 획득이 증명된 owner는 uncertain으로 남긴다. 원래 예약과 정확히 일치하는 물리 marker만 복구 모드로 읽을 수 있다. 실제 owner PID가 살아 있거나 확인할 수 없으면 marker를 지우지 않는다. 죽은 owner의 정확한 marker는 승인된 native recovery transaction 안에서 대조 후 정리한다. ACK는 원래 uncertain 기록과 cleanup 관찰을 바꾸지 않으며, 별도의 fresh preview/resume가 필요하다. 다른 producer의 quarantine이나 import pause는 해제하지 않는다.

## 지원 범위와 한계

파일은 canonical workspace 안의 단일 링크 일반 UTF-8 텍스트이며 현재 읽기·출력 모두 16 KiB로 제한한다. `.git`과 `node_modules` 대상(대소문자와 HFS+가 무시하는 zero-width·bidi 제어 문자를 무시하고 비교), 점이나 공백으로 끝나는 경로 segment, Windows 8.3 short name 형태의 segment는 모든 플랫폼에서 거부한다. 일반 파일의 부모는 이미 있어야 한다. 새 부모 생성은 정확한 `.moodcode/skills/<id>/SKILL.md` 경로에만 허용한다. source/root/parent/file identity와 SHA를 각 실제 효과 경계에서 확인하며 symlink/hardlink 치환을 거부한다. 부분 생성한 부모를 자동으로 되돌리는 복구는 제공하지 않는다.

Node의 경로 기반 rename/unlink는 외부 writer와의 원자적인 OS hash CAS가 아니다. 관찰과 실제 syscall 사이의 외부 수정 가능성까지 차단한다고 주장하지 않는다. 공통 잠금은 이 Engine storage에 결속된 producer를 조정한다. 배포 환경의 원격 filesystem과 Windows 검증, imported knowledge의 명시적 재결속·activation(MC2-03d)은 별도 미완료 작업이다.

검증 결과와 동결 source SHA는 `engine-phase-two-file-publication-verification.json`에 기록한다.
