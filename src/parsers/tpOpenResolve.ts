/**
 * Shared TP list handling when "open" appears between or after numeric levels (DGF VIP, VGC, etc.).
 */

export type TpToken = { kind: 'number'; value: number } | { kind: 'open' };

/** Mean gap between consecutive numeric TPs in message order. */
export const meanNumericGap = (nums: number[]): number => {
  if (nums.length < 2) return 0;
  let sum = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    sum += nums[i + 1] - nums[i];
  }
  return sum / (nums.length - 1);
};

/**
 * Fills "open" slots: between two numerics uses even steps; trailing uses avgStep from numeric gaps.
 * Leading opens are skipped until the first number exists.
 */
export const resolveTpTokensWithOpen = (tokens: TpToken[], avgStep: number): number[] => {
  let i = 0;
  while (i < tokens.length && tokens[i].kind === 'open') {
    i++;
  }

  const result: number[] = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === 'number') {
      result.push(t.value);
      i++;
      continue;
    }

    let j = i;
    while (j < tokens.length && tokens[j].kind === 'open') {
      j++;
    }
    const openCount = j - i;
    const prev = result[result.length - 1];
    if (prev === undefined) {
      i = j;
      continue;
    }

    const nextTok = j < tokens.length ? tokens[j] : undefined;
    if (nextTok?.kind === 'number') {
      const next = nextTok.value;
      const step = (next - prev) / (openCount + 1);
      for (let k = 1; k <= openCount; k++) {
        result.push(prev + step * k);
      }
      i = j;
    } else {
      let last = prev;
      for (let k = 1; k <= openCount; k++) {
        last += avgStep;
        result.push(last);
      }
      i = j;
    }
  }
  return result;
};
