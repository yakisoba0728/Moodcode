# 모델 카탈로그와 확장 설정

2026-10-13, codex/product-connections. 자체 엔진·native adapter·Codex broker·승인·취소·복구·DB23을 유지하고 기존 profile/plugin/skill port를 Desktop에 연결한다.

## 모델 목록

공개 모델 카탈로그 새로고침은 인증 없이 [Models.dev JSON](https://models.dev/api.json)을 읽는다. 현재 지원하는 여덟 API 공급자의 이름/ID 검색·선택과 컨텍스트/출력 한도, 도구·추론·입력 모달리티 선언을 표시한다. 수동 ID와 별도 Codex 계정/로컬 모델 목록을 유지한다. 카탈로그는 계정 사용 권한이나 실제 검증 완료를 뜻하지 않는다.

15초·8 MiB·고정 URL·redirect 금지·UTF-8/JSON 한도를 적용하고 userData/model-catalog.json을 원자적으로 저장한다. 실패한 갱신은 이전 캐시를 보존하고 손상된 캐시는 앱 시작을 막지 않는다. 공식 endpoint의 선택 모델 한 개만 worker ModelRegistry에 전달한다. proxy/Codex에는 자동 적용하지 않는다. SDK 입력은 텍스트로 제한하며 native PDF 선언도 adapter의 별도 허용 계약을 통과해야 한다. reasoning 선언은 SDK 공급자별 추론 옵션 구현을 뜻하지 않는다.

## 웹 조사

설정의 웹 조사 · Skills · Plugins · 에이전트에서 공개 문서 읽기를 켜면 Build에 web_fetch를 노출한다. 기본은 꺼짐이다. 각 요청은 기존 scoped runtime의 exact approval을 요구한다. Plan은 기존 read/state 정책을 유지하므로 network 도구를 노출하지 않는다. 환경 변수 이름을 지정하고 키가 있을 때만 [Exa Search](https://exa.ai/docs/reference/search)의 web_search를 노출한다. 키 값은 설정 파일/화면으로 전달하지 않으며 명령 환경에서도 제거한다.

HTTP(S) 기본 포트만 허용한다. credential URL·secret query·private/link-local/loopback/reserved IPv4/IPv6·transition 주소를 거부한다. DNS의 모든 결과를 검사하고 확인된 주소에 socket lookup을 고정한다. proxy·공유 agent·redirect·cookie·문서 요청의 인증 헤더는 사용하지 않는다. UTF-8 text/HTML/Markdown/JSON에 30초·1 MiB, model 32 KiB/display 64 KiB와 Run 예산을 적용한다. 완료·실패·취소는 원본 HTTP request close를 기다리고 DNS 취소 후 HTTP를 만들지 않는다. 외부 본문을 실행하지 않으며 출처/untrusted 표시와 지침으로 따르지 말라는 안내를 붙인다. 로그인 문서·binary/PDF·압축 응답·브라우저 조작은 범위 밖이다.

## Skills

기존 .moodcode/skills/<id>/SKILL.md와 .moodcode/references를 유지한다. 선택 시 ~/.config/moodcode/skills, 호환 경로 선택 시 프로젝트 .agents/skills·.claude/skills, 전역+호환 선택 시 사용자 홈의 동일 경로를 포함한다. 같은 ID는 workspace → project compatibility → global 순으로 선택한다.

기존 skill_list/skill_read/reference_read를 사용한다. 총 64개, 각 root scan 1,024개, 파일 64 KiB로 제한한다. root 밖 경로·symlink/hardlink·변경된 원본·binary·다른 실행의 prepared request를 거부한다. 외부 catalog/script를 자동 내려받아 실행하지 않는다.

## Plugins

고정 npm 버전을 추가 → 확장 설정 저장 → 설치 → 활성화 선택 → 저장 순으로 사용한다. 컴퓨터에 Node.js/npm이 필요하다. userData/plugins에 ignore-scripts·save-exact·no-audit·no-fund와 공식 registry로 설치하고 provider/search credential을 installer 환경에 전달하지 않는다. 취소는 installer 프로세스 실제 close 후 반환하며 앱 종료 시에도 취소한다.

설치만으로 실행하지 않는다. 활성 패키지만 원본 engine utility에서 import하고 기존 EnginePluginManager로 등록한다. EnginePlugin 객체를 default export해야 한다. 설치 버전·package entry/경로·명시적 활성화를 검사한다. 충돌·잘못된 계약·시작/정리 실패는 기존 실패·재시도 경로를 따른다. activation은 5초와 utility 종료 signal을 적용한다. import/activation을 worker가 추적하므로 끝나지 않은 startup을 정리 완료로 보고하지 않는다.

활성 Node plugin은 컴퓨터에서 코드를 실행하는 신뢰된 host 확장이다. sandbox/OpenCode plugin ABI 호환을 주장하지 않는다. 목록에서 제거하고 저장하면 다음 worker에서 로드하지 않고 설치 cache는 보존한다.

## 프로파일과 설정 수명

최대 8개 profile의 ID·설명·지침·현재 공급자의 모델 ID·turn allowance·tool allowlist를 편집한다. allowlist를 켜고 비워 두면 도구 없음, model ID를 비우면 현재 연결 모델이다. 실행창 선택이 preload를 통해 기존 AgentProfiles로 전달된다. 기존 delegate_task/자식·팀 화면을 사용하며 host 권한·Plan/Build·승인 정책을 넓히지 않는다. Run과 같은 request ID 재시도는 기존 immutable revision 계약을 유지한다.

product-settings.json에는 키 대신 환경 변수 이름과 metadata만 저장한다. preload/main/worker의 closed field·byte/count·ID·중복 검증, 원자적 mode-0600 쓰기와 파일 digest로 stale writer를 거절한다. malformed JSON/설정은 확장을 끈 기본값으로 시작하고 오류를 표시한다. 사용자가 수정 후 저장하면 잘못된 원본을 mode-0600 별도 파일로 먼저 보관한다. unsafe/oversized file은 읽지 않는다.

변경/설치는 기존 host idle/admission gate를 사용한다. active Run이면 거부하고 이전 utility 정리 확인 후 재시작한다. 정리 미확인·장애를 성공으로 보고하지 않는다. 기존 모델/계정 설정과 SQL schema는 별도로 유지한다.

## 검증과 남은 조건

npm test, build:desktop, scripts/test-desktop-product.mjs와 기존 설정·코딩·Codex broker fixtures를 사용한다. 새 GUI는 임시 userData/scripted provider/합성 package로 캐시 검색·deprecated 제외·web opt-in·키 없는 search 제외·원본 utility의 plugin·실제 profile Run·DB23을 확인한다. 합성 npm CLI로 설치 옵션·환경·취소/원본 pid 종료를, 로컬 HTTP peer로 DNS pin·redirect 거부·출력 한도·원본 close를 확인한다. 실제 공급자/검색 계정 호출은 없다.

Desktop CI에 새 경계/도구 테스트와 세 OS GUI를 추가했다. [검증 기록](product-connections-verification.json)에 source pin과 실제 결과를 기록한다. 첫 전체 실행 중 작업 파일 변경으로 생긴 REPOSITORY_SOURCE_STALE도 보존하고 완료 소스를 고정해 다시 확인한다.

이번 환경/repository secrets에는 macOS/Windows signing 자격이 없어 N-05 실제 서명·공증·설치·공개 feed는 남는다. 기존 release preflight/업데이트 검증과 unsigned OS 빌드를 사용하며 publish하지 않는다. 추가 검색 공급자·SDK 미디어·OpenCode plugin ABI·Windows PTY·추가 architecture는 완료 범위 밖이다.

