# 복구 증거의 공유 조회 범위

Moodcode는 일반 provider 결과 결정, summary 결정, overflow-linked Turn 및 cleanup을 확인할 때 한 SQLite transaction에 속하는 선택 증거 읽기 범위를 사용한다. 구현은 `packages/engine/src/storage/evidence-read.ts`이며, 실제 측정은 [최신 검증](engine-goal-verification.md)을 따른다. 현재 primary는 DB9이고 metrics schema는6이다. DB9 MCP receipt와 result-free proposal projection도 같은 선택 본문 예산/cache를 사용하며 [MCP 계약](engine-mcp-execution.md)의 owner/header 한도를 추가로 검사한다. G1-26 [일반 tool frontier capture](engine-tool-recovery-frontier.md)도 자체 bounded 후보/owner 선택과 audit owner 검사를 같은 read scope에 계산한다. 기존 전체 legacy/native startup `.all()`나 SQLite 내부 JSON/물리 I/O는 이 새 selected-proof 예산 밖이다.

## 실행 접수와 호환

SQLite store의 `hasUncertainWorkspace(workspaceId)`는 summary와 ordinary 실행의 기존 공개 predicates를 같은 읽기 transaction과 범위에서 호출한다. `RunCoordinator`의 신규 실행 접수·resume·maintenance 검사도 이 통합 port를 우선 사용한다. 통합 port를 제공하지 않는 custom store는 기존 두 predicates를 호출한다. 기존 메서드도 개별 검사로 사용할 수 있다.

한 범위는 서로 다른 proof 도메인과 native owner getter가 반환하는 JSON 본문·명시적 projection의 합계에 **8MiB**, cache에 동시에 보관하는 주소에 **4,096개**의 제한을 둔다. 다음 본문을 가져오기 전에 크기를 확인하고 남은 예산을 검사한다. 한도를 넘으면 workspace는 차단된 상태를 유지한다. 내부 predicate가 예외를 보수적으로 처리해도 소진된 범위는 clear 결과로 반환할 수 없다. 정상 workspace/session/Run/Turn/Attempt/context/document getter의 기존 읽기 동작은 proof 범위 밖에서 유지한다.

기존 도메인의 후보·row·source closure·owner·context document·ledger 크기 제한도 유지한다. 도메인별 논리 선택 예산은 cache hit에도 기존 방식으로 계산할 수 있으므로 공통 예산을 만족하는 모든 큰 proof가 반드시 승인되는 것은 아니다. 공유 예산은 도메인별 제한을 완화하지 않는다.

## 재사용과 변경 감지

cache에는 `(table, primary identity, projection)`별 원래 문자열만 저장한다. Provider와 Summary의 서로 다른 canonical row/hash 구조, 파싱한 객체, receipt validity는 공유하지 않는다. 각 호출자는 SQL owner와 payload·source·pin·fingerprint·revision/CAS 검증을 다시 수행한다. Summary 원본 Run과 message의 foreign SQL owner는 원문 읽기 전에 거부한다.

caller가 알려 준 크기와 예산 계산만으로 본문을 반환하지 않는다. SQL body 조회에도 정확한 byte length 조건을 걸어, header 확인 뒤 callback이 같은 기록을 키워도 그 큰 문자열이 JavaScript로 반환되지 않게 한다. 실제 9MiB Session owner 변경 회귀를 포함한다. 누락·변경된 본문은 결정의 유효한 증거로 쓰지 않는다.

native singleton getter와 proof selector가 같은 본문을 요청하면 그 범위 안에서 재사용한다. summary usage의 metadata projection은 `partialText`를 제거하고, full summary 본문과 별개의 주소·예산으로 계산한다. context/head·memory 문서도 composite identity와 정확한 projection으로 구분한다.

각 raw lookup은 같은 connection의 `total_changes()`와 다른 connection의 `data_version`을 확인한다. 관측 값이 달라지거나 명시적 write가 시작되면 기존 raw cache를 비운다. 이미 선택한 bytes는 환급하지 않는다. 같은 길이의 본문 수정, owner만 변경, delete/reinsert, rollback 이후 조회와 외부 connection의 변경도 회귀 검사한다. 임의 callback이 transaction을 끝내면 읽기를 거부하며, 종료 후 다른 transaction을 열고 외부 변경을 관측한 경우에도 이전 본문을 재사용하지 않는다.

범위는 동기 operation의 반환·예외 시 폐기한다. nested read는 같은 범위를 쓰고, 다음 transaction·다음 workspace 검사·정확한 역사 receipt의 별도 read와 ACK write 사이에는 cache를 공유하지 않는다. ACK write의 preview와 fresh CAS는 같은 원문을 재사용할 수 있으나 검사 자체를 생략하지 않는다. ledger와 두 journal의 write 전에 cache를 무효화하고 scope는 COMMIT 뒤 알림 전에 끝난다. 실패한 write는 기존처럼 전체 rollback한다.

## 결정과 측정의 의미

이 작업은 원래 uncertain outcome·nullable usage·control/inbox·context head를 변경하지 않는다. 합산 예산 부족, source drift, 다른 execution blocker는 자동 ACK·retry·activation·resume로 처리하지 않는다. 정확한 역사 receipt는 실행 허용과 별도로 유지한다. 기존 summary V1의 inactive admission과 V2의 pin coverage는 [summary 계약](engine-summary-recovery.md)을 따른다.

provider source의 ordinal·seq·admitted_seq 조회는 숫자 원본 열로 정렬한다. 문자열 CAST 별칭으로 정렬해 9→10 경계가 뒤집히던 문제를 수정했다. 기존 provider V1 source hash의 group encoding 순서는 별도로 유지해, 원본이 같은 기존 결정의 digest와 역사 receipt를 바꾸지 않는다. 실제 transcript validation은 올바른 숫자 순서를 검사한다.

측정치는 SQL에서 JavaScript로 반환된 값, raw JSON/projection bytes, body 호출과 query 수다. metadata·SQLite 내부 JSON 계산·page cache·디스크 I/O·파싱 후 객체 메모리·production latency/throughput의 전체 상한을 뜻하지 않는다. 변경 감지와 owner 재검사에 필요한 metadata 호출도 query 수에 포함한다. 본문 반환량 감소와 query 수 변화는 각각 기록한다.
