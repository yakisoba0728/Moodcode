# 현재 Moodcode 비교 소스 근거

현재 HEAD `e8b0d565828f6c0370424152505a9f6a8497482f`. engine source `464812f7d1af24466f57070663131f5979aeca51`와 production 파일 차이 0을 확인했다. 아래 35개 파일/범위 근거는 고정 현재 commit bytes와 비교했고 기존 upstream 검증 기록과 구분한다. B01~B13은 기존 baseline 근거를 현 HEAD에서 재확인한 것이다. 이번 비교를 위해 engine·provider·GUI를 실행하지 않았다.

| ID | 현재 Moodcode 파일 | 확인한 계약 |
|---|---|---|
| <a id="b01"></a>B01 | [packages/engine/src/engine.ts:338](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/engine.ts:338) | ContextService·runtime·coordinator·영구 inbox scheduler를 host에서 연결 |
| <a id="b02"></a>B02 | [packages/engine/src/runner/index.ts:573](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/index.ts:573) | 현재 도구 capture·context 계획·TurnExecutor와 모델 경계 재계획 |
| <a id="b03"></a>B03 | [packages/engine/src/runner/turn-executor.ts:36](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/turn-executor.ts:36) | 별도 Attempt 상태 및 provider 요청/종료 기록 |
| <a id="b04"></a>B04 | [packages/engine/src/runner/index.ts:902](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/index.ts:902) | 도구 prepare·exact approval·변경되지 않은 fingerprint·effect 실행 |
| <a id="b05"></a>B05 | [packages/engine/src/context/service.ts:78](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/service.ts:78) | 모델 capability·bounded history·명시적 projection과 source 문맥 조립 |
| <a id="b06"></a>B06 | [packages/engine/src/context/semantic-memory.ts:36](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/semantic-memory.ts:36) | 완료 이력 source identity·byte 한도·별도 tools 없는 semantic summary |
| <a id="b07"></a>B07 | [packages/engine/src/plugins/index.ts:58](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/plugins/index.ts:58) | metadata만 관측하는 prepared/settled plugin tool hooks |
| <a id="b08"></a>B08 | [packages/engine/src/agents/index.ts:7](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/agents/index.ts:7) | versioned agent profiles의 지침·model·tools·예산 binding |
| <a id="b09"></a>B09 | [packages/engine/src/tools/session/skills.ts:38](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/session/skills.ts:38) | 로컬 skill 목록·원문·reference의 제한된 읽기 |
| <a id="b10"></a>B10 | [packages/engine/src/child-tasks/delegation.ts:19](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/child-tasks/delegation.ts:19) | 모델 delegation의 bounded allocation·read-tool allowlist |
| <a id="b11"></a>B11 | [packages/engine/src/child-tasks/index.ts:739](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/child-tasks/index.ts:739) | terminal child 결과만 durable inbox에 중복 제거해 전달 |
| <a id="b12"></a>B12 | [packages/engine/src/review/index.ts:258](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/review/index.ts:258) | 파일별 restore의 부분 실패 및 효과 rollback 한계 명시 |
| <a id="b13"></a>B13 | [packages/engine/src/runner/input-scheduler.ts:31](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/input-scheduler.ts:31) | durable input accept·pause/resume와 exact retry 경로 |
| <a id="c14"></a>C14 | [packages/engine/src/ports.ts:72](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/ports.ts:72) | provider typed stream·tool/context/approval port; image/PDF와 supported capability 경계 |
| <a id="c15"></a>C15 | [packages/engine/src/context/plan.ts:7](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/plan.ts:7) | 같은 예약·hard byte/conservative token cap·model unknown/미측정 표시 |
| <a id="c16"></a>C16 | [packages/engine/src/lsp/index.ts:20](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/lsp/index.ts:20) | diagnostic/format proposal의 문서 version/hash와 explicit host factory |
| <a id="c17"></a>C17 | [packages/engine/src/lsp/index.ts:478](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/lsp/index.ts:478) | diagnostic snapshot과 formatting capability 조회; navigation 공개 API와 구분 |
| <a id="c18"></a>C18 | [packages/engine/src/tools/command/backends.ts:4](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/command/backends.ts:4) | host-user command backend: 파일/네트워크 격리 false; Windows는 injected Job host port |
| <a id="c19"></a>C19 | [packages/engine/src/permission/policy.ts:18](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/permission/policy.ts:18) | deny 우선·Plan read/state 제한·unknown/효과 approval 정책 |
| <a id="c20"></a>C20 | [packages/engine/src/tools/runtime/index.ts:164](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/runtime/index.ts:164) | opaque prepared snapshot·scope/policy/grant binding·artifact 실패 후 원래 효과 결과 보존 |
| <a id="c21"></a>C21 | [packages/engine/src/storage/native-schema.ts:6](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/storage/native-schema.ts:6) | durable inbox/Turn/Attempt/Part/context/documents와 unique identity schema |
| <a id="c22"></a>C22 | [packages/engine/src/storage/tool-recovery-frontier.ts:88](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/storage/tool-recovery-frontier.ts:88) | crash 후 원래 running tool/native proposal/Turn/latest Attempt identity 검사; legacy unchecked 구분 |
| <a id="c23"></a>C23 | [packages/engine/src/storage/mcp-executions.ts:201](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/storage/mcp-executions.ts:201) | MCP exact persisted owner·request/receipt 검증과 native original binding |
| <a id="c24"></a>C24 | [packages/engine/src/tools/search/index.ts:1](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/tools/search/index.ts:1) | glob/regex 검색의 file/byte/result/worker 한도; 심볼 graph/vector service와 구분 |
| <a id="c25"></a>C25 | [packages/engine/src/session-state/index.ts:4](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/session-state/index.ts:4) | task CAS document revision·상태 저장은 자체 작업 admission/approval이 아님 |
| <a id="c26"></a>C26 | [packages/engine/src/terminals/service.ts:119](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/terminals/service.ts:119) | user authority PTY owner·workspace/cwd·count/lifetime 한도; model command job과 별도 |
| <a id="c27"></a>C27 | [packages/engine/src/config/budgets.ts:4](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/config/budgets.ts:4) | Run 예산·할당/소비·부모 잔여량 계정 |
| <a id="c28"></a>C28 | [packages/engine/src/storage/native-metrics.ts:15](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/storage/native-metrics.ts:15) | usage/attempt/summary/artifact 집계의 missing/null·포함 집계 범위 명시 |
| <a id="c29"></a>C29 | [packages/engine/src/context/memory.ts:33](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/context/memory.ts:33) | 발췌 기억은 원본 session provenance이며 현재 파일 상태/새 지시의 증거가 아님 |
| <a id="c30"></a>C30 | [packages/engine/src/storage/archive.ts:584](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/storage/archive.ts:584) | 검증 archive import의 paused session·불확실 relocated worktree와 실행 미재개 |
| <a id="c31"></a>C31 | [packages/engine/src/media/provider.ts:6](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/media/provider.ts:6) | session/attachment/hash·supported image gate·원본 전송 한도 |
| <a id="c32"></a>C32 | [packages/engine/src/documents/provider.ts:42](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/documents/provider.ts:42) | 명시적 PDF 지원·별도 refs와 image/document 공유 byte 상한 |
| <a id="c33"></a>C33 | [packages/engine/src/provider/anthropic.ts:36](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/provider/anthropic.ts:36) | Anthropic text/image capability metadata; 계정 실행 성공과 구분 |
| <a id="c34"></a>C34 | [packages/engine/src/runner/index.ts:677](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/index.ts:677) | 현재 read 효과 batch만 제한 병렬; mutating 자원-aware scheduler와 구분 |
| <a id="c35"></a>C35 | [packages/engine/src/runner/index.ts:915](/Users/yakisoba0728/Documents/GitHub/Moodcode/packages/engine/src/runner/index.ts:915) | 읽기 동일 fingerprint 차단·effect 이후 읽기 집합 갱신·cleanup uncertainty 보존 |

whole-file/range SHA-256 및 상대 경로는 [JSON](comparison-evidence.json)을 따른다. 기능 부재는 이 공개 port·등록·실행 경계에서 새 계약이 확인되지 않았다는 뜻이며 제품 전체의 숨은 기능을 단정하지 않는다. 실제 테스트 통과 이력은 [구현 상태](../moodcode/implementation-status.md), 이번 문서 검사는 [비교 검증](comparison-verification.json)을 따른다.
