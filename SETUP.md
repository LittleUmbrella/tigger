# Setup Guide

## Prerequisites

1. Node.js 20+ installed
2. npm or yarn package manager

## Installation Steps

1. **Install dependencies:**
   ```bash
   npm install
   ```

   This will install:
   - TypeScript and type definitions
   - Database (better-sqlite3)
   - Logging (winston)
   - Telegram client
   - Bybit API client
   - Other dependencies

2. **Build the project:**
   ```bash
   npm run build
   ```

3. **Create environment file:**
   ```bash
   # Create .env file with credentials
   cat > .env << EOF
   TG_API_ID=your_api_id
   TG_API_HASH=your_api_hash
   TG_SESSION=your_session_string
   BYBIT_API_KEY=your_bybit_api_key
   BYBIT_API_SECRET=your_bybit_api_secret
   EOF
   ```
   
   Get your Telegram API credentials from https://my.telegram.org
   Get your Bybit API credentials from https://www.bybit.com/app/user/api-management

4. **Create configuration:**
   ```bash
   cp config.example.json config.json
   ```

5. **Edit `config.json`** with your settings:
   - Define named harvesters (one per Telegram channel you want to monitor)
   - Define named parsers (one per channel you want to parse)
   - Define monitors by type (bybit, and optionally dex in the future)
   - Define channel sets that combine harvesters, parsers, and monitors
   - Set risk percentages and other trading parameters

5. **Create necessary directories:**
   ```bash
   mkdir -p logs data
   ```

6. **Run the bot:**
   ```bash
   npm start
   ```

   Or for development:
   ```bash
   npm run dev
   ```

## Docker Setup

1. **Build and run with Docker Compose:**
   ```bash
   docker-compose up -d
   ```

2. **View logs:**
   ```bash
   docker-compose logs -f
   ```

## Getting Telegram Session String

To get your Telegram session string, you can use the existing utility script or manually authenticate. The session string should be stored in your `.env` file as `TG_SESSION`.

You can also use the existing utility script at `src/utilities/index.js` which will save the session to `.env` automatically after first login.

## Notes

- The database will be created automatically at `data/trading_bot.db`
- Logs will be written to `logs/combined.log` and `logs/error.log`
- Make sure your Bybit API keys have the necessary permissions for trading
- Start with `testnet: true` in your initiator config to test safely

