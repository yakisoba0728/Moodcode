import { EngineError, type EngineBudgets, type RunConfig } from '@moodcode/contracts';
import { normalizeEngineBudgets } from '@moodcode/contracts/validation';

export interface BudgetUsage {
  logicalTurns: number;
  allowanceUsed: number;
  toolCalls: number;
  turnToolCalls: number;
  summaryCalls: number;
  providerAttempts: number;
}

/** Resettable input allowance never extends the absolute Run budget. */
export class BudgetAccount {
  readonly budgets: Readonly<EngineBudgets>;
  private usage: BudgetUsage = { logicalTurns: 0, allowanceUsed: 0, toolCalls: 0, turnToolCalls: 0, summaryCalls: 0, providerAttempts: 0 };

  constructor(private readonly config: RunConfig) {
    this.budgets = Object.freeze(normalizeEngineBudgets(config.budgets, config.budgets === undefined ? {
      turnAllowance: config.limits.maxTurns,
      maxToolCallsPerTurn: config.limits.maxToolCalls,
    } : undefined));
  }

  inputPromoted(): void { this.usage.allowanceUsed = 0; }

  startTurn(): void {
    if (this.usage.logicalTurns >= this.config.limits.maxTurns) {
      throw new EngineError('TURN_LIMIT', 'Run reached its absolute turn limit');
    }
    if (this.usage.allowanceUsed >= this.budgets.turnAllowance) {
      throw new EngineError('TURN_ALLOWANCE', 'Input reached its turn allowance');
    }
    this.usage.logicalTurns++;
    this.usage.allowanceUsed++;
    this.usage.turnToolCalls = 0;
    this.usage.providerAttempts = 0;
  }

  startProviderAttempt(): void {
    if (this.usage.logicalTurns === 0) throw new EngineError('TURN_NOT_STARTED', 'A provider attempt must belong to a logical turn');
    if (this.usage.providerAttempts >= this.budgets.maxProviderAttempts) throw new EngineError('RETRY_LIMIT', 'Turn reached its provider attempt limit');
    this.usage.providerAttempts++;
  }

  reserveToolCalls(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new EngineError('INVALID_BUDGET_USAGE', 'Tool count must be a nonnegative integer');
    if (this.usage.toolCalls + count > this.config.limits.maxToolCalls) throw new EngineError('TOOL_LIMIT', 'Run reached its tool call limit');
    if (this.usage.turnToolCalls + count > this.budgets.maxToolCallsPerTurn) throw new EngineError('TURN_TOOL_LIMIT', 'Turn reached its tool call limit');
    this.usage.toolCalls += count;
    this.usage.turnToolCalls += count;
  }

  startSummary(): void {
    if (this.usage.summaryCalls >= this.budgets.maxSummaryCalls) throw new EngineError('SUMMARY_LIMIT', 'Run reached its summary request limit');
    this.usage.summaryCalls++;
  }

  snapshot(): Readonly<BudgetUsage> { return Object.freeze({ ...this.usage }); }
}
