# Feature Specification: Discord Self-Bot Harvester

**Feature Branch**: `002-discord-selfbot-harvester`  
**Created**: 2025-01-29  
**Status**: Draft  
**Input**: User description: "Create a Discord self-bot harvester that uses a user account token instead of a bot token, relying on an npm package for Discord self-bot functionality"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Self-Bot Authentication and Connection (Priority: P1)

As a bot operator, I want to configure a Discord harvester that uses a user account token (self-bot) instead of a bot token, so that I can access Discord channels that require user account permissions or when bot access is not available.

**Why this priority**: This is the foundational capability that differentiates the self-bot harvester from the app-bot harvester. Without proper authentication, the harvester cannot function.

**Independent Test**: Can be fully tested by configuring a Discord self-bot harvester with a user token, verifying successful connection, and confirming the harvester can access channels the user account has permission to view.

**Acceptance Scenarios**:

1. **Given** a Discord self-bot harvester is configured with `platform: "discord-selfbot"` and a valid user token, **When** the harvester starts, **Then** it successfully connects to Discord using the user account
2. **Given** a Discord self-bot harvester is configured without a user token, **When** the harvester starts, **Then** it fails with a clear error message indicating the user token is required
3. **Given** a Discord self-bot harvester is configured with an invalid user token, **When** the harvester starts, **Then** it fails with an authentication error
4. **Given** a Discord self-bot harvester successfully connects, **When** it attempts to access a channel, **Then** it can only access channels the user account has permission to view (not channels requiring bot permissions)

---

### User Story 2 - Message Harvesting with Self-Bot (Priority: P1)

As a bot operator, I want the Discord self-bot harvester to collect messages from Discord channels using the same polling and storage mechanism as the app-bot harvester, so that I can source signals from Discord regardless of whether I use a bot or user account.

**Why this priority**: Message harvesting is the core functionality. The self-bot harvester must provide the same message collection capabilities as the app-bot harvester to be useful.

**Independent Test**: Can be fully tested by running a self-bot harvester on a Discord channel and verifying that messages are collected, stored in the database, and follow the same data structure as messages from the app-bot harvester.

**Acceptance Scenarios**:

1. **Given** a Discord self-bot harvester is running on a channel, **When** new messages are posted, **Then** those messages are collected and stored in the database
2. **Given** a Discord self-bot harvester is running, **When** messages are edited, **Then** the edits are detected and stored in the message_versions table (same as app-bot)
3. **Given** a Discord self-bot harvester processes messages, **When** messages are stored, **Then** they use the same database schema and format as app-bot messages (ensuring parser compatibility)
4. **Given** a Discord self-bot harvester is configured with `pollInterval`, **When** it runs, **Then** it polls for new messages at the specified interval

---

### User Story 3 - Configuration Interface Consistency (Priority: P2)

As a bot operator, I want the Discord self-bot harvester to support the same configuration options as the app-bot harvester (except authentication), so that I can use a consistent configuration approach and easily switch between bot and self-bot implementations.

**Why this priority**: Consistency reduces cognitive load and makes the system easier to operate. Operators should be able to use similar configurations for both harvester types.

**Independent Test**: Can be fully tested by creating equivalent app-bot and self-bot harvester configurations and verifying that both support the same options (pollInterval, downloadImages, skipOldMessagesOnStartup, maxMessageAgeMinutes) except for the authentication method.

**Acceptance Scenarios**:

1. **Given** a configuration file with both app-bot and self-bot Discord harvesters, **When** both harvesters use the same `pollInterval`, `downloadImages`, `skipOldMessagesOnStartup`, and `maxMessageAgeMinutes` values, **Then** both behave identically in terms of message processing (except authentication)
2. **Given** a Discord self-bot harvester configuration, **When** I specify `skipOldMessagesOnStartup` and `maxMessageAgeMinutes` options, **Then** the configuration is accepted and the options are respected (same as app-bot)
3. **Given** the HarvesterConfig interface, **When** I examine the TypeScript types, **Then** self-bot harvesters are documented as supporting the same options as app-bot harvesters (except userToken vs botToken)

---

### User Story 4 - Image Download Support (Priority: P2)

As a bot operator, I want the Discord self-bot harvester to support downloading images from messages when configured, so that I can capture visual trading signals (charts, screenshots) from Discord channels.

**Why this priority**: Many trading signals include images. This feature parity ensures operators can capture the same information regardless of harvester type.

**Independent Test**: Can be fully tested by configuring a self-bot harvester with `downloadImages: true` and verifying that images from messages are downloaded and their paths stored in the database.

**Acceptance Scenarios**:

1. **Given** a Discord self-bot harvester is configured with `downloadImages: true`, **When** a message contains image attachments, **Then** those images are downloaded and their paths stored in the database
2. **Given** a Discord self-bot harvester is configured with `downloadImages: false` (default), **When** messages contain images, **Then** images are not downloaded but message content is still stored
3. **Given** image download fails for a message, **When** the harvester processes the message, **Then** the message content is still stored and a warning is logged (non-blocking error)

---

### Edge Cases

- What happens when the user account token expires or becomes invalid? (Should log error and stop gracefully)
- What happens when the user account is rate-limited by Discord? (Should implement exponential backoff retry logic)
- What happens when the user account doesn't have permission to access a channel? (Should log error and fail gracefully)
- What happens when Discord's API changes and the self-bot npm package becomes incompatible? (Should handle errors gracefully and log warnings)
- How does the system handle multiple self-bot harvesters using the same user account? (Should support multiple harvesters with same token, similar to Telegram client sharing)
- What happens when a self-bot harvester and app-bot harvester are configured for the same channel? (Should work independently, may result in duplicate messages)
- What happens when the self-bot npm package is not installed? (Should fail at startup with clear error message)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST support a new harvester platform type `"discord-selfbot"` in addition to existing `"discord"` platform type
- **FR-002**: Discord self-bot harvesters MUST authenticate using a user account token instead of a bot token
- **FR-003**: Discord self-bot harvesters MUST use an npm package for Discord self-bot functionality (e.g., `discord.js-selfbot-v13` or similar)
- **FR-004**: Discord self-bot harvesters MUST support user token configuration via `envVarNames.userToken` in HarvesterConfig
- **FR-005**: Discord self-bot harvesters MUST fall back to `DISCORD_USER_TOKEN` environment variable if `envVarNames.userToken` is not specified
- **FR-006**: Discord self-bot harvesters MUST collect messages from Discord channels using the same polling mechanism as app-bot harvesters
- **FR-007**: Discord self-bot harvesters MUST store messages in the same database schema and format as app-bot harvesters
- **FR-008**: Discord self-bot harvesters MUST support all configuration options available to app-bot harvesters: `pollInterval`, `downloadImages`, `skipOldMessagesOnStartup`, `maxMessageAgeMinutes`
- **FR-009**: Discord self-bot harvesters MUST detect and handle message edits, storing versions in the message_versions table (same as app-bot)
- **FR-010**: Discord self-bot harvesters MUST support image downloading when `downloadImages: true` is configured
- **FR-011**: Discord self-bot harvesters MUST handle rate limiting with exponential backoff retry logic
- **FR-012**: Discord self-bot harvesters MUST log authentication failures with clear error messages
- **FR-013**: Discord self-bot harvesters MUST gracefully handle cases where the user account lacks permission to access a channel
- **FR-014**: The implementation MUST maintain backward compatibility - existing Discord app-bot harvester configurations MUST continue to work unchanged
- **FR-015**: The orchestrator MUST support both `platform: "discord"` (app-bot) and `platform: "discord-selfbot"` (self-bot) harvester types

### Key Entities

- **Discord Self-Bot Harvester**: A new harvester component that uses a user account token to access Discord channels, implemented using a self-bot npm package
- **User Token**: A Discord user account authentication token (different from bot token) used to authenticate self-bot connections
- **Harvester Configuration**: Extended to support `platform: "discord-selfbot"` and `envVarNames.userToken` for user token specification
- **Self-Bot Client**: The npm package client instance that manages the Discord user account connection and message polling

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Discord self-bot harvesters successfully connect and authenticate using user tokens (100% success rate for valid tokens)
- **SC-002**: Discord self-bot harvesters collect messages with the same reliability as app-bot harvesters (within 5% message collection rate)
- **SC-003**: Messages collected by self-bot harvesters are stored in the same database format as app-bot messages (100% schema compatibility)
- **SC-004**: Self-bot harvesters support all configuration options available to app-bot harvesters (100% feature parity except authentication method)
- **SC-005**: Operators can configure self-bot harvesters using the same configuration pattern as app-bot harvesters (same config structure, different platform value)
- **SC-006**: Self-bot harvesters handle rate limiting gracefully without crashing (exponential backoff implemented, max retry attempts respected)

## Assumptions

- A suitable npm package exists for Discord self-bot functionality (e.g., `discord.js-selfbot-v13` or similar)
- User tokens can be obtained by operators (extraction from browser DevTools or other methods)
- The self-bot npm package provides similar API to discord.js for message fetching and event handling
- Message structure and content are identical between app-bot and self-bot access methods
- The database schema does not need changes (same message storage format)
- Self-bot and app-bot harvesters can coexist in the same configuration without conflicts
- Rate limiting behavior is similar between bot and user account access (may need adjustment based on actual API behavior)

## Dependencies

- npm package for Discord self-bot functionality (to be selected during implementation)
- Existing database schema (no changes needed)
- Existing logger utility
- Existing image downloader utility (if downloadImages is enabled)
- HarvesterConfig interface extension to support `platform: "discord-selfbot"` and `envVarNames.userToken`
- Orchestrator updates to route `discord-selfbot` platform to the new harvester implementation

## Out of Scope

- Changes to existing Discord app-bot harvester (remains unchanged)
- Changes to database schema
- Changes to parser or other downstream components (they work with messages regardless of source)
- User token extraction/obtainment methods (operators are responsible for providing tokens)
- Handling Discord Terms of Service violations (operators use at their own risk)
- Support for multiple self-bot packages (one package will be selected and used)
- Real-time WebSocket events (initial implementation focuses on polling, may add later)

## Risks and Considerations

- **Discord Terms of Service**: Self-bots violate Discord's ToS. Operators use this at their own risk. The system should log warnings about this.
- **Package Maintenance**: Self-bot npm packages may be less maintained than official discord.js. Need to select a stable, maintained package.
- **API Stability**: Discord may change APIs that break self-bot packages. Implementation should handle errors gracefully.
- **Rate Limiting**: User accounts may have different rate limits than bot accounts. Implementation should be conservative with request rates.
- **Account Security**: User tokens provide full account access. Operators must secure tokens carefully (use environment variables, never commit to git).

## Notes

- The specific npm package to use will be determined during implementation research. Common options include `discord.js-selfbot-v13`, `discord-user-bots`, or similar packages.
- This feature provides an alternative to app-bot harvesters for cases where bot access is not available or user account access is preferred.
- The implementation should follow the same functional programming patterns as existing harvesters (no classes, pure functions where possible).
