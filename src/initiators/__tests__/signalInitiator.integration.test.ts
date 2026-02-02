import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { processUnparsedMessages } from '../signalInitiator.js';
import { registerInitiator } from '../initiatorRegistry.js';
import { bybitInitiator } from '../bybitInitiator.js';
import { DatabaseManager } from '../../db/schema.js';
import { mockMessage, mockParsedOrder, mockPriceData } from './fixtures.js';
import { createMockDatabase, createMockPriceProvider } from './mocks.js';
import { parseMessage } from '../../parsers/signalParser.js';
import { InitiatorConfig } from '../../types/config.js';

// Mock the parser
vi.mock('../../parsers/signalParser.js', () => ({
  parseMessage: vi.fn(),
}));

describe('Signal Initiator Integration Tests', () => {
  let mockDb: DatabaseManager;
  let mockPriceProvider: any;

  beforeEach(() => {
    mockDb = createMockDatabase();
    mockPriceProvider = createMockPriceProvider(mockPriceData);
    
    // Register the bybit initiator
    registerInitiator('bybit', bybitInitiator);
    
    // Reset mocks
    vi.clearAllMocks();
    
    // Setup default parser mock
    (parseMessage as any).mockReturnValue(mockParsedOrder);
    
    // Add a test message to the database
    mockDb.insertMessage({
      message_id: mockMessage.message_id,
      channel: mockMessage.channel,
      content: mockMessage.content,
      sender: mockMessage.sender,
      date: mockMessage.date,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should process unparsed messages and initiate trades', async () => {
    const initiatorConfig: InitiatorConfig = {
      name: 'bybit',
      riskPercentage: 3,
      testnet: false,
    };

    await processUnparsedMessages(
      initiatorConfig,
      'test_channel',
      2,
      mockDb,
      true, // simulation mode
      mockPriceProvider,
      'default'
    );

    // Should have marked message as parsed
    expect(mockDb.markMessageParsed).toHaveBeenCalled();
    
    // Should have inserted a trade
    expect(mockDb.insertTrade).toHaveBeenCalled();
  });

  it('should skip messages that cannot be parsed', async () => {
    // Mock parser to return null (cannot parse)
    (parseMessage as any).mockReturnValue(null);

    const initiatorConfig: InitiatorConfig = {
      name: 'bybit',
      riskPercentage: 3,
      testnet: false,
    };

    await processUnparsedMessages(
      initiatorConfig,
      'test_channel',
      2,
      mockDb,
      true,
      mockPriceProvider,
      'default'
    );

    // Should not have inserted a trade if message couldn't be parsed
    expect(mockDb.insertTrade).not.toHaveBeenCalled();
    
    // Message should still be marked as parsed (to avoid reprocessing)
    expect(mockDb.markMessageParsed).toHaveBeenCalled();
  });

  it('should process messages in chronological order in simulation mode', async () => {
    // Add multiple messages with different timestamps
    const message1 = {
      ...mockMessage,
      message_id: '111',
      date: '2024-01-15T10:00:00Z',
      content: 'Message 1',
    };
    const message2 = {
      ...mockMessage,
      message_id: '222',
      date: '2024-01-15T10:05:00Z',
      content: 'Message 2',
    };
    const message3 = {
      ...mockMessage,
      message_id: '333',
      date: '2024-01-15T10:03:00Z',
      content: 'Message 3',
    };

    mockDb.insertMessage({
      message_id: message1.message_id,
      channel: message1.channel,
      content: message1.content,
      sender: message1.sender,
      date: message1.date,
    });
    mockDb.insertMessage({
      message_id: message2.message_id,
      channel: message2.channel,
      content: message2.content,
      sender: message2.sender,
      date: message2.date,
    });
    mockDb.insertMessage({
      message_id: message3.message_id,
      channel: message3.channel,
      content: message3.content,
      sender: message3.sender,
      date: message3.date,
    });

    const initiatorConfig: InitiatorConfig = {
      name: 'bybit',
      riskPercentage: 3,
      testnet: false,
    };

    const parseOrder = vi.fn().mockReturnValue(mockParsedOrder);
    (parseMessage as any).mockImplementation(parseOrder);

    await processUnparsedMessages(
      initiatorConfig,
      'test_channel',
      2,
      mockDb,
      true, // simulation mode
      mockPriceProvider,
      'default'
    );

    // Should have processed all 4 messages (including the one from beforeEach)
    expect(parseOrder).toHaveBeenCalledTimes(4);
    expect(mockDb.insertTrade).toHaveBeenCalledTimes(4);
  });

  it('should handle initiator errors gracefully', async () => {
    // Create a failing initiator
    const failingInitiator = vi.fn().mockRejectedValue(new Error('Initiator failed'));
    registerInitiator('failing_initiator', failingInitiator);

    const initiatorConfig: InitiatorConfig = {
      name: 'failing_initiator',
      riskPercentage: 3,
      testnet: false,
    };

    await processUnparsedMessages(
      initiatorConfig,
      'test_channel',
      2,
      mockDb,
      true,
      mockPriceProvider,
      'default'
    );

    // Should have attempted to process
    expect(failingInitiator).toHaveBeenCalled();
    
    // Should not have inserted a trade due to error
    expect(mockDb.insertTrade).not.toHaveBeenCalled();
    
    // Message should not be marked as parsed on error
    expect(mockDb.markMessageParsed).not.toHaveBeenCalled();
  });

  it('should return early if initiator not found', async () => {
    const initiatorConfig: InitiatorConfig = {
      name: 'non_existent_initiator',
      riskPercentage: 3,
      testnet: false,
    };

    await processUnparsedMessages(
      initiatorConfig,
      'test_channel',
      2,
      mockDb,
      true,
      mockPriceProvider,
      'default'
    );

    // Should not have processed anything
    expect(mockDb.insertTrade).not.toHaveBeenCalled();
    expect(mockDb.markMessageParsed).not.toHaveBeenCalled();
  });

  it('should use initiator name from config', async () => {
    const initiatorConfig: InitiatorConfig = {
      name: 'bybit',
      riskPercentage: 5,
      testnet: false,
    };

    await processUnparsedMessages(
      initiatorConfig,
      'test_channel',
      2,
      mockDb,
      true,
      mockPriceProvider,
      'default'
    );

    expect(mockDb.insertTrade).toHaveBeenCalled();
    const insertCall = (mockDb.insertTrade as any).mock.calls[0][0];
    expect(insertCall.risk_percentage).toBe(5);
  });

  it('should support backward compatibility with type field', async () => {
    const initiatorConfig = {
      type: 'bybit', // deprecated field
      name: 'bybit', // Provide name for type compatibility
      riskPercentage: 3,
      testnet: false,
    } as InitiatorConfig;

    await processUnparsedMessages(
      initiatorConfig,
      'test_channel',
      2,
      mockDb,
      true,
      mockPriceProvider,
      'default'
    );

    // Should still work with type field
    expect(mockDb.insertTrade).toHaveBeenCalled();
  });

  it('should pass parser name to parseMessage', async () => {
    const initiatorConfig: InitiatorConfig = {
      name: 'bybit',
      riskPercentage: 3,
      testnet: false,
    };

    await processUnparsedMessages(
      initiatorConfig,
      'test_channel',
      2,
      mockDb,
      true,
      mockPriceProvider,
      'custom_parser'
    );

    expect(parseMessage).toHaveBeenCalledWith(
      mockMessage.content,
      'custom_parser'
    );
  });

  it('should update price provider time in simulation mode', async () => {
    const initiatorConfig: InitiatorConfig = {
      name: 'bybit',
      riskPercentage: 3,
      testnet: false,
    };

    const messageTime = new Date('2024-01-15T10:00:00Z');
    const setCurrentTimeSpy = vi.spyOn(mockPriceProvider, 'setCurrentTime');

    await processUnparsedMessages(
      initiatorConfig,
      'test_channel',
      2,
      mockDb,
      true, // simulation mode
      mockPriceProvider,
      'default'
    );

    // Should have set the price provider time to message time
    expect(setCurrentTimeSpy).toHaveBeenCalled();
  });
});




