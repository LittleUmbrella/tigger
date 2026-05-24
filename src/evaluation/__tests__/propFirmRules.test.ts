import { describe, expect, it } from 'vitest';
import {
  PROP_FIRM_RULES,
  createCustomPropFirmRule,
  getPropFirmRule,
} from '../propFirmRules.js';

describe('getPropFirmRule', () => {
  it('returns known firm config case-insensitively', () => {
    const rule = getPropFirmRule('MUBITE');
    expect(rule).not.toBeNull();
    expect(rule!.name).toBe('mubite');
    expect(rule!.profitTarget).toBe(10);
  });

  it('returns null for unknown firm', () => {
    expect(getPropFirmRule('unknown-firm')).toBeNull();
  });

  it('merges overrides without mutating base', () => {
    const base = PROP_FIRM_RULES['mubite'].initialBalance;
    const rule = getPropFirmRule('mubite', { initialBalance: 50000 });
    expect(rule!.initialBalance).toBe(50000);
    expect(PROP_FIRM_RULES['mubite'].initialBalance).toBe(base);
  });
});

describe('createCustomPropFirmRule', () => {
  it('builds a rule with name and displayName', () => {
    const rule = createCustomPropFirmRule('custom', 'Custom Firm', {
      initialBalance: 25000,
      maxDrawdown: 8,
    });
    expect(rule).toEqual({
      name: 'custom',
      displayName: 'Custom Firm',
      initialBalance: 25000,
      maxDrawdown: 8,
    });
  });
});
