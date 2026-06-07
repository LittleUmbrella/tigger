import { InitiatorContext } from '../initiators/initiatorRegistry.js';
import { PairRule, PairRuleEntryOverrides } from '../types/config.js';

/** Normalize pair keys for rule matching (XAU/USD and XAUUSD both → XAUUSD). */
export const normalizeTradingPairKey = (pair: string): string =>
  pair.replace(/\//g, '').replace(/USDT$|USDC$/i, '').toUpperCase();

export interface ResolvedPairRule {
  skip: boolean;
  entry?: PairRuleEntryOverrides;
  matchedRuleIndex?: number;
}

const pairMatchesRule = (tradingPair: string, rulePairs: string[]): boolean => {
  const key = normalizeTradingPairKey(tradingPair);
  return rulePairs.some((candidate) => {
    if (candidate === '*') {
      return true;
    }
    return normalizeTradingPairKey(candidate) === key;
  });
};

const ruleMatchesOrder = (
  rule: PairRule,
  tradingPair: string,
  signalType: 'long' | 'short',
): boolean => {
  if (!pairMatchesRule(tradingPair, rule.pairs)) {
    return false;
  }
  if (rule.signalTypes?.length && !rule.signalTypes.includes(signalType)) {
    return false;
  }
  return true;
};

/** First matching pair rule wins; unmatched orders use channel defaults only. */
export const resolvePairRule = (
  tradingPair: string,
  signalType: 'long' | 'short',
  pairRules?: PairRule[],
): ResolvedPairRule => {
  if (!pairRules?.length) {
    return { skip: false };
  }

  const matchedRuleIndex = pairRules.findIndex((rule) =>
    ruleMatchesOrder(rule, tradingPair, signalType),
  );
  if (matchedRuleIndex < 0) {
    return { skip: false };
  }

  const rule = pairRules[matchedRuleIndex];
  return {
    skip: rule.skip === true,
    entry: rule.entry,
    matchedRuleIndex,
  };
};

export const mergePairRuleEntryOverrides = (
  context: InitiatorContext,
  entry?: PairRuleEntryOverrides,
): InitiatorContext => {
  if (!entry) {
    return context;
  }

  return {
    ...context,
    useLimitOrderForEntry: entry.useLimitOrderForEntry ?? context.useLimitOrderForEntry,
    useMarketRangeForEntry: entry.useMarketRangeForEntry ?? context.useMarketRangeForEntry,
    maxSkippablePastTPs: entry.maxSkippablePastTPs ?? context.maxSkippablePastTPs,
  };
};

/**
 * Apply channel pairRules to initiator context.
 * Returns null when the matched rule has skip:true (initiator should return cleanly).
 */
export const applyPairRulesToContext = (
  context: InitiatorContext,
): InitiatorContext | null => {
  const resolved = resolvePairRule(
    context.order.tradingPair,
    context.order.signalType,
    context.pairRules,
  );
  if (resolved.skip) {
    return null;
  }
  return mergePairRuleEntryOverrides(context, resolved.entry);
};
