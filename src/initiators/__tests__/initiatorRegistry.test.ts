import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerInitiator,
  getInitiator,
  hasInitiator,
  getRegisteredInitiators,
  InitiatorFunction,
  InitiatorContext,
} from '../initiatorRegistry.js';
import { DatabaseManager, Message } from '../../db/schema.js';
import { ParsedOrder } from '../../types/order.js';
import { InitiatorConfig } from '../../types/config.js';

describe('Initiator Registry', () => {
  beforeEach(() => {
    // Clear registry before each test
    const registered = getRegisteredInitiators();
    // Note: We don't have a clearRegistry function, but in a real scenario,
    // we might want to reset the registry or use a fresh instance for tests
    // For now, we'll just test with unique names
  });

  it('should register an initiator', () => {
    const mockInitiator: InitiatorFunction = async () => {};
    
    registerInitiator('test_initiator', mockInitiator);
    
    expect(hasInitiator('test_initiator')).toBe(true);
  });

  it('should retrieve a registered initiator', () => {
    const mockInitiator: InitiatorFunction = async () => {};
    
    registerInitiator('test_initiator_2', mockInitiator);
    const retrieved = getInitiator('test_initiator_2');
    
    expect(retrieved).toBe(mockInitiator);
  });

  it('should return undefined for non-existent initiator', () => {
    const retrieved = getInitiator('non_existent_initiator');
    
    expect(retrieved).toBeUndefined();
  });

  it('should check if initiator exists', () => {
    const mockInitiator: InitiatorFunction = async () => {};
    
    registerInitiator('test_initiator_3', mockInitiator);
    
    expect(hasInitiator('test_initiator_3')).toBe(true);
    expect(hasInitiator('non_existent')).toBe(false);
  });

  it('should return all registered initiator names', () => {
    const mockInitiator1: InitiatorFunction = async () => {};
    const mockInitiator2: InitiatorFunction = async () => {};
    
    registerInitiator('initiator_a', mockInitiator1);
    registerInitiator('initiator_b', mockInitiator2);
    
    const registered = getRegisteredInitiators();
    
    expect(registered).toContain('initiator_a');
    expect(registered).toContain('initiator_b');
  });

  it('should allow overwriting an existing initiator', () => {
    const initiator1: InitiatorFunction = async () => {};
    const initiator2: InitiatorFunction = async () => {};
    
    registerInitiator('overwrite_test', initiator1);
    expect(getInitiator('overwrite_test')).toBe(initiator1);
    
    registerInitiator('overwrite_test', initiator2);
    expect(getInitiator('overwrite_test')).toBe(initiator2);
  });

  it('should call initiator with correct context', async () => {
    const mockContext: InitiatorContext = {
      channel: 'test_channel',
      riskPercentage: 5,
      entryTimeoutMinutes: 2880, // 2 days = 2880 minutes
      message: {
        id: 1,
        message_id: 123,
        channel: 'test_channel',
        content: 'test',
        sender: 'test',
        date: '2024-01-15T10:00:00Z',
        created_at: '2024-01-15T10:00:00Z',
        parsed: false,
      },
      order: {
        tradingPair: 'BTC/USDT',
        leverage: 10,
        entryPrice: 50000,
        stopLoss: 48000,
        takeProfits: [52000, 54000],
        signalType: 'long',
      },
      db: {} as DatabaseManager,
      isSimulation: true,
      config: {
        name: 'test_initiator',
        riskPercentage: 5,
      } as InitiatorConfig,
    };

    const mockInitiator = vi.fn<InitiatorFunction>();
    registerInitiator('test_initiator_4', mockInitiator);
    
    const initiator = getInitiator('test_initiator_4');
    expect(initiator).toBeDefined();
    
    await initiator!(mockContext);
    
    expect(mockInitiator).toHaveBeenCalledOnce();
    expect(mockInitiator).toHaveBeenCalledWith(mockContext);
  });
});




