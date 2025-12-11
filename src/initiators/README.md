# Initiator System

The initiator system allows you to create custom trade initiators for different exchanges or trading strategies. Each initiator is registered by name and can be configured independently.

## Architecture

- **Initiator Registry**: Central registry that maps initiator names to initiator functions
- **Initiator Functions**: Functions that initiate trades based on parsed order data
- **Built-in Initiators**: Default initiators for common exchanges (e.g., Bybit)

## Creating a Custom Initiator

### 1. Create an Initiator Function

Create a new file in `src/initiators/` for your custom initiator:

```typescript
// src/initiators/myExchangeInitiator.ts
import { InitiatorFunction, InitiatorContext } from './initiatorRegistry.js';
import { logger } from '../utils/logger.js';

export const myExchangeInitiator: InitiatorFunction = async (context: InitiatorContext): Promise<void> => {
  const { 
    channel, 
    riskPercentage, 
    entryTimeoutDays, 
    message, 
    order, 
    db, 
    isSimulation,
    priceProvider,
    config 
  } = context;

  try {
    // Get config-specific settings
    const mySetting = (config as any).mySetting || 'default';
    
    logger.info('Initiating trade on MyExchange', {
      channel,
      tradingPair: order.tradingPair,
      entryPrice: order.entryPrice
    });

    if (isSimulation) {
      // Handle simulation mode
      const orderId = `SIM-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      logger.info('Simulation mode: Simulated order placement', {
        channel,
        orderId,
        tradingPair: order.tradingPair
      });
      
      // Store trade in database
      db.insertTrade({
        message_id: message.message_id,
        channel: channel,
        trading_pair: order.tradingPair,
        leverage: order.leverage,
        entry_price: order.entryPrice,
        stop_loss: order.stopLoss,
        take_profits: JSON.stringify(order.takeProfits),
        risk_percentage: riskPercentage,
        exchange: 'my_exchange', // Your exchange identifier
        order_id: orderId,
        status: 'pending',
        stop_loss_breakeven: false,
        expires_at: new Date(Date.now() + entryTimeoutDays * 24 * 60 * 60 * 1000).toISOString()
      });
    } else {
      // Handle live trading
      // Connect to your exchange API
      // Calculate position size based on riskPercentage
      // Place order
      // Store trade in database
    }
  } catch (error) {
    logger.error('Error initiating trade on MyExchange', {
      channel,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};
```

### 2. Register the Initiator

In `src/initiators/index.ts`:

```typescript
import { registerInitiator } from './initiatorRegistry.js';
import { myExchangeInitiator } from './myExchangeInitiator.js';

// Register the initiator
registerInitiator('my_exchange', myExchangeInitiator);
```

### 3. Configure in config.json

```json
{
  "initiators": [
    {
      "name": "my_exchange",
      "riskPercentage": 3,
      "mySetting": "custom_value"
    }
  ],
  "channels": [
    {
      "channel": "my_channel",
      "harvester": "my_harvester",
      "parser": "my_parser",
      "initiator": "my_exchange",
      "monitor": "bybit"
    }
  ]
}
```

## Initiator Function Requirements

Your initiator function must:

- Accept an `InitiatorContext` object
- Return `Promise<void>`
- Handle both simulation and live trading modes
- Store trades in the database using `db.insertTrade()`
- Handle errors gracefully
- Use the logger for all important events

### InitiatorContext Interface

```typescript
interface InitiatorContext {
  channel: string;                    // Channel name
  riskPercentage: number;             // Risk percentage from config
  entryTimeoutDays: number;           // Days to wait for entry
  message: Message;                   // Original Telegram message
  order: ParsedOrder;                 // Parsed order data
  db: DatabaseManager;                // Database instance
  isSimulation: boolean;              // Whether in simulation mode
  priceProvider?: HistoricalPriceProvider; // Price provider for simulation
  config: InitiatorConfig;            // Full initiator config
}
```

### ParsedOrder Interface

```typescript
interface ParsedOrder {
  tradingPair: string;        // e.g., "BTCUSDT"
  leverage: number;           // e.g., 20
  entryPrice: number;         // Primary entry price
  stopLoss: number;          // Stop loss price
  takeProfits: number[];      // Array of take profit prices
  signalType: 'long' | 'short';
  entryTargets?: number[];   // Optional: multiple entry prices
}
```

## Example: Bybit Initiator

The built-in Bybit initiator (`bybitInitiator`) provides a complete example:

- Connects to Bybit API using environment variables
- Supports testnet mode
- Calculates position size based on risk percentage
- Sets leverage and places limit orders
- Handles simulation mode
- Stores trades in database

See `src/initiators/bybitInitiator.ts` for the full implementation.

## Configuration Options

### Common Options

All initiators support these common configuration options:

- `name`: Initiator name (must match registry name)
- `riskPercentage`: Percentage of account balance to risk per trade
- `testnet`: (Optional) Use testnet/demo account

### Custom Options

You can add any custom configuration options to your initiator config. Access them via `context.config`:

```typescript
const myCustomSetting = (context.config as any).myCustomSetting;
```

## Testing Your Initiator

### Simulation Mode

Test your initiator in simulation mode first:

```json
{
  "simulation": {
    "enabled": true,
    "messagesFile": "data/messages.csv"
  }
}
```

This allows you to test without real API calls.

### Backward Compatibility

For backward compatibility, the config supports both `name` and deprecated `type` fields:

```json
{
  "initiators": [
    {
      "name": "bybit",     // Preferred
      "type": "bybit"      // Still works, but deprecated
    }
  ]
}
```

## Built-in Initiators

### Bybit

- **Name**: `bybit`
- **Config**:
  - `testnet`: Use Bybit testnet (default: false)
  - `riskPercentage`: Risk percentage per trade
- **Environment Variables**:
  - `BYBIT_API_KEY`: Your Bybit API key
  - `BYBIT_API_SECRET`: Your Bybit API secret

Example:

```json
{
  "initiators": [
    {
      "name": "bybit",
      "testnet": true,
      "riskPercentage": 3
    }
  ]
}
```

## Tips

1. **Start with simulation mode** - Test your logic without real trades
2. **Calculate position size carefully** - Based on risk percentage and stop loss distance
3. **Handle API errors gracefully** - Exchange APIs can be unreliable
4. **Log everything** - Helps with debugging and monitoring
5. **Store all trades** - Database is the source of truth
6. **Support testnet** - Allows safe testing with demo accounts
7. **Follow exchange API limits** - Respect rate limits and connection limits

## Registry Functions

The registry provides several utility functions:

```typescript
import { 
  registerInitiator, 
  getInitiator, 
  hasInitiator,
  getRegisteredInitiators 
} from './initiatorRegistry.js';

// Register an initiator
registerInitiator('my_exchange', myExchangeInitiator);

// Get an initiator
const initiator = getInitiator('my_exchange');

// Check if an initiator exists
if (hasInitiator('my_exchange')) {
  // ...
}

// Get all registered initiator names
const names = getRegisteredInitiators();
```




