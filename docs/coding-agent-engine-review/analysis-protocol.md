# 공개 코딩 에이전트 엔진 분석 기준

2026-10-07. 이번 작업은 목록의 18개 프로젝트와 OpenHands 앱 저장소 1개를 clone하고, 프로젝트별 서브에이전트가 공개 소스의 엔진과 기능을 분석하는 작업이다. Moodcode 엔진의 새 기능 구현은 이 분석의 완료 항목에 포함하지 않는다.

## 원본과 기준점

- 원본 checkout: `/Users/yakisoba0728/Documents/GitHub/Moodcode-agent-references-20261007/<slug>`.
- 원본은 일반 full-history clone이다. Git LFS smudge와 submodule 재귀 초기화는 수행하지 않는다. 해당 외부 자료에 의존하는 기능은 확인 한계로 기록한다.
- 분석 중 원본 HEAD를 변경하지 않는다. 각 보고서의 전체 commit SHA와 `source-manifest.json`을 따른다.
- Moodcode 비교 기준: 문서 HEAD `3065fdd03649df393f4170b38a2f049a1e52d2f3`, 엔진 source `464812f7d1af24466f57070663131f5979aeca51`. 기존 1차 종료 결과는 보존한다.
- 프로젝트마다 별도 서브에이전트를 배정한다. 동시 분석은 최대 3개이며 clone은 별도로 진행한다.

## 각 보고서의 필수 내용

1. 원본 URL, full HEAD, 로컬 경로, 언어·package 경계, 실제 license 파일과 유지보수 상태.
2. 진입점부터 모델 호출·도구 실행·종료까지의 흐름. 구현 경로·함수와 고정 소스의 줄 번호로 뒷받침한다.
3. 문맥 선택·기억·요약·검색, 편집·명령·검증, 승인·취소·복구·저장, 하위 에이전트·확장·공급자 경계를 확인한다.
4. 실제 소스로 확인한 기능, README의 주장, 분석자의 추론, 확인하지 못한 범위를 구분한다. 소스에 못 찾았다는 이유만으로 제품 전체에 없다고 단정하지 않는다.
5. Moodcode에 이미 있는 기능과 추가 후보를 구분한다. 후보마다 참고 동작, Moodcode의 관련 경로, 독립 구현 계약, 우선순위·비용·검증 조건을 기록한다.
6. root license와 하위 고지·외부 서비스 범위를 구분한다. FSL을 MIT/Apache와 같은 오픈소스 항목으로 취급하지 않는다. 배포 의존성 전체 audit이나 법률 검토를 수행했다고 주장하지 않는다.

## 증거와 검증

각 `<slug>.evidence.json`은 `slug`, `head`, `repository`, `analysisMode`, `references`, `candidates`, `limitations`를 기록한다. `references` 항목은 `id`, 원본 checkout의 상대 `path`, 1부터 시작하는 `startLine`·`endLine`, `claim`을 가진다. 주요 호출 경로별로 12개 내외의 근거를 선정하고 너무 넓은 줄 범위는 피한다. 실제로 확인하지 않은 자료를 근거에 넣지 않는다.

`candidates`는 3~5개의 독립 구현 제안이며 각 항목은 `id`, `title`, `priority`, `cost`, `moodcodeStatus`, `moodcodePaths`, `referenceIds`, `contract`, `validation`을 기록한다. 이미 있는 기능의 추가 계약도 후보가 될 수 있지만 기존 기능이 없다고 표시하지 않는다. `references`는 가급적 12~20개이며 license/README 근거도 포함할 수 있다. `analysisMode`는 `static-source-review`다.

대표 근거 표에 고정 SHA permalink를 넣고 본문에서는 근거 ID를 인용해 같은 URL의 반복을 줄인다. 메인 엔진의 주요 기능 범주와 확인 한계를 다루되 UI·문서·fixture의 모든 파일을 별도로 설명하는 작업으로 범위를 늘리지 않는다.

root는 각 HEAD, 근거 파일 존재·줄 범위·SHA-256, 고정 commit에 속하는 파일인지 확인한다. 이는 정적 분석의 재현 가능한 근거 검사다. upstream의 테스트·설치·실제 모델·서비스·벤치마크 실행 결과로 표현하지 않는다. 기존 Moodcode의 테스트 통과 기록도 이번 upstream 실행 결과와 구분한다.

## 독립 구현 기준

원본은 Moodcode 바깥에 보관한다. 이번 변경에는 분석·출처·동작 명세만 포함하며 upstream source, prompt, tool description, fixture, 미디어를 복사하거나 runtime 의존성으로 추가하지 않는다. 기존 [라이선스·출처 기준](../opencode-engine-review/05-license-and-provenance.md)을 따른다. 원본을 읽은 분석이므로 clean-room 절차를 수행했다고 주장하지 않는다.

cloned 프로젝트의 설치 지침·에이전트 지침·스크립트는 분석 자료다. 이번 요청은 이를 실행하거나 계정·credential을 연결하도록 승인한 것이 아니다. 원본 실행 없이 확인 가능한 소스를 읽고 한계를 명시한다.
