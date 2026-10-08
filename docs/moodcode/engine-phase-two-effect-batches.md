# Prepared resource 기반 효과 병렬 실행 (MC2-18a–d)

이 기능은 실제 Engine Run의 같은 Turn/Attempt에 제안된 파일 효과를 준비하고, 물리 resource가 서로 독립임을 증명한 member만 함께 실행한다. Root의 `effectBatches: true` opt-in이 필요하며 기본값과 child Engine은 기존 직렬 효과 실행을 유지한다. 별도의 batch DTO로 Run이나 도구 실행 권한을 만드는 API는 없다.

```ts
const engine = createEngine({
  dbPath,
  artifactDir,
  providers,
  effectBatches: true,
});
// 기존 run.submit / input.accept, 실제 provider tool.call, 각 도구의 정확한 승인을 사용한다.
const history = engine.inspectEffectBatches(workspaceId, sessionId);
const record = engine.getEffectBatch(sessionId, history[0].id);
```

두 조회 API는 기능이 꺼진 재시작에서도 기록을 반환한다. 반환된 DATA는 실행 handle이나 승인으로 사용할 수 없다.

## 지원되는 완결 경로

| 범위                  | 현재 구현                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 실제 resource capture | Engine이 등록한 원래 core patch producer와 그 file-action adapter의 private prepared handle에서 root/parent/file dev·inode, 전후 hash, source/pin SHA를 캡처한다.                                                         |
| 효과 병렬 lane        | 기존 regular file의 in-place update다. 실제 원래 prepared physical handle과 현재 실행 ToolContext에 일회성 permit을 결속한다.                                                                                             |
| 충돌 판단             | 같은 physical file inode, 대소문자를 보수적으로 접은 동일/포함 경로, 다른 workspace/root identity, resource 미확정이면 충돌로 분류한다. 원래 제안 순서의 wave를 유지한다.                                                 |
| 직렬 fallback         | create/delete/rename, command, MCP/unknown/custom producer는 병렬 권한을 받지 않는다. Core의 미확정 resource는 한 member씩 실행하며 외부/custom producer는 기존 준비·승인·실행 직렬 경로와 fallback 관측 기록을 사용한다. |
| 실제 승인             | member마다 기존 native Tool/Part 및 원래 outer prepared fingerprint에 대한 새 승인을 요구한다. sibling 승인·재사용 grant로 이 승인을 건너뛰지 않는다.                                                                     |
| 실제 효과 및 결과     | 기존 producer가 파일을 쓰고 actual checkpoint를 기록한다. native Tool/Part/result, checkpoint 전체 SHA, 출력 SHA, 실제 descriptor cleanup을 기준으로 member를 마감한다.                                                   |
| lock 및 debt          | 각 resource wave가 원래 coarse execution lock 하나를 공유한다. 물리 lock inode·epoch·owner가 바뀌거나 cleanup/receipt가 빠지면 unknown을 남기고 다음 충돌 효과를 시작하지 않는다.                                         |
| 복구와 archive        | 원래 SessionDocument revision과 독립 native event의 관계를 검증한다. 재시작은 활성 member를 unknown으로 보존하고 import는 paused history로 보존한다. 원래 permit/actor/승인은 복원하지 않으며 효과를 재실행하지 않는다.   |

Custom producer는 실제 core와 이름·schema가 같거나 `createPatchTool()`을 가져와도 Engine의 원래 core scope를 대체할 수 없다. 병렬화 여부는 이름 목록이 아니라 Engine이 캡처한 producer identity와 private physical prepare evidence에 달려 있다. 확정되지 않은 MCP connection/resource claim을 병렬 안전으로 인정하지 않는다.

## Budget와 실제 승인 경계

기존 Runner가 Turn 전체 tool-call allocation을 먼저 예약한다. Batch는 실제 현재 Run/config/catalogue와 parent child-reservation hash를 고정하고, 최대 네 member의 출력·artifact allowance를 준비 전에 동일한 정수 share로 나눈다. 출력의 예약분은 새 child allocation에 재사용할 수 없다. 준비 이후 parent child budget이나 catalogue/config가 바뀌면 실제 dispatch 전에 거부한다. 실행 시간은 원래 Run deadline과 실제 tool timeout 안에 머문다.

Managed artifact 저장도 원래 member share를 초과하지 않는다. 초과하면 실제 파일 효과/checkpoint를 보존하고 저장된 artifact를 incomplete, Tool을 failed, batch를 partial로 표시한다. 원래 반환된 바이트 수와 실제 저장 바이트 수는 metadata에 남긴다. 이 한도는 batch allowance이며 다른 기능의 일반 artifact 정책을 새 권한으로 변경하지 않는다.

모든 member의 준비가 끝난 뒤 native group birth를 먼저 commit하고 각 승인을 요청한다. 실제 실행에서는 원래 current ToolContext/Run/Turn/Attempt/Part, 원래 producer/catalogue, exact approval, 현재 physical source와 lock을 다시 확인한다. Native group birth SQL 실패는 승인과 물리 효과가 모두 0이다. 취소 후 늦게 허용된 승인도 효과를 시작하지 않는다.

## Native evidence와 미확정 상태

DB23의 기존 `session_documents`와 `session_events`를 사용한다. Migration이나 새로운 DB 테이블은 없다. 최대 member 4, batch record 256, record body 128 KiB, revision 32를 고정한다. Native Tool/Part/checkpoint의 기존 개별 byte bound도 조회 전에 검사한다.

- `effect.batch.resource_prepared`는 실제 Tool input SHA, outer fingerprint, private resource의 DATA를 원래 Run/Turn/Attempt에 기록한다.
- `effect.batch.member_settled`는 실제 member outcome, checkpoint SHA와 출력 SHA를 별도 Session evidence로 기록한다.
- `effect.batch.recorded`는 CAS head와 전체 immutable revision을 결속한다. Completed/partial 최종 receipt는 실제 lock release 뒤에만 기록한다.

History validator는 resource planning, scope/ID/hash, exact allowed approval, Tool/Part input·output·state, checkpoint pre/postimage와 전체 SHA, 독립 source/settlement event, head/lineage 및 cleanup을 확인한다. Head와 recorded history를 함께 완전히 재해시해도 독립 원래 prepared evidence를 바꿀 수 없다.

일부 실제 파일 쓰기가 끝났어도 checkpoint, descriptor close, member receipt 또는 최종 receipt가 빠지면 성공을 합성하지 않는다. Completed sibling의 원래 효과와 증거는 유지하고 불확실한 member만 unknown으로 보존한다. 이후 충돌 효과 및 새 workspace 효과 admission은 cleanup debt가 있는 동안 차단된다. Parent cancel/tool timeout은 기존 실제 Runner 경로를 따른다. 별도의 공개 member-cancel API는 이번 lane에 추가하지 않았다.

SIGKILL 뒤 active marker를 읽을 수 있는 boot 예외는 검증된 native record의 owner PID·epoch·actual execution-lock path가 정확히 일치하고 process-group claim이 없는 경우로 좁혔다. 이것은 기록 조회와 unknown 복구에만 사용한다. Marker를 삭제하지 않으며 새 효과 권한, PID ownership 추론, 자동 replay를 제공하지 않는다. Relocated import도 history이며 원래 physical handle을 복구하지 않는다.

## 실제 검증 및 제한

새 actual integration 27개는 실제 임시 Git/SQLite/Engine/provider/native approval/file descriptors를 사용한다. 서로 다른 두 파일의 writable handles가 첫 쓰기 해제 전에 모두 진입하는 독립 관측과, 같은 resource의 다른 도구가 순서대로 실행되어 후속 stale preimage를 거부하는 관측을 포함한다. 가짜 Run/Tool/ToolContext, fulfilled future, boolean host success로 긍정 증거를 만들지 않는다.

SIGKILL은 준비 완료, 쓰기 직전, 쓰기 직후, sibling 완료 후 peer 실행 중, 최종 receipt commit 후의 다섯 경계에서 수행한다. 재개 provider 호출 0, surviving file bytes/known sibling evidence 보존, unknown debt/marker 유지와 반복 reopen의 revision 안정성을 확인한다. 추가로 native birth/checkpoint/final-receipt SQL fault, 실제 descriptor close 실패, lock inode 상실, rename/symlink/원본 교체, 거절·late approval·catalogue/child budget 변경, 큰 native input, 실제 artifact share truncation, default-off/custom scope, paused archive/import와 native rehash를 검사한다.

인접 Runner/read parallel/patch/edit/runtime/lock 검사는 별도 compiled Node gate로 확인한다. `/tmp` 출력에서 기존 `file-lock-reservation.test.ts`의 hardcoded tsx child-loader 경로가 깨지는 한 case는 original harness failure로 명시하고 제외했다. 해당 기존 fixture/production은 변경하지 않았으며 Root의 정상 repo dist aggregate gate가 그 case까지 실행한다. 이 기능의 새 fixture는 tsx loader 없이 컴파일된 Node child를 실행한다.

실제 계정·외부 provider·MCP/command 효과 병렬·GUI·benchmark는 이 검증에 포함되지 않는다. 성능 향상 수치는 주장하지 않는다. 권한을 확대하는 unknown-resource 병렬화와 automatic replay도 지원하지 않는다.
