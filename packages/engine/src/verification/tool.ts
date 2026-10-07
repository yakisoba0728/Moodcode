import { EngineError, isTerminal } from '@moodcode/contracts';
import type { PreparedTool, ToolContext, ToolDefinition } from '../ports.js';
import type { ToolCatalogue } from '../tools/runtime/index.js';
import { assertVerificationCwd, importOwnedCommandEvidence, observeOwnedCommandResult, observeVerificationSource, observeVerificationSourceAfter,
  verificationCatalogueIdentity, verificationExecutionBinding, verificationNestedContext, verificationResult,
  type VerificationToolHost, VERIFICATION_EXECUTION_LIMITS } from './execution.js';
import { normalizeVerificationCommandCapability, normalizeVerificationSource, verificationFail, verificationHash, verificationJson, verificationPlain, verificationText,
  type VerificationCheck, type VerificationCommandCapability, type VerificationObservation, type VerificationReceiptResult, type VerificationSnapshot, type VerificationSource } from './types.js';

interface Capture {
  snapshot: VerificationSnapshot; check: VerificationCheck; source: VerificationSource; catalogue: ToolCatalogue; catalogueIdentity: string;
  inner: PreparedTool | null; innerSnapshot: string; capability: VerificationCommandCapability | null; preparedSnapshot: string; binding: string; outputLimit: number; timeoutLimit: number; used: boolean;
}
function active(context: ToolContext): void { if (context.signal.aborted) verificationFail('CANCELLED', 'Verification tool execution was cancelled'); }
function select(host: VerificationToolHost, context: ToolContext, checkId: string): { snapshot: VerificationSnapshot; check: VerificationCheck; catalogue: ToolCatalogue } {
  active(context); const run = host.getRun(context.runId);
  if (run.sessionId !== context.sessionId || run.workspaceId !== context.workspace.id) verificationFail('VERIFICATION_SCOPE_MISMATCH', 'Verification context belongs to another Run or workspace');
  if (isTerminal(run.state) || run.state === 'cancelling') verificationFail('RUN_TERMINAL', 'Verification requires an active Run');
  if (run.config.mode !== 'build') verificationFail('PLAN_MODE_WRITE_BLOCKED', 'Verification commands require build mode');
  const snapshot = host.plans.get(context.sessionId, context.runId);
  if (!snapshot) return verificationFail('VERIFICATION_PLAN_NOT_FOUND', 'Host has not configured a verification plan for this Run');
  host.plans.assertCurrent(snapshot);
  const check = snapshot.plans.at(-1)!.checks.find(value => value.id === checkId);
  if (!check) return verificationFail('VERIFICATION_CHECK_NOT_IN_PLAN', 'Requested check is outside the host captured plan');
  const catalogue = host.captureCatalogue(context); host.commandRuntime.assertCatalogueCurrent(catalogue);
  if (catalogue.mode !== 'build' || !catalogue.profile || catalogue.profile.id !== check.profileId || catalogue.profile.revision !== check.profileRevision || !catalogue.tools.some(tool => tool.name === 'run_command')) verificationFail('VERIFICATION_PROFILE_DENIED', 'The authenticated parent profile does not allow the exact registered command');
  return { snapshot, check, catalogue };
}
function sameSource(left: VerificationSource, right: VerificationSource): void { if (verificationHash(left) !== verificationHash(right)) verificationFail('VERIFICATION_SOURCE_STALE', 'Verification source changed after capture'); }
function capability(host: VerificationToolHost, context: ToolContext, catalogue: ToolCatalogue): VerificationCommandCapability | null {
  return host.commandCapability ? normalizeVerificationCommandCapability(host.commandCapability(context, catalogue), catalogue.revision) : null;
}
function sameCapability(left: VerificationCommandCapability | null, right: VerificationCommandCapability | null): void {
  if (verificationHash(left) !== verificationHash(right)) verificationFail('VERIFICATION_COMMAND_CAPABILITY_STALE', 'Native command registration or execution platform changed after capture');
}
function commandPolicy(host: VerificationToolHost, check: VerificationCheck, catalogue: ToolCatalogue): void {
  const decision = host.commandRuntime.policy.evaluate({ toolName: 'run_command', effect: 'execute', mode: catalogue.mode, requiresApproval: true, resources: [`path:${check.cwd}`, `command:${check.command}`] });
  if (decision.version !== catalogue.policyVersion) verificationFail('TOOL_CATALOGUE_STALE', 'Native command policy changed after catalogue capture');
  if (decision.decision === 'deny') verificationFail('TOOL_POLICY_DENIED', 'Registered verification command is denied by its current base policy');
}

/** One registered check, one retained command capability, one exact outer approval. */
export function createVerificationTool(host: VerificationToolHost): ToolDefinition {
  const captures = new WeakMap<PreparedTool, Capture>();
  return {
    name: 'verify_changes', effectClass: 'execute',
    description: 'Execute one host registered verification check with exact command approval and durable source-bound outcome. Use only a check ID from the host plan. Failed or stale verification does not prove completion.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['checkId'], properties: { checkId: { type: 'string', minLength: 1, maxLength: 256 } } },
    async prepare(input, context) {
      verificationPlain(input, ['checkId']); verificationText(input.checkId);
      const selected = select(host, context, input.checkId), plan = selected.snapshot.plans.at(-1)!;
      await assertVerificationCwd(context, selected.check);
      const source = await observeVerificationSource(host, context, context.signal); sameSource(source, normalizeVerificationSource(plan.source));
      const nested = verificationNestedContext(context, selected.check);
      const commandCapability = capability(host, context, selected.catalogue); commandPolicy(host, selected.check, selected.catalogue);
      const inner = commandCapability?.supported === false ? null : await host.commandRuntime.resolve(selected.catalogue, 'run_command').prepare({ command: selected.check.command, cwd: selected.check.cwd, timeoutMs: nested.limits.toolTimeoutMs }, nested);
      const innerPreview = inner?.preview ?? { command: selected.check.command, cwd: selected.check.cwd, timeoutMs: nested.limits.toolTimeoutMs, workspaceId: context.workspace.id, runId: context.runId, toolCallId: context.toolCallId,
        platform: commandCapability!.platform, termination: 'unsupported', commandPreparation: 'unsupported-no-inner-preflight', commandCapability: commandCapability! };
      // Host policy/preflight may have awaited external analysis. Recheck the frozen owner and source after it.
      const current = select(host, context, selected.check.id);
      if (current.snapshot.revision !== selected.snapshot.revision || verificationCatalogueIdentity(current.catalogue) !== verificationCatalogueIdentity(selected.catalogue)) verificationFail('VERIFICATION_PREPARED_STALE', 'Verification plan or authenticated catalogue changed during preparation');
      sameCapability(capability(host, context, current.catalogue), commandCapability);
      sameSource(await observeVerificationSource(host, context, context.signal), source); active(context);
      const fingerprint = verificationHash({ version: 1, binding: verificationExecutionBinding(context), planId: plan.id, planSha256: plan.planSha256, checkSha256: selected.check.registrationSha256, source,
        innerFingerprint: inner?.fingerprint ?? null, innerPreviewSha256: verificationHash(innerPreview), commandCapability, catalogue: verificationCatalogueIdentity(selected.catalogue), maxOutputBytes: nested.limits.maxOutputBytes, timeoutMs: nested.limits.toolTimeoutMs });
      host.receipts.assertCanBegin(context.sessionId, context.runId, selected.snapshot.revision, { checkId: selected.check.id, toolCallId: context.toolCallId, preparedFingerprint: fingerprint, source });
      const preview = verificationJson({ ...innerPreview, verification: { checkId: selected.check.id, planId: plan.id, planSha256: plan.planSha256, registrationSha256: selected.check.registrationSha256, source,
        preparedFingerprint: fingerprint, commandPreparedFingerprint: inner?.fingerprint ?? null, commandCapability, maxOutputBytes: nested.limits.maxOutputBytes, executionAuthority: 'exact-approval-required' } });
      const prepared: PreparedTool = { name: 'verify_changes', input: { checkId: selected.check.id }, fingerprint, requiresApproval: true, preview };
      captures.set(prepared, { ...selected, source, inner, innerSnapshot: JSON.stringify(inner), capability: commandCapability, preparedSnapshot: JSON.stringify(prepared), binding: verificationExecutionBinding(context), catalogueIdentity: verificationCatalogueIdentity(selected.catalogue), outputLimit: nested.limits.maxOutputBytes, timeoutLimit: nested.limits.toolTimeoutMs, used: false });
      return prepared;
    },
    async execute(prepared, context) {
      // Capture the host port only during actual execution and retain the original outer context for its WeakMap authentication.
      const consumedWriter = host.consumedSettlementWriter;
      const capture = captures.get(prepared);
      if (!capture || capture.used) verificationFail('INVALID_PREPARED_TOOL', 'Verification prepared capability is unknown or already consumed');
      capture.used = true;
      verificationPlain(prepared, ['name', 'input', 'fingerprint', 'requiresApproval', 'preview', 'data']); verificationJson(prepared);
      if (JSON.stringify(prepared) !== capture.preparedSnapshot || JSON.stringify(capture.inner) !== capture.innerSnapshot || verificationExecutionBinding(context) !== capture.binding) verificationFail('VERIFICATION_APPROVAL_STALE', 'Exact verification preview or execution owner changed');
      const selected = select(host, context, capture.check.id);
      if (selected.snapshot.revision !== capture.snapshot.revision || verificationCatalogueIdentity(selected.catalogue) !== capture.catalogueIdentity) verificationFail('VERIFICATION_PREPARED_STALE', 'Verification plan or authenticated catalogue changed after approval');
      sameCapability(capability(host, context, selected.catalogue), capture.capability); commandPolicy(host, capture.check, selected.catalogue);
      await assertVerificationCwd(context, capture.check);
      const checkpoints: import('@moodcode/contracts').Checkpoint[] = [];
      const nested = verificationNestedContext(context, capture.check, checkpoint => {
        if (checkpoints.length >= VERIFICATION_EXECUTION_LIMITS.maxCheckpoints) verificationFail('VERIFICATION_CHECKPOINT_LIMIT', 'Actual command published too many verification checkpoints');
        checkpoints.push(structuredClone(checkpoint));
      });
      if (nested.limits.maxOutputBytes !== capture.outputLimit || nested.limits.toolTimeoutMs !== capture.timeoutLimit) verificationFail('VERIFICATION_APPROVAL_STALE', 'Command execution limits changed after exact approval');
      if (capture.inner) await host.commandRuntime.assertPreparedCurrent(capture.inner, nested);
      const source = await observeVerificationSource(host, context, context.signal); sameSource(source, capture.source); active(context);
      // Physical role/preflight/source checks may await. Never publish intent for a changed owner afterwards.
      const ready = select(host, context, capture.check.id);
      if (ready.snapshot.revision !== capture.snapshot.revision || verificationCatalogueIdentity(ready.catalogue) !== capture.catalogueIdentity) verificationFail('VERIFICATION_PREPARED_STALE', 'Verification owner changed during command authority revalidation');
      sameCapability(capability(host, context, ready.catalogue), capture.capability); commandPolicy(host, capture.check, ready.catalogue);
      const begun = host.receipts.begin(context.sessionId, context.runId, ready.snapshot.revision, { checkId: capture.check.id, toolCallId: context.toolCallId, preparedFingerprint: prepared.fingerprint, source });
      if (!capture.inner) {
        if (!capture.capability || capture.capability.supported) verificationFail('INVALID_VERIFICATION_COMMAND_CAPABILITY', 'Unsupported verification requires the pinned native capability');
        const observation: VerificationObservation = { disposition: 'unsupported', command: capture.check.command, cwd: capture.check.cwd, profileId: capture.check.profileId, profileRevision: capture.check.profileRevision, toolCallId: context.toolCallId, preparedFingerprint: prepared.fingerprint,
          sourceBefore: source, sourceAfter: { ...source }, executionCheckpointId: null, exitCode: null, signal: null, started: false, cancelled: false, timedOut: false, cleanup: { confirmed: true, scope: 'not-dispatched', evidenceSha256: null }, observedOutputBytes: 0, outputAccountingComplete: true, artifactRefs: [], executionComplete: true, reasonCode: 'COMMAND_PLATFORM_UNSUPPORTED', commandCapability: capture.capability };
        const result = { content: `Verification command unsupported on ${capture.capability.platform}; no process dispatched.`, isError: true,
          data: { command: capture.check.command, cwd: capture.check.cwd, timeoutMs: nested.limits.toolTimeoutMs, status: 'unsupported', exitCode: null, signal: null, started: false, cancelled: false, timedOut: false, cleanupConfirmed: true, terminationScope: 'not-dispatched', commandCapability: { ...capture.capability } } };
        try { const settled = host.receipts.settle(context.sessionId, context.runId, begun.revision, begun.receipt.id, observation); return verificationResult(result, settled.receipt, 'saved', nested); }
        catch { return verificationResult(result, begun.receipt, 'pending', nested, 'RECEIPT_PUBLICATION_REJECTED'); }
      }
      const dispatched = host.receipts.dispatch(context.sessionId, context.runId, begun.revision, begun.receipt.id, source);
      let result: import('../ports.js').ToolResult;
      try { result = await host.commandRuntime.execute(capture.inner, nested); }
      catch {
        // The retained capability may have consumed an effect before failing. Error details are not evidence.
        try { host.receipts.markUncertain(context.sessionId, context.runId, dispatched.revision, dispatched.receipt.id); } catch { /* Atomic terminal/CAS guard leaves the pending record for explicit host recovery. */ }
        throw new EngineError('CLEANUP_UNCERTAIN', 'Verification command returned no owned terminal outcome; its consumed capability must never be replayed');
      }
      const sourceAfter = await observeVerificationSourceAfter(host, context);
      let owned: ReturnType<typeof observeOwnedCommandResult>;
      try { owned = observeOwnedCommandResult(result, capture.check, dispatched.receipt, nested, checkpoints, sourceAfter); }
      catch {
        let failed: VerificationReceiptResult | null = null;
        try { failed = host.receipts.markUncertain(context.sessionId, context.runId, dispatched.revision, dispatched.receipt.id); } catch { /* Preserve the active/terminal publication boundary. */ }
        return verificationResult(result, failed?.receipt ?? dispatched.receipt, failed ? 'saved' : 'pending', nested, 'OWNED_OUTCOME_INCOMPLETE');
      }
      if (capture.capability) owned.observation.commandCapability = { ...capture.capability };
      try { owned.observation.artifactRefs = await importOwnedCommandEvidence(host, owned, result, dispatched.receipt, nested); }
      catch { owned.observation.executionComplete = false; owned.observation.reasonCode = 'ORIGINAL_LOG_EVIDENCE_INCOMPLETE'; }
      let settled: VerificationReceiptResult;
      try { settled = host.receipts.settle(context.sessionId, context.runId, dispatched.revision, dispatched.receipt.id, owned.observation); }
      catch {
        // Only a still-live actual cancelling owner may publish this already-consumed result. No new intent or terminal write is admitted.
        if (consumedWriter && host.getRun(context.runId).state === 'cancelling') {
          try { settled = host.receipts.settleConsumed(context.sessionId, context.runId, dispatched.revision, dispatched.receipt.id, owned.observation, (kind, revision, data) => consumedWriter.call(host, context, kind, revision, data)); }
          catch { return verificationResult(result, dispatched.receipt, 'pending', nested, 'RECEIPT_PUBLICATION_REJECTED'); }
        } else return verificationResult(result, dispatched.receipt, 'pending', nested, 'RECEIPT_PUBLICATION_REJECTED');
      }
      return verificationResult(result, settled.receipt, 'saved', nested);
    },
  };
}

export type { VerificationToolHost } from './execution.js';
