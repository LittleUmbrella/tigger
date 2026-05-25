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

const SUPERSCRIPT_DIGIT_MAP: Record<string, string> = {
  '\u00B9': '1',
  '\u00B2': '2',
  '\u00B3': '3',
  '\u2070': '0',
  '\u2074': '4',
  '\u2075': '5',
  '\u2076': '6',
  '\u2077': '7',
  '\u2078': '8',
  '\u2079': '9',
};

const normalizeTpSuperscriptLabels = (content: string): string =>
  content.replace(/(T[Pp])([\u00B9\u00B2\u00B3\u2070\u2074-\u2079]+)/gi, (_full, tp: string, subs: string) => {
    const digits = [...subs].map((ch) => SUPERSCRIPT_DIGIT_MAP[ch] ?? '').join('');
    return digits ? `${tp}${digits}` : _full;
  });

/** Tp 4 — 4738; TP1 ➝ 4723 → TPn: price for the main TP regex. */
const normalizeTpArrowAndEmDashLabels = (content: string): string => {
  let s = content;
  s = s.replace(/T[Pp]\s+(\d+)\s*[\u2014\u2013\-]\s*([\d.]+)/gi, 'TP$1: $2');
  s = s.replace(/T[Pp](\d*)\s+[^\d.\r\n:]{1,40}?\s+([\d.]+)/gi, (_full, idx: string, price: string) =>
    `TP${idx}: ${price}`,
  );
  return s;
};

/** TP 4 : Open — index must not be captured as the price by the generic TP regex. */
const normalizeTpIndexedOpenLabels = (content: string): string =>
  content.replace(/T[Pp]\s*(\d+)\s*:\s*open\b/gi, 'TP$1: open');

/** T1 :4565 / T2 : 4550 (no P) → TP1: for the main TP regex. */
const normalizeBareTTakeProfitLabels = (content: string): string =>
  content.replace(/(?<![Pp])T(\d+)\s*:/gi, 'TP$1:');

/** Ordered TP lines: numeric price or the word "open" (case-insensitive). */
export const parseTpTokens = (content: string): TpToken[] => {
  const normalized = normalizeTpIndexedOpenLabels(
    normalizeTpArrowAndEmDashLabels(
      normalizeBareTTakeProfitLabels(normalizeTpSuperscriptLabels(content)),
    ),
  );
  const re = /T[Pp]\d*[\s:]*@?\s*([\d.]+|open)\b/gi;
  const out: TpToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) {
    const raw = m[1].trim().toLowerCase();
    if (raw === 'open') {
      out.push({ kind: 'open' });
      continue;
    }
    const n = parseFloat(raw);
    if (!isNaN(n) && n > 0) {
      out.push({ kind: 'number', value: n });
    }
  }
  return out;
};
