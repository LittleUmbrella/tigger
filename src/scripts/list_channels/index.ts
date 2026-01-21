#!/usr/bin/env node
import "dotenv/config";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import fs from "fs-extra";
import { Command } from "commander";
import { logger } from "../../utils/logger.js";

// Helper function to log all options
const logOptions = (commandName: string, options: Record<string, unknown>): void => {
  logger.info("Command options", {
    command: commandName,
    options: JSON.parse(JSON.stringify(options, (key, value) => {
      // Handle undefined values
      if (value === undefined) return undefined;
      return value;
    }))
  });
};

// -----------------------------
// CLI setup
// -----------------------------
const program = new Command();
program
  .name("find-channels")
  .description("List or search Telegram dialogs (channels, groups, and private chats) (GramJS)")
  .option("-s, --search <term>", "Search term (case-insensitive)")
  .option("--api-id <id>", "Telegram API ID (override .env)")
  .option("--api-hash <hash>", "Telegram API hash (override .env)")
  .option("--session <string>", "Session string (override .env)")
  .parse(process.argv);

const opts = program.opts();
logOptions("list-channels", opts);

// -----------------------------
// Environment / session setup
// -----------------------------
const envPath = ".env";
const apiId = parseInt(opts.apiId || process.env.TG_API_ID, 10);
const apiHash = opts.apiHash || process.env.TG_API_HASH;
let sessionString = opts.session || process.env.TG_SESSION || "";
const phone = process.env.TG_PHONE;
const password = process.env.TG_PASSWORD;

if (!apiId || !apiHash) {
  console.error("❌ Missing API credentials (set TG_API_ID and TG_API_HASH in .env)");
  process.exit(1);
}

// -----------------------------
// Main async function
// -----------------------------
(async () => {
  // -----------------------------
  // Client login
  // -----------------------------
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });

  if (!sessionString) {
    console.log("🔐 No saved session found — first-time login required.\n");

    await client.start({
      phoneNumber: async () => phone || await input.text("Phone number: "),
      password: async () => password || await input.text("2FA password (if any): "),
      phoneCode: async () => await input.text("Code from Telegram: "),
      onError: (err) => console.error("Login error:", err),
    });

    const newSession = client.session.save();
    console.log("\n✅ Logged in successfully. Saving session to .env");

    let env = "";
    if (fs.existsSync(envPath)) env = fs.readFileSync(envPath, "utf8");
    const newEnv = env.includes("TG_SESSION=")
      ? env.replace(/TG_SESSION=.*/, `TG_SESSION=${newSession}`)
      : env.trim() + `\nTG_SESSION=${newSession}\n`;
    fs.writeFileSync(envPath, newEnv);
  } else {
    await client.connect();
    console.log("✅ Logged in using saved session.\n");
  }

  // -----------------------------
  // List or search dialogs
  // -----------------------------
  console.log("📋 Retrieving your dialogs...\n");
  const dialogs = await client.getDialogs({ limit: 500 });

  const term = opts.search ? opts.search.toLowerCase() : null;

  const dialogsList = dialogs
    .filter((d) => {
      if (!d.entity) return false;
      if (!term) return true;
      
      // Search in channels
      if (d.entity instanceof Api.Channel) {
        return d.entity.title.toLowerCase().includes(term);
      }
      // Search in groups
      if (d.entity instanceof Api.Chat) {
        return d.entity.title.toLowerCase().includes(term);
      }
      // Search in private chats (users)
      if (d.entity instanceof Api.User) {
        const firstName = d.entity.firstName || "";
        const lastName = d.entity.lastName || "";
        const fullName = `${firstName} ${lastName}`.trim().toLowerCase();
        const username = (d.entity.username || "").toLowerCase();
        return fullName.includes(term) || username.includes(term);
      }
      return false;
    })
    .map((d) => {
      if (!d.entity) {
        throw new Error("Dialog has no entity");
      }
      
      // Handle channels
      if (d.entity instanceof Api.Channel) {
        return {
          type: "Channel",
          name: d.entity.title,
          id: d.entity.id,
          accessHash: d.entity.accessHash,
          username: d.entity.username || "(none)",
        };
      }
      
      // Handle groups
      if (d.entity instanceof Api.Chat) {
        return {
          type: "Group",
          name: d.entity.title,
          id: d.entity.id,
          accessHash: BigInt(0), // Groups don't have accessHash
          username: "(none)",
        };
      }
      
      // Handle private chats (users)
      if (d.entity instanceof Api.User) {
        const firstName = d.entity.firstName || "";
        const lastName = d.entity.lastName || "";
        const fullName = `${firstName} ${lastName}`.trim() || "(no name)";
        return {
          type: "Private Chat",
          name: fullName,
          id: d.entity.id,
          accessHash: d.entity.accessHash || BigInt(0),
          username: d.entity.username || "(none)",
        };
      }
      
      throw new Error(`Unknown entity type: ${d.entity.className}`);
    });

  if (!dialogsList.length) {
    console.log(term
      ? `⚠️ No dialogs found matching "${opts.search}".`
      : "⚠️ No dialogs found.");
    await client.disconnect();
    process.exit(0);
  }

  console.log(`✅ Found ${dialogsList.length} dialog(s):\n`);
  for (const d of dialogsList) {
    console.log("────────────────────────────────────");
    console.log(`📋 Type:        ${d.type}`);
    console.log(`📛 Name:        ${d.name}`);
    console.log(`🆔 ID:          ${d.id}`);
    console.log(`🔑 AccessHash:  ${d.accessHash}`);
    console.log(`🔗 Username:    ${d.username}`);
  }
  console.log("────────────────────────────────────");

  await client.disconnect();
  console.log("\n🏁 Done.");
})().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
