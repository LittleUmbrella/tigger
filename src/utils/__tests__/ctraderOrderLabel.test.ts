import { describe, expect, it } from 'vitest';
import {
  buildCtraderOrderLabel,
  parseCtraderOrderLabel,
  tradeMatchesCtraderOrderLabel,
} from '../ctraderOrderLabel.js';

describe('ctraderOrderLabel', () => {
  it('builds and parses tgr labels', () => {
    const label = buildCtraderOrderLabel('3469900302', '3273');
    expect(label).toBe('tgr-3469900302-3273');
    expect(parseCtraderOrderLabel(label)).toEqual({
      channel: '3469900302',
      messageId: '3273',
    });
  });

  it('parses dgfvip labels', () => {
    expect(parseCtraderOrderLabel('tgr-2845421508-15145')).toEqual({
      channel: '2845421508',
      messageId: '15145',
    });
  });

  it('tradeMatchesCtraderOrderLabel compares expected label', () => {
    const trade = { channel: '2845421508', message_id: '15145' };
    expect(tradeMatchesCtraderOrderLabel(trade, 'tgr-2845421508-15145')).toBe(true);
    expect(tradeMatchesCtraderOrderLabel(trade, 'tgr-3469900302-3273')).toBe(false);
  });
});
