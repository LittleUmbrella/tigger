import { describe, expect, it } from 'vitest';
import type { Trade } from '../../db/schema.js';
import { classifyCtraderCloseFromDb, collectSignalTakeProfitLevels } from '../ctraderCloseClassification.js';
import { resolveBreakevenAfterTPs, getTakeProfitLevelCount } from '../../utils/breakevenAfterTPs.js';

const leg = (overrides: Partial<Trade>): Trade =>
  ({
    exchange: 'ctrader',
    channel: '2845421508',
    message_id: '14695',
    trading_pair: 'XAUUSD',
    direction: 'long',
    entry_price: 4574.42,
    stop_loss: 4563,
    ...overrides,
  }) as Trade;

/** Mirrors monitor: TP hits are message-wide; BE threshold uses same-account leg count. */
const evaluateBreakevenEligibility = (
  trade: Trade,
  allOnMessage: Trade[]
): { siblingsHitTp: number; effectiveBreakevenAfterTPs: number } => {
  const accountLegs = allOnMessage.filter(
    (t) => t.exchange === 'ctrader' && t.account_name === trade.account_name
  );
  const totalTpLevels = accountLegs.reduce(
    (sum, t) => sum + Math.max(getTakeProfitLevelCount(t), 1),
    0
  );
  const effectiveBreakevenAfterTPs = resolveBreakevenAfterTPs(totalTpLevels, {
    breakevenAfterTPs: 1,
    dynamicBreakevenAfterTPs: true,
  });
  const signalTps = collectSignalTakeProfitLevels(
    allOnMessage.filter((t) => t.exchange === 'ctrader')
  );
  let siblingsHitTp = 0;
  for (const sib of allOnMessage.filter((t) => t.exchange === 'ctrader' && t.id !== trade.id)) {
    if (!['closed', 'completed', 'stopped'].includes(sib.status)) continue;
    if (classifyCtraderCloseFromDb(sib, signalTps) === 'take_profit') {
      siblingsHitTp += Math.max(getTakeProfitLevelCount(sib), 1);
    }
  }
  return { siblingsHitTp, effectiveBreakevenAfterTPs };
};

const evaluateTickCloseBreakevenEligibility = (
  filledTpCount: number,
  effectiveBreakevenAfterTPs: number
): boolean => filledTpCount >= effectiveBreakevenAfterTPs;

describe('cTrader breakeven eligibility (message 14695 pattern)', () => {
  it('counts TP on another account toward BE on open legs', () => {
    const tp1OtherAccount = leg({
      id: 1153,
      account_name: 'ctrader_demo_2_100',
      status: 'closed',
      take_profits: '[4577.08]',
      exit_price: 4577.33,
      pnl: 52.74,
    });
    const openLeg = leg({
      id: 1157,
      account_name: 'ctrader_demo_2_25',
      status: 'active',
      take_profits: '[4577.08]',
    });
    const all = [
      tp1OtherAccount,
      openLeg,
      leg({ id: 1159, account_name: 'ctrader_demo_2_25', status: 'active', take_profits: '[4593.08]' }),
      leg({
        id: 1158,
        account_name: 'ctrader_demo_2_25',
        status: 'stopped',
        exit_price: 4574.08,
        pnl: -0.92,
        take_profits: '[4584.08]',
      }),
    ];
    const { siblingsHitTp, effectiveBreakevenAfterTPs } = evaluateBreakevenEligibility(openLeg, all);
    expect(siblingsHitTp).toBeGreaterThanOrEqual(1);
    expect(effectiveBreakevenAfterTPs).toBe(1);
    expect(siblingsHitTp >= effectiveBreakevenAfterTPs).toBe(true);
  });

  it('triggers BE when other legs closed at SL (N-trade scale-out)', () => {
    const openLeg = leg({
      id: 1251,
      account_name: 'ctrader_demo_2',
      status: 'active',
      take_profits: '[4462.11]',
    });
    const all = [
      openLeg,
      leg({
        id: 1254,
        account_name: 'ctrader_demo_2_100',
        status: 'stopped',
        exit_price: 4430.95,
        pnl: -419,
        take_profits: '[4462.11]',
      }),
      leg({
        id: 1253,
        account_name: 'ctrader_demo_2_25',
        status: 'stopped',
        exit_price: 4430.97,
        pnl: -66,
        take_profits: '[4478.1]',
      }),
    ];
    const { siblingsHitTp, effectiveBreakevenAfterTPs } = evaluateBreakevenEligibility(openLeg, all);
    expect(siblingsHitTp).toBe(0);
    const closedCount = all.filter(
      (s) => s.id !== openLeg.id && ['closed', 'stopped', 'completed'].includes(s.status)
    ).length;
    expect(closedCount).toBeGreaterThanOrEqual(effectiveBreakevenAfterTPs);
  });

  it('uses filled TP count gate for tick-close strategy', () => {
    expect(evaluateTickCloseBreakevenEligibility(0, 1)).toBe(false);
    expect(evaluateTickCloseBreakevenEligibility(1, 2)).toBe(false);
    expect(evaluateTickCloseBreakevenEligibility(2, 2)).toBe(true);
  });
});
