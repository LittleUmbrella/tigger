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
});
