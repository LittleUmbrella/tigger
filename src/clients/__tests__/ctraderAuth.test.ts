import { describe, expect, it, vi } from 'vitest';
import { CTraderClient } from '../ctraderClient.js';

const attachMockConnection = (client: CTraderClient, sendCommand: ReturnType<typeof vi.fn>) => {
  const connection = {
    isConnected: () => true,
    sendCommand,
    close: vi.fn(),
  };
  (client as unknown as { connection: typeof connection }).connection = connection;
  (client as unknown as { connected: boolean }).connected = true;
  (client as unknown as { authenticated: boolean }).authenticated = true;
  (client as unknown as { lastVerifiedAuthAt: number }).lastVerifiedAuthAt = Date.now();
};

describe('CTraderClient auth resilience', () => {
  it('retries getAccountInfo once after not authorized', async () => {
    const sendCommand = vi.fn();
    const client = new CTraderClient({
      clientId: 'id',
      clientSecret: 'secret',
      accessToken: 'token',
      accountId: '47393545',
      environment: 'live',
      authMaxAgeMs: 0,
    });
    attachMockConnection(client, sendCommand);

    const authError = JSON.stringify({
      payloadType: 'ProtoOAErrorRes',
      errorCode: 'INVALID_REQUEST',
      description: 'Trading account is not authorized',
    });

    sendCommand
      .mockRejectedValueOnce(new Error(authError))
      .mockResolvedValueOnce({ trader: { balance: 500000 } });

    vi.spyOn(client as unknown as { reconnectAndAuthenticate: () => Promise<void> }, 'reconnectAndAuthenticate')
      .mockImplementation(async () => {
        (client as unknown as { authenticated: boolean }).authenticated = true;
      });

    const info = await client.getAccountInfo();
    expect(info.trader.balance).toBe(500000);
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it('probes stale auth before commands when authMaxAgeMs elapsed', async () => {
    vi.useFakeTimers();
    const sendCommand = vi.fn().mockResolvedValue({ trader: { balance: 100 } });
    const client = new CTraderClient({
      clientId: 'id',
      clientSecret: 'secret',
      accessToken: 'token',
      accountId: '47393545',
      environment: 'live',
      authMaxAgeMs: 60_000,
    });
    attachMockConnection(client, sendCommand);
    (client as unknown as { lastVerifiedAuthAt: number }).lastVerifiedAuthAt = Date.now() - 120_000;

    await client.getAccountInfo();

    expect(sendCommand).toHaveBeenCalledWith('ProtoOATraderReq', {
      ctidTraderAccountId: 47393545,
    });
    vi.useRealTimers();
  });
});
