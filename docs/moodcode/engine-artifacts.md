# 엔진 아티팩트와 구조화된 도구 결과

E0-07/E4-02의 독립 기반 모듈이다. `ArtifactStore`는 GUI 없이 임시 디렉터리나 엔진 소유 저장 디렉터리에서 사용할 수 있다. 기존 command/read/patch 생산자는 아직 이 저장소로 전환하지 않았으며, runner의 저장·복구 연결은 별도 통합 작업이다.

## 계약

`ArtifactIdentity`는 sessionId/runId/toolCallId를 필수로, turnId/attemptId를 선택적으로 보유한다. 공개 `ArtifactReference`에는 저장 경로가 없고 ID·SHA-256·바이트 손실·보관 기한·완료 여부·결과가 있다. 소유자 검증은 선택 필드까지 일치해야 한다.

`ArtifactStore.open({directory, limits, retentionMs, now})` 이후 `put({identity, content, sourceComplete, outcome, metadata, signal})`로 문자열·바이트·비동기 스트림을 넣는다. 유한 입력은 producer loss를 정확히 계산하고, 중단·실패·스트림 조기 종료는 `producerTruncatedBytes:null`로 알 수 없는 전체 손실을 표현한다. completed 결과라도 저장 제한에 걸리면 complete는 false다. failed/interrupted 결과도 이미 관측한 내용을 보관해 검토할 수 있다.

producer 기본 제한은 16 MiB, 저장 제한은 8 MiB, model/display는 각각 32/64 KiB다. 개별 제한은 검증된 상한 안에서 변경할 수 있다. UTF-8 표시 문자열은 Unicode scalar 경계를 지키며, 원본 바이트는 그대로 저장한다. 관측량 = 저장량 + artifact 손실 + producer 손실은 producer 손실이 알려진 경우에만 성립한다. producer 손실이 null이면 관측량은 저장량 + artifact 손실 이상이다. 표시·모델 한도는 별도다. 스트림에는 chunk 수 제한이 있으며 정지한 생산자에는 호출자의 AbortSignal이 필요하다.

`read(id,{identity,offset,limit,signal})`는 제한된 원본 바이트 페이지를 반환한다. 페이지 요청마다 저장된 전체 SHA-256을 검증한다. `get`은 메타데이터 조회이며 내용 해시 검증을 하지 않는다.

`createToolResultEnvelope`는 displayContent/modelContent/structuredData/metadata/warnings/artifactRefs/outcome을 분리한다. 구조화된 데이터가 너무 크면 생략과 경고를 반환하고, 잘못된 JSON·순환·accessor는 거부한다. `projectToolResult`는 modelContent를 기존 content에 투영한다. `enrichLegacyToolResult`는 기존 content/data/artifacts를 유지하면서 additive structuredResult를 추가하므로 기존 소비자의 동작이 바뀌지 않는다.

`bindCheckpointArtifacts`는 기존 checkpoint의 실행 identity를 검증하고 공개 flat ArtifactCheckpointBinding을 만든다. 다른 run/call/turn/attempt와 중복 참조는 거부하며, 불완전 checkpoint 또는 artifact는 partial로 표현한다. 파일 전후 이미지나 복원 계약을 변경하지 않는다.

## 파일 저장과 보관

디렉터리와 파일은 각각 0700/0600으로 생성한다. 엔진이 UUID 파일명을 결정하며 model 입력을 경로로 사용하지 않는다. canonical root와 모든 기존 상위 디렉터리에서 symlink를 거부하고 root inode를 재검증한다. 파일 열기는 O_NOFOLLOW, 신규 파일은 O_EXCL이며 읽기는 regular file과 단일 hardlink를 검증한다. 원본·manifest를 staging 디렉터리에 fsync한 후 rename으로 함께 공개한다. 실패한 staging은 엔진이 정한 두 파일만 정리한다.

기본 보관은 7일이다. 만료 후 조회를 거부하고 `prune`이 제한된 개수의 엔트리를 조사해 검증 가능한 만료 아티팩트만 제거한다. 손상된 manifest·symlink·관련 없는 파일은 건드리지 않는다. 알 수 없는 파일이 아티팩트 디렉터리 안에 추가되면 알려진 파일만 정리하고 남은 retired 디렉터리는 보존한다. 비정상 종료로 남은 staging/retired orphan의 자동 복구는 아직 제공하지 않는다.

Node의 경로 기반 파일 API는 hostile same-UID 프로세스의 모든 동시 상위 디렉터리 교체에 대해 dirfd 수준의 원자적 격리를 제공하지 않는다. 이 저장소는 검사 가능한 symlink/hardlink/root 교체를 거부하지만 OS sandbox를 대신하지 않는다. O_NOFOLLOW 지원이 없는 플랫폼에서는 명시적으로 실패하며 Windows backend는 별도 구현이 필요하다.

## 검증

`node --import tsx --test packages/engine/src/artifacts/artifacts.test.ts`: 18개 테스트 통과. 재개방·SHA·권한·producer/store/display/model 독립 제한·UTF-8·페이지·unknown loss·생산자 실패·비협조적 취소·빈 chunk 제한·만료/prune·소유자·manifest/content 변조·symlink/hardlink/root inode 교체·잘못된 JSON·staging 정리·호환 projection·checkpoint 결합을 검증했다. 실제 producer wiring과 전체 엔진 통합 테스트는 별도다.
