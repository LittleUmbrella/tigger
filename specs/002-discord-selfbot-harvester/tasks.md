# Tasks: Discord Self-Bot Harvester

**Input**: Design documents from `/specs/002-discord-selfbot-harvester/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅

**Tests**: Tests are included per constitution requirement (Test-Driven Development)

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and dependency installation

- [ ] T001 Install npm package `discord.js-selfbot-v13` (or selected alternative) in package.json
- [ ] T002 [P] Verify package installation and TypeScript compatibility

**Checkpoint**: Dependencies installed and verified

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 Extend `HarvesterConfig` interface in `src/types/config.ts`:
  - Add `"discord-selfbot"` to platform union type (`platform?: 'telegram' | 'discord' | 'discord-selfbot'`)
  - Add `envVarNames.userToken?: string` for user token configuration
  - Add JSDoc comments documenting the new platform type and userToken option
- [ ] T004 [P] Create base file structure `src/harvesters/discordSelfBotHarvester.ts` with exports and basic structure
- [ ] T005 [P] Create test file structure `tests/harvesters/discordSelfBotHarvester.test.ts` with test framework setup

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Self-Bot Authentication and Connection (Priority: P1) 🎯 MVP

**Goal**: Implement Discord self-bot authentication using user account token, enabling harvester to connect to Discord

**Independent Test**: Configure a Discord self-bot harvester with a user token, verify successful connection, and confirm the harvester can access channels the user account has permission to view.

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T006 [P] [US1] Unit test for authentication with valid user token in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T007 [P] [US1] Unit test for authentication failure with missing token in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T008 [P] [US1] Unit test for authentication failure with invalid token in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T009 [P] [US1] Unit test for channel resolution in `tests/harvesters/discordSelfBotHarvester.test.ts`

### Implementation for User Story 1

- [ ] T010 [US1] Implement `connectSelfBot` function in `src/harvesters/discordSelfBotHarvester.ts`:
  - Extract user token from `envVarNames.userToken` or `DISCORD_USER_TOKEN` env var
  - Initialize self-bot client from npm package
  - Authenticate with user token
  - Log connection success with user account info
  - Handle authentication errors with clear error messages
- [ ] T011 [US1] Implement `resolveChannel` function in `src/harvesters/discordSelfBotHarvester.ts`:
  - Handle channel ID and channel mention format (`<#123456789>`)
  - Fetch channel using self-bot client
  - Validate channel is text-based (not voice/DM)
  - Return TextChannel or equivalent
  - Handle channel not found errors gracefully
- [ ] T012 [US1] Add error handling and logging for authentication failures in `src/harvesters/discordSelfBotHarvester.ts`:
  - Log clear error messages for missing/invalid tokens
  - Log permission errors when channel access is denied
  - Use Winston logger with appropriate log levels

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently - harvester can authenticate and resolve channels

---

## Phase 4: User Story 2 - Message Harvesting with Self-Bot (Priority: P1)

**Goal**: Implement message collection from Discord channels using polling mechanism, storing messages in the same database format as app-bot harvester

**Independent Test**: Run a self-bot harvester on a Discord channel and verify that messages are collected, stored in the database, and follow the same data structure as messages from the app-bot harvester.

### Tests for User Story 2 ⚠️

- [ ] T013 [P] [US2] Unit test for message fetching logic in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T014 [P] [US2] Unit test for message storage in database in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T015 [P] [US2] Integration test for end-to-end message harvesting flow in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T016 [P] [US2] Unit test for message edit detection in `tests/harvesters/discordSelfBotHarvester.test.ts`

### Implementation for User Story 2

- [ ] T017 [US2] Implement `hashDiscordId` function in `src/harvesters/discordSelfBotHarvester.ts`:
  - Reuse same hash function from `discordHarvester.ts` for consistency
  - Convert Discord snowflake ID (string) to safe integer for database storage
- [ ] T018 [US2] Implement `fetchNewMessages` function in `src/harvesters/discordSelfBotHarvester.ts`:
  - Fetch messages from channel using self-bot client API
  - Handle pagination (Discord API limit is 100 per request)
  - Process messages oldest-first (reverse if needed)
  - Extract message content, sender, timestamp, reply references
  - Convert message IDs using `hashDiscordId`
  - Store messages in database using `db.insertMessage`
  - Handle duplicate messages (UNIQUE constraint errors)
  - Return new lastMessageId
- [ ] T019 [US2] Implement message edit detection in `src/harvesters/discordSelfBotHarvester.ts`:
  - Set up event handler for message updates (similar to app-bot)
  - Detect when messages are edited
  - Store previous version in `message_versions` table using `db.insertMessageVersion`
  - Update message content using `db.updateMessage`
  - Mark message as unparsed (`parsed: false`) to trigger re-processing
- [ ] T020 [US2] Implement polling loop in `startDiscordSelfBotHarvester` function in `src/harvesters/discordSelfBotHarvester.ts`:
  - Initialize lastMessageId from database (if existing messages)
  - Create polling loop with configurable `pollInterval`
  - Call `fetchNewMessages` in loop
  - Handle errors gracefully (log and continue, don't crash)
  - Implement exponential backoff on errors
- [ ] T021 [US2] Implement `startDiscordSelfBotHarvester` main function in `src/harvesters/discordSelfBotHarvester.ts`:
  - Call `connectSelfBot` to authenticate
  - Call `resolveChannel` to get channel
  - Initialize lastMessageId from database
  - Set up message edit event handler
  - Start polling loop
  - Return stop function that gracefully shuts down harvester

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently - harvester can authenticate, connect, and collect messages

---

## Phase 5: User Story 3 - Configuration Interface Consistency (Priority: P2)

**Goal**: Ensure self-bot harvester supports all configuration options available to app-bot harvester (pollInterval, downloadImages, skipOldMessagesOnStartup, maxMessageAgeMinutes)

**Independent Test**: Create equivalent app-bot and self-bot harvester configurations and verify that both support the same options and behave identically in terms of message processing (except authentication).

### Tests for User Story 3 ⚠️

- [ ] T022 [P] [US3] Unit test for `skipOldMessagesOnStartup` configuration in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T023 [P] [US3] Unit test for `maxMessageAgeMinutes` configuration in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T024 [P] [US3] Unit test for `pollInterval` configuration in `tests/harvesters/discordSelfBotHarvester.test.ts`

### Implementation for User Story 3

- [ ] T025 [US3] Implement `shouldSkipMessage` helper function in `src/harvesters/discordSelfBotHarvester.ts`:
  - Check if message age exceeds `maxMessageAgeMinutes`
  - Only apply during startup (not during runtime polling)
  - Return boolean indicating if message should be skipped
- [ ] T026 [US3] Integrate `skipOldMessagesOnStartup` and `maxMessageAgeMinutes` filtering in `fetchNewMessages` function in `src/harvesters/discordSelfBotHarvester.ts`:
  - Check `skipOldMessagesOnStartup` config (default: true)
  - Apply `maxMessageAgeMinutes` filter only on startup (when lastMessageId is null)
  - Skip messages older than max age
  - Log skipped messages at debug level
- [ ] T027 [US3] Integrate `pollInterval` configuration in polling loop in `src/harvesters/discordSelfBotHarvester.ts`:
  - Use `config.pollInterval` or default to 5000ms
  - Apply interval between polling cycles
  - Use exponential backoff on errors (pollInterval * 2)

**Checkpoint**: At this point, User Stories 1, 2, AND 3 should all work independently - harvester supports all configuration options

---

## Phase 6: User Story 4 - Image Download Support (Priority: P2)

**Goal**: Support downloading images from messages when `downloadImages: true` is configured, storing image paths in database

**Independent Test**: Configure a self-bot harvester with `downloadImages: true` and verify that images from messages are downloaded and their paths stored in the database.

### Tests for User Story 4 ⚠️

- [ ] T028 [P] [US4] Unit test for image download when `downloadImages: true` in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T029 [P] [US4] Unit test for skipping images when `downloadImages: false` in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T030 [P] [US4] Integration test for image download functionality in `tests/harvesters/discordSelfBotHarvester.test.ts`

### Implementation for User Story 4

- [ ] T031 [US4] Integrate image download support in `fetchNewMessages` function in `src/harvesters/discordSelfBotHarvester.ts`:
  - Check `config.downloadImages` flag (default: false)
  - Extract image attachments from messages
  - Filter for image content types (`contentType?.startsWith('image/')`)
  - Reuse `downloadMessageImages` utility from `src/utils/imageDownloader.ts` (if compatible) or implement similar logic
  - Store image URLs/paths in `image_paths` field as JSON string
  - Handle image download errors gracefully (log warning, continue processing message)
  - Ensure message content is still stored even if image download fails

**Checkpoint**: At this point, all user stories should be complete - harvester has full feature parity with app-bot harvester

---

## Phase 7: Orchestrator Integration

**Purpose**: Integrate self-bot harvester with orchestrator to enable configuration-driven usage

- [ ] T032 Update `src/orchestrator/tradeOrchestrator.ts`:
  - Import `startDiscordSelfBotHarvester` from `src/harvesters/discordSelfBotHarvester.ts`
  - Add `platform === 'discord-selfbot'` condition in harvester selection logic (around line 206)
  - Call `startDiscordSelfBotHarvester` when platform is `discord-selfbot`
  - Maintain backward compatibility with existing `discord` and `telegram` platforms
- [ ] T033 [P] Add integration test for orchestrator routing in `tests/orchestrator/tradeOrchestrator.test.ts` (if test file exists)

**Checkpoint**: Self-bot harvester is integrated and can be used via configuration

---

## Phase 8: Rate Limiting & Error Handling

**Purpose**: Implement robust rate limiting and error handling per constitution requirements

- [ ] T034 Implement exponential backoff retry logic in `src/harvesters/discordSelfBotHarvester.ts`:
  - Detect rate limit errors from Discord API
  - Implement exponential backoff (1s, 2s, 4s, 8s, max 60s)
  - Set maximum retry attempts (e.g., 5 attempts)
  - Log retry attempts with appropriate log levels
- [ ] T035 Implement comprehensive error handling in `src/harvesters/discordSelfBotHarvester.ts`:
  - Handle network errors (timeout, connection failures)
  - Handle API errors (rate limits, permission errors, invalid tokens)
  - Handle database errors (connection failures, constraint violations)
  - Log all errors with sufficient context (channel, message IDs, timestamps)
  - Continue operation on non-fatal errors (don't crash harvester)
- [ ] T036 [P] Add unit tests for rate limiting and error handling in `tests/harvesters/discordSelfBotHarvester.test.ts`

**Checkpoint**: Harvester handles errors gracefully and respects rate limits

---

## Phase 9: Testing & Validation

**Purpose**: Comprehensive testing per constitution requirement

### Unit Tests

- [ ] T037 [P] Complete all unit tests for authentication, message fetching, filtering, and error handling in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T038 [P] Verify test coverage is above 80% for new code

### Integration Tests

- [ ] T039 [P] Complete integration test for end-to-end harvesting flow in `tests/harvesters/discordSelfBotHarvester.test.ts`
- [ ] T040 [P] Test database storage compatibility (verify messages stored in same format as app-bot)
- [ ] T041 [P] Test message edit detection and versioning

### Manual Testing

- [ ] T042 Test with real Discord channel (requires user token)
- [ ] T043 Verify feature parity with app-bot harvester (compare behavior side-by-side)
- [ ] T044 Test rate limit handling (may require intentional rate limiting)
- [ ] T045 Test long-running stability (run harvester for extended period)

**Checkpoint**: All tests pass, harvester is validated and ready for use

---

## Phase 10: Documentation & Polish

**Purpose**: Code documentation and user documentation updates

### Code Documentation

- [ ] T046 Add JSDoc comments to all exported functions in `src/harvesters/discordSelfBotHarvester.ts`:
  - Document function parameters and return types
  - Document error conditions
  - Document configuration requirements
- [ ] T047 [P] Add inline comments for complex logic in `src/harvesters/discordSelfBotHarvester.ts`
- [ ] T048 Update `src/types/config.ts` with comprehensive JSDoc for new platform type and userToken option

### User Documentation

- [ ] T049 Update `README.md` with self-bot harvester configuration examples:
  - Add example configuration for discord-selfbot platform
  - Document user token extraction methods (general guidance)
  - Document ToS warnings and security considerations
- [ ] T050 Verify `quickstart.md` is accurate and complete
- [ ] T051 [P] Add troubleshooting section for common self-bot harvester issues

### Code Quality

- [ ] T052 Run linter and fix any issues
- [ ] T053 Verify TypeScript compilation passes with strict mode
- [ ] T054 [P] Code review: verify functional programming patterns are followed (no classes)
- [ ] T055 [P] Code review: verify error handling is comprehensive
- [ ] T056 [P] Code review: verify logging is sufficient for observability

**Checkpoint**: Documentation complete, code is polished and ready for production

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phases 3-6)**: All depend on Foundational phase completion
  - User stories can proceed sequentially in priority order (P1 → P2)
  - US1 and US2 (both P1) can be worked on together after foundational
  - US3 and US4 (both P2) depend on US1 and US2 completion
- **Orchestrator Integration (Phase 7)**: Depends on User Stories 1-4 completion
- **Rate Limiting (Phase 8)**: Can be done in parallel with User Stories or after
- **Testing (Phase 9)**: Depends on all implementation phases
- **Documentation (Phase 10)**: Depends on implementation completion

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P1)**: Depends on User Story 1 (needs authentication to fetch messages)
- **User Story 3 (P2)**: Depends on User Story 2 (needs message fetching to apply filters)
- **User Story 4 (P2)**: Depends on User Story 2 (needs message fetching to download images)

### Within Each User Story

- Tests (T006-T009, T013-T016, T022-T024, T028-T030) MUST be written and FAIL before implementation
- Core functions before integration
- Error handling added throughout implementation
- Story complete before moving to next priority

### Parallel Opportunities

- **Phase 1**: T001 and T002 can run in parallel
- **Phase 2**: T004 and T005 can run in parallel
- **Phase 3 (US1)**: Tests T006-T009 can be written in parallel
- **Phase 4 (US2)**: Tests T013-T016 can be written in parallel
- **Phase 5 (US3)**: Tests T022-T024 can be written in parallel
- **Phase 6 (US4)**: Tests T028-T030 can be written in parallel
- **Phase 9**: Unit tests T037-T038 can run in parallel with integration tests T039-T041
- **Phase 10**: Documentation tasks T046-T051 can be done in parallel

---

## Implementation Strategy

### MVP First (User Stories 1 & 2 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: User Story 1 (Authentication)
4. Complete Phase 4: User Story 2 (Message Harvesting)
5. **STOP and VALIDATE**: Test User Stories 1 & 2 independently
6. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (Authentication MVP)
3. Add User Story 2 → Test independently → Deploy/Demo (Message Harvesting MVP)
4. Add User Story 3 → Test independently → Deploy/Demo (Configuration Parity)
5. Add User Story 4 → Test independently → Deploy/Demo (Image Support)
6. Add Orchestrator Integration → Test → Deploy/Demo (Full Integration)
7. Add Rate Limiting & Error Handling → Test → Deploy/Demo (Production Ready)
8. Complete Testing & Documentation → Final Release

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (Authentication)
   - Developer B: Write tests for User Stories 1-4
3. Once User Story 1 is done:
   - Developer A: User Story 2 (Message Harvesting)
   - Developer B: User Story 3 (Configuration)
4. Once User Story 2 is done:
   - Developer A: User Story 4 (Images)
   - Developer B: Orchestrator Integration
5. Both: Rate Limiting, Testing, Documentation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Follow functional programming patterns (no classes, pure functions)
- Reuse existing utilities (logger, imageDownloader, database operations)
- Maintain consistency with existing `discordHarvester.ts` patterns

