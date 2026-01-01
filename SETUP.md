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
   - Discord.js client
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
   # Telegram (required if using Telegram harvesters)
   TG_API_ID=your_api_id
   TG_API_HASH=your_api_hash
   TG_SESSION=your_session_string
   
   # Discord (required if using Discord harvesters)
   DISCORD_BOT_TOKEN=your_discord_bot_token
   
   # Bybit (required for trading)
   BYBIT_API_KEY=your_bybit_api_key
   BYBIT_API_SECRET=your_bybit_api_secret
   EOF
   ```
   
   **Get credentials:**
   - Telegram API credentials: https://my.telegram.org
   - Discord bot token: Create a bot at https://discord.com/developers/applications
   - Bybit API credentials: https://www.bybit.com/app/user/api-management

4. **Create configuration:**
   ```bash
   cp config.example.json config.json
   ```

5. **Edit `config.json`** with your settings:
   - Define named harvesters (one per Telegram or Discord channel you want to monitor)
     - Set `platform: "telegram"` or `platform: "discord"` (defaults to `"telegram"`)
     - For Discord: include `botToken` or set `DISCORD_BOT_TOKEN` env var
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

## Platform Setup

### Telegram

To get your Telegram session string, you can use the existing utility script or manually authenticate. The session string should be stored in your `.env` file as `TG_SESSION`.

You can also use the existing utility script at `src/utilities/index.js` which will save the session to `.env` automatically after first login.

**⚠️ Important: Multiple Instances**
- Each instance (local, cloud, etc.) needs its own unique `TG_SESSION`
- Telegram does not allow the same auth key to be used concurrently from multiple instances
- If you get `AUTH_KEY_DUPLICATED` error, you're using the same session in multiple places
- To create a new session, run: `npm run list-channels` and authenticate when prompted

### Discord

To set up Discord:

1. Go to https://discord.com/developers/applications
2. Create a new application or select an existing one
3. Go to the "Bot" section
4. Create a bot and copy the token
5. Add the token to your `.env` file as `DISCORD_BOT_TOKEN`
6. In the "OAuth2" → "URL Generator" section:
   - Select scopes: `bot`
   - Select bot permissions: `Read Message History`
   - Copy the generated URL and open it in your browser to invite the bot to your server
7. Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode)
8. Right-click on the channel you want to monitor → Copy ID
9. Use the channel ID in your harvester configuration

## Notes

- The database will be created automatically at `data/trading_bot.db`
- Logs will be written to `logs/combined.log` and `logs/error.log`
- Make sure your Bybit API keys have the necessary permissions for trading
- Start with `testnet: true` in your initiator config to test safely

