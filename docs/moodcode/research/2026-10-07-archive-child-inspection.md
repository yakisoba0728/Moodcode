# Historical child 조회와 취소 경계

G1-22/23의 저장·crash 검증 후, 원래 archive에서 과거 child 문서를 명시적으로 조회하는 계약을 추가했다. 다른 제품의 코드를 가져오지 않고 [기존 공개 비교](2026-10-07-child-storage.md)에서 구분한 lineage·process ownership·불완전한 reference count의 의미를 자체 host API에 적용한다. Amp/Claude Code의 비공개 archive나 실제 DB 구조를 추정하지 않는다.

새 host 조회는 exact manifest digest와 root session/Run/task를 필수로 지정한다. 전체 validation에서 이미 확인한 child index를 같은 proof frame으로 수집한다. 문서 본문을 report 목적으로 다시 읽거나 새 8MiB budget을 만들지 않는다. Selected metadata samples와 counts를 반환하지만 실행·복구·ACK·physical rebinding을 하지 않는다. 규범적 상한과 완료/unknown 의미는 [조회 계약](../engine-archive-child-document-inspection.md)을 따른다.

실제 authored parent/child/grandchild, 11개 child 중 1개 선택, legacy ancestor와 verified grandchild, external unchecked, 같은 크기의 blob 변조, oversized foreign owner, exact digest·budget·sample/report cap을 검증했다. Original/source 및 archive의 stat/SHA를 비교하고 실제 모델·원본 프로젝트 변경을 사용하지 않았다. Whole file/logical DB hashing은 JSON proof 예산 밖이며 display cap은 검증을 건너뛰는 근거가 아니다.

[Node의 AbortSignal 문서](https://nodejs.org/api/globals.html#static-method-abortsignalanysignals)는 composite cancellation과 abort 이벤트를 설명한다. 열람한 최신 문서는 26.10.0이고 실행한 로컬 Node는 26.9.0이다. 실제 fixture에서 이미 취소한 signal의 공개 aborted=false shadow가 native 상태를 숨기지 않도록 strict 입력 검증을 추가했다. 그 다음에는 유효한 signal로 진입한 뒤, 최초 async yield 중 controller 취소와 공개 property 변경을 동시에 수행해 검증된 보고서가 잘못 반환되는 별도 실패를 발견했다.

Private AbortSignal.any만 만드는 첫 수정도 실제 후속 취소 시험에서 실패했다. [Node 26.9.0 공개 구현](https://github.com/nodejs/node/blob/v26.9.0/lib/internal/abort_controller.js)의 lazy composite 관측과 로컬 ESM 실험을 확인했다. Operation 동안 native derived signal의 abort observer를 활성화하고 finally에서 해제한 뒤 실제 direct/composite 취소 시험이 통과했다. Observer 자체를 완료 상태나 원격 provider 취소의 증거로 해석하지 않는다.

검사 전에 관측되지 않은 composite의 부모를 취소한 뒤 부모의 공개 상태를 가리면, 제공된 composite의 intrinsic getter도 false로 관측됐다. 나중에 observer를 붙여 이미 가려진 과거 취소를 복원할 수 없었다. 보장은 제공된 native 상태와 진입 후 활성 관측의 범위다. Private Node ancestry를 읽거나 수정하지 않는다. 진입 뒤에는 두 겹 composite에서도 private signal이 실제 controller 취소를 유지했다.

ROOT의 독립 review는 기존 sync validateEngineArchive의 proof deadline 시작이 whole file/logical DB/review 검사 뒤였음을 확인했다. 공통 validator로 리팩터링할 때 이 경계를 앞당기지 않아야 한다. 새 inspector의 entry frame과 기존 validation의 lazy proof frame을 구분하며 controlled clock 회귀 시험은 실제 wall-time benchmark와 별도로 보고한다.

초기 fixture 오류·실제 cancellation 실패·부분 수정의 실패·최종 전체 gate를 [최신 검증](../engine-goal-verification.md)의 기계 판독 결과에 보존한다. 기존 로컬 Codex 인증의 child text 회귀는 PDF를 전송하지 않는 별도 검사이며 remote PDF/token fit·Linux/Windows runtime·GUI 검증을 뜻하지 않는다.
