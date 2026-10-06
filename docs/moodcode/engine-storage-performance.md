# 긴 대화 저장 성능

근거는 [storage-history-benchmark.json](storage-history-benchmark.json)이다. macOS arm64, Node v26.9.0에서 synthetic SQLite fixture를 1천·1만·10만 메시지로 만들고, 완료 Run 하나당 50개 메시지와 약 1KiB UTF-8 content를 저장했다. warm-up 5회 뒤 30회 `readModelHistory`를 측정했다. 다른 구현 세션도 실행 중인 로컬 측정이며 cold I/O나 모든 운영체제의 보장값은 아니다.

| 전체 메시지 | DB 크기 | history p50 / p95 | 반환 메시지 / JSON bytes | GC 이후 retained heap 증가 | 일시 heap 최대 증가 |
| --- | --- | --- | --- | --- | --- |
| 1,000 | 2,027,520 bytes | 1.07 / 1.68ms | 200 / 232,535 | 0.50MiB | 7.29MiB |
| 10,000 | 18,079,744 bytes | 7.77 / 13.28ms | 200 / 232,950 | 0.38MiB | 14.62MiB |
| 100,000 | 179,691,520 bytes | 37.22 / 46.37ms | 200 / 233,365 | 0.37MiB | 14.51MiB |

메시지 JSON은 전체 이력을 불러온 뒤 자르지 않는다. SQL은 최신 129 Run의 count/bytes metadata를 읽고, 최대 128 Run에서 예산에 맞는 완전한 묶음을 선택한다. 이 fixture에서 SQL metadata 계산 대상은 최대 6,450 메시지다. `EXPLAIN QUERY PLAN`은 Run별 message projection에 `model_messages_run` index를 사용한다. 반환 JSON은 약 233KB로 일정하지만 생략한 메시지 수 계산을 위한 session index count는 전체 메시지 수에 비례한다. 실제 파일시스템 I/O bytes는 측정하지 않았으며 JSON 반환량을 물리 I/O라고 해석하지 않는다.

구독 압력은 1ms씩 늦게 100개 이벤트를 읽는 consumer와 durable session-control 이벤트 256개를 동시에 생성하는 producer로 측정했다. 최종 persisted backlog는 1,256·10,256·100,256개였다. 소비자별 메모리에는 100개/8MiB 이하의 page와 waiter 하나만 유지하며 전체 backlog를 push queue에 복제하지 않는다. 측정 중 heap 증가 최대는 3.53·5.39·5.36MiB, explicit GC 뒤 증가는 0.24·-0.11·0.03MiB였다. 음수는 GC로 기존 임시 객체가 회수된 결과다. 이 probe는 로컬 journal 경합을 다루며 네트워크 provider backpressure나 오래 걸리는 command cleanup을 검증하지 않는다.

현재 로컬 목표는 10만 메시지 warm history p95 50ms 이하, 기본 반환 200 메시지/8MiB 이하, 반복 읽기 후 retained heap 증가 8MiB 이하, subscriber당 page 100개/8MiB 이하로 잡는다. 이번 측정은 해당 목표를 통과했으나 10만 메시지 최대 표본은 51.63ms였다. 절대 시간으로 CI를 실패시키지 않는다. 하드 계약은 byte/record caps와 완전한 Run exchange 보존이며, 느려질 때 전체 snapshot fallback을 사용하지 않는다.

가장 최신 필수 Run exchange 자체가 메시지/byte 예산을 넘으면 `MODEL_HISTORY_LIMIT`다. 그 Run 안의 tool proposal/result를 반만 모델에 보내지 않는다. 대형 현재 출력은 producer/artifact 계층의 축소나 별도 요약 경계를 통해 해결해야 한다. 다음 성능 개선 후보는 omitted-count 집계 cache와 metadata 크기 집계의 durable 유지, cold-cache·다양한 Run 크기·실제 provider stream 별도 측정이다.

재현 명령은 `node --expose-gc --import tsx packages/engine/src/storage/fixtures/history-benchmark.ts docs/moodcode/storage-history-benchmark.json`이다. temporary DB는 종료 시 삭제한다. fixture는 빠른 bulk SQL로 생성하며 라이브 provider나 파일 편집을 실행하지 않는다.
