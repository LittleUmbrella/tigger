#!/usr/bin/env tsx
/**
 * Generate data/signal_templates/*.sh from config.json channels.
 *
 * Default SIGNAL text is loaded from the database: the most recent trade-linked
 * message content per channel (trades JOIN messages).
 *
 * Usage:
 *   npm run generate-signal-templates
 *   npm run generate-signal-templates -- --force          # reset SIGNAL blocks from DB
 *   npm run generate-signal-templates -- --clean            # remove scripts for removed channels
 *   npm run generate-signal-templates -- --config path.json
 */

import 'dotenv/config';
import { Command } from 'commander';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { BotConfig } from '../types/config.js';
import { DatabaseManager } from '../db/schema.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const TEMPLATES_DIR = 'data/signal_templates';

const LIB_SH = `#!/usr/bin/env bash
# Shared helpers for data/signal_templates/*.sh — run from repo root.
# Regenerate with: npm run generate-signal-templates

set -euo pipefail

SIGNAL_TEMPLATES_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SIGNAL_TEMPLATES_DIR/../.." && pwd)"

run_from_root() {
  cd "$ROOT"
  "$@"
}

# cTrader channels: parse signal text via channel parser, then place via initiator.
place_ctrader_signal() {
  local channel="$1"
  local signal="$2"
  shift 2
  run_from_root npm run open-ctrader-trade -- \\
    --channel "$channel" \\
    --content "$signal" \\
    "$@"
}

# Bybit channels: insert unparsed message and run orchestrator pipeline.
place_bybit_signal() {
  local channel="$1"
  local signal="$2"
  shift 2
  run_from_root npm run replay-messages -- \\
    --channel "$channel" \\
    --content "$signal" \\
    --date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \\
    "$@"
}
`;

const scriptFileName = (channel: string, parser: string) => `${channel}_${parser}.sh`;

const extractExistingSignal = (content: string): string | null => {
  const match = content.match(/read -r -d '' SIGNAL <<'EOF' \|\| true\n([\s\S]*?)\nEOF/);
  return match?.[1] ?? null;
};

const placeholderSample = (channel: string, parser: string): string =>
  `# No trade-linked message found in DB for channel ${channel}\n# Paste a representative ${parser} signal below`;

const channelLabel = (parser: string, harvester?: string): string => {
  const extra = harvester && harvester !== `${parser}_harvester` ? ` / ${harvester}` : '';
  return `${parser}${extra}`;
};

const buildChannelScript = (params: {
  channel: string;
  parser: string;
  initiator: string;
  harvester?: string;
  signal: string;
}): string => {
  const { channel, parser, initiator, harvester, signal } = params;
  const isCtrader = initiator === 'ctrader';
  const placeFn = isCtrader ? 'place_ctrader_signal' : 'place_bybit_signal';
  const platform = isCtrader ? 'cTrader' : 'Bybit';
  const scriptName = scriptFileName(channel, parser);
  const extraComment = isCtrader
    ? '# Optional: --force  --dry-run --entry <price>  --account ctrader_demo_2_100'
    : '';

  return `#!/usr/bin/env bash
# Channel ${channel} — ${channelLabel(parser, harvester)} (${platform})
# Edit SIGNAL below, then: ./data/signal_templates/${scriptName}
${extraComment}
# Regenerate scaffold (keeps your SIGNAL): npm run generate-signal-templates

set -euo pipefail
source "$(dirname "$0")/_lib.sh"

CHANNEL="${channel}"

read -r -d '' SIGNAL <<'EOF' || true
${signal}
EOF

${placeFn} "$CHANNEL" "$SIGNAL" "$@"
`;
};

const createDatabase = (config: BotConfig): DatabaseManager => {
  const rawDbType = (config.database?.type || 'sqlite').toLowerCase();
  const dbType =
    rawDbType === 'postgres' || rawDbType === 'postgresql' ? 'postgresql' : 'sqlite';
  const dbPath =
    dbType === 'sqlite'
      ? (config.database?.path || 'data/trading_bot.db')
      : (config.database?.url || process.env.DATABASE_URL || '');
  if (dbType === 'postgresql' && !dbPath) {
    throw new Error(
      'PostgreSQL selected but no URL provided. Set config.database.url or DATABASE_URL in .env'
    );
  }
  return new DatabaseManager({
    type: dbType,
    path: dbType === 'sqlite' ? dbPath : undefined,
    url: dbType === 'postgresql' ? dbPath : undefined,
  });
};

const loadSampleSignalsFromDb = async (
  db: DatabaseManager,
  channels: string[]
): Promise<Map<string, string>> => {
  const samples = new Map<string, string>();
  for (const channel of channels) {
    const content = await db.getSampleSignalContentByChannel(channel);
    if (content) {
      samples.set(channel, content);
    }
  }
  return samples;
};

const program = new Command();

program
  .name('generate-signal-templates')
  .description('Generate data/signal_templates/*.sh from config.json channels')
  .option('--config <path>', 'Path to config.json', path.join(projectRoot, 'config.json'))
  .option('--output-dir <path>', 'Output directory', path.join(projectRoot, TEMPLATES_DIR))
  .option('--preserve-signals', 'Keep existing SIGNAL blocks when regenerating', true)
  .option('--force', 'Reset SIGNAL blocks from DB samples (overrides --preserve-signals)')
  .option('--clean', 'Remove channel scripts no longer present in config')
  .action(async (options) => {
    const configPath = path.resolve(options.config);
    if (!(await fs.pathExists(configPath))) {
      console.error(`Config not found: ${configPath}`);
      process.exit(1);
    }

    const config: BotConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    const channels = config.channels ?? [];
    if (channels.length === 0) {
      console.error('No channels in config');
      process.exit(1);
    }

    const db = createDatabase(config);
    await db.initialize();

    const channelIds = channels.map(c => c.channel).filter(Boolean);
    const dbSamples = await loadSampleSignalsFromDb(db, channelIds);

    const outputDir = path.resolve(options.outputDir);
    await fs.ensureDir(outputDir);

    const preserveSignals = !options.force && options.preserveSignals !== false;
    const expectedFiles = new Set(['_lib.sh']);

    await fs.writeFile(path.join(outputDir, '_lib.sh'), LIB_SH, 'utf-8');
    expectedFiles.add('_lib.sh');

    let created = 0;
    let updated = 0;
    let preserved = 0;
    let fromDb = 0;
    let placeholders = 0;

    for (const channelConfig of channels) {
      const { channel, parser, initiator, harvester } = channelConfig;
      if (!channel || !parser || !initiator) {
        console.warn(`Skipping channel entry missing channel/parser/initiator: ${JSON.stringify(channelConfig)}`);
        continue;
      }

      const fileName = scriptFileName(channel, parser);
      const filePath = path.join(outputDir, fileName);
      expectedFiles.add(fileName);

      let signal = dbSamples.get(channel) ?? placeholderSample(channel, parser);
      if (dbSamples.has(channel)) {
        fromDb += 1;
      } else {
        placeholders += 1;
        console.warn(`  no DB sample for channel ${channel} (${parser})`);
      }

      if (preserveSignals && (await fs.pathExists(filePath))) {
        const existing = await fs.readFile(filePath, 'utf-8');
        const extracted = extractExistingSignal(existing);
        if (extracted != null) {
          signal = extracted;
          preserved += 1;
        }
      } else if (await fs.pathExists(filePath)) {
        updated += 1;
      } else {
        created += 1;
      }

      const script = buildChannelScript({
        channel,
        parser,
        initiator,
        harvester,
        signal
      });
      await fs.writeFile(filePath, script, 'utf-8');
      await fs.chmod(filePath, 0o755);
    }

    let removed = 0;
    if (options.clean) {
      const entries = await fs.readdir(outputDir);
      for (const entry of entries) {
        if (!entry.endsWith('.sh') || entry === '_lib.sh') continue;
        if (!expectedFiles.has(entry)) {
          await fs.remove(path.join(outputDir, entry));
          removed += 1;
          console.log(`  removed stale ${entry}`);
        }
      }
    }

    await fs.chmod(path.join(outputDir, '_lib.sh'), 0o755);
    await db.close();

    console.log(`Generated ${channels.length} channel script(s) in ${outputDir}`);
    console.log(`  new: ${created}  updated scaffold: ${updated}  preserved SIGNAL: ${preserved}  from DB: ${fromDb}  placeholders: ${placeholders}  removed: ${removed}`);
    if (preserveSignals && !options.force) {
      console.log('  (use --force to reset SIGNAL blocks from DB samples)');
    }
  });

program.parse(process.argv);
