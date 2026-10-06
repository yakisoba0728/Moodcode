# 라이선스 확인과 독립 구현 기준

2026-10-07. 참조 commit은 `4ac0d9c3d169bbe81d9570013effdda3fe24d36e`다. 이 문서는 이번에 실제 확인한 고지와 작업 기준을 기록한다.

## 확인한 고지

OpenCode root `LICENSE`는 **MIT**, 저작권자는 `(c) 2025 opencode`로 기재되어 있다. root와 주요 engine package manifest도 MIT라고 표시한다. MIT는 사용·수정·배포·상업적 재사용을 허용하면서, 복사본 또는 상당 부분에 저작권·허가 고지를 포함하도록 요구한다. 따라서 “라이선스 때문에 엔진 코드를 사용할 수 없다”는 해석은 맞지 않는다. [고정 commit의 LICENSE](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/LICENSE), [OSI MIT 본문](https://opensource.org/license/mit).

이번 Git tracked inventory에서 발견한 별도 LICENSE는 다음과 같다. 이름에 LICENSE/NOTICE/COPYING이 들어간 경로를 검사했으며, 이것만으로 모든 파일의 권리를 확정한 것은 아니다.

| 경로 | 표시된 라이선스·고지 |
|---|---|
| `LICENSE` | MIT, 2025 opencode |
| `packages/ui/LICENSE` | root와 동일한 MIT 고지 |
| `packages/http-recorder/LICENSE` | root와 동일한 MIT 고지 |
| `packages/docs/LICENSE` | MIT, 2023 Mintlify |

파일별 SHA-256과 source URL은 [source inventory](./source-inventory.json)의 `trackedLicenseFiles`에 기록했다. docs/UI는 이번 재구현 대상이 아니지만 별도 고지가 존재하는 사실은 남긴다.

## 루트 MIT만으로 끝나지 않는 부분

upstream의 package manifests에는 AI SDK, Effect, PTY, parser, native watcher 등 많은 의존성이 있다. 실제 Moodcode 배포에 포함하는 패키지·native binary·패치의 자체 라이선스와 고지는 별도로 확인해야 한다. 이 분석에서 upstream의 전체 전이 의존성 고지를 수집하거나 Moodcode 배포 패키지의 license audit을 수행한 것은 아니다.

기존 `tool/edit.ts` 첫 부분은 Cline 및 Gemini CLI의 접근을 참조했다고 밝힌다. 이 고지는 참조 출처를 알리는 근거이며, 해당 코드들의 모든 라이선스 조건을 이번에 검증했다는 의미는 아니다. Moodcode는 그 fuzzy edit 구현을 가져오지 않고 exact edit/expected hash 동작부터 자체 명세를 작성한다. [upstream 출처 주석](https://github.com/anomalyco/opencode/blob/4ac0d9c3d169bbe81d9570013effdda3fe24d36e/packages/opencode/src/tool/edit.ts#L1).

모델별 system prompt, tool description, 기존 테스트 fixture, 문서, 아이콘·미디어도 별도 저작물로 취급한다. 원본 package가 MIT라는 이유만으로 이 자료를 추출해 Moodcode 브랜드로 배포하는 결정을 자동으로 내리지 않는다.

## 이번 작업에 적용한 기준

- 소스는 Moodcode 바깥의 고정 reference checkout에 두고, Moodcode에는 분석·동작 명세·원본 링크·해시만 기록한다.
- OpenCode runtime dependency, source vendoring, 원본 prompt/tool description/test fixture를 추가하지 않는다.
- 함수명·폴더명·표현을 바꾸는 기계적인 port를 독립 구현이라고 부르지 않는다. Moodcode의 기존 API·데이터·제약에 맞춰 계약과 테스트를 먼저 작성한다.
- 특정 구현을 나중에 실제 재사용하기로 하면 copied/derived 파일을 식별하고 해당 저작권·허가 고지와 의존성 고지를 보존한다. 독립 구현 문서와 재사용 파일의 출처를 구분한다.
- Moodcode 코드의 저작권·라이선스 선택은 프로젝트 자체의 배포 정책으로 정한다. OpenCode MIT를 읽었다는 이유로 Moodcode 전체 라이선스를 자동으로 변경하지 않는다.

이번 작업은 원본을 읽고 동작을 분석하는 작업이므로, 원본을 전혀 보지 않은 팀의 분리 개발이라는 의미의 **clean-room 절차를 수행했다고 주장하지 않는다.** 자체 구현이라는 이유만으로 모든 라이선스·기타 권리 문제가 자동으로 없어진다고 보장하지도 않는다. 이번에 확정한 것은 참조 commit의 MIT 고지와 원본을 복사하지 않는 구현 방침이다.

## 구현 단계에서 남길 출처 기록

각 주요 모듈 설계에는 Moodcode 계약, 참고한 원본 경로/commit, 실제 재사용 여부, 자체 테스트의 기대 동작을 기록한다. 외부 패키지는 lockfile의 정확한 버전과 배포 포함 여부를 기준으로 고지를 만든다. 새 prompt·도구 설명·fixture는 Moodcode 요구사항에서 작성한다.

원본 코드가 이번 문서 변경에 포함되지 않았는지는 Git diff 경로와 문서 내 code fence를 검사한다. 이는 이번 patch에 runtime source 이식이 없다는 확인이며, 과거 Moodcode 전체의 독립성이나 모든 배포 자료의 권리를 인증하는 검사는 아니다.
