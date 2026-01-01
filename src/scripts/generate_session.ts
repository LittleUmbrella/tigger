#!/usr/bin/env node
import "dotenv/config";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import { Command } from "commander";

const program = new Command();
program
  .name("generate-session")
  .description("Generate a new Telegram session string")
  .option("--api-id <id>", "Telegram API ID (override .env)")
  .option("--api-hash <hash>", "Telegram API hash (override .env)")
  .option("--env-var-name <name>", "Output as environment variable (e.g., TG_SESSION_RONNIE)")
  .parse(process.argv);

const opts = program.opts();

const apiId = parseInt(opts.apiId || process.env.TG_API_ID || "", 10);
const apiHash = opts.apiHash || process.env.TG_API_HASH;
const phone = process.env.TG_PHONE;
const password = process.env.TG_PASSWORD;

if (!apiId || !apiHash) {
  console.error("❌ Missing API credentials");
  console.error("   Set TG_API_ID and TG_API_HASH in .env or use --api-id and --api-hash flags");
  process.exit(1);
}

(async () => {
  console.log("🔐 Generating new Telegram session...\n");
  
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    connectionRetries: 5,
  });

  try {
    await client.start({
      phoneNumber: async () => phone || await input.text("Phone number: "),
      password: async () => password || await input.text("2FA password (if any): "),
      phoneCode: async () => await input.text("Code from Telegram: "),
      onError: (err) => {
        console.error("❌ Login error:", err);
        process.exit(1);
      },
    });

    const sessionString = client.session.save();
    const me = await client.getMe();
    
    console.log("\n✅ Session generated successfully!\n");
    console.log("────────────────────────────────────");
    
    if (opts.envVarName) {
      console.log(`\n${opts.envVarName}=${sessionString}\n`);
    } else {
      console.log("Session string:");
      console.log(sessionString);
      console.log("\n────────────────────────────────────");
      console.log("\nTo use this session, set it as an environment variable:");
      console.log(`export TG_SESSION="${sessionString}"`);
      console.log("\nOr add it to your .env file:");
      console.log(`TG_SESSION=${sessionString}`);
    }
    
    console.log("\n────────────────────────────────────");
    console.log(`Logged in as: ${me.firstName || ""} ${me.lastName || ""}`.trim());
    if (me.username) {
      console.log(`Username: @${me.username}`);
    }
    console.log("────────────────────────────────────\n");

    await client.disconnect();
  } catch (error) {
    console.error("❌ Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});

