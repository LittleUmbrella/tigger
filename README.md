# Tigger - Crypto Trading Bot

A comprehensive crypto trading bot written in TypeScript that harvests trading signals from Telegram and Discord channels, parses them, initiates trades on exchanges (Bybit), and monitors them automatically.

## Features

- **Signal Harvestors**: Long-running, long-polling message readers for Telegram and Discord channels that store messages in a database
- **CSV Harvester**: Alternative harvester for simulation mode that reads from CSV files
- **Signal Parsers**: Parse messages from Telegram or Discord into structured order data (trading pair, leverage, entry price, stop-loss, take-profits)
- **Signal Initiators**: Automatically initiate trades on Bybit exchange based on parsed signals
- **Trade Monitors**: Monitor open trades, adjust stop-loss to breakeven after N take profits are hit (configurable per channel), cancel orders if conditions aren't met, track PNL
- **Trade Orchestrator**: Coordinates all components based on JSON configuration
- **Simulation Mode**: Backtest strategies using historical signals and price data
- **Database Storage**: SQLite database for messages and trades
- **Comprehensive Logging**: Winston-based logging with file and console outputs
- **Dockerized**: Ready to run in Docker containers

## Architecture

```
┌─────────────┐
│ Orchestrator│
└──────┬──────┘
       │
       ├──► Harvesters (Telegram/Discord polling)
       │         │
       │         ▼
       │    Database (Messages)
       │         │
       ├──► Parsers
       │         │
       │         ▼
       │    Database (Parsed Orders)
       │         │
       ├──► Initiators (Bybit API)
       │         │
       │         ▼
       │    Database (Trades)
       │         │
       └──► Monitors (Price polling)
                 │
                 ▼
            Database (Trade Updates)
```

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Build TypeScript:
   ```bash
   npm run build
   ```

4. Copy the example configuration:
   ```bash
   cp config.example.json config.json
   ```

5. Create a `.env` file with your credentials:
   ```bash
   cp .env.example .env
   ```
   Then edit `.env` and add:
   - `TG_API_ID`: Your Telegram API ID
   - `TG_API_HASH`: Your Telegram API Hash
   - `TG_SESSION`: Your Telegram session string
   - `BYBIT_API_KEY`: Your Bybit API key
   - `BYBIT_API_SECRET`: Your Bybit API secret

6. Edit `config.json` with your channel settings (harvesters, parsers, monitors, and channels)

## Configuration

The bot is configured via `config.json`. See `config.example.json` for a template.

### Environment Variables

Required environment variables (set in `.env` file):
- **Telegram** (required if using Telegram harvesters):
  - `TG_API_ID`: Telegram API ID (get from https://my.telegram.org)
  - `TG_API_HASH`: Telegram API Hash (get from https://my.telegram.org)
  - `TG_SESSION`: Telegram session string (obtained after first login)
- **Discord** (required if using Discord harvesters):
  - `DISCORD_BOT_TOKEN`: Discord bot token (get from https://discord.com/developers/applications)
- **Bybit** (required for trading):
  - `BYBIT_API_KEY`: Bybit API key (for Bybit exchange operations)
  - `BYBIT_API_SECRET`: Bybit API secret (for Bybit exchange operations)

### Configuration Structure

The configuration file has four main sections:

1. **harvesters**: Array of named harvester configurations
   - `name`: Unique name for this harvester
   - `channel`: Channel identifier (Telegram: username/invite/channel ID, Discord: channel ID)
   - `platform`: Platform type - `"telegram"` or `"discord"` (default: `"telegram"` for backward compatibility)
   - **Telegram-specific fields**:
     - `apiId`: Telegram API ID (can also use `TG_API_ID` env var)
     - `accessHash`: Optional access hash for private channels
   - **Discord-specific fields**:
     - `botToken`: Discord bot token (can also use `DISCORD_BOT_TOKEN` env var)
     - `guildId`: Optional Discord server/guild ID (can be inferred from channel)
   - `pollInterval`: Polling interval in milliseconds (default: 5000)
   - `downloadImages`: Whether to download and store images from messages (default: false)

2. **parsers**: Array of named parser configurations
   - `name`: Unique name for this parser
   - `channel`: Channel to parse messages from

3. **initiators**: Array of initiator configurations (by type)
   - `type`: Either "bybit" or "dex" (dex not yet implemented)
   - `testnet`: Use testnet (default: false)
   - `riskPercentage`: Percentage of account to risk per trade

4. **monitors**: Array of monitor configurations (by type)
   - `type`: Either "bybit" or "dex" (dex not yet implemented)
   - `pollInterval`: Polling interval in milliseconds (default: 10000)
   - `entryTimeoutDays`: Days to wait for entry before cancelling (default: 2)
   - `breakevenAfterTPs`: Number of take profits to hit before moving stop-loss to breakeven (default: 1)

5. **channels**: Array of channel sets that combine harvesters, parsers, initiators, and monitors
   - `channel`: Channel identifier (Telegram: username/invite/channel ID, Discord: channel ID)
   - `harvester`: Name of harvester to use (references harvesters array)
   - `parser`: Name of parser to use (references parsers array)
   - `initiator`: Initiator type to use ("bybit" or "dex")
   - `monitor`: Monitor type to use ("bybit" or "dex")
   - `breakevenAfterTPs`: Optional per-channel override for number of TPs before breakeven (overrides monitor config)

6. **simulation** (optional): Simulation mode configuration
   - `enabled`: Enable simulation mode (default: false)
   - `messagesFile`: Path to CSV file with historical messages
   - `priceDataDir`: Directory containing historical price CSV files
   - `startDate`: ISO date string - when to start simulation
   - `speedMultiplier`: Playback speed (1.0 = real-time, 10.0 = 10x speed)

## Usage

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

### Docker

```bash
docker-compose up -d
```

### Simulation Mode (Backtesting)

To evaluate the profitability of a Telegram channel using historical data:

1. Prepare your message CSV file (see `SIMULATION.md`)
2. Prepare historical price data CSV files
3. Configure simulation in `config.json`:

```json
{
  "simulation": {
    "enabled": true,
    "messagesFile": "data/messages.csv",
    "priceDataDir": "data/prices",
    "startDate": "2024-09-15T00:00:00Z",
    "speedMultiplier": 10.0
  }
}
```

4. Run the bot - it will simulate trades and calculate PNL

See `SIMULATION.md` for detailed simulation mode documentation.

## Platform Support

### Telegram

Telegram channels are supported using the Telegram API. Configure a harvester with `platform: "telegram"` (or omit the platform field for backward compatibility).

**Channel identifiers:**
- Username: `"@channelname"`
- Channel ID: `"1234567890"`
- Invite link: `"https://t.me/+invitehash"` or `"t.me/+invitehash"`

### Discord

Discord channels are supported using Discord.js. Configure a harvester with `platform: "discord"`.

**Setup:**
1. Create a Discord bot at https://discord.com/developers/applications
2. Get the bot token
3. Invite the bot to your server with "Read Message History" permission
4. Get the channel ID (enable Developer Mode in Discord, right-click channel → Copy ID)

**Channel identifiers:**
- Channel ID: `"1234567890123456789"` (numeric string)
- Channel mention: `"<#1234567890123456789>"` (also supported)

**Example Discord harvester configuration:**
```json
{
  "harvesters": [
    {
      "name": "discord-signals",
      "channel": "1234567890123456789",
      "platform": "discord",
      "botToken": "your-bot-token",
      "pollInterval": 5000
    }
  ]
}
```

## Message Format

The parser supports various signal formats from both Telegram and Discord. Example:

```
⚡️© PERP/USDT ©⚡️ Exchanges: Pionex, Binance, Bybit 
Signal Type: Regular (Short) 
Leverage: 5x-10х 
Use 3-5% Of Portfolio 
Entry Targets: 0.7034 🖖🏽 0.717605 
Take-Profit Targets: 1) 0.68919 2) 0.67498 3) 0.65366 4) 0.63945 5) 0.61814 6) 0.59682 8) 0.56840 7) 🚀🚀🚀 
Stop Targets: 0.76024
```

Also supports formats like:
```
⚡ #1000FLOKI/USDT 📤 Long 💹 Buy: 0.08710 - 0.08457 🧿 Target: 0.08797 - 0.08884 - 0.08973 - 0.09062 - 0.09153 - 0.09256 🧨 StopLoss: 0.08220 🔘 Leverage: 20x
```

## Trade Monitoring

The monitor performs the following actions:

1. **Entry Timeout**: Cancels orders if entry price is not hit within the configured timeout (default: 2 days)
2. **Pre-Entry Cancellation**: Cancels orders if price hits stop-loss or first take-profit before entry
3. **Breakeven Stop-Loss**: After N take profits are hit (configurable per channel, default: 1), moves stop-loss to entry price (breakeven) to protect profits
4. **Stop-Loss Monitoring**: Closes position if stop-loss is hit

### Configuring Breakeven After N Take Profits

You can configure when the stop-loss moves to breakeven (entry price) by setting `breakevenAfterTPs`:

- **At monitor level**: Set `breakevenAfterTPs` in the monitor configuration to apply to all channels using that monitor
- **Per channel**: Override the monitor setting by adding `breakevenAfterTPs` to individual channel configurations

Example configuration:

```json
{
  "monitors": [
    {
      "type": "bybit",
      "breakevenAfterTPs": 1  // Default: move to breakeven after 1 TP
    }
  ],
  "channels": [
    {
      "channel": "aggressive_channel",
      "monitor": "bybit",
      "breakevenAfterTPs": 2  // Override: move to breakeven after 2 TPs
    },
    {
      "channel": "conservative_channel",
      "monitor": "bybit"
      // Uses monitor default (1 TP)
    }
  ]
}
```

This allows you to customize risk management per channel - some channels may benefit from moving to breakeven after the first TP (protecting capital early), while others may wait for multiple TPs to be hit before securing breakeven.

## Database

The bot uses SQLite (or PostgreSQL) to store:
- **messages**: All harvested messages from Telegram and Discord channels
- **trades**: All initiated trades with their status

Database file location: `data/trading_bot.db` (configurable)

## Logging

Logs are written to:
- `logs/combined.log`: All logs
- `logs/error.log`: Error logs only
- Console: Formatted console output

Log level can be set via `LOG_LEVEL` environment variable (default: `info`)

## Project Structure

```
src/
├── db/
│   └── schema.ts          # Database schema and manager
├── harvesters/
│   ├── signalHarvester.ts # Telegram message harvester
│   └── discordHarvester.ts # Discord message harvester
├── parsers/
│   └── signalParser.ts    # Message parser
├── initiators/
│   └── signalInitiator.ts # Trade initiator
├── monitors/
│   └── tradeMonitor.ts    # Trade monitor
├── orchestrator/
│   └── tradeOrchestrator.ts # Main orchestrator
├── types/
│   ├── config.ts          # Configuration types
│   └── order.ts           # Order data types
├── utils/
│   └── logger.ts          # Logger setup
└── index.ts               # Entry point
```

## Requirements

- Node.js 20+
- TypeScript 5+
- **Telegram API credentials** (if using Telegram harvesters)
  - Get from https://my.telegram.org
- **Discord Bot Token** (if using Discord harvesters)
  - Create bot at https://discord.com/developers/applications
- **Bybit API credentials** (for trading)
  - Get from https://www.bybit.com/app/user/api-management

## License

ISC
