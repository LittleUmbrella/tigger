# Implementation Plan: Discord Self-Bot Harvester

**Branch**: `002-discord-selfbot-harvester` | **Date**: 2025-01-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-discord-selfbot-harvester/spec.md`

## Summary

Implement a Discord self-bot harvester that uses a user account token instead of a bot token, providing an alternative to the existing app-bot harvester. The implementation will use an npm package (discord.js-selfbot-v13 or similar) and maintain feature parity with the existing Discord app-bot harvester while following the project's functional programming patterns and safety-first principles.

## Technical Context

**Language/Version**: TypeScript 5.5+  
**Primary Dependencies**: discord.js-selfbot-v13 (or similar), discord.js (existing), winston (existing), better-sqlite3 (existing)  
**Storage**: SQLite/PostgreSQL (existing schema, no changes)  
**Testing**: Vitest (existing test framework)  
**Target Platform**: Node.js 20+ (Linux server, Docker)  
**Project Type**: Single Node.js application  
**Performance Goals**: Process messages within 5 seconds of arrival, handle 100+ messages per channel per minute  
**Constraints**: Must handle rate limiting gracefully, respect Discord API limits, maintain <100MB memory per harvester instance  
**Scale/Scope**: Support multiple concurrent self-bot harvesters, handle 10+ channels simultaneously

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Safety-First Trading Operations
✅ **PASS**: This feature does not interact with financial exchanges or execute trades. It only harvests messages, which are inputs to the trading system. Safety mechanisms apply to message validation and error handling.

### II. Functional & Declarative Programming
✅ **PASS**: Implementation will follow existing harvester patterns:
- Pure functions for message processing
- Module-level state management (similar to `discordHarvester.ts`)
- No classes, functional composition
- Side effects isolated (database writes, API calls)

### III. Comprehensive Error Handling & Observability
✅ **PASS**: Will implement:
- Retry logic with exponential backoff for API calls
- Comprehensive logging with Winston
- Error context preservation (channel, message IDs, timestamps)
- Graceful degradation on failures

### IV. Test-Driven Development
✅ **PASS**: Will create:
- Unit tests for authentication, message fetching, parsing
- Integration tests for end-to-end harvesting flow
- Tests for error scenarios (rate limits, invalid tokens, permission errors)

### V. Configuration-Driven Architecture
✅ **PASS**: Extends existing `HarvesterConfig` interface:
- New platform type: `"discord-selfbot"`
- User token via `envVarNames.userToken`
- All existing config options supported (pollInterval, downloadImages, etc.)

### VI. Database Integrity & Transaction Safety
✅ **PASS**: Uses existing database schema:
- Same message storage format as app-bot harvester
- Transaction support for multi-step operations
- No schema changes required

### VII. API Integration Resilience
✅ **PASS**: Will implement:
- Rate limiting respect (conservative polling)
- Exponential backoff retry logic
- API response validation
- Connection pooling and timeouts

## Project Structure

### Documentation (this feature)

```text
specs/002-discord-selfbot-harvester/
├── plan.md              # This file
├── research.md          # NPM package research and selection
├── data-model.md        # Data structures and interfaces
├── quickstart.md        # Setup and usage guide
└── spec.md             # Feature specification
```

### Source Code (repository root)

```text
src/
├── harvesters/
│   ├── discordHarvester.ts          # Existing app-bot harvester (unchanged)
│   ├── discordSelfBotHarvester.ts   # NEW: Self-bot harvester implementation
│   ├── signalHarvester.ts           # Existing Telegram harvester
│   └── csvHarvester.ts              # Existing CSV harvester
├── types/
│   └── config.ts                    # MODIFY: Extend HarvesterConfig interface
├── orchestrator/
│   └── tradeOrchestrator.ts         # MODIFY: Add discord-selfbot platform routing
└── utils/
    ├── logger.ts                    # Existing (reuse)
    └── imageDownloader.ts           # Existing (reuse)

tests/
└── harvesters/
    └── discordSelfBotHarvester.test.ts  # NEW: Unit and integration tests
```

**Structure Decision**: Single project structure maintained. New harvester file follows existing pattern. Configuration and orchestrator updates are minimal and localized.

## Complexity Tracking

> **No Constitution violations identified. Implementation follows existing patterns.**

## Implementation Phases

### Phase 0: Research & Setup (Complete)
- ✅ Research npm packages for Discord self-bot functionality
- ✅ Select package: `discord.js-selfbot-v13` (or similar)
- ✅ Document package selection rationale
- ✅ Identify integration points with existing codebase

### Phase 1: Core Implementation

#### 1.1 Configuration Extension
- Extend `HarvesterConfig` interface in `src/types/config.ts`:
  - Add `"discord-selfbot"` to platform union type
  - Add `envVarNames.userToken?: string` for user token configuration
  - Document new platform type and configuration options

#### 1.2 Self-Bot Harvester Implementation
- Create `src/harvesters/discordSelfBotHarvester.ts`:
  - Implement authentication with user token
  - Implement message fetching (polling mechanism)
  - Implement message storage (reuse database operations)
  - Implement message edit detection and versioning
  - Implement image download support (reuse utility)
  - Implement `skipOldMessagesOnStartup` and `maxMessageAgeMinutes` filtering
  - Implement rate limiting with exponential backoff
  - Follow functional programming patterns (no classes)

#### 1.3 Orchestrator Integration
- Update `src/orchestrator/tradeOrchestrator.ts`:
  - Add `platform === 'discord-selfbot'` routing logic
  - Import and call `startDiscordSelfBotHarvester` function
  - Maintain backward compatibility with existing platforms

### Phase 2: Testing & Validation

#### 2.1 Unit Tests
- Test authentication (valid/invalid tokens)
- Test message fetching logic
- Test message age filtering
- Test rate limiting and retry logic
- Test error handling scenarios

#### 2.2 Integration Tests
- Test end-to-end harvesting flow
- Test database storage compatibility
- Test image download functionality
- Test message edit detection

#### 2.3 Manual Testing
- Test with real Discord channel
- Verify feature parity with app-bot harvester
- Test rate limit handling
- Test long-running stability

### Phase 3: Documentation & Polish

#### 3.1 Code Documentation
- Add JSDoc comments to all exported functions
- Document configuration options
- Document error handling behavior

#### 3.2 User Documentation
- Update README with self-bot harvester configuration examples
- Document user token extraction methods (general guidance)
- Document ToS warnings and security considerations

## Technical Design Decisions

### Package Selection
**Decision**: Use `discord.js-selfbot-v13` or similar discord.js-based package  
**Rationale**: API similarity to existing discord.js usage minimizes adaptation effort

### Code Structure
**Decision**: Create separate `discordSelfBotHarvester.ts` file, not modify existing `discordHarvester.ts`  
**Rationale**: Maintains separation of concerns, allows both harvester types to coexist

### Configuration Approach
**Decision**: Extend existing `HarvesterConfig` interface with new platform type  
**Rationale**: Maintains consistency, allows operators to use same config pattern

### Error Handling
**Decision**: Implement exponential backoff with max retry attempts  
**Rationale**: Aligns with constitution requirement for API integration resilience

### Message Storage
**Decision**: Use same database schema and format as app-bot harvester  
**Rationale**: Ensures parser compatibility, no downstream changes needed

## Dependencies

### New Dependencies
- `discord.js-selfbot-v13` (or selected package): ~2-5 MB

### Existing Dependencies (Reused)
- `discord.js`: Already installed (for reference/comparison)
- `winston`: Logging
- `better-sqlite3`: Database operations
- `zod`: Configuration validation (if needed for new config options)

## Risks & Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Selected npm package becomes unmaintained | High | Medium | Select package with recent updates, implement graceful error handling, document fallback options |
| API compatibility issues between self-bot package and discord.js | Medium | Medium | Abstract common operations, thorough testing, fallback to alternative package if needed |
| Rate limiting stricter than expected | Medium | High | Implement conservative polling intervals, exponential backoff, monitor and adjust |
| User token security breach | High | Low | Require environment variables, never commit tokens, document security best practices |
| Discord ToS violation consequences | High | Low | Document clearly, log warnings, operators use at own risk |

## Success Metrics

- ✅ Self-bot harvesters successfully authenticate (100% success rate for valid tokens)
- ✅ Message collection rate within 5% of app-bot harvester
- ✅ 100% database schema compatibility with app-bot messages
- ✅ All configuration options work identically to app-bot harvester
- ✅ Rate limiting handled gracefully (no crashes, exponential backoff working)
- ✅ Test coverage above 80% for new code

## Next Steps

1. Install selected npm package: `npm install discord.js-selfbot-v13`
2. Create proof-of-concept connection test
3. Implement core harvester functionality
4. Add configuration support
5. Integrate with orchestrator
6. Write tests
7. Update documentation

