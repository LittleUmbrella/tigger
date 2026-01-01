import { parseMessage } from './src/parsers/signalParser.js';
import Database from 'better-sqlite3';

async function testFormats() {
  const db = new Database('data/evaluation.db');

  const formats = db.prepare(`
    SELECT format_pattern, format_hash, example_count 
    FROM signal_formats 
    WHERE channel = ? AND classification = ?
    ORDER BY example_count DESC
  `).all('3241720654', 'signal') as Array<{format_pattern: string, format_hash: string, example_count: number}>;

  console.log(`Testing ${formats.length} signal formats...\n`);

  let parsed = 0;
  let failed = 0;
  const failedFormats: Array<{hash: string, pattern: string, count: number}> = [];

  for (const format of formats) {
    const result = parseMessage(format.format_pattern, 'ronnie_crypto_signals');
    if (result) {
      parsed++;
    } else {
      failed++;
      failedFormats.push({
        hash: format.format_hash,
        pattern: format.format_pattern.substring(0, 150),
        count: format.example_count
      });
    }
  }

  console.log(`\nResults:`);
  console.log(`  Parsed: ${parsed}/${formats.length}`);
  console.log(`  Failed: ${failed}/${formats.length}`);

  if (failedFormats.length > 0) {
    console.log(`\nFailed formats (top 15 by example count):`);
    failedFormats
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)
      .forEach((f, i) => {
        console.log(`\n${i + 1}. (${f.count} examples)`);
        console.log(`   ${f.pattern}...`);
      });
  }

  db.close();
}

testFormats().catch(console.error);
