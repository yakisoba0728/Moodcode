# Electron과 Tauri 선택 검토

검토일: 2026-10-04, Asia/Seoul. 사용자가 **Electron**을 선택했다. 자체 엔진을 먼저 구현하고 GUI를 연결하는 순서도 확정했다. 엔진 언어는 TypeScript/Node를 제안한다. 아래 비교는 선택 근거와 대안 검토 기록으로 유지한다.

선택한 Electron에서는 Node utility process에 엔진을 구성하고 TypeScript 계약을 공유하는 구조를 제안한다. host·엔진 연결과 배포 경로가 단순해진다는 판단이다. 이것은 공식 구조를 바탕으로 한 구현 복잡도 평가이며, Moodcode의 성능 실험 결과는 아니다. [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model).

앱의 배포 크기·기본 자원 사용을 우선하고 Rust host/엔진을 함께 개발할 의향이 있으면 Tauri가 강한 후보가 된다. Tauri에서도 TypeScript 엔진을 별도 sidecar로 사용할 수 있다. GUI 프레임워크와 엔진 언어를 함께 비교해야 한다.

## Moodcode 요구사항에 따른 비교

| 항목 | Electron | Tauri | Moodcode에 주는 의미 |
|---|---|---|---|
| React GUI | Chromium renderer에서 사용 | OS WebView에서 사용 | 현재 GUI 설계는 양쪽에서 구현 가능 |
| renderer | 앱에 포함된 Chromium | Windows WebView2, macOS WKWebView, Linux WebKit | Tauri에서는 지원 OS/버전별 렌더·입력·clipboard·worker 동작을 확인 |
| TypeScript 엔진 | Node utility process에 구성 | self-contained sidecar 또는 포함한 runtime으로 구성 | Tauri는 별도 엔진 binary·통신·수명·배포 연결이 추가됨 |
| Rust 엔진 | 별도 native 엔진을 연결 가능 | Rust host와 동일 언어로 구성 가능 | Rust 엔진을 선택하면 Tauri의 구조상 이점이 커짐 |
| 배포 크기 | Chromium·Node가 앱에 포함됨 | 시스템 WebView 사용, 별도 engine/runtime 크기는 추가됨 | host 기본 크기와 엔진을 포함한 전체 앱 크기를 구분 |
| 도구·SQLite·PTY | Node 및 native module 연결, Electron 대상 rebuild 검토 | Rust 구현 또는 sidecar의 native module 연결 | 양쪽 모두 실제 플랫폼·패키징 검증 필요 |
| GUI 자동화 | Playwright의 실험적 Electron 지원 | WebdriverIO Tauri service 및 embedded WebDriver 경로 | macOS도 Tauri 자동화 경로가 있음 |
| 앱 업데이트 | autoUpdater 및 배포 도구의 업데이트 경로 | 공식 updater plugin | 양쪽 모두 앱·엔진 버전과 DB migration을 조율해야 함 |

구조 근거: [Tauri architecture](https://v2.tauri.app/concept/architecture/), [WebView 종류](https://v2.tauri.app/reference/webview-versions/), [Node sidecar](https://v2.tauri.app/learn/sidecar-nodejs/), [target별 binary bundling](https://v2.tauri.app/develop/sidecar/), [Electron native module](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules).

자동화 근거: [Playwright Electron](https://playwright.dev/docs/api/class-electron), [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/). Tauri의 native `tauri-driver` 직접 사용은 Windows/Linux 대상이지만, 공식 문서는 embedded WebDriver를 사용하는 service의 macOS 지원도 안내한다. macOS GUI 테스트가 불가능하다는 이유로 Tauri를 제외하지 않는다.

업데이트 근거: [Electron updates](https://www.electronjs.org/docs/latest/tutorial/updates), [Tauri updater](https://v2.tauri.app/plugin/updater/).

## 구현 가능한 세 가지 구성

| 구성 | 엔진과 배포 | 선택할 이유 |
|---|---|---|
| Electron + React + TypeScript 엔진 | Electron host → Node utility engine | TS 도메인·SDK·도구와 단일 개발 흐름을 우선 |
| Tauri + React + TypeScript 엔진 | Rust host → 포함한 TS engine binary/runtime | 시스템 WebView를 사용하면서 TS 엔진을 유지 |
| Tauri + React + Rust 엔진 | Rust host → 분리 가능한 Rust engine 모듈/프로세스 | native core와 배포 크기·자원 관리가 주요 목표 |

Tauri를 선택한다고 agent loop를 Rust로 다시 작성해야 하는 것은 아니다. 다만 TS sidecar를 추가하면 그 runtime·native 의존성과 child process도 제품에 포함되므로, 작은 기본 host의 특성을 전체 앱의 크기·메모리로 그대로 환산할 수 없다.

Rust로 작성한다는 사실만으로 model 응답이나 전체 코딩 작업이 빨라진다고 판단하지 않는다. 실제 작업에는 네트워크, 파일·검색, shell·테스트, DB, GUI 렌더링이 함께 들어간다. 프레임워크별 메모리·시작 속도·입력 성능의 확정 수치는 이번 검토에서 측정하지 않았다.

## 아키텍처에서 유지할 계약

renderer에는 command·snapshot·event 계약을 제공하고, 세션·run·tool·approval·checkpoint·journal은 엔진이 소유한다. Electron preload 또는 Tauri command/channel은 host adapter다. Tauri capability와 Electron의 renderer/IPC 경계에 더해, 모델이 요청한 도구의 권한·승인은 엔진에서 검사한다.

이 분리는 host 선택이 도메인 전체에 퍼지는 것을 줄인다. 프레임워크 변경 시에는 OS adapter·통신·프로세스 수명·native 의존성·서명·업데이트·GUI 회귀 검증을 다시 연결해야 한다. 교체가 비용 없이 끝난다는 계획은 잡지 않는다.

## 선택한 구조의 실행 확인

[엔진 우선 구현 계획](./implementation-plan.md)의 E0에서 창 없는 Electron utility process로 runtime·SQLite 호환성을 확인하고, E5에서 실제 앱 bundle로 다음을 확인한다.

1. 사용자의 Node/Bun 개발 설치 없이 엔진이 실행되고 SQLite를 사용할 수 있음.
2. 같은 event fixture의 긴 timeline·큰 diff·한글 입력·clipboard·worker가 동작함.
3. 엔진 crash·중지·앱 종료 시 child process와 기록이 정해진 상태로 정리됨.
4. 앱+engine+renderer의 전체 설치 크기, 시작 시간, idle/streaming 자원 사용을 측정함.
5. packaged GUI 자동화와 업데이트 후 engine 계약·DB migration을 검증함.

이후 구현은 Electron을 기준으로 진행한다. 엔진 개발용 Node 실행과 최종 Electron bundle 실행을 모두 검증하며, Tauri 대안 구현은 현재 범위에 포함하지 않는다.
