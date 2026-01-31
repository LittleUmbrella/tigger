# Feature Specification: Discord Sourcing Feature Parity

**Feature Branch**: `001-discord-sourcing-parity`  
**Created**: 2025-01-29  
**Status**: Draft  
**Input**: User description: "Enhance Discord signal sourcing to achieve feature parity with Telegram harvesting, ensuring all Telegram capabilities are available for Discord channels"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Skip Old Messages on Startup (Priority: P1)

As a bot operator, I want Discord harvesters to skip processing old messages on startup, so that the bot doesn't waste time and resources processing stale trading signals that are no longer relevant.

**Why this priority**: This is a critical performance and resource optimization feature. Processing old messages on every startup can cause delays in processing new signals and wastes database operations. Telegram already has this capability, so Discord should match it.

**Independent Test**: Can be fully tested by configuring a Discord harvester with `skipOldMessagesOnStartup: true` and `maxMessageAgeMinutes: 10`, then verifying that messages older than 10 minutes are skipped on startup while newer messages are processed normally.

**Acceptance Scenarios**:

1. **Given** a Discord harvester is configured with `skipOldMessagesOnStartup: true` and `maxMessageAgeMinutes: 10`, **When** the harvester starts up and finds messages older than 10 minutes, **Then** those old messages are skipped and not inserted into the database
2. **Given** a Discord harvester is configured with `skipOldMessagesOnStartup: true` and `maxMessageAgeMinutes: 10`, **When** the harvester starts up and finds messages newer than 10 minutes, **Then** those messages are processed and inserted into the database
3. **Given** a Discord harvester is configured with `skipOldMessagesOnStartup: false`, **When** the harvester starts up, **Then** all messages are processed regardless of age
4. **Given** a Discord harvester is configured without `skipOldMessagesOnStartup` (default), **When** the harvester starts up, **Then** old messages exceeding `maxMessageAgeMinutes` (default 10) are skipped

---

### User Story 2 - Configurable Message Age Filtering (Priority: P1)

As a bot operator, I want to configure the maximum age of messages that Discord harvesters process on startup, so that I can control how far back the bot looks for trading signals based on my strategy needs.

**Why this priority**: Different trading strategies require different time windows. Some operators want to process only very recent signals (minutes), while others may want to catch up on signals from the past hour. This flexibility is essential and already exists for Telegram.

**Independent Test**: Can be fully tested by configuring Discord harvesters with different `maxMessageAgeMinutes` values (5, 30, 60) and verifying that only messages within the specified age window are processed.

**Acceptance Scenarios**:

1. **Given** a Discord harvester is configured with `maxMessageAgeMinutes: 5`, **When** the harvester starts up, **Then** only messages from the last 5 minutes are processed
2. **Given** a Discord harvester is configured with `maxMessageAgeMinutes: 60`, **When** the harvester starts up, **Then** messages up to 60 minutes old are processed
3. **Given** a Discord harvester is configured without `maxMessageAgeMinutes`, **When** the harvester starts up, **Then** the default value of 10 minutes is used
4. **Given** a Discord harvester processes messages during runtime (not startup), **When** new messages arrive, **Then** the `maxMessageAgeMinutes` filter does not apply (only applies to startup catch-up)

---

### User Story 3 - Consistent Configuration Interface (Priority: P2)

As a bot operator, I want Discord harvesters to support the same configuration options as Telegram harvesters, so that I can use a consistent configuration approach regardless of the platform I'm sourcing signals from.

**Why this priority**: Consistency reduces cognitive load and makes the system easier to operate. Operators shouldn't need to remember different configuration options for different platforms.

**Independent Test**: Can be fully tested by creating equivalent Telegram and Discord harvester configurations and verifying that both support the same configuration options and behave consistently.

**Acceptance Scenarios**:

1. **Given** a configuration file with both Telegram and Discord harvesters, **When** both harvesters use the same `skipOldMessagesOnStartup` and `maxMessageAgeMinutes` values, **Then** both behave identically in terms of message age filtering
2. **Given** a Discord harvester configuration, **When** I specify `skipOldMessagesOnStartup` and `maxMessageAgeMinutes` options, **Then** the configuration is accepted without errors and the options are respected
3. **Given** the HarvesterConfig interface, **When** I examine the TypeScript types, **Then** Discord harvesters are documented as supporting the same options as Telegram harvesters

---

### Edge Cases

- What happens when `maxMessageAgeMinutes` is set to 0? (Should process only messages from the current moment)
- What happens when `maxMessageAgeMinutes` is set to a very large number (e.g., 10080 for a week)? (Should process messages up to that age)
- What happens when Discord API returns messages out of chronological order? (Should still filter correctly based on message timestamp)
- How does the system handle timezone differences between Discord message timestamps and system time? (Should use UTC consistently)
- What happens when a Discord harvester restarts multiple times quickly? (Should not reprocess messages that were already skipped)
- What happens when `skipOldMessagesOnStartup` is true but there are no existing messages in the database? (Should process all messages up to maxMessageAgeMinutes)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Discord harvesters MUST support the `skipOldMessagesOnStartup` configuration option with the same behavior as Telegram harvesters
- **FR-002**: Discord harvesters MUST support the `maxMessageAgeMinutes` configuration option with the same behavior as Telegram harvesters  
- **FR-003**: Discord harvesters MUST skip messages older than `maxMessageAgeMinutes` when `skipOldMessagesOnStartup` is true (default)
- **FR-004**: Discord harvesters MUST process all messages regardless of age when `skipOldMessagesOnStartup` is false
- **FR-005**: Discord harvesters MUST use a default value of 10 minutes for `maxMessageAgeMinutes` when not specified
- **FR-006**: Discord harvesters MUST use a default value of true for `skipOldMessagesOnStartup` when not specified
- **FR-007**: Discord harvesters MUST apply message age filtering only during startup catch-up, not during runtime message processing
- **FR-008**: Discord harvesters MUST log when messages are skipped due to age filtering with appropriate log levels (debug for individual skips, info for summary)
- **FR-009**: The implementation MUST maintain backward compatibility - existing Discord harvester configurations without these options MUST continue to work
- **FR-010**: The implementation MUST handle Discord message timestamps correctly, accounting for Discord's snowflake ID timestamp extraction

### Key Entities

- **Discord Harvester**: The component responsible for polling Discord channels and storing messages. Must respect age filtering configuration.
- **Harvester Configuration**: The configuration object that specifies harvester behavior, including `skipOldMessagesOnStartup` and `maxMessageAgeMinutes` options.
- **Message Age**: The time difference between the current time and the Discord message timestamp, calculated from the message's snowflake ID or creation date.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Discord harvesters process startup messages with the same age filtering behavior as Telegram harvesters (100% parity)
- **SC-002**: Configuration options `skipOldMessagesOnStartup` and `maxMessageAgeMinutes` work identically for both Telegram and Discord harvesters
- **SC-003**: Discord harvesters skip old messages on startup when configured, reducing unnecessary database operations by at least 50% for channels with historical messages
- **SC-004**: Operators can configure Discord harvesters using the same configuration pattern as Telegram harvesters without platform-specific knowledge
- **SC-005**: All existing Discord harvester configurations continue to work without modification (100% backward compatibility)

## Assumptions

- Discord message timestamps can be reliably extracted from message objects (either from `createdTimestamp` property or from snowflake ID)
- The `skipOldMessagesOnStartup` and `maxMessageAgeMinutes` options are already defined in the `HarvesterConfig` TypeScript interface and accepted by the configuration system
- Message age filtering should only apply during the initial startup catch-up phase, not during ongoing real-time message processing
- The default behavior (skip old messages, 10 minute window) matches Telegram harvester defaults

## Dependencies

- Existing `HarvesterConfig` interface already includes `skipOldMessagesOnStartup` and `maxMessageAgeMinutes` options
- Discord.js library provides message timestamps via `createdTimestamp` property
- Database schema already supports message storage (no schema changes needed)
- Logger utility is available for logging skipped messages

## Out of Scope

- Changes to Telegram harvester implementation (already has these features)
- Changes to database schema
- Changes to parser or other downstream components
- Real-time message age filtering during runtime (only startup filtering is in scope)
- Performance optimizations beyond the age filtering feature itself
