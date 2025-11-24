#!/usr/bin/env node
/**
 * Telegram scraper with CSV + JSONL + per-target last_id resume file
 * Features:
 *  - Optional keywords/phrases, start/end dates
 *  - CSV + NDJSON output (--json / --json-only)
 *  - Per-target last_id resume (last_id_<sanitized_target>.txt)
 *  - Human-like delays + occasional longer pauses
 *  - --limit to stop after N saved messages
 *  - --dry-run to preview matches but do not write files or update resume
 */

import "dotenv/config";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import fs from "fs-extra";
import { Command } from "commander";
import pkg from "csv-writer";
import dayjs from "dayjs";

const { createObjectCsvWriter } = pkg;

const program = new Command();
program
  .option("-t, --target <target>", "Target username, invite link, or channel ID (falls back to TG_TARGET in .env)")
  .option("-k, --keywords <keywords>", "Comma-separated keywords or quoted phrases (optional)")
  .option("-s, --start <date>", "Start date (YYYY-MM-DD, optional)")
  .option("-e, --end <date>", "End date (YYYY-MM-DD, optional)")
  .option("--json", "Also save NDJSON (appendable) to data/messages.jsonl")
  .option("--json-only", "Save only NDJSON (do not write CSV)")
  .option("-d, --delay <ms>", "Delay between batches or 'auto' (default: auto)", "auto")
  .option("-v, --verbose", "Show batches that had no matching messages", false)
  .option("--limit <n>", "Max messages to save (0 = unlimited)", "0")
  .option("--dry-run", "Preview only: do not write CSV/JSONL or update resume", false)
  .parse(process.argv);

const opts = program.opts();

// --- environment ---
const apiId = parseInt(process.env.TG_API_ID, 10);
const apiHash = process.env.TG_API_HASH;
const sessionString = process.env.TG_SESSION || "";
const phone = process.env.TG_PHONE;
const password = process.env.TG_PASSWORD;
const envTarget = process.env.TG_TARGET;
const envAccessHash = process.env.TG_ACCESS_HASH; // optional for private channels

const target = opts.target || envTarget;
if (!apiId || !apiHash) {
  console.error("❌ Missing TG_API_ID or TG_API_HASH in .env");
  process.exit(1);
}
if (!target) {
  console.error("❌ Missing target: pass --target or set TG_TARGET in .env");
  process.exit(1);
}

// --- parse keywords (optional) ---
function parseKeywords(raw) {
  if (!raw) return [];
  const tokens = raw.match(/"[^"]+"|'[^']+'|[^,]+/g) || [];
  return tokens.map(t => t.replace(/^["']|["']$/g, "").trim().toLowerCase()).filter(Boolean);
}
const keywords = parseKeywords(opts.keywords || "");
const hasKeywords = keywords.length > 0;

// --- parse date options (optional) ---
function parseDateOpt(d) {
  if (!d) return null;
  const parsed = dayjs(d);
  return parsed.isValid() ? parsed.toDate() : null;
}
const startDate = parseDateOpt(opts.start);
const endDate = parseDateOpt(opts.end);

// --- output options ---
const writeJsonFlag = !!opts.json;
const writeJsonOnly = !!opts.jsonOnly;
const writeCsvFlag = !writeJsonOnly; // write CSV unless json-only
const jsonPath = "../../data/messages.jsonl";
const csvPath = "../../data/messages.csv";
const maxLimit = Math.max(0, parseInt(opts.limit || "0", 10));
const dryRun = !!opts.dryRun;

// --- helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randBetween = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
function sanitizeTargetForFile(t) {
  return String(t).replace(/[^a-z0-9]/gi, "_").slice(0, 200);
}
function normalizeMsgDate(m) {
  if (!m) return null;
  if (m instanceof Date) return m;
  const n = Number(m);
  if (Number.isNaN(n)) return null;
  return new Date(n < 1e12 ? n * 1000 : n);
}
async function appendJsonLines(rows, path) {
  if (!rows.length) return;
  const fh = await fs.open(path, "a");
  try {
    for (const r of rows) await fs.appendFile(fh, JSON.stringify(r) + "\n", "utf8");
  } finally {
    await fs.close(fh);
  }
}

// --- prepare output files & CSV writer safely (unless dry-run) ---
await fs.ensureDir("./data");

if (!dryRun && writeCsvFlag && !fs.existsSync(csvPath)) {
  await fs.writeFile(csvPath, "", "utf8");
}

let csvWriter;
if (!dryRun && writeCsvFlag) {
  csvWriter = createObjectCsvWriter({
    path: csvPath,
    header: [
      { id: "id", title: "ID" },
      { id: "date", title: "Date" },
      { id: "sender", title: "Sender" },
      { id: "message", title: "Message" },
    ],
    append: true,
  });
}

if (!dryRun && writeJsonFlag && !fs.existsSync(jsonPath)) {
  await fs.writeFile(jsonPath, "", "utf8");
}

// --- Telegram client setup ---
const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
  connectionRetries: 5,
});

// login or connect
async function ensureLogin() {
  if (!sessionString) {
    console.log("🔐 No session in env — interactive login (will save session to .env).");
    await client.start({
      phoneNumber: async () => phone || (await input.text("Phone number: ")),
      password: async () => password || (await input.text("2FA password (if any): ")),
      phoneCode: async () => await input.text("Code from Telegram: "),
      onError: (err) => console.error("Login error:", err),
    });
    const newSession = client.session.save();
    // Save TG_SESSION in .env (append or replace)
    let envText = "";
    if (fs.existsSync(".env")) envText = fs.readFileSync(".env", "utf8");
    const updated = envText.includes("TG_SESSION=")
      ? envText.replace(/TG_SESSION=.*/, `TG_SESSION=${newSession}`)
      : envText.trim() + `\nTG_SESSION=${newSession}\n`;
    fs.writeFileSync(".env", updated);
    console.log("✅ Logged in and saved TG_SESSION to .env");
  } else {
    await client.connect();
    console.log("✅ Connected using TG_SESSION from .env");
  }
}

// resolve target robustly
async function resolveTargetEntity(t) {
  try { await client.getDialogs({ limit: 200 }); } catch {}
  try {
    if (/^-?\d+$/.test(t) && envAccessHash) {
      return new Api.InputPeerChannel({ channelId: BigInt(t), accessHash: BigInt(envAccessHash) });
    }
    if (t.startsWith("https://t.me/+") || t.startsWith("t.me/+")) {
      const hash = t.split("+")[1];
      const res = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
      if (res.chats && res.chats.length) return res.chats[0];
      throw new Error("invite import returned no chats");
    }
    return await client.getEntity(t);
  } catch (err) {
    console.error("❌ Failed to resolve target entity:", err && err.message ? err.message : err);
    process.exit(1);
  }
}

// --- main ---
(async () => {
  await ensureLogin();
  const me = await client.getMe();
  console.log(`Logged in as ${me.username || me.firstName || "(no-username)"}`);

  const entity = await resolveTargetEntity(target);
  console.log(`Resolved target: ${entity.title || entity.username || target}`);

  // per-target last_id file
  const lastIdFile = `../data/last_id_${sanitizeTargetForFile(target)}.txt`;
  let offsetId = 0;

  if (!dryRun && fs.existsSync(lastIdFile)) {
    try {
      const t = (await fs.readFile(lastIdFile, "utf8")).trim();
      const n = parseInt(t, 10);
      if (!Number.isNaN(n)) {
        offsetId = n;
        console.log("Resuming from last_id file:", offsetId);
      }
    } catch (e) {
      console.warn("Could not read last_id file, starting fresh.");
    }
  } else if (dryRun) {
    console.log("Dry-run: not loading last_id file; simulation only.");
  }

  let totalSaved = 0;
  let batchCount = 0;

  while (true) {
    batchCount++;
    const delayMs = opts.delay === "auto" ? randBetween(300, 700) : Math.max(0, parseInt(opts.delay, 10) || 0);

    const history = await client.invoke(new Api.messages.GetHistory({
      peer: entity,
      offsetId,
      limit: 100,
      addOffset: 0,
      maxId: 0,
      minId: 0,
      hash: 0,
    }));

    const msgs = history.messages || [];
    if (!msgs.length) {
      if (opts.verbose) console.log("No messages returned — finished paging.");
      break;
    }

    // process oldest->newest in batch
    const ordered = [...msgs].reverse();
    const rows = [];

    for (const m of ordered) {
      if (!m.message) continue;

      const msgDate = normalizeMsgDate(m.date);

      // date filters (only if provided)
      if (startDate && msgDate && msgDate < startDate) continue;
      if (endDate && msgDate && msgDate > endDate) continue;

      // keyword filtering (only if provided)
      if (hasKeywords) {
        const lower = String(m.message).toLowerCase();
        if (!keywords.some(k => lower.includes(k))) continue;
      }

      const msgId = Number(m.id);
      if (Number.isNaN(msgId)) continue;

      const row = {
        id: msgId,
        date: msgDate ? msgDate.toISOString() : "",
        sender: String(m.fromId?.userId || m.senderId?.userId || m.fromId || ""),
        message: String(m.message).replace(/\s+/g, " ").trim(),
      };

      rows.push(row);
      // update offset to newest saved
      offsetId = Math.max(offsetId || 0, msgId);

      // if limit reached in dry-run or live, break out to write and stop
      if (maxLimit && totalSaved + rows.length >= maxLimit) break;
    }

    if (rows.length > 0) {
      if (dryRun) {
        console.log(`Dry-run: would save ${rows.length} messages in batch ${batchCount} (sample 3):`);
        console.log(rows.slice(0, 3));
      } else {
        if (writeJsonFlag) await appendJsonLines(rows, jsonPath);
        if (writeCsvFlag) await csvWriter.writeRecords(rows);
        // update last_id file immediately after successful writes
        try { await fs.writeFile(lastIdFile, String(offsetId), "utf8"); } catch (e) { console.warn("Warning: could not write last_id file:", e && e.message); }
        totalSaved += rows.length;
        console.log(`Batch ${batchCount}: saved ${rows.length} (total saved: ${totalSaved})`);
      }
    } else {
      if (opts.verbose) console.log(`Batch ${batchCount}: no matching messages`);
    }

    // stop if limit reached
    if (maxLimit && totalSaved >= maxLimit) {
      console.log("Reached --limit, stopping.");
      break;
    }

    // prepare next offsetId: set to smallest id in msgs minus 1 (older messages)
    const minId = Math.min(...msgs.map(m => Number(m.id)).filter(Number.isFinite));
    if (!Number.isFinite(minId)) {
      console.log("Could not determine min message id; stopping.");
      break;
    }
    if (minId <= 1 || offsetId <= minId) {
      if (opts.verbose) console.log("Reached earliest message(s) or no progress; stopping.");
      break;
    }
    offsetId = minId - 1;

    // human-like pause between batches
    await sleep(delayMs);

    // occasional longer pause to mimic human breaks
    if (Math.random() < 0.05 && !dryRun) {
      const pause = randBetween(3000, 8000);
      console.log(`😴 Taking a human-like break (${Math.round(pause/1000)}s)`);
      await sleep(pause);
    }
  }

  console.log(`Done. Total messages saved: ${totalSaved} ${dryRun ? "(dry-run, nothing written)" : ""}`);
  await client.disconnect();
  process.exit(0);
})().catch(err => {
  console.error("Fatal error:", err && (err.message || err.toString()));
  process.exit(1);
});
