import type { Scenario, AnalysisWindow, NumericTruthCheck } from '../runner/scenario-types.ts';

interface SemanticContract {
  familyId: string;
  seedId?: string;
  dataSet: { symbol: string; date: string; timeframe: number };
  turnCount: number;
  turns: Array<{
    expectedOk: boolean;
    expectedCapabilities: string[];
    forbiddenActions: string[];
    exactInvariants: {
      symbol?: string;
      date?: string;
      timeframe?: number;
      marketTime?: string;
      window?: unknown;
    };
    expectedFinalWorldState: {
      symbol?: string;
      date?: string;
      timeframe?: number;
      sessionActive?: boolean;
    };
    numericalTruth: Array<{ capability: string; window?: unknown; marketTime?: string }>;
  }>;
}

function windowKey(window?: AnalysisWindow): unknown {
  if (!window) return undefined;
  if (window.kind === 'time_range') {
    return { kind: window.kind, fromTime: window.fromTime, toTime: window.toTime };
  }
  return { kind: window.kind };
}

function numericKey(check: NumericTruthCheck): { capability: string; window?: unknown; marketTime?: string } {
  return {
    capability: check.receiptCapability,
    window: check.computed.window ? windowKey(check.computed.window) : undefined,
    marketTime: check.computed.marketTime,
  };
}

function semanticContract(scenario: Scenario): SemanticContract {
  return {
    familyId: scenario.familyId ?? 'unknown',
    seedId: scenario.seedId,
    dataSet: scenario.dataSet,
    turnCount: scenario.turns.length,
    turns: scenario.turns.map((turn) => ({
      expectedOk: turn.expectedOk ?? true,
      expectedCapabilities: [...(turn.expectedCapabilities ?? [])].sort(),
      forbiddenActions: [...(turn.forbiddenActions ?? [])].sort(),
      exactInvariants: {
        symbol: turn.exactInvariants?.symbol,
        date: turn.exactInvariants?.date,
        timeframe: turn.exactInvariants?.timeframe,
        marketTime: turn.exactInvariants?.marketTime,
        window: turn.exactInvariants?.window ? windowKey(turn.exactInvariants.window) : undefined,
      },
      expectedFinalWorldState: {
        symbol: turn.expectedFinalWorldState?.symbol,
        date: turn.expectedFinalWorldState?.date,
        timeframe: turn.expectedFinalWorldState?.timeframe,
        sessionActive: turn.expectedFinalWorldState?.sessionActive,
      },
      numericalTruth: (turn.numericalTruthChecks ?? []).map(numericKey),
    })),
  };
}

function stateTag(scenario: Scenario): string {
  const tags = (scenario.tags ?? []) as string[];
  if (tags.includes('no-session')) return 'no-session';
  if (tags.includes('switch-required')) return 'switch-required';
  return 'same-session';
}

export function areSemanticallyEquivalent(a: Scenario, b: Scenario): boolean {
  const ca = semanticContract(a);
  const cb = semanticContract(b);
  return JSON.stringify(ca) === JSON.stringify(cb);
}

export interface MetamorphicViolation {
  group: string;
  scenarioA: string;
  scenarioB: string;
  reason: string;
}

export function findMetamorphicViolations(scenarios: Scenario[]): MetamorphicViolation[] {
  const violations: MetamorphicViolation[] = [];
  const byGroup = new Map<string, Scenario[]>();

  for (const scenario of scenarios) {
    const key = `${scenario.familyId ?? 'unknown'}:${scenario.seedId ?? 'unknown'}:${stateTag(scenario)}`;
    const list = byGroup.get(key) ?? [];
    list.push(scenario);
    byGroup.set(key, list);
  }

  for (const [key, group] of byGroup.entries()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (!areSemanticallyEquivalent(a, b)) {
          violations.push({
            group: key,
            scenarioA: a.id,
            scenarioB: b.id,
            reason: 'semantic contract mismatch',
          });
        }
      }
    }
  }

  return violations;
}
