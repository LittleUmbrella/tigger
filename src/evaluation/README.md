# Evaluation Module

The evaluation module allows you to assess the quality of trading signals from Telegram channels by simulating trades using historical price data and evaluating performance against proprietary trading firm (prop firm) rules.

## Overview

The evaluation subsystem replaces the simulation subsystem with a more focused purpose: evaluating whether signals from candidate channels would keep accounts open with various prop firms. It:

1. **Harvests historical messages** from Telegram channels and stores them in a database
2. **Processes messages and signals** just like the running bot
3. **Simulates trades** using historical price data
4. **Evaluates performance** against prop firm rules (Crypto Fund Trader, Hyrotrader, Mubite, and custom firms)
5. **Logs and saves results** for each prop firm evaluation

## Quick Start

### 1. Harvest Messages from a Channel

Pull historical messages from a Telegram channel:

```bash
npm run evaluate harvest \
  --channel "your_channel_username" \
  --start-date "2024-01-01" \
  --end-date "2024-12-31" \
  --limit 1000
```

Options:
- `-c, --channel`: Channel username, invite link, or channel ID (required)
- `-a, --access-hash`: Access hash for private channels
- `-s, --start-date`: Start date (YYYY-MM-DD or ISO format)
- `-e, --end-date`: End date (YYYY-MM-DD or ISO format)
- `-k, --keywords`: Comma-separated keywords to filter messages
- `-l, --limit`: Maximum messages to harvest (0 = unlimited)
- `-d, --delay`: Delay between batches in ms, or "auto" (default: auto)
- `--db-path`: Database path (default: data/evaluation.db)
- `--db-type`: Database type: sqlite or postgresql (default: sqlite)

### 2. Run Evaluation

Evaluate the harvested messages against prop firm rules:

```bash
npm run evaluate evaluate \
  --channel "your_channel_username" \
  --parser "emoji_heavy" \
  --prop-firms "crypto-fund-trader,hyrotrader,mubite" \
  --initial-balance 10000 \
  --risk-percentage 3
```

Options:
- `-c, --channel`: Channel to evaluate (required)
- `-p, --parser`: Parser name to use (required)
- `--prop-firms`: Comma-separated list of prop firms (required)
- `--config`: Path to evaluation config JSON file (alternative to CLI options)
- `--initial-balance`: Initial account balance in USDT (default: 10000)
- `--start-date`: Start date (optional, uses earliest message if not provided)
- `--speed-multiplier`: Speed multiplier (0 = max speed, default: 0)
- `--max-trade-duration`: Maximum trade duration in days (default: 7)
- `--risk-percentage`: Risk percentage per trade (default: 3)
- `--db-path`: Database path (default: data/evaluation.db)
- `--db-type`: Database type: sqlite or postgresql (default: sqlite)

### 3. View Results

List evaluation results:

```bash
npm run evaluate results
```

Options:
- `-c, --channel`: Filter by channel
- `-f, --firm`: Filter by prop firm name
- `--db-path`: Database path (default: data/evaluation.db)
- `--db-type`: Database type: sqlite or postgresql (default: sqlite)

## Configuration File

You can also use a configuration file for more complex setups:

```json
{
  "evaluation": {
    "channel": "your_channel_username",
    "parser": "emoji_heavy",
    "initiator": {
      "name": "bybit",
      "riskPercentage": 3,
      "testnet": false
    },
    "monitor": {
      "type": "bybit",
      "testnet": false,
      "pollInterval": 10000,
      "entryTimeoutDays": 2
    },
    "propFirms": [
      "crypto-fund-trader",
      "hyrotrader",
      "mubite",
      {
        "name": "custom-firm",
        "displayName": "Custom Prop Firm",
        "initialBalance": 10000,
        "profitTarget": 8,
        "maxDrawdown": 8,
        "dailyDrawdown": 4,
        "minTradingDays": 5
      }
    ],
    "initialBalance": 10000,
    "startDate": "2024-01-01T00:00:00Z",
    "speedMultiplier": 0,
    "maxTradeDurationDays": 7
  }
}
```

Then run:

```bash
npm run evaluate evaluate --config config.evaluation.json
```

## Supported Prop Firms

### Crypto Fund Trader
- **Reverse Trading Rule**: Cannot open opposite trades with simultaneous duration of 60+ seconds
- **30 Seconds Rule**: Trades < 30 seconds cannot exceed 5% of total trades
- **Gambling Rule**: Daily or per-trade profit limit of $10,000

### Hyrotrader
- **Profit Target**: 10%
- **Maximum Drawdown**: 10% of initial balance
- **Daily Drawdown**: 5% of initial balance
- **Minimum Trading Days**: 10 days
- **Max Risk Per Trade**: 3% of initial balance
- **Stop-Loss Required**: Yes (within 5 minutes)

### Mubite
- **Profit Target**: 10%
- **Maximum Drawdown**: 8-10% of starting balance
- **Daily Drawdown**: 5% of starting balance
- **Minimum Trading Days**: 4 days
- **Min Trades Per Day**: 1 (with P&L > 0.25% of day start capital)

## Custom Prop Firms

You can define custom prop firms in your configuration:

```json
{
  "propFirms": [
    {
      "name": "my-custom-firm",
      "displayName": "My Custom Prop Firm",
      "initialBalance": 10000,
      "profitTarget": 8,
      "maxDrawdown": 8,
      "dailyDrawdown": 4,
      "minTradingDays": 5,
      "maxRiskPerTrade": 2.5,
      "stopLossRequired": true,
      "stopLossTimeLimit": 5,
      "customRules": {
        "customRule1": "value1"
      }
    }
  ]
}
```

## Database

By default, evaluation uses a separate database (`data/evaluation.db` for SQLite) to avoid polluting the running bot's database. You can specify a different database path or use PostgreSQL:

```bash
npm run evaluate evaluate \
  --channel "channel" \
  --parser "parser" \
  --prop-firms "firm1,firm2" \
  --db-type postgresql \
  --db-path "postgresql://user:pass@localhost/dbname"
```

## Evaluation Results

Evaluation results are stored in the database and include:

- **Pass/Fail Status**: Whether the channel passed all rules for each prop firm
- **Violations**: List of rule violations (if any)
- **Metrics**: 
  - Initial and final balance
  - Total P&L and percentage
  - Maximum drawdown
  - Trading days
  - Total trades, win rate, winning/losing trades

Results can be viewed using the `results` command or queried directly from the database.

## Architecture

The evaluation module consists of:

- **Message Harvester** (`messageHarvester.ts`): Pulls historical messages from Telegram channels
- **Prop Firm Rules** (`propFirmRules.ts`): Defines rule configurations for prop firms
- **Prop Firm Evaluator** (`propFirmEvaluator.ts`): Evaluates trading performance against rules
- **Evaluation Orchestrator** (`evaluationOrchestrator.ts`): Coordinates message processing, trade simulation, and evaluation
- **CLI** (`index.ts`): Command-line interface for running evaluations

## Integration with Running Bot

The evaluation module:
- Uses the same parsers, initiators, and monitors as the running bot
- Reuses the historical price provider for price simulation
- Can use the same database or a separate one
- Processes messages in chronological order, just like simulation mode

## Notes

- Evaluation uses historical price data from Bybit (requires internet connection)
- With Bybit API key: Uses execution history for maximum granularity
- Without API key: Uses 1-minute index price klines
- Evaluation runs at maximum speed by default (no artificial delays)
- All trades are simulated - no real trades are executed

