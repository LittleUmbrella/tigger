import { parseMessage } from './src/parsers/signalParser.js';

const content = `Free Trade

LONG SIGNAL

PAIR:  FHE/ USDT

Leverage: 50x

Entry Zone:  0.076 _ 0.070

🎯 Take-Profit Targets:

0.078$

0.080$

0.082$

0.090$



 Stop-Loss:  0.063

Wallet size 2%`;

console.log('Testing format:');
console.log(content);
console.log('\n' + '='.repeat(80) + '\n');

const result = parseMessage(content, 'ronnie_crypto_signals');

if (result) {
  console.log('✓ PARSED SUCCESSFULLY');
  console.log('  Trading pair:', result.tradingPair);
  console.log('  Signal type:', result.signalType);
  console.log('  Leverage:', result.leverage);
  console.log('  Entry price:', result.entryPrice);
  console.log('  Stop loss:', result.stopLoss);
  console.log('  Take profits:', result.takeProfits);
  console.log('  Number of TPs:', result.takeProfits.length);
  console.log('\nExpected:');
  console.log('  Entry price: 0.076 (worst for LONG)');
  console.log('  Stop loss: 0.063');
  console.log('  Take profits: [0.078, 0.080, 0.082, 0.090]');
} else {
  console.log('✗ PARSED FAILED - returned null');
}
