# ScopedToolRuntime

기존 ToolDefinition/runner 승인·취소·checkpoint를 유지하는 additive 공통 lifecycle이다.

- register(scopeId,tool,{effect,revalidate})는 중복 이름을 거부하며 disposer/clearScope로 등록 identity를 해제한다. scope 128개, scope당 도구 256개, schema 64 KiB 한도가 있다.
- catalogue(scopeId,mode)는 도구·policy revision과 실제 handler를 함께 capture한다. resolve(catalogue,name)는 registry/policy 교체·해제·위조된 handle·광고 schema 변경을 거부한다. 기존 runner용 delegate는 prepare 시 새 catalogue를 capture한다. 모델 광고 시점과 prepare 사이의 stale 보장을 원하면 같은 catalogue의 resolve 결과를 실행에 사용해야 한다.
- prepare는 leaf의 opaque prepared를 유지하면서 fingerprint/preview/identity를 외부 wrapper에 결합한다. configured deny를 먼저 평가하고 unknown 효과는 승인을 요구한다. execute는 one-shot, revision, preview/input 및 session/run/call/turn/attempt를 재검증한다. executeApproved는 headless 사용에서 ApprovalPort를 호출한다. delegate.execute는 기존 runner가 이미 승인을 검사한다는 기존 계약을 유지한다.
- read/state/write/execute/network/unknown 효과가 있다. Plan은 read/state를 허용하며 state라도 leaf가 승인 요청하면 이를 유지한다. resource rule은 정확한 `path:...`, `command:...`와 path의 `/**` 하위 범위를 지원한다. resource별 deny는 catalog에서 도구 전체를 숨기지 않고 prepare와 execute에서 적용한다. 현재 path/destination/cwd/changes/command의 정형 입력만 resource identity로 추출하며 arbitrary plugin의 미신고 효과를 발견하는 sandbox는 아니다.
- 정책 수정은 새 version으로 기존 요청을 무효화한다. scoped grant는 workspace/session/tool/effect/exact resources/policyversion/expiry/remainingUses/revision에 결합한다. grant를 쓰려면 등록자가 opaque prepared의 실제 preimage를 재검증하는 callback을 제공해야 한다. callback 이후 grant 취소·만료·version을 다시 확인하고 consume한다. 선택적 GrantDocumentPort를 전달하면 session document CAS로 허용·소모·철회를 보관하며 재시작 후 복원한다. CAS 충돌은 cached grant를 무효화하고 효과 전에 실패한다. command identity는 원문 대신 SHA-256으로 저장한다. persistence port를 생략하면 memory-only다. 기존 runner가 effectclass마다 별도 승인 gate를 적용하면 그 gate를 우회하지 않는다.
- optional ArtifactStore를 넣으면 반환된 content를 bounded artifact로 보관하고 refs/warnings를 추가한다. 기존 content/data/artifacts는 호환 유지한다. 이미 잘린 legacy producer의 원문을 복구할 수는 없다. 실제 engine producer wiring은 별도 통합이다.

정확 편집은 fuzzy match 없이 oldString이 정확히 한 번 나타나는 경우만 변경한다. 서로 겹치는 중복도 거부한다. untouched BOM/CRLF는 그대로 보존하며 사용자가 명시한 newString의 줄바꿈을 임의 변환하지 않는다. patch adapter는 expectedHash, approval, checkpoint를 기존 apply_patch에 위임한다. rename은 목적지 create 다음 원본 delete이며 원자적 rename이 아니다. default-created permissions 외 executable/custom mode는 명시 거부한다. binary/directory/Git metadata/symlink/hardlink는 지원하지 않는다.

패턴 검색은 기존 Git ignore-aware list_files를 재사용하고, 정확한 no-follow UTF-8 파일 읽기를 한다. 전체 1000 files/8 MiB/200 matches 한도이며 regex/glob은 250 ms disposable worker에 실행한다. 정규식은 i/m/u만, glob은 *, **, ?만 지원한다. 줄과 열은 1-based, 열은 UTF-16이다. continuation은 같은 query/path/limit와 파일 내용 snapshot에 결합하고 process HMAC으로 보호한다. scan/result hard limit 또는 unreadable files이면 안전한 continuation 대신 요청 축소를 안내한다.

setIncludedScopes(base,[...scopes])는 host가 선택한 등록 범위를 합성하며 이름 중복은 setter와 뒤이은 등록 모두에서 거부한다. 포함 범위 교체·scope 제거는 captured catalogue를 무효화한다. Policy 초기 version은 규칙 SHA-256의 48-bit 정수로 다른 재시작 설정과 구분하고, 프로세스 내 replace는 version을 증가시킨다. 동적으로 교체한 policy의 새 grants는 재시작 뒤 보수적으로 재승인을 요구할 수 있다.

artifacts 옵션은 인스턴스/Promise/getter를 받으므로 synchronous engine constructor를 유지할 수 있다. 첫 실행의 settlement에서 지연 개방한다. 생산자 반환 후 projection/storage 실패는 기존 내용과 checkpoint를 보존하면서 failed outcome·effectsMayBePresent·warning을 돌려준다. producer를 다시 실행하지 않는다. repeatIdentity는 권한용 fingerprint와 별도로 opaque inner fingerprint/catalogue scope/revision/policy version을 사용해 정상화된 반복 읽기를 확인한다.
