import type { CTraderClient } from '../clients/ctraderClient.js';
import { protobufLongToNumber } from './protobufLong.js';

export const CTRADER_ORDER_LABEL_PREFIX = 'tgr-';

export type ParsedCtraderOrderLabel = {
  channel: string;
  messageId: string;
};

/** Bot order label: `tgr-{telegramChannelId}-{messageId}` (max 100 chars). */
export const buildCtraderOrderLabel = (channel: string, messageId: string): string =>
  `${CTRADER_ORDER_LABEL_PREFIX}${channel}-${messageId}`.slice(0, 100);

/**
 * Parse `tgr-{channel}-{messageId}`. Message id is the segment after the last hyphen
 * (channel ids are numeric; message ids may be snowflakes).
 */
export const parseCtraderOrderLabel = (label: string | undefined | null): ParsedCtraderOrderLabel | null => {
  if (!label || !label.startsWith(CTRADER_ORDER_LABEL_PREFIX)) return null;
  const rest = label.slice(CTRADER_ORDER_LABEL_PREFIX.length);
  const lastDash = rest.lastIndexOf('-');
  if (lastDash <= 0) return null;
  const channel = rest.slice(0, lastDash);
  const messageId = rest.slice(lastDash + 1);
  if (!channel || !messageId) return null;
  return { channel, messageId };
};

export const tradeMatchesCtraderOrderLabel = (
  trade: { channel: string; message_id: string },
  label: string | undefined | null
): boolean => {
  if (!label) return false;
  return buildCtraderOrderLabel(trade.channel, String(trade.message_id)) === String(label);
};

export const readLabelFromCtraderOrder = (order: Record<string, unknown> | undefined): string | undefined => {
  if (!order) return undefined;
  const td = order.tradeData as Record<string, unknown> | undefined;
  const l = td?.label ?? order.label;
  return l != null && String(l) !== '' ? String(l) : undefined;
};

const positionIdToString = (raw: unknown): string => {
  if (raw == null) return '';
  if (typeof raw === 'object' && 'low' in (raw as object)) {
    return String(protobufLongToNumber(raw as { low: number }) ?? (raw as { low: number }).low);
  }
  return String(raw);
};

/**
 * Resolve entry order label for an open/historical position via opening deal → order details.
 */
export const resolveCtraderPositionEntryLabel = async (
  ctraderClient: CTraderClient,
  positionId: string,
  options?: {
    dealLookbackMs?: number;
    orderDetailsCache?: Map<string, { order: any; deals: any[] } | null>;
  }
): Promise<string | undefined> => {
  const now = Date.now();
  const from = now - (options?.dealLookbackMs ?? 7 * 24 * 3600 * 1000);
  const deals = await ctraderClient.getDealListByPositionId(positionId, from, now);
  const opening = deals.find((d: Record<string, unknown>) => {
    const cpd = d.closePositionDetail ?? d.close_position_detail;
    return cpd == null;
  });
  if (!opening) return undefined;

  const rawOid = opening.orderId ?? opening.order_id;
  const orderId =
    rawOid != null
      ? String(
          typeof rawOid === 'object' && rawOid != null && 'low' in rawOid
            ? protobufLongToNumber(rawOid as { low: number })
            : rawOid
        )
      : '';
  if (!orderId) return undefined;

  const cache = options?.orderDetailsCache;
  let details = cache?.get(orderId);
  if (cache && !cache.has(orderId)) {
    details = await ctraderClient.getOrderDetails(orderId);
    cache.set(orderId, details);
  } else if (!cache) {
    details = await ctraderClient.getOrderDetails(orderId);
  }

  return readLabelFromCtraderOrder(details?.order as Record<string, unknown> | undefined);
};

export const verifyCtraderEntryOrderLabel = async (
  ctraderClient: CTraderClient,
  orderId: string,
  channel: string,
  messageId: string,
  orderDetailsCache?: Map<string, { order: any; deals: any[] } | null>
): Promise<{ ok: boolean; expected: string; actual?: string }> => {
  const expected = buildCtraderOrderLabel(channel, messageId);
  let details = orderDetailsCache?.get(orderId);
  if (orderDetailsCache && !orderDetailsCache.has(orderId)) {
    details = await ctraderClient.getOrderDetails(orderId);
    orderDetailsCache.set(orderId, details);
  } else if (!orderDetailsCache) {
    details = await ctraderClient.getOrderDetails(orderId);
  }
  const actual = readLabelFromCtraderOrder(details?.order as Record<string, unknown> | undefined);
  return { ok: actual === expected, expected, actual };
};

export const positionIdFromCtraderOpenPosition = (p: Record<string, unknown>): string =>
  positionIdToString(p.positionId ?? p.id);
