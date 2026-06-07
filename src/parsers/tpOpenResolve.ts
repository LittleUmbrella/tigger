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

/** Mathematical Alphanumeric Symbols: map stylized Latin letters to ASCII (dgfvip 𝑇𝑃 labels). */
const MATHEMATICAL_LATIN_CAPITAL_BASES = [
  0x1d400, 0x1d434, 0x1d468, 0x1d5a0, 0x1d5d4, 0x1d608,
] as const;
const MATHEMATICAL_LATIN_SMALL_BASES = [
  0x1d41a, 0x1d44e, 0x1d482, 0x1d5ba, 0x1d5ee, 0x1d622,
] as const;

export const decodeMathematicalLatinLetter = (codePoint: number): string | null => {
  for (const base of MATHEMATICAL_LATIN_CAPITAL_BASES) {
    if (codePoint >= base && codePoint < base + 26) {
      return String.fromCharCode(0x41 + (codePoint - base));
    }
  }
  for (const base of MATHEMATICAL_LATIN_SMALL_BASES) {
    if (codePoint >= base && codePoint < base + 26) {
      return String.fromCharCode(0x61 + (codePoint - base));
    }
  }
  return null;
};

/** Map Mathematical Alphanumeric Symbols (𝑋𝐴𝑈𝑈𝑆𝐷, 𝖲𝗍𝗈𝗉, etc.) to ASCII for DGF parsers. */
export const normalizeMathematicalLatin = (content: string): string => {
  let result = '';
  let i = 0;
  while (i < content.length) {
    const cp = content.codePointAt(i);
    if (cp === undefined) break;
    const charLen = cp > 0xffff ? 2 : 1;
    const decoded = decodeMathematicalLatinLetter(cp);
    result += decoded ?? String.fromCodePoint(cp);
    i += charLen;
  }
  return result;
};

const decodeTpLetter = (codePoint: number): string | null => {
  if (codePoint === 0x54 || codePoint === 0x74) {
    return codePoint === 0x74 ? 't' : 'T';
  }
  if (codePoint === 0x50 || codePoint === 0x70) {
    return codePoint === 0x70 ? 'p' : 'P';
  }
  return decodeMathematicalLatinLetter(codePoint);
};

/** 𝑇𝑃1: → TP1: before other TP normalizers run. */
const normalizeMathematicalTpLabels = (content: string): string => {
  let result = '';
  let i = 0;
  while (i < content.length) {
    const cp = content.codePointAt(i);
    if (cp === undefined) break;
    const charLen = cp > 0xffff ? 2 : 1;
    const nextIdx = i + charLen;
    const nextCp = content.codePointAt(nextIdx);
    const nextLen = nextCp !== undefined && nextCp > 0xffff ? 2 : 1;

    const t = decodeTpLetter(cp);
    const p = nextCp !== undefined ? decodeTpLetter(nextCp) : null;
    if (t && p && t.toUpperCase() === 'T' && p.toUpperCase() === 'P') {
      result += 'TP';
      i = nextIdx + nextLen;
      continue;
    }
    result += String.fromCodePoint(cp);
    i += charLen;
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

/** Unicode/ASCII arrows between TP label and price (not plain space — avoids matching `TP 4 : Open`). */
const TP_ARROW_SEP = String.raw`(?:➝|→|➜|➡|=>)`;

/** Tp 4 — 4738; TP1 ➝ 4723 / TP2➝ 72650 / TP3 ➝72350 → TPn: price for the main TP regex. */
const normalizeTpArrowAndEmDashLabels = (content: string): string => {
  let s = content;
  s = s.replace(/T[Pp]\s+(\d+)\s*[\u2014\u2013\-]\s*([\d.]+)/gi, 'TP$1: $2');
  s = s.replace(
    new RegExp(`T[Pp](\\d*)\\s*${TP_ARROW_SEP}\\s*([\\d.]+)`, 'gi'),
    (_full, idx: string, price: string) => `TP${idx}: ${price}`,
  );
  return s;
};

/** Require colon/@/space separator so TP index digits are not captured as prices (e.g. TP2➝). */
const TP_PRICE_CAPTURE =
  /T[Pp](?:\d+\s*:\s*|\d+\s*@\s*|\d+\s+|\s*:\s*|\s+@\s*|\s+)([\d.]+|open)\b/gi;

/** TP 4 : Open — index must not be captured as the price by the generic TP regex. */
const normalizeTpIndexedOpenLabels = (content: string): string =>
  content.replace(/T[Pp]\s*(\d+)\s*:\s*open\b/gi, 'TP$1: open');

/** TP 1: 4464 / TP 2: 4459 — space between TP and index; without this, `\s+` captures the index as the price. */
const normalizeSpacedTpIndexLabels = (content: string): string =>
  content.replace(/\bT[Pp]\s+(\d+)\s*:/gi, 'TP$1:');

/** TP 1 4406 / TP 2 4401 — space between index and price, no colon (dgfvip message 15951). */
const normalizeSpacedTpIndexPriceLabels = (content: string): string =>
  content.replace(/\bT[Pp]\s+(\d+)\s+([\d.]+)/gi, 'TP$1: $2');

/** T1 :4565 / T2 : 4550 (no P) → TP1: for the main TP regex. */
const normalizeBareTTakeProfitLabels = (content: string): string =>
  content.replace(/(?<![Pp])T(\d+)\s*:/gi, 'TP$1:');

/** Ordered TP lines: numeric price or the word "open" (case-insensitive). */
export const parseTpTokens = (content: string): TpToken[] => {
  const normalized = normalizeTpArrowAndEmDashLabels(
    normalizeTpIndexedOpenLabels(
      normalizeSpacedTpIndexPriceLabels(
        normalizeSpacedTpIndexLabels(
          normalizeBareTTakeProfitLabels(
            normalizeTpSuperscriptLabels(normalizeMathematicalTpLabels(content)),
          ),
        ),
      ),
    ),
  );
  const out: TpToken[] = [];
  let m: RegExpExecArray | null;
  while ((m = TP_PRICE_CAPTURE.exec(normalized)) !== null) {
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
