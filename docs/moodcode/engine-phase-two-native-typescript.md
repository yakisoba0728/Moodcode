# MC2-01d — 실제 TypeScript 의미 분석과 프로젝트 source freshness

기존 host 등록 LSP/navigation과 repository ContextSource를 실제 설치된 TypeScript 7 native language server에 연결한다. Moodcode가 호스트의 명시적 executable·version을 사용하며 모델 응답이나 저장소 지침이 서버를 설치하거나 실행 인자를 선택하지 않는다.

## 사용 방법

```ts
import { createEngine, createTypeScriptNativeLspFactory } from '@moodcode/engine';

const engine = createEngine({ dbPath });
engine.registerLanguageServer(
  'typescript-native',
  createTypeScriptNativeLspFactory({ executable: nativeExecutableAbsolutePath, expectedVersion: '7.0.2' }),
  path => /\.[cm]?tsx?$/.test(path) ? 'typescript' : null,
  'typescript-7.0.2',
);
```

서버 등록과 `repositoryContextPolicy`/`repositoryContextTools`는 별도 host 선택이다. 기본 core 도구 21개와 서버 미등록 동작은 유지한다. 등록된 서버는 실제 workspace/server별로 소유하고 기존 UTF-16 range·bounded navigation·취소·원래 요청 deadline을 사용한다. 읽기 결과는 코드 실행·파일 수정 권한이 되지 않는다.

## source 범위와 변경 반영

기존 selected query/target hash만으로는 native compiler가 읽은 미개방 import 파일의 변경을 감지하지 못한다. 실제 Engine fixture에서 barrel 파일의 export target은 그대로 두고 comment만 바꾸면 기존 source 검사에서 놓쳤다.

native factory는 호스트의 `projectSources` read port를 제공한다. `captureTypeScriptProjectSources`가 workspace 안의 TS/JS 소스, JSON 설정, ignore 파일을 bounded content-addressed snapshot으로 읽는다. generated/dependency tree와 Git-ignored 경로는 제외한다. 제외되지 않은 이름이 exact workspace path 규칙(콜론·역슬래시·제어 문자, 점이나 공백으로 끝나는 이름 등)을 벗어나면 digest로 고정할 수 없으므로 capture를 `UNSAFE_LSP_WORKSPACE`로 거절한다. 저장되는 정보는 digest·file count·byte count이며 전체 프로젝트 본문을 모델 문맥에 넣지 않는다. ordinary canonical root/file, 파일별 UTF-8/1MiB, traversal 16,384 entries·4,096 files/directories·총64MiB·동시16·15초 상한을 적용한다.

각 snapshot은 파일 내용과 경로·현재 physical root를 결합하고 읽는 중 파일 identity/membership 변경을 거절한다. 순서가 정해진 파일 배열로 digest를 계산한다. 설정·미개방 소스·파일 추가/삭제·ignore 변경이 동일 compiler snapshot으로 재사용되지 않는다.

`RepositorySourceManifest.projectSources`가 server별 digest/count를 고정한다. contribution의 generation과 실제 ContextRevision `sourceIds`가 이를 보존한다. 원래 capture의 freshness는 새 snapshot과 비교하므로 changed source 뒤 retry/dispatch가 이전 messages를 사용하지 못한다. 같은 Turn을 새 파일로 자동 재작성하지 않는다.

다음 명시적 semantic query에서는 project digest가 달라졌을 때 이전 실제 서버를 종료하고 새 서버에서 현재 source를 읽는다. 미개방 dependency/config의 native watcher 지연에 의존하지 않는다. source freshness 조회 자체는 서버 query나 새 native process를 시작하지 않는다. 취소된 원본 source Promise도 manager가 소유하며 종료 시 실제 파일 읽기·FileHandle 정리까지 bounded drain한다. 서버 entry 취소와 read drain을 병행하고 확인되지 않은 종료는 typed uncertainty로 남긴다. 선택한 파일·returned target의 기존 hash/ignore/Git head/branch/worktree 검사도 유지한다.

## 실제 검증 범위

별도 작성한 ground truth 위치와 실제 native definitions/references를 대조한다. 동명 선언, import alias/re-export/local shadow, UTF-16/BOM/CRLF/astral 문자를 포함한다. partial/unresolved build, ignored/outside target과 bounded omission을 구분한다. 큰 authored corpus와 실제 Moodcode 저장소에서 실제 시간·읽기/결과/디스크 크기를 측정한다. 이 측정은 전 저장소 자동 관련 path/ranking이나 성능 향상의 증거가 아니다.

실제 Engine 연결은 registered factory → repository read tool/host API → prepared contribution → ContextRevision → ProviderAttempt/request digest/cleanup을 검사한다. captured source/config/Git 변경, 같은 Turn retry, restart, 별도 worktree, 취소와 실제 child exit를 관찰한다. fake peer의 결과를 실제 의미 정확도에 합산하지 않는다.

workspace 안의 지원된 source snapshot만 검증한다. excluded dependency tree, external config/dependency, compiler의 모든 ambient input이나 OS sandbox는 이 snapshot의 완전성 주장에 포함하지 않는다. 라이브 모델·Windows native descendant 종료·원래 환경 이월 E5-13/E5-08/E6-07/E6-08은 별도 범위로 유지한다.

검증 결과는 [단계별 검증 기록](engine-phase-two-native-typescript-verification.json)과 [실제 의미 분석 측정](engine-phase-two-native-typescript-benchmark.json)에 저장한다. 초기 취소 실패에서 원본 RPC Promise rejection 관측 누락을 수정했고, source 취소 후 actual FileHandle 종료 전에 host close가 반환하던 경계도 원본 read drain으로 보강했다.

최종 검사: TypeScript 통과, 전체 engine 3,464개 중 3,462개 통과·실패0·기존 Windows skip2, 관련 source294개 통과, scripted coding 평가3개 통과. 신규35개 회귀는 Engine20·source snapshot5·native factory5·실제 stdio3·코퍼스2다. 이 로컬 지원 범위에서 MC2-01d를 완료하여 누적18/80·3/20을 기록하며 전체 goal은 active다.

최종 측정은 회귀 검사와 동시에 실행했다. authored corpus는512개 모듈/525개 파일·62,388logical bytes·2,150,400allocated file bytes, 전체 약9.0초였다. 8개 기준 probe와 실제 Moodcode2개 기준 위치의 precision/recall은 각각1이다. 별도81-reference case는64개 반환·17개 상한 누락·recall64/81을 명시한다. Moodcode 기준 조회는 약1.9초/1.5초였고646개 project file/11,714,455bytes를 관찰했다. 이 숫자는 해당 동시 부하의 측정값이며 개선률이나 단독 실행 기준값을 뜻하지 않는다.
