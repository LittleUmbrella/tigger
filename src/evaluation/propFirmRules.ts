/**
 * Prop Firm Rule Definitions
 * 
 * These rules are based on funded account requirements (not qualification rules).
 * Rules are evaluated to determine if a trading strategy would keep accounts open.
 */

export interface PropFirmRule {
  name: string;
  displayName: string;
  
  // Account balance and equity tracking
  initialBalance: number; // Starting account balance in USDT
  
  // Profit targets
  profitTarget?: number; // Percentage profit target (e.g., 10 = 10%)
  
  // Drawdown limits
  maxDrawdown?: number; // Maximum drawdown percentage (e.g., 10 = 10% of initial balance)
  dailyDrawdown?: number; // Daily drawdown limit percentage (e.g., 5 = 5% of initial balance)
  /**
   * Daily drawdown calculation mode.
   * - 'dayStartPercent' (default): limit is % of the balance at the start of the day
   * - 'swing': limit is a static % of the initial balance (e.g., HyroTrader Swing daily drawdown)
   * - 'trailing': placeholder for intraday trailing-from-peak equity logic (not fully supported yet)
   */
  dailyDrawdownMode?: 'dayStartPercent' | 'swing' | 'trailing';
  
  // Trading requirements
  minTradingDays?: number; // Minimum number of trading days required
  minTradesPerDay?: number; // Minimum trades per day (optional)
  
  // Risk management
  maxRiskPerTrade?: number; // Maximum risk per trade as percentage of initial balance (e.g., 3 = 3%)
  stopLossRequired?: boolean; // Whether stop-loss is mandatory
  stopLossTimeLimit?: number; // Minutes within which stop-loss must be set
  
  // Trade restrictions
  maxProfitPerDay?: number; // Maximum profit per day in USDT (e.g., 10000)
  maxProfitPerTrade?: number; // Maximum profit per trade in USDT
  minTradeDuration?: number; // Minimum trade duration in seconds (e.g., 30)
  maxShortTradesPercentage?: number; // Maximum percentage of trades that can be < minTradeDuration (e.g., 5 = 5%)
  
  // Reverse trading rules
  reverseTradingAllowed?: boolean; // Whether opposite trades are allowed
  reverseTradingTimeLimit?: number; // Seconds that opposite trades can overlap (e.g., 60)
  
  // Additional custom rules
  customRules?: Record<string, any>;
}

/**
 * Predefined prop firm configurations
 */
export const PROP_FIRM_RULES: Record<string, PropFirmRule> = {
  'crypto-fund-trader': {
    name: 'crypto-fund-trader',
    displayName: 'Crypto Fund Trader',
    initialBalance: 10000, // Default, can be overridden
    
    // Reverse trading/hedging rule: cannot open opposite positions on the same trading pair
    // with simultaneous duration of 60+ seconds (prevents hedging the same symbol)
    reverseTradingAllowed: false,
    reverseTradingTimeLimit: 60,
    
    // 30 seconds rule: trades < 30 seconds cannot exceed 5% of total trades
    minTradeDuration: 30,
    maxShortTradesPercentage: 5,
    
    // Gambling rule: daily or per-trade profit limit of $10,000
    maxProfitPerDay: 10000,
    maxProfitPerTrade: 10000,
  },
  
  'hyrotrader': {
    name: 'hyrotrader',
    displayName: 'Hyrotrader',
    initialBalance: 10000, // Default, can be overridden
    
    profitTarget: 10, // 10% profit target
    
    maxDrawdown: 10, // 10% maximum drawdown
    dailyDrawdown: 5, // 5% daily drawdown limit
    dailyDrawdownMode: 'swing',
    
    minTradingDays: 10, // 10 minimum trading days
    
    maxRiskPerTrade: 3, // 3% max risk per trade
    stopLossRequired: true,
    stopLossTimeLimit: 5, // Must set stop-loss within 5 minutes
  },
  
  'mubite': {
    name: 'mubite',
    displayName: 'Mubite',
    initialBalance: 10000, // Default, can be overridden
    
    profitTarget: 10, // 10% profit target
    
    maxDrawdown: 10, // 8-10% maximum drawdown (using 10% as conservative)
    dailyDrawdown: 5, // 5% daily drawdown limit
    
    minTradingDays: 4, // 4 minimum trading days
    minTradesPerDay: 1, // At least 1 position closed per day with P&L > 0.25% of day start capital
  },
};

/**
 * Get a prop firm rule configuration
 */
export function getPropFirmRule(name: string, overrides?: Partial<PropFirmRule>): PropFirmRule | null {
  const rule = PROP_FIRM_RULES[name.toLowerCase()];
  if (!rule) return null;
  
  if (overrides) {
    return { ...rule, ...overrides };
  }
  
  return { ...rule };
}

/**
 * Create a custom prop firm rule
 */
export function createCustomPropFirmRule(
  name: string,
  displayName: string,
  config: Omit<PropFirmRule, 'name' | 'displayName'>
): PropFirmRule {
  return {
    name,
    displayName,
    ...config,
  };
}

