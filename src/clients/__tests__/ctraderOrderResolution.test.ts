import { describe, expect, it, vi } from 'vitest';
import {
  extractPositionIdFromCtraderOrderDetails,
  isCtraderOpeningFilledDeal,
  orderDetailsHasOnlyClosingDeals,
  orderDetailsHasOpeningDeal,
  resolveCtraderNTradeEntryOrderIds,
  type CTraderClient,
} from '../ctraderClient.js';

describe('isCtraderOpeningFilledDeal', () => {
  it('returns true for filled opening deals', () => {
    expect(isCtraderOpeningFilledDeal({ dealStatus: 2, closePositionDetail: null })).toBe(true);
  });

  it('returns false for closing deals', () => {
    expect(
      isCtraderOpeningFilledDeal({ dealStatus: 2, closePositionDetail: { closedVolume: 1 } })
    ).toBe(false);
  });
});

describe('extractPositionIdFromCtraderOrderDetails', () => {
  it('uses opening deal positionId', () => {
    expect(
      extractPositionIdFromCtraderOrderDetails(
        { positionId: 999 },
        [
          { dealStatus: 2, positionId: 3756841, closePositionDetail: null },
          { dealStatus: 2, positionId: 3756839, closePositionDetail: { x: 1 } },
        ]
      )
    ).toBe('3756841');
  });

  it('returns null when only closing deals are present', () => {
    expect(
      extractPositionIdFromCtraderOrderDetails(
        { positionId: 3756839 },
        [{ dealStatus: 2, positionId: 3756839, closePositionDetail: { x: 1 } }]
      )
    ).toBeNull();
  });

  it('falls back to order positionId when deal list is empty', () => {
    expect(extractPositionIdFromCtraderOrderDetails({ positionId: 42 }, [])).toBe('42');
  });
});

describe('resolveCtraderNTradeEntryOrderIds', () => {
  it('replaces close-only placed id with chronological opening deal for that leg index', async () => {
    const label = 'tgr-2845421508-14312';
    const client = {
      getDealList: vi.fn().mockResolvedValue([
        {
          orderId: '6590413',
          positionId: '3756839',
          dealStatus: 2,
          label,
          executionTimestamp: 1,
        },
        {
          orderId: '6590415',
          positionId: '3756840',
          dealStatus: 2,
          label,
          executionTimestamp: 2,
        },
        {
          orderId: '6590416',
          positionId: '3756841',
          dealStatus: 2,
          label,
          executionTimestamp: 3,
        },
        {
          orderId: '6590417',
          positionId: '3756842',
          dealStatus: 2,
          label,
          executionTimestamp: 4,
        },
        {
          orderId: '6590414',
          positionId: '3756839',
          dealStatus: 2,
          label,
          executionTimestamp: 5,
          closePositionDetail: { closedVolume: 1 },
        },
      ]),
      getOrderDetails: vi.fn().mockImplementation(async (orderId: string) => {
        if (orderId === '6590414') {
          return {
            order: { positionId: 3756839 },
            deals: [{ dealStatus: 2, positionId: 3756839, closePositionDetail: { x: 1 } }],
          };
        }
        return {
          order: { positionId: orderId === '6590413' ? 3756839 : 3756840 },
          deals: [{ dealStatus: 2, positionId: orderId === '6590413' ? 3756839 : 3756840 }],
        };
      }),
    } as unknown as CTraderClient;

    const resolved = await resolveCtraderNTradeEntryOrderIds(
      client,
      ['6590413', '6590413', '6590414', '6590415'],
      { label }
    );

    expect(resolved).toEqual(['6590413', '6590413', '6590416', '6590415']);
    expect(orderDetailsHasOnlyClosingDeals([{ closePositionDetail: {} }])).toBe(true);
    expect(orderDetailsHasOpeningDeal([{ dealStatus: 2 }])).toBe(true);
  });
});
