# Simulation Mode

Simulation mode allows you to backtest trading strategies using historical Telegram signals and price data. This is useful for evaluating the profitability of a Telegram channel before risking real capital.

## How It Works

1. **CSV Message Harvester**: Reads trading signals from a CSV file (like `messages.csv`) instead of live Telegram
2. **Historical Price Provider**: Uses historical Bybit price data to simulate real-time price feeds
3. **Simulated Trading**: Places simulated orders (no real trades) and tracks PNL based on historical prices
4. **Time Progression**: Plays back historical data at configurable speed to mimic real-time trading

## Setup

### 1. Prepare Message CSV

Your CSV file should have the format:
```csv
id,date,sender,message
1277,2025-10-02T06:10:19.000Z,,💹 #1MBABYDOGE ...
1278,2025-10-03T03:16:49.000Z,,⚡ #1000FLOKI/USDT ...
```

Columns:
- `id`: Message ID (numeric)
- `date`: ISO 8601 date string
- `sender`: Sender ID (can be empty)
- `message`: Message content

### 2. Configure Simulation

**Note**: Historical price data is automatically fetched from Bybit Futures API based on message timestamps. No manual price data files are needed!

Add simulation configuration to your `config.json`:

```json
{
  "simulation": {
    "enabled": true,
    "messagesFile": "data/messages.csv",
    "startDate": "2024-09-15T00:00:00Z",
    "speedMultiplier": 10.0,
    "maxTradeDurationDays": 7
  }
}
```

Configuration options:
- `enabled`: Enable/disable simulation mode
- `messagesFile`: Path to CSV file with messages
- `startDate`: ISO date string - when to start the simulation (optional, uses earliest message if not provided)
- `speedMultiplier`: How fast to play back (1.0 = real-time, 10.0 = 10x speed)
- `maxTradeDurationDays`: Maximum days to track a trade before closing (default: 7)

### 4. Run Simulation

```bash
npm run build
npm start
```

The simulation will:
1. Load all messages from the CSV file in chronological order
2. For each message, set simulation time to the message timestamp
3. Parse signals and create simulated trades
4. Automatically fetch historical price data from Bybit Futures API starting from message timestamp
5. Use historical prices (1-minute granularity) to determine entry/exit
6. Calculate PNL for each trade
7. Store results in the database

## How Price Data Works

Historical price data is automatically fetched from Bybit Futures API:
- **With API Key (Recommended)**: 
  - Uses **Execution History API** for individual trade executions (tick-by-tick granularity)
  - Most granular data available - captures every price movement from actual trades
  - Supplemented with 1-minute index price klines for complete coverage
- **Without API Key**:
  - Uses **Index Price Kline API** with 1-minute intervals
  - Still very granular (much better than typical 5min/15min/1h klines)
- **Fetching**: Prices are fetched on-demand based on message timestamps
- **Caching**: Fetched prices are cached to avoid redundant API calls
- **Coverage**: Works for any historical date range (no file size limits!)

The system automatically:
- Fetches price data starting from each message's timestamp
- Continues fetching until the trade closes (or max duration reached)
- Uses index price which is more stable and reliable for backtesting
- With API key: Gets individual trade executions for maximum granularity

## Viewing Results

After the simulation completes, check the database for trade results:

```sql
SELECT 
  trading_pair,
  entry_price,
  exit_price,
  pnl,
  pnl_percentage,
  status,
  created_at,
  exit_filled_at
FROM trades
WHERE status IN ('closed', 'stopped')
ORDER BY exit_filled_at DESC;
```

## Limitations

- Simulation assumes perfect order execution at specified prices
- Slippage and fees are not fully accounted for
- Price data is fetched from Bybit API (requires internet connection)
- Without API key: 1-minute price intervals may not capture every micro-movement
- With API key: Individual trade executions provide maximum granularity
- API rate limits may slow down backtests for very large date ranges
- Execution history may be limited to recent trades (varies by account type)

## Tips

- Start with a small date range to test
- Use higher `speedMultiplier` for faster backtests (but be mindful of API rate limits)
- The system automatically handles price fetching - no manual setup needed
- Check logs for API errors or missing price data warnings
- For very old data (1+ years), the backtest may take longer due to API rate limits


