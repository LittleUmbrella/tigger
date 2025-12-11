# Parser System

The parser system allows you to create channel-specific parsers for different Telegram signal formats. Each channel can have its own parser that understands its unique message format.

## Architecture

- **Parser Registry**: Central registry that maps parser names to parser functions
- **Parser Functions**: Simple functions that take message content and return `ParsedOrder | null`
- **Default Parser**: Fallback parser that handles common formats

## Creating a Custom Parser

### 1. Create a Parser Function

Create a new file in `src/parsers/` for your channel-specific parser:

```typescript
// src/parsers/myChannelParser.ts
import { ParsedOrder } from '../types/order.js';
import { logger } from '../utils/logger.js';

export const myChannelParser = (content: string): ParsedOrder | null => {
  try {
    // Your parsing logic here
    // Extract: tradingPair, leverage, entryPrice, stopLoss, takeProfits, signalType
    
    // Example: Parse a specific format
    const pairMatch = content.match(/#(\w+)\/USDT/);
    if (!pairMatch) return null;
    
    const tradingPair = pairMatch[1].toUpperCase();
    
    // ... extract other fields ...
    
    return {
      tradingPair,
      leverage: 20,
      entryPrice: 100.0,
      stopLoss: 95.0,
      takeProfits: [105.0, 110.0, 115.0],
      signalType: 'long'
    };
  } catch (error) {
    logger.error('Error in myChannelParser', { error });
    return null;
  }
};
```

### 2. Register the Parser

In your main entry point (e.g., `src/index.ts` or `src/orchestrator/tradeOrchestrator.ts`):

```typescript
import { registerParser } from './parsers/parserRegistry.js';
import { myChannelParser } from './parsers/myChannelParser.js';

// Register the parser
registerParser('my_channel_parser', myChannelParser);
```

### 3. Configure in config.json

```json
{
  "parsers": [
    {
      "name": "my_channel_parser",
      "channel": "my_channel"
    }
  ],
  "channels": [
    {
      "channel": "my_channel",
      "harvester": "my_harvester",
      "parser": "my_channel_parser",
      "initiator": "bybit",
      "monitor": "bybit"
    }
  ]
}
```

## Parser Function Requirements

Your parser function must:
- Accept a `string` (message content)
- Return `ParsedOrder | null`
- Return `null` if the message cannot be parsed
- Handle errors gracefully

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

## Example: Format-Specific Parser

Here's an example parser for a specific format:

```typescript
// src/parsers/emojiHeavyParser.ts
export const emojiHeavyParser = (content: string): ParsedOrder | null => {
  // Format: "⚡ #SYMBOL/USDT 📥 Short 💹 Buy: 1.0 - 1.1 🧿 Target: 0.9 - 0.8 🧨 StopLoss: 1.2 🔘 Leverage: 20x"
  
  const symbolMatch = content.match(/#(\w+)\/USDT/);
  if (!symbolMatch) return null;
  
  const tradingPair = symbolMatch[1].toUpperCase();
  const isShort = content.includes('📥') || /short/i.test(content);
  const signalType = isShort ? 'short' : 'long';
  
  // Extract Buy prices (entry range)
  const buyMatch = content.match(/Buy:\s*([0-9.]+)\s*-\s*([0-9.]+)/);
  if (!buyMatch) return null;
  const entryPrice = parseFloat(buyMatch[1]);
  
  // Extract Targets
  const targetMatch = content.match(/Target:\s*([0-9.\s-+]+)/);
  if (!targetMatch) return null;
  const targets = targetMatch[1].match(/[0-9.]+/g)?.map(parseFloat) || [];
  
  // Extract StopLoss
  const stopLossMatch = content.match(/StopLoss:\s*([0-9.]+)/);
  if (!stopLossMatch) return null;
  const stopLoss = parseFloat(stopLossMatch[1]);
  
  // Extract Leverage
  const leverageMatch = content.match(/(\d+)x/i);
  const leverage = leverageMatch ? parseInt(leverageMatch[1]) : 1;
  
  // Sort take profits
  const takeProfits = signalType === 'long' 
    ? targets.sort((a, b) => a - b)
    : targets.sort((a, b) => b - a);
  
  return {
    tradingPair,
    leverage,
    entryPrice,
    stopLoss,
    takeProfits,
    signalType
  };
};
```

## Testing Your Parser

You can test your parser with sample messages:

```typescript
import { myChannelParser } from './parsers/myChannelParser.js';

const testMessage = "⚡ #BTC/USDT 📥 Short 💹 Buy: 50000 - 51000 🧿 Target: 49000 - 48000 🧨 StopLoss: 52000 🔘 Leverage: 20x";
const result = myChannelParser(testMessage);
console.log(result);
```

## Tips

1. **Start with the default parser** - See what it extracts and build from there
2. **Use regex patterns** - Most signal formats are consistent enough for regex
3. **Handle edge cases** - Some messages might have variations
4. **Log failures** - Use logger to debug why messages aren't parsing
5. **Test with real messages** - Use actual messages from your channel to test

## Default Parser

The default parser (`defaultParser`) handles common formats and is used as a fallback. You can reference it in `src/parsers/defaultParser.ts` to see how parsing is done.

## LLM Fallback Parser

For messages that cannot be parsed by strict parsers, you can enable an LLM-based fallback parser using Ollama. This uses a local LLM to interpret ambiguous Telegram messages.

### Setup

1. **Install and run Ollama**: Follow instructions at https://ollama.ai
2. **Pull a model**: `ollama pull llama3.2:1b` (or another model of your choice)
3. **Configure in config.json**: Add `ollama` configuration to your parser:

```json
{
  "parsers": [
    {
      "name": "main_parser",
      "channel": "your_channel",
      "ollama": {
        "baseUrl": "http://localhost:11434",
        "model": "llama3.2:1b",
        "timeout": 30000,
        "maxRetries": 2,
        "rateLimit": {
          "perChannel": 10,
          "perMinute": 30
        }
      }
    }
  ]
}
```

### How It Works

The LLM fallback is automatically triggered when:
1. The configured parser fails to parse a message
2. The default parser also fails
3. The `ollama` configuration is present

The LLM uses a carefully crafted system prompt to extract trading signals and convert them to the standard `ParsedOrder` format.

### Features

- **Automatic fallback**: No code changes needed, just configuration
- **Rate limiting**: Prevents abuse and manages costs
- **Retry logic**: Handles transient failures gracefully
- **Timeout protection**: Prevents hanging on slow LLM responses
- **Schema validation**: Uses Zod to validate LLM output before use
- **Monitoring**: Tracks usage metrics and success rates

### Limitations

- **Latency**: LLM calls add 500ms-5s delay
- **Cost**: Local models are free, but consume CPU/GPU resources
- **Reliability**: LLMs can sometimes misinterpret messages
- **Only OPEN actions**: Currently only supports parsing OPEN trade signals

For more details, see `FALLBACK.md` in the project root.

