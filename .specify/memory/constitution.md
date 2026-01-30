<!--
Sync Impact Report:
Version: 1.0.0 (initial)
Ratified: 2025-01-29
Last Amended: 2025-01-29

Principles Established:
- I. Safety-First Trading Operations
- II. Functional & Declarative Programming
- III. Comprehensive Error Handling & Observability
- IV. Test-Driven Development
- V. Configuration-Driven Architecture
- VI. Database Integrity & Transaction Safety
- VII. API Integration Resilience

Templates Status:
✅ constitution.md - Updated
⚠ plan-template.md - Review recommended for trading-specific constraints
⚠ spec-template.md - Review recommended for financial domain requirements
⚠ tasks-template.md - Review recommended for safety-critical task types
-->

# Tigger Trading Bot Constitution

## Core Principles

### I. Safety-First Trading Operations
All code that interacts with financial exchanges or executes trades MUST prioritize safety over performance. Every trade operation MUST include:
- Pre-execution validation of all parameters (symbol, quantity, price, leverage)
- Explicit confirmation mechanisms for high-risk operations
- Circuit breakers and rate limiting to prevent runaway execution
- Comprehensive audit logging of all trading decisions and actions
- Fail-safe defaults: on error, the system MUST default to the safest state (no trade, cancel orders, etc.)

Rationale: This system manages real financial assets. A single bug can result in significant financial loss. Safety mechanisms are non-negotiable.

### II. Functional & Declarative Programming
Code MUST follow functional programming patterns:
- Prefer pure functions over classes and stateful objects
- Avoid mutable state; use immutable data structures where possible
- Use iteration and modularization over code duplication
- Functions MUST be small, focused, and testable in isolation
- Side effects (database writes, API calls, file I/O) MUST be isolated and explicit

Rationale: Functional patterns improve testability, reduce bugs, and make the codebase more maintainable. This aligns with the project's existing patterns.

### III. Comprehensive Error Handling & Observability
Every component MUST implement robust error handling:
- All external API calls (Telegram, Discord, Bybit) MUST have retry logic with exponential backoff
- All errors MUST be logged with sufficient context (request IDs, timestamps, relevant state)
- Critical errors (trade failures, API outages) MUST trigger alerts/notifications
- All async operations MUST handle promise rejections and timeouts
- Database operations MUST use transactions for multi-step operations
- Logging MUST be structured (Winston) with appropriate log levels

Rationale: Trading bots operate 24/7 and must be observable. Failures must be traceable and recoverable.

### IV. Test-Driven Development
Testing is mandatory for all trading-critical paths:
- Unit tests MUST be written for all parsers (signal parsing is critical)
- Integration tests MUST cover trade initiation flows end-to-end
- Simulation mode MUST be used to validate strategies before live trading
- All tests MUST be deterministic (no flaky tests)
- Test coverage MUST be maintained above 80% for core trading logic

Rationale: Automated testing is the only way to ensure reliability in a complex, stateful system handling financial transactions.

### V. Configuration-Driven Architecture
The system MUST be configurable without code changes:
- All channel-specific settings (harvesters, parsers, initiators, monitors) MUST be in `config.json`
- Environment-specific values (API keys, database URLs) MUST use environment variables
- Configuration MUST be validated at startup using Zod schemas
- Configuration changes MUST NOT require restarts for non-critical settings (where possible)

Rationale: The bot needs to adapt to different channels, strategies, and environments without code modifications.

### VI. Database Integrity & Transaction Safety
All database operations MUST maintain data integrity:
- Multi-step operations (parse → initiate → monitor) MUST use database transactions
- Database schema changes MUST be backward compatible or include migration scripts
- All database queries MUST use parameterized statements to prevent injection
- Critical data (trades, messages) MUST never be deleted, only soft-deleted or archived

Rationale: Financial data integrity is paramount. Lost or corrupted trade data cannot be recovered.

### VII. API Integration Resilience
All external API integrations MUST be resilient:
- Rate limiting MUST be respected (Bybit, Telegram, Discord APIs)
- API responses MUST be validated against expected schemas
- Network failures MUST be handled gracefully with retries
- API credentials MUST never be logged or exposed in error messages
- Connection pooling and timeouts MUST be configured appropriately

Rationale: External APIs are unreliable. The bot must continue operating despite API outages or rate limits.

## Technology Stack Constraints

### Required Technologies
- **Runtime**: Node.js 20+ with TypeScript 5+
- **Database**: SQLite (default) or PostgreSQL (production)
- **Logging**: Winston with structured logging
- **Testing**: Vitest for unit/integration tests
- **Validation**: Zod for runtime type checking and config validation

### Prohibited Patterns
- Classes for business logic (use functional modules instead)
- Global state or singletons (use dependency injection)
- Synchronous file I/O in request handlers (use async/await)
- Hardcoded API endpoints or credentials (use config/env vars)

## Development Workflow

### Code Review Requirements
- All PRs MUST be reviewed before merging
- Trading-critical changes (initiators, monitors) REQUIRE explicit approval
- Configuration changes MUST be validated against schema
- Database migrations MUST be reviewed for backward compatibility

### Deployment Process
- All changes MUST pass CI/CD tests before deployment
- Production deployments MUST use Docker containers
- Database migrations MUST be tested in staging before production
- Rollback procedures MUST be documented for critical components

### Quality Gates
- TypeScript compilation MUST pass with strict mode enabled
- All tests MUST pass before merge
- Linter errors MUST be resolved (no warnings allowed)
- Code coverage MUST not decrease below 80% threshold

## Governance

### Constitution Supremacy
This constitution supersedes all other development practices and documentation. Any deviation MUST be:
1. Documented with explicit rationale
2. Approved through code review
3. Added as an amendment to this document with version bump

### Amendment Process
- **PATCH** (X.Y.Z → X.Y.Z+1): Clarifications, typo fixes, non-semantic changes
- **MINOR** (X.Y.Z → X.Y+1.0): New principles or sections added
- **MAJOR** (X.Y.Z → X+1.0.0): Principle removal or backward-incompatible changes

All amendments MUST include:
- Updated version number
- Last amended date
- Sync Impact Report listing affected templates/artifacts

### Compliance Verification
- All PRs MUST verify compliance with relevant principles
- Automated checks MUST validate: TypeScript strict mode, test coverage, linter rules
- Manual review MUST verify: safety mechanisms, error handling, observability

**Version**: 1.0.0 | **Ratified**: 2025-01-29 | **Last Amended**: 2025-01-29
