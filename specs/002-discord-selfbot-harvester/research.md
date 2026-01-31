# Research: Discord Self-Bot Harvester

**Date**: 2025-01-29  
**Feature**: Discord Self-Bot Harvester  
**Purpose**: Research npm packages and implementation approach for Discord self-bot functionality

## NPM Package Research

### Package Options

#### Option 1: discord.js-selfbot-v13
- **Package**: `discord.js-selfbot-v13` (or `@discordjs-selfbot-v13/discord.js-selfbot-v13`)
- **Status**: Community-maintained fork of discord.js for self-bot usage
- **API Compatibility**: Similar to discord.js v13 API
- **Pros**: 
  - Familiar API if already using discord.js
  - Active community maintenance
  - Supports user token authentication
- **Cons**: 
  - May lag behind official discord.js updates
  - Violates Discord ToS (not officially supported)
- **Installation**: `npm install discord.js-selfbot-v13`
- **Documentation**: GitHub repository and npm package page

#### Option 2: discord-user-bots
- **Package**: `discord-user-bots`
- **Status**: Alternative self-bot library
- **API Compatibility**: Different API from discord.js
- **Pros**: 
  - Purpose-built for self-bot usage
  - Lightweight
- **Cons**: 
  - Different API requires more adaptation
  - May have less community support
- **Installation**: `npm install discord-user-bots`

#### Option 3: eris (with user token)
- **Package**: `eris`
- **Status**: Low-level Discord API library
- **API Compatibility**: Different from discord.js
- **Pros**: 
  - More control over API calls
  - Supports user tokens
- **Cons**: 
  - More complex API
  - Requires more implementation work
- **Installation**: `npm install eris`

### Recommended Choice

**Selected Package**: `discord.js-selfbot-v13` (or similar discord.js-based self-bot package)

**Rationale**:
1. API similarity to existing `discord.js` usage in `discordHarvester.ts` minimizes adaptation effort
2. Message fetching and event handling patterns will be familiar
3. Can reuse similar code structure from existing Discord harvester
4. Community-maintained packages are more likely to have recent updates

**Alternative Consideration**: If `discord.js-selfbot-v13` is unavailable or incompatible, `eris` provides a fallback option with more manual implementation required.

## Implementation Approach

### Authentication Pattern

Self-bot packages typically authenticate using:
```typescript
const client = new Client({
  // User token instead of bot token
});

await client.login(userToken);
```

### Message Fetching Pattern

Similar to discord.js:
```typescript
const channel = await client.channels.fetch(channelId);
const messages = await channel.messages.fetch({ limit: 100, after: lastMessageId });
```

### Key Differences from App-Bot

1. **Authentication**: User token instead of bot token
2. **Rate Limits**: May have different rate limits (typically stricter for user accounts)
3. **Permissions**: User account permissions instead of bot permissions
4. **API Endpoints**: Some endpoints may differ or be unavailable

## Integration Points

### Existing Code Reuse

- **Database Operations**: Reuse existing `DatabaseManager` methods
- **Image Downloader**: Reuse `downloadMessageImages` utility
- **Logger**: Reuse existing Winston logger
- **Message Processing**: Reuse message parsing and storage logic
- **Configuration**: Extend `HarvesterConfig` interface

### New Components Required

1. **Self-Bot Client Wrapper**: New file `src/harvesters/discordSelfBotHarvester.ts`
2. **Configuration Extension**: Update `src/types/config.ts` to support `platform: "discord-selfbot"` and `envVarNames.userToken`
3. **Orchestrator Update**: Update `src/orchestrator/tradeOrchestrator.ts` to route `discord-selfbot` platform

## Risk Assessment

### Technical Risks

1. **Package Maintenance**: Self-bot packages may become unmaintained if Discord changes APIs
   - **Mitigation**: Select package with recent updates, implement graceful error handling
   
2. **API Compatibility**: Self-bot package API may differ from discord.js
   - **Mitigation**: Abstract common operations into shared utilities where possible
   
3. **Rate Limiting**: User accounts may have stricter rate limits
   - **Mitigation**: Implement conservative polling intervals, exponential backoff

### Operational Risks

1. **Discord ToS Violation**: Self-bots violate Discord's Terms of Service
   - **Mitigation**: Document clearly, log warnings, operators use at own risk
   
2. **Account Security**: User tokens provide full account access
   - **Mitigation**: Require environment variables, never commit tokens, document security practices

## Testing Strategy

### Unit Tests
- Authentication with valid/invalid tokens
- Message fetching and parsing
- Configuration validation
- Error handling (rate limits, permission errors)

### Integration Tests
- End-to-end message harvesting flow
- Database storage verification
- Image download functionality
- Message edit detection

### Manual Testing
- Real Discord channel access
- Rate limit handling
- Long-running harvester stability

## Dependencies

### New Dependencies
- `discord.js-selfbot-v13` (or selected package): ~2-5 MB

### Existing Dependencies (No Changes)
- `discord.js`: Already installed, but self-bot package will be separate
- `winston`: Logging
- `better-sqlite3`: Database
- `zod`: Configuration validation (if needed)

## Next Steps

1. Install selected npm package
2. Create proof-of-concept connection test
3. Verify message fetching API compatibility
4. Implement harvester following existing patterns
5. Add configuration support
6. Integrate with orchestrator

