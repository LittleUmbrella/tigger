import type { TickTpWatch } from './types.js';

export class TickTpRegistry {
  private byTradeId = new Map<number, TickTpWatch>();
  private bySymbolId = new Map<number, Set<TickTpWatch>>();

  register(watch: TickTpWatch): void {
    this.unregister(watch.tradeId);
    this.byTradeId.set(watch.tradeId, watch);
    let set = this.bySymbolId.get(watch.symbolId);
    if (!set) {
      set = new Set();
      this.bySymbolId.set(watch.symbolId, set);
    }
    set.add(watch);
  }

  unregister(tradeId: number): void {
    const existing = this.byTradeId.get(tradeId);
    if (!existing) return;
    this.byTradeId.delete(tradeId);
    const set = this.bySymbolId.get(existing.symbolId);
    set?.delete(existing);
    if (set?.size === 0) this.bySymbolId.delete(existing.symbolId);
  }

  getByTradeId(tradeId: number): TickTpWatch | undefined {
    return this.byTradeId.get(tradeId);
  }

  getBySymbolId(symbolId: number): TickTpWatch[] {
    return [...(this.bySymbolId.get(symbolId) ?? [])];
  }

  getFilledTpCount(tradeId: number): number {
    const watch = this.byTradeId.get(tradeId);
    if (!watch) return 0;
    return watch.levels.filter((l) => l.status === 'filled').length;
  }

  allSymbolIds(): number[] {
    return [...this.bySymbolId.keys()];
  }
}
