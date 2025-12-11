# Initiator Tests

This directory contains unit and integration tests for the initiator system.

## Test Structure

- **fixtures.ts**: Test data and mock responses
- **mocks.ts**: Mock implementations for database, price provider, and API clients
- **testHelpers.ts**: Helper functions for creating test scenarios
- **initiatorRegistry.test.ts**: Unit tests for the registry system
- **bybitInitiator.test.ts**: Unit tests for the Bybit initiator
- **signalInitiator.integration.test.ts**: Integration tests for the full flow

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with UI
npm run test:ui

# Run tests with coverage
npm run test:coverage
```

## Test Fixtures

The fixtures include:
- Sample Telegram messages
- Parsed order data
- Mock Bybit API responses
- Historical price data

## Mock System

The tests use mocks instead of real API calls:
- **Mock Database**: In-memory or file-based test database
- **Mock Price Provider**: Simulated historical price data
- **Mock Bybit Client**: Mocked API responses

## Adding New Tests

When adding new initiator tests:

1. Add fixtures to `fixtures.ts` if needed
2. Create unit tests for individual functions
3. Create integration tests for full workflows
4. Use mocks instead of real API calls
5. Test both simulation and live modes

## Test Coverage Goals

- Registry functions: 100%
- Initiator logic: >90%
- Integration flows: >80%




