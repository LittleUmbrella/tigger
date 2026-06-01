import type { AccountConfig } from '../types/config.js';
import { logger } from './logger.js';

/**
 * Minimum reward-to-risk ratio (reward / risk). E.g. 2 means at least 2:1 (2R reward per 1R risk).
 * Uses equal quantity weighting across take profits (same semantics as trade_calculator.js).
 */
export const calculateRiskRewardRatio = (
  signalType: 'long' | 'short',
  entryPrice: number,
  stopLoss: number,
  takeProfits: number[]
): number | null => {
  if (
    !Number.isFinite(entryPrice) ||
    entryPrice <= 0 ||
    !Number.isFinite(stopLoss) ||
    stopLoss <= 0 ||
    !takeProfits?.length
  ) {
    return null;
  }

  const risk =
    signalType === 'long'
      ? entryPrice - stopLoss
      : stopLoss - entryPrice;

  if (!Number.isFinite(risk) || risk <= 0) {
    return null;
  }

  const rewards = takeProfits
    .map((tp) =>
      signalType === 'long' ? tp - entryPrice : entryPrice - tp
    )
    .filter((reward) => Number.isFinite(reward) && reward > 0);

  if (rewards.length === 0) {
    return null;
  }

  const averageReward = rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length;
  return averageReward / risk;
};

/**
 * Channel-level minRiskReward overrides account-level when set; account is fallback only.
 */
export const resolveMinRiskReward = (
  channelMin: number | undefined,
  account: AccountConfig | null | undefined
): number | undefined => {
  if (channelMin !== undefined) {
    return channelMin;
  }
  if (account?.minRiskReward !== undefined) {
    return account.minRiskReward;
  }
  return undefined;
};

export const assertMinRiskReward = (opts: {
  minRiskReward: number | undefined;
  signalType: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfits: number[];
  context?: {
    channel?: string;
    symbol?: string;
    messageId?: string | number;
    accountName?: string;
  };
}): void => {
  const { minRiskReward, signalType, entryPrice, stopLoss, takeProfits, context } = opts;

  if (minRiskReward === undefined || minRiskReward === null || minRiskReward <= 0) {
    return;
  }

  const ratio = calculateRiskRewardRatio(signalType, entryPrice, stopLoss, takeProfits);

  if (ratio === null || !Number.isFinite(ratio)) {
    throw new Error(
      `Cannot evaluate minimum risk/reward: invalid entry (${entryPrice}), stop loss (${stopLoss}), or take profits`
    );
  }

  if (ratio + 1e-9 < minRiskReward) {
    logger.warn('Trade rejected: risk/reward below minimum', {
      ...context,
      signalType,
      entryPrice,
      stopLoss,
      takeProfits,
      riskRewardRatio: ratio,
      minRiskReward
    });
    throw new Error(
      `Trade rejected: risk/reward ${ratio.toFixed(2)} is below minimum ${minRiskReward} ` +
        `(entry=${entryPrice}, stopLoss=${stopLoss}, takeProfits=${takeProfits.join(', ')})`
    );
  }

  logger.debug('Minimum risk/reward check passed', {
    ...context,
    signalType,
    riskRewardRatio: ratio,
    minRiskReward
  });
};
