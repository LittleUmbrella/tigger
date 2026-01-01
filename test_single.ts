import { parseMessage } from './src/parsers/signalParser.js';

/**
 * Quick test script to test individual message formats with the parser
 * 
 * Usage:
 *   npx tsx test_single.ts
 * 
 * Or modify the content variable below to test different formats
 */
const content = 'Free Trade Long SIGNAL PAIR: WET / USDT Leverage: 50x Entry Zone: Market price 🎯 Take-Profit Targets: TP1: 0.2060$ TP2: 0.2063$ TP3: 0.2066$ TP4: 0.2070$ Stop-Loss: 0.15❌ hold Wallet size 2%';

console.log('Testing format:');
console.log(content);
console.log('\n' + '='.repeat(80) + '\n');

const result = parseMessage(content, 'ronnie_crypto_signals');

if (result) {
  console.log('✓ PARSED SUCCESSFULLY');
  console.log('  Trading pair:', result.tradingPair);
  console.log('  Signal type:', result.signalType);
  console.log('  Leverage:', result.leverage);
  console.log('  Entry price:', result.entryPrice ?? 'Market price');
  console.log('  Stop loss:', result.stopLoss);
  console.log('  Take profits:', result.takeProfits);
  console.log('  Number of TPs:', result.takeProfits.length);
} else {
  console.log('✗ PARSED FAILED - returned null');
  console.log('\nThis format could not be parsed. Check:');
  console.log('  - Signal type (LONG/SHORT)');
  console.log('  - Trading pair format');
  console.log('  - Leverage');
  console.log('  - Stop loss');
  console.log('  - Take profits');
}

