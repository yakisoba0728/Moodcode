import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_LIMITS, EngineError, type RunConfig } from '@moodcode/contracts';
import { normalizeEngineBudgets } from '@moodcode/contracts/validation';
import { BudgetAccount } from './budgets.js';

function fixture(budgets = {}, limits = {}): BudgetAccount {
  const config: RunConfig = { providerId: 'fixture', modelId: 'fixture', mode: 'plan', limits: { ...DEFAULT_LIMITS, ...limits }, budgets: normalizeEngineBudgets(budgets) };
  return new BudgetAccount(config);
}
const code = (expected: string) => (error: unknown) => error instanceof EngineError && error.code === expected;

test('new input renews turn allowance without renewing the absolute Run limit', () => {
  const budget = fixture({ turnAllowance: 1 }, { maxTurns: 2 });
  budget.startTurn();
  assert.throws(() => budget.startTurn(), code('TURN_ALLOWANCE'));
  budget.inputPromoted();
  budget.startTurn();
  budget.inputPromoted();
  assert.throws(() => budget.startTurn(), code('TURN_LIMIT'));
  assert.equal(budget.snapshot().logicalTurns, 2);
});

test('turn calls, Run calls and retries have independent atomic bounds', () => {
  const budget = fixture({ maxToolCallsPerTurn: 2, maxProviderAttempts: 2 }, { maxToolCalls: 3 });
  assert.throws(() => budget.startProviderAttempt(), code('TURN_NOT_STARTED'));
  budget.startTurn();
  budget.reserveToolCalls(2);
  assert.throws(() => budget.reserveToolCalls(1), code('TURN_TOOL_LIMIT'));
  assert.equal(budget.snapshot().toolCalls, 2);
  budget.startProviderAttempt();
  budget.startProviderAttempt();
  assert.throws(() => budget.startProviderAttempt(), code('RETRY_LIMIT'));
  budget.startTurn();
  budget.reserveToolCalls(1);
  assert.throws(() => budget.reserveToolCalls(1), code('TOOL_LIMIT'));
  budget.startProviderAttempt();
  assert.equal(budget.snapshot().providerAttempts, 1);
});

test('summary requests and returned usage are bounded and immutable', () => {
  const budget = fixture({ maxSummaryCalls: 1 });
  budget.startSummary();
  assert.throws(() => budget.startSummary(), code('SUMMARY_LIMIT'));
  const snapshot = budget.snapshot();
  assert.equal(Reflect.set(snapshot, 'summaryCalls', 0), false);
  assert.equal(Reflect.set(budget.budgets, 'maxSummaryCalls', 10), false);
  for (const invalid of [-1, 0.5, NaN, Infinity]) assert.throws(() => budget.reserveToolCalls(invalid), code('INVALID_BUDGET_USAGE'));
});
