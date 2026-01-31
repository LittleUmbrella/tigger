# Quickstart Guide: Discord Self-Bot Harvester

**Date**: 2025-01-29  
**Feature**: Discord Self-Bot Harvester

## Prerequisites

1. **Node.js 20+** installed
2. **Discord User Account** with access to target channels
3. **User Token** extracted from Discord (see Token Extraction section)
4. **Existing Tigger Bot Setup** (database, configuration structure)

## Installation

### Step 1: Install NPM Package

```bash
npm install discord.js-selfbot-v13
```

Or if using an alternative package:

```bash
npm install <selected-package-name>
```

### Step 2: Set Environment Variable

Add your Discord user token to your `.env` file:

```bash
DISCORD_USER_TOKEN=your_user_token_here
```

**⚠️ Security Warning**: Never commit your user token to version control. User tokens provide full access to your Discord account.

### Step 3: Update Configuration

Add a self-bot harvester to your `config.json`:

```json
{
  "harvesters": [
    {
      "name": "discord-selfbot-signals",
      "channel": "1234567890123456789",
      "platform": "discord-selfbot",
      "envVarNames": {
        "userToken": "DISCORD_USER_TOKEN"
      },
      "pollInterval": 5000,
      "downloadImages": false,
      "skipOldMessagesOnStartup": true,
      "maxMessageAgeMinutes": 10
    }
  ],
  "channels": [
    {
      "channel": "1234567890123456789",
      "harvester": "discord-selfbot-signals",
      "parser": "your_parser_name",
      "initiator": "bybit",
      "monitor": "bybit"
    }
  ]
}
```

### Step 4: Run the Bot

```bash
npm run dev
```

Or for production:

```bash
npm run build
npm start
```

## Configuration Options

### Required Configuration

- **name**: Unique identifier for this harvester
- **channel**: Discord channel ID (numeric string)
- **platform**: Must be `"discord-selfbot"`
- **envVarNames.userToken**: Name of environment variable containing user token (or use default `DISCORD_USER_TOKEN`)

### Optional Configuration

- **pollInterval**: Polling interval in milliseconds (default: 5000)
- **downloadImages**: Whether to download images from messages (default: false)
- **skipOldMessagesOnStartup**: Skip messages older than maxMessageAgeMinutes on startup (default: true)
- **maxMessageAgeMinutes**: Maximum age of messages to process on startup in minutes (default: 10)

## Token Extraction

### Method 1: Browser DevTools (Chrome/Edge)

1. Open Discord in your browser
2. Press `F12` to open DevTools
3. Go to the **Network** tab
4. Filter by `XHR` or `Fetch`
5. Send a message or perform any Discord action
6. Find a request to `discord.com/api`
7. Open the request and go to **Headers**
8. Find `authorization` header
9. Copy the token value (starts with your user ID)

### Method 2: Browser Console

1. Open Discord in your browser
2. Press `F12` to open DevTools
3. Go to the **Console** tab
4. Run:
   ```javascript
   (webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()
   ```
5. Copy the returned token

**⚠️ Important**: 
- Tokens are sensitive - treat them like passwords
- Never share your token
- If token is compromised, regenerate it immediately (change password)
- Tokens may expire - you'll need to extract a new one if authentication fails

## Usage Examples

### Basic Self-Bot Harvester

```json
{
  "harvesters": [
    {
      "name": "my-selfbot",
      "channel": "1234567890123456789",
      "platform": "discord-selfbot",
      "envVarNames": {
        "userToken": "DISCORD_USER_TOKEN"
      }
    }
  ]
}
```

### Self-Bot with Image Downloading

```json
{
  "harvesters": [
    {
      "name": "selfbot-with-images",
      "channel": "1234567890123456789",
      "platform": "discord-selfbot",
      "envVarNames": {
        "userToken": "DISCORD_USER_TOKEN"
      },
      "downloadImages": true
    }
  ]
}
```

### Self-Bot with Custom Polling

```json
{
  "harvesters": [
    {
      "name": "fast-polling-selfbot",
      "channel": "1234567890123456789",
      "platform": "discord-selfbot",
      "envVarNames": {
        "userToken": "DISCORD_USER_TOKEN"
      },
      "pollInterval": 2000
    }
  ]
}
```

### Multiple Self-Bot Harvesters

You can run multiple self-bot harvesters with the same user token:

```json
{
  "harvesters": [
    {
      "name": "selfbot-channel-1",
      "channel": "1111111111111111111",
      "platform": "discord-selfbot",
      "envVarNames": {
        "userToken": "DISCORD_USER_TOKEN"
      }
    },
    {
      "name": "selfbot-channel-2",
      "channel": "2222222222222222222",
      "platform": "discord-selfbot",
      "envVarNames": {
        "userToken": "DISCORD_USER_TOKEN"
      }
    }
  ]
}
```

## Troubleshooting

### Authentication Failed

**Error**: `Failed to connect to Discord` or `Invalid token`

**Solutions**:
1. Verify token is correct (no extra spaces, complete token)
2. Check environment variable name matches config
3. Token may have expired - extract a new one
4. Ensure token is a user token, not a bot token

### Channel Not Found

**Error**: `Channel not found: <channel-id>`

**Solutions**:
1. Verify channel ID is correct
2. Ensure your user account has access to the channel
3. Check if channel is a text channel (not voice/DM)

### Rate Limiting

**Error**: `Rate limit exceeded` or frequent errors

**Solutions**:
1. Increase `pollInterval` (e.g., 10000ms instead of 5000ms)
2. Reduce number of concurrent harvesters
3. Wait for rate limit to reset (usually 1 minute)

### Messages Not Appearing

**Symptoms**: Harvester runs but no messages in database

**Solutions**:
1. Check harvester logs for errors
2. Verify channel ID is correct
3. Check if `skipOldMessagesOnStartup` is filtering out all messages
4. Verify database connection is working
5. Check if messages are being filtered by `maxMessageAgeMinutes`

## Differences from App-Bot Harvester

| Feature | App-Bot | Self-Bot |
|---------|---------|----------|
| Authentication | Bot token | User token |
| Token Source | Discord Developer Portal | Browser DevTools |
| Rate Limits | Bot account limits | User account limits (stricter) |
| Permissions | Bot permissions | User account permissions |
| ToS Compliance | ✅ Allowed | ⚠️ Violates ToS |

## Security Best Practices

1. **Never commit tokens**: Use environment variables, add `.env` to `.gitignore`
2. **Rotate tokens**: If token is exposed, change Discord password immediately
3. **Limit access**: Use tokens only on trusted systems
4. **Monitor usage**: Watch for unusual activity on your Discord account
5. **Use separate account**: Consider using a dedicated Discord account for self-bot usage

## Legal Considerations

⚠️ **Discord Terms of Service**: Self-bots violate Discord's Terms of Service. Using self-bots may result in account suspension or termination. Use at your own risk.

The Tigger bot logs warnings about ToS violations when self-bot harvesters are used. Operators are responsible for understanding and accepting these risks.

## Next Steps

After setting up your self-bot harvester:

1. **Monitor logs**: Check that messages are being harvested correctly
2. **Verify parsing**: Ensure your parser can process messages from the self-bot harvester
3. **Test trading**: Run in simulation mode first before live trading
4. **Adjust configuration**: Fine-tune `pollInterval` and other options based on your needs

## Support

For issues or questions:
1. Check logs in `logs/combined.log` and `logs/error.log`
2. Review this quickstart guide
3. Check the main README.md for general troubleshooting
4. Review the specification and implementation plan documents

