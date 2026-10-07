# W3 승인형 지식 게시의 실제 엔진 연결

별도 `knowledgePublication: true`를 지정한 호스트에서 네이티브 workspace 문서를 게시·수정·철회할 수 있다. 생성 opt-in과 게시 opt-in은 별개다. 후보와 미리보기는 아직 활성 지침이 아니며 공급자·도구·코딩 Session/Run을 새로 만들지 않는다.

`captureWorkspaceKnowledgeDocumentTarget(workspaceId, key)`는 실제 문서 head를 읽는다. 최초 대상만 revision 0과 null hash이며, 게시·수정·철회는 각각 새 revision을 만든다. 철회도 양의 revision과 빈 본문의 SHA를 유지하므로 과거의 absent-target 승인으로 다시 덮어쓸 수 없다. Session document를 workspace 문서로 사용하지 않는다.

호스트는 `previewWorkspaceKnowledgePublication({workspaceId, candidateId})` 또는 `previewWorkspaceKnowledgeRevocation({workspaceId, publicationId})`로 원본 미리보기를 확보한 뒤 `publishWorkspaceKnowledge`/`revokeWorkspaceKnowledge`에 `{workspaceId, requestId, approved: true, preview}`를 전달한다. 미리보기에는 실제 후보·완료 generation/attempt·trust·source·현재 head·전후 본문·hash·원래 만료가 고정된다. 복제·다른 인스턴스·해제·getter/proxy 입력은 새 게시 owner나 효과를 만들지 못한다.

DB12는 `knowledge_publications`, `workspace_document_revisions`, `workspace_document_heads`, `knowledge_publication_receipts` 네 STRICT 테이블을 추가한다. 실제 승인 owner의 검증 callback, source/trust/binding/target 재검사, head CAS, 문서 revision, 완료 owner와 영수증을 한 primary SQL 트랜잭션에서 반영한다. 기존 문서 수정도 처음 게시와 동일한 승인 흐름과 정확한 target revision을 요구한다. exact request 재전송은 원래 영수증을 관측하며 현재 head를 다시 적용하지 않는다.

원래 generation target은 게시 후 preimage가 달라진다. 게시 이력 조회·철회·archive는 이를 다시 검사하는 `readEvidence` 대신 불변 후보와 완료 producer의 역사 tuple 및 실제 게시 문서를 검사한다. generation의 후보 marker도 `recorded`와 정확한 candidate ID여야 게시할 수 있다. 후보 append 직후 marker 저장 전에 강제 종료된 경우 먼저 명시적 후보 마무리를 수행해야 한다. 이를 actual SIGKILL로 재현하고, 이후 게시·반복 마무리·철회·archive가 원래 generation hash를 바꾸지 않는 회귀를 추가했다.

게시 전 취소·만료는 효과를 만들지 않는다. 실제 SQL COMMIT 이후 취소는 원래 완료 문서와 영수증을 보존한다. 재시작은 남은 prepared owner를 cancelled로 전환하고 자동 적용하지 않는다. publish/revoke 각각 prepare·COMMIT 직전·COMMIT 성공 직후의 여섯 actual SIGKILL 경계를 검증했다. 철회는 정확한 현재 활성 게시를 제거하는 작업이므로 원래 source가 삭제·변경되거나 trust가 deny로 바뀌어도 허용하되, physical binding·pause·활성 head와 역사 producer는 일치해야 한다.

archive는 각각의 row hash뿐 아니라 완료 producer/후보/게시/문서 predecessor/head/영수증의 실제 관계도 검사한다. 크기 metadata를 확인하기 전에 본문을 가져오지 않는다. import는 완료 게시·문서·영수증의 원래 역사 hash를 보존하고 workspace 지식을 paused로 남긴다. 남은 prepared owner는 startup 복구에서 cancelled로 전환할 수 있으며 문서 효과를 다시 적용하지 않는다. read-only 게시·문서·영수증 조회 및 제한된 페이지를 제공하며 자동 게시·provider 재호출·대기 입력 시작은 없다.

검증은 source 316개 통과, 전체 엔진 3,358개 통과·실패 0개·기존 Windows 조건부 제외 2개, typecheck 통과, scripted headless fixture 3개 통과다. 실제 Engine 경계는 승인·수정·철회 검사 31개, publish/revoke SQL COMMIT 전후 SIGKILL 6개, 후보 append/marker SIGKILL 1개로 검증했다. [이번 검증 기록](engine-phase-two-knowledge-publication-verification.json)에 source/test hash와 게이트 결과를 저장한다.

이번 범위는 실제 SQL workspace 문서 경로다. 파일·skill 파일의 생성/덮어쓰기/물리적 철회는 실제 OS publication 어댑터가 준비될 때까지 typed unsupported로 남긴다. 따라서 MC2-03c는 진행 중으로 유지한다. 활성 ContextPlan projection과 import 이후 명시적 지식 복구는 MC2-03d에 남아 있으며, 전체 완료 수는 17/80이다.
