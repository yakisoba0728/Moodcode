Archive 문서 증명 시간 예산

큰 archive의 export는 child DB mirror, 문서 증명, artifact 복사·재검증과 게시 직전 원본 확인이 기존 단일 문서 read frame의 2초를 공유한다. 첫 실제 CI에서 대형 보관 fixture가 이 deadline을 초과했다. 호스트가 해당 증명 예산을 명시적으로 선택할 수 있게 했다.

`exportEngineArchive`, `validateEngineArchive`, `importEngineArchive`는 `archiveDocumentBudgetMs?: number`를 받는다. 기본값 2,000ms와 정수 1~30,000ms 범위를 사용한다. Proxy·accessor·비정수·범위 밖 값은 `INVALID_ARCHIVE_DOCUMENT_BUDGET`으로 파일 작업 전에 거부한다. 공개 `ArchiveDocumentBudgetOptions`와 `ValidateEngineArchiveOptions` 타입을 engine index에서 제공한다.

이 값은 기존 document proof frame에 적용하며 전체 archive 작업의 wall-clock timeout은 아니다. 일반 reader와 live/historical inspector의 2초 상한은 유지한다. archive 전용 factory만 제한된 시간 확대를 선택하며 metadata·refs·rows·child 수·DB/mirror bytes는 기존 상한이다. 한 frame의 deadline을 중간에 재설정하지 않는다. 원본/소유권·단일 capture·취소·hash·최종 게시·실패 staging 정리·import pause/no replay 계약도 유지한다.

큰 CI child-document fixture와 coding-batch archive fixture는 호스트 옵션을 명시적으로 30,000ms로 선택한다. 기존 collector 횟수·원본 문서·import 이력·실행 재생 없음 assertion은 유지한다. 테스트 skip이나 전체 공통 시간 제한 변경으로 실패를 숨기지 않는다.

실제 native engine·managed child·Git·PDF·2MiB artifact를 사용하는 신규 검사 8개에서 기본 deadline의 실패/부분 파일 정리, 명시 예산의 export→validate→import 소비, finite deadline, 취소, PDF 원본 무결성, 일반 inspector 상한을 확인했다. 최종 source 8/8·scoped strict/noUncheckedIndexedAccess 통과다. 인접 reader/archive/CI fixture 63/63은 최종 테스트 1줄 타입 수정 전 증거이며 동일 production SHA를 사용한다. 최초 통합 컴파일에서 fixture Buffer index 타입 오류가 드러났고, 해당 1줄을 수정해 최종 source 및 통합 build를 재검증했다.

[최종 6파일 동결](engine-archive-document-budget-source-freeze.json)·[독립 검토](engine-archive-document-budget-independent-review.json)를 따른다. 새 Linux/macOS/Windows hosted 성공은 후속 실제 Actions 결과로 판정하며 로컬 검사로 대체하지 않는다.
