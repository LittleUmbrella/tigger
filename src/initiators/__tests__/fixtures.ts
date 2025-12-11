import { Message } from '../../db/schema.js';
import { ParsedOrder } from '../../types/order.js';

/**
 * Test fixtures for initiator tests
 */

export const mockMessage: Message = {
  id: 1,
  message_id: 12345,
  channel: 'test_channel',
  content: '⚡️© BTC/USDT ©⚡️ Signal Type: Regular (Long) Leverage: 10x Entry: 50000 Stop: 48000 TP: 52000, 54000, 56000',
  sender: 'test_sender',
  date: '2024-01-15T10:00:00Z',
  created_at: '2024-01-15T10:00:00Z',
  parsed: false,
};

export const mockParsedOrder: ParsedOrder = {
  tradingPair: 'BTC/USDT',
  leverage: 10,
  entryPrice: 50000,
  stopLoss: 48000,
  takeProfits: [52000, 54000, 56000],
  signalType: 'long',
};

export const mockShortParsedOrder: ParsedOrder = {
  tradingPair: 'ETH/USDT',
  leverage: 5,
  entryPrice: 3000,
  stopLoss: 3100,
  takeProfits: [2900, 2800, 2700],
  signalType: 'short',
};

/**
 * Mock price data for testing
 */
export const mockPriceData = {
  'BTC/USDT': {
    '2024-01-15T10:00:00Z': 50000,
    '2024-01-15T10:01:00Z': 50100,
    '2024-01-15T10:02:00Z': 50200,
    '2024-01-15T10:03:00Z': 50300,
    '2024-01-15T10:04:00Z': 50400,
    '2024-01-15T10:05:00Z': 50500,
  },
  'ETH/USDT': {
    '2024-01-15T10:00:00Z': 3000,
    '2024-01-15T10:01:00Z': 2990,
    '2024-01-15T10:02:00Z': 2980,
    '2024-01-15T10:03:00Z': 2970,
    '2024-01-15T10:04:00Z': 2960,
    '2024-01-15T10:05:00Z': 2950,
  },
};

/**
 * Mock Bybit API responses
 */
export const mockBybitResponses = {
  walletBalance: {
    retCode: 0,
    retMsg: 'OK',
    result: {
      USDT: {
        availableBalance: '10000.00',
        walletBalance: '10000.00',
      },
    },
  },
  submitOrder: {
    retCode: 0,
    retMsg: 'OK',
    result: {
      orderId: 'test-order-123',
      orderLinkId: 'test-link-123',
    },
  },
  setLeverage: {
    retCode: 0,
    retMsg: 'OK',
    result: {},
  },
  getTickers: {
    retCode: 0,
    retMsg: 'OK',
    result: {
      list: [
        {
          symbol: 'BTCUSDT',
          lastPrice: '50000',
          markPrice: '50000',
        },
      ],
    },
  },
  getOpenOrders: {
    retCode: 0,
    retMsg: 'OK',
    result: {
      list: [],
    },
  },
  getOrderHistory: {
    retCode: 0,
    retMsg: 'OK',
    result: {
      list: [
        {
          orderId: 'test-order-123',
          orderStatus: 'Filled',
          symbol: 'BTCUSDT',
        },
      ],
    },
  },
  getPositionInfo: {
    retCode: 0,
    retMsg: 'OK',
    result: {
      list: [
        {
          symbol: 'BTCUSDT',
          size: '0.1',
          positionIdx: 0,
        },
      ],
    },
  },
};




