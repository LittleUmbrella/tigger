import type { CTraderClient } from '../../clients/ctraderClient.js';
import type { DatabaseManager } from '../../db/schema.js';
import type { AccountConfig } from '../../types/config.js';
import { isTickCloseStrategy } from '../../utils/ctraderTpStrategy.js';
import { logger } from '../../utils/logger.js';
import { CTraderTickTpService } from './ctraderTickTpService.js';
import type { TickTpWatch } from './types.js';

const services = new Map<string, CTraderTickTpService>();

export async function startTickTpServices({
  accounts,
  db,
  getCTraderClient,
  isSimulation,
  onBreakevenCheck,
}: {
  accounts: AccountConfig[] | undefined;
  db: DatabaseManager;
  getCTraderClient: (accountName?: string) => Promise<CTraderClient | undefined>;
  isSimulation: boolean;
  onBreakevenCheck?: (tradeId: number, filledTpCount: number) => Promise<void>;
}): Promise<() => Promise<void>> {
  if (services.size > 0) {
    await Promise.all([...services.values()].map((service) => service.stop()));
    services.clear();
  }

  if (isSimulation || !accounts?.length) {
    return async () => undefined;
  }

  for (const account of accounts) {
    if (account.exchange !== 'ctrader') continue;
    if (!isTickCloseStrategy(account)) continue;

    const client = await getCTraderClient(account.name);
    if (!client) {
      logger.warn('Tick-close service not started: missing cTrader client', {
        accountName: account.name,
        exchange: 'ctrader',
      });
      continue;
    }

    const service = new CTraderTickTpService(account.name, client, db, onBreakevenCheck);
    await service.start();
    services.set(account.name, service);
  }

  return async () => {
    await Promise.all([...services.values()].map((service) => service.stop()));
    services.clear();
  };
}

export function getTickTpService(accountName: string): CTraderTickTpService | undefined {
  return services.get(accountName);
}

export function registerTickCloseWatch(accountName: string, watch: TickTpWatch): void {
  const service = services.get(accountName);
  if (!service) {
    throw new Error(
      `Tick-close TP service not running for account "${accountName}" (tradeId=${watch.tradeId})`
    );
  }
  service.register(watch);
}
