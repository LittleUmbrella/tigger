/**
 * Convert protobuf int64 Long values to JavaScript numbers.
 * Protobuf decoders return Long objects { low, high, toNumber? } for int64 fields.
 */
export function protobufLongToNumber(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number' && !isNaN(v)) return v;
  if (typeof v === 'object' && v != null) {
    const obj = v as Record<string, unknown>;
    if (typeof obj.toNumber === 'function') return (obj.toNumber as () => number)();
    if (obj.low != null && obj.high != null) {
      return (obj.high as number) * 0x100000000 + ((obj.low as number) >>> 0);
    }
    if (obj.low != null) return (obj.low as number) >>> 0;
  }
  return undefined;
}
