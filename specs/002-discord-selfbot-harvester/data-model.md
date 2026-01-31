# Data Model: Discord Self-Bot Harvester

**Date**: 2025-01-29  
**Feature**: Discord Self-Bot Harvester

## Configuration Data Structures

### Extended HarvesterConfig Interface

```typescript
export interface HarvesterConfig {
  name: string;
  channel: string;
  platform?: 'telegram' | 'discord' | 'discord-selfbot'; // NEW: Added 'discord-selfbot'
  
  // ... existing Telegram fields ...
  
  envVarNames?: {
    // ... existing fields ...
    botToken?: string; // For app-bot
    userToken?: string; // NEW: For self-bot
  };
  
  // ... existing configuration options ...
  pollInterval?: number;
  downloadImages?: boolean;
  skipOldMessagesOnStartup?: boolean;
  maxMessageAgeMinutes?: number;
}
```

### Configuration Example

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
  ]
}
```

## Runtime Data Structures

### Self-Bot Client State

```typescript
interface SelfBotHarvesterState {
  client: SelfBotClient; // From npm package
  running: boolean;
  lastMessageId: string | null;
  channel?: TextChannel; // Or equivalent from self-bot package
}
```

### Message Data Structure

**No changes** - Uses same structure as app-bot harvester:

```typescript
interface MessageData {
  message_id: number; // Hashed Discord snowflake ID
  channel: string; // Channel ID
  content: string; // Message text
  sender: string; // User ID
  date: string; // ISO timestamp
  reply_to_message_id?: number; // Optional reply reference
  image_paths?: string; // JSON array of image URLs/paths
}
```

### Database Schema

**No changes** - Uses existing schema:

- `messages` table: Stores harvested messages
- `message_versions` table: Stores message edit history

## API Contracts

### Harvester Function Signature

```typescript
export const startDiscordSelfBotHarvester = async (
  config: HarvesterConfig,
  db: DatabaseManager
): Promise<() => Promise<void>>
```

**Input**:
- `config`: HarvesterConfig with `platform: "discord-selfbot"` and user token configured
- `db`: DatabaseManager instance for message storage

**Output**:
- Promise resolving to stop function that gracefully shuts down the harvester

**Errors**:
- Throws if user token is missing or invalid
- Throws if channel cannot be accessed
- Logs and continues on message processing errors (non-fatal)

### Internal Function Signatures

```typescript
// Authentication
const connectSelfBot = async (
  config: HarvesterConfig,
  client: SelfBotClient
): Promise<void>

// Channel resolution
const resolveChannel = async (
  config: HarvesterConfig,
  client: SelfBotClient
): Promise<TextChannel>

// Message fetching
const fetchNewMessages = async (
  config: HarvesterConfig,
  channel: TextChannel,
  db: DatabaseManager,
  lastMessageId: string | null
): Promise<string | null>

// Message age filtering (startup)
const shouldSkipMessage = (
  messageDate: Date,
  config: HarvesterConfig
): boolean
```

## Data Flow

### Message Harvesting Flow

```
1. Harvester starts
   ↓
2. Authenticate with user token
   ↓
3. Resolve Discord channel
   ↓
4. Initialize lastMessageId from database (if exists)
   ↓
5. Apply skipOldMessagesOnStartup filter (if enabled)
   ↓
6. Poll loop:
   - Fetch new messages from channel
   - Filter by maxMessageAgeMinutes (startup only)
   - Process each message:
     * Extract content, sender, timestamp
     * Handle reply references
     * Download images (if enabled)
     * Store in database
   - Update lastMessageId
   - Wait pollInterval
   ↓
7. Listen for message edits (event handler)
   ↓
8. Store edits in message_versions table
```

### Error Handling Flow

```
API Error (rate limit, network, etc.)
   ↓
Log error with context
   ↓
Exponential backoff retry
   ↓
Max retries exceeded?
   ↓
Yes → Log fatal error, continue polling (don't crash)
No → Retry with backoff
```

## State Management

### Module-Level State (Functional Pattern)

Similar to existing `discordHarvester.ts`:

```typescript
// No global state - each harvester instance manages its own state
// State is encapsulated in the returned stop function closure
```

### Client Instance Management

- Each harvester creates its own client instance
- Client is destroyed when harvester stops
- No client sharing (unlike Telegram which shares clients by session)

## Configuration Validation

### Required Fields
- `name`: Unique harvester name
- `channel`: Discord channel ID
- `platform`: Must be `"discord-selfbot"`
- User token: Must be provided via `envVarNames.userToken` or `DISCORD_USER_TOKEN` env var

### Optional Fields
- `pollInterval`: Default 5000ms
- `downloadImages`: Default false
- `skipOldMessagesOnStartup`: Default true
- `maxMessageAgeMinutes`: Default 10 minutes

### Validation Rules
- User token must be non-empty string
- Channel ID must be valid Discord snowflake format
- pollInterval must be positive number
- maxMessageAgeMinutes must be non-negative number

## Database Operations

### Message Insertion

```typescript
await db.insertMessage({
  message_id: hashDiscordId(messageId),
  channel: config.channel,
  content: messageContent,
  sender: messageAuthorId,
  date: messageCreatedAt.toISOString(),
  reply_to_message_id: replyToId,
  image_paths: imagePaths.length > 0 ? JSON.stringify(imagePaths) : undefined
});
```

### Message Update (Edit)

```typescript
// Store previous version
await db.insertMessageVersion(messageIdNum, config.channel, oldContent);

// Update message
await db.updateMessage(messageIdNum, config.channel, {
  content: newContent,
  edited_at: new Date().toISOString(),
  parsed: false // Mark for re-parsing
});
```

## Type Definitions

### Self-Bot Package Types

```typescript
// These will depend on the selected npm package
// Example for discord.js-selfbot-v13:
import { Client as SelfBotClient } from 'discord.js-selfbot-v13';
import { TextChannel, Message } from 'discord.js-selfbot-v13';
```

### Internal Types

```typescript
interface SelfBotHarvesterConfig extends HarvesterConfig {
  platform: 'discord-selfbot';
  envVarNames: {
    userToken: string;
  };
}
```

## Data Transformations

### Discord ID to Database ID

```typescript
// Same hash function as app-bot harvester
const hashDiscordId = (discordId: string): number => {
  const id = BigInt(discordId);
  const maxSafeInt = BigInt(9007199254740991);
  const hashed = Number(id % maxSafeInt);
  return Math.abs(hashed);
};
```

### Message Content Normalization

```typescript
// Same as app-bot harvester
const normalizedContent = messageContent.replace(/\s+/g, ' ').trim();
```

### Image Path Extraction

```typescript
// Same as app-bot harvester
const imagePaths = attachments
  .filter(att => att.contentType?.startsWith('image/'))
  .map(att => att.url);
```

