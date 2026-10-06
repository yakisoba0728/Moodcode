# 엔진 데이터베이스 마이그레이션

현재 primary DB 버전은 3이다. `storage/migrations.ts`의 append-only 목록이 지원 버전과 적용 순서를 함께 정의한다. v1은 기존 Run·입력·메시지·도구·승인·checkpoint·이벤트의 테이블과 제약을 그대로 생성한다. v2는 session 입력·제어·독립 이벤트·Turn·provider attempt·message Part·context revision·CAS 문서를 추가한다. 기존 `events.run_id`는 NOT NULL 외래 키이며 실행 전 입력은 nullable Run binding을 가진 별도 `session_inputs`와 `session_events`에 기록한다. 가짜 Run은 만들지 않는다.

파일 경로 정규화와 SQLite owner 획득은 기존 방식이다. 지원 버전을 넘는 DB는 connection의 WAL/synchronous 설정을 변경하기 전에 거부한다. 실패한 open은 primary와 owner 연결을 닫아 후속 소유자를 막지 않는다. migration에는 filesystem effect, provider 요청, 비동기 작업을 넣지 않는다.

미적용 migration 전체는 하나의 `BEGIN IMMEDIATE`에서 순서대로 실행된다. 각 단계 뒤에 framework가 `user_version`을 갱신하며, 마지막 SQLite integrity/foreign-key 검사까지 통과한 경우에만 commit한다. 중간 SQL 실패나 검사 실패는 전체 pending chain의 schema·record·version 변경을 rollback한다. 기존 호출자의 transaction을 가져다 쓰거나 foreign key enforcement가 꺼진 상태에서 시작하지 않는다. migration 함수는 내부의 신뢰된 코드이며 transaction·PRAGMA user_version을 직접 관리하지 않는다.

새 버전은 목록 끝에 연속 번호로 추가한다. 이미 배포된 migration을 고치지 않는다. 새 테이블과 backfill은 그 기능에 필요한 범위로 제한하고, Run의 terminal 상태·원본 메시지·native replay·승인 fingerprint·checkpoint 이미지와 hash·기존 이벤트 seq를 재해석하거나 재작성하지 않는다. migration 적용을 위해 승인이나 도구 실행을 반복하지 않는다.

v2 backfill은 v1 `inputs`를 원래 Run에 연결한 promoted 입력으로 추가하고 delivery를 queue로 기록한다. v1 request ID·input ID·Run ID·admitted seq는 유지한다. v2 이벤트 seq는 session별 독립 순서로 할당하며 기존 event cursor와 섞지 않는다. 이미 수락된 request ID의 prompt·정규화된 config·delivery가 다르면 충돌이며, pending 또는 cancelled 입력으로 v1 Run receipt를 만들어 주지 않는다.

`fixtures/v1-database.ts`는 변경 전 v1 writer에서 캡처한 고정 SQL/row fixture다. 현재 store나 migration으로 다시 만들면 이전 형식과의 호환 검증이 사라지므로 재생성하지 않는다. primary 9개 테이블의 31개 row, review 완료/중단/미완료 작업 3개, recovery ledger 확인 기록 1개를 포함한다. fixture loader는 현재 runtime writer를 호출하지 않고 저장된 schema와 row를 복원한다. 테스트용 workspace root만 다시 연결하며 복구 ledger의 원래 file-identity scope를 새 파일에 맞춰 위조하지 않는다.

호환 테스트는 v1 기록의 raw JSON·ordinal·FK·event cursor와 API projection을 함께 확인한다. 명시적 interrupted recovery는 active Run을 interrupted로 만들고 미완료 도구와 승인 상태를 정리하되 terminal Run과 checkpoint를 유지한다. 같은 복구를 다시 실행해 이벤트를 중복 추가하지 않는다. review의 checkpoint/run/session/workspace/fingerprint 및 outcome binding도 보존한다. 다른 파일에 복사한 ledger 확인은 새로운 파일의 미확정 상태를 해제하지 못한다.

`store.backup`은 primary DB의 일관된 SQLite snapshot이다. review DB와 recovery ledger를 포함하는 전체 아카이브라고 해석하지 않는다. recovery 진단은 primary v1·v2·v3를 읽고 원본의 실제 schema version으로 backup metadata를 기록한다. 기존 v1 ledger record의 metadata·acknowledgement·file identity scope를 새 버전으로 바꾸지 않는다. primary manifest의 미래 버전과 review의 지원되지 않는 버전은 거부한다.

검증 명령은 `node --import tsx --test packages/engine/src/storage/*.test.ts`다. E0-03/E0-04 구현 시점 71개, v2 inbox/execution/CAS/history 추가 시점 98개가 통과했다. 순차 적용, chain rollback, deferred FK 실패, future DB byte 보존, owner release, WAL backup, v1 기록·승인·checkpoint·복구·review·ledger 호환 및 실제 v1 recovery acknowledgement를 생성한 뒤 upgrade하는 검증을 포함한다. 전체 workspace build는 통합 담당자가 별도로 실행한다. 저장 API는 [engine-storage-v2.md](engine-storage-v2.md)에 정리한다.

DB3는 `attempt_usage`에 attempt/session/Run/Turn FK owner, 최신 누적 usage snapshot, revision, observedAt을 저장한다. 과거 이벤트에서 usage를 역산하지 않아 기존 attempt의 미관측은 그대로다. `(run_id,json_extract(data,'$.role'),ordinal)` index는 긴 active Run의 user/assistant anchor 조회를 지원하며 원본 메시지를 바꾸지 않는다. DB user_version=3과 공개 session event schemaVersion=2는 별도 버전이다. 새 테이블/index 실패는 v2 상태로 rollback하며, archive/recovery의 exact table 집합도 실제 primary version에 맞춰 검증한다.
