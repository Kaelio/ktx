import { describe, expect, it } from 'vitest';
import {
  createKtxRelationshipDetectionBudget,
  mapWithBudget,
} from '../../../src/context/scan/relationship-detection-budget.js';

describe('relationship detection budget', () => {
  it('reports no stop while inside the wall-clock budget', () => {
    let clock = 1000;
    const budget = createKtxRelationshipDetectionBudget({ budgetMs: 500, now: () => clock });
    expect(budget.check()).toBeNull();
    clock = 1400;
    expect(budget.check()).toBeNull();
    expect(budget.stopReason()).toBeNull();
  });

  it('trips on budget exhaustion and records it stickily', () => {
    let clock = 0;
    const budget = createKtxRelationshipDetectionBudget({ budgetMs: 100, now: () => clock });
    clock = 150;
    expect(budget.check()).toBe('budget');
    // Even after a notional clock rewind the recorded reason persists.
    clock = 10;
    expect(budget.stopReason()).toBe('budget');
  });

  it('prefers abort over budget when the signal fires', () => {
    const controller = new AbortController();
    let clock = 0;
    const budget = createKtxRelationshipDetectionBudget({
      budgetMs: 1_000,
      signal: controller.signal,
      now: () => clock,
    });
    expect(budget.check()).toBeNull();
    controller.abort();
    expect(budget.check()).toBe('aborted');
    expect(budget.stopReason()).toBe('aborted');
  });

  it('maps every item and stays unmarked when the budget is never exhausted', async () => {
    const budget = createKtxRelationshipDetectionBudget({ budgetMs: 1_000, now: () => 0 });
    const { results, processedCount } = await mapWithBudget({
      inputs: [1, 2, 3, 4],
      concurrency: 2,
      budget,
      mapOne: async (value) => value * 10,
    });
    expect(processedCount).toBe(4);
    expect(results).toEqual([10, 20, 30, 40]);
    expect(budget.stopReason()).toBeNull();
  });

  it('stops claiming new items once the budget trips and leaves the rest undefined', async () => {
    let clock = 0;
    const budget = createKtxRelationshipDetectionBudget({ budgetMs: 25, now: () => clock });
    const started: number[] = [];
    const { results, processedCount } = await mapWithBudget({
      inputs: [0, 1, 2, 3, 4],
      concurrency: 1,
      budget,
      onStart: (index) => {
        started.push(index);
        clock += 10; // each unit advances the clock; the budget elapses partway through
      },
      mapOne: async (value) => value,
    });
    expect(processedCount).toBeLessThan(5);
    expect(results.slice(processedCount).every((value) => value === undefined)).toBe(true);
    expect(budget.stopReason()).toBe('budget');
  });
});
