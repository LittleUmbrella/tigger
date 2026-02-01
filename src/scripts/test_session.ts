#!/usr/bin/env node
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Command } from "commander";
import path from "path";
import dotenv from "dotenv";
import fs from "fs";

// Load .env-investigation first, then fall back to .env
const projectRoot = process.cwd();
const envInvestigationPath = path.join(projectRoot, ".env-investigation");
const envPath = path.join(projectRoot, ".env");

// Try .env-investigation first, then .env
if (fs.existsSync(envInvestigationPath)) {
  dotenv.config({ path: envInvestigationPath });
} else if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config(); // Fallback to default behavior
}

const program = new Command();
program
  .name("test-session")
  .description("Test if a Telegram session string is valid")
  .option("--session <string>", "Session string to test (overrides env vars)")
  .option("--api-id <id>", "Telegram API ID (override .env)")
  .option("--api-hash <hash>", "Telegram API hash (override .env)")
  .option("--env-var-name <name>", "Test session from specific env var (e.g., TG_SESSION_RONNIE)")
  .parse(process.argv);

const opts = program.opts();

const apiId = parseInt(opts.apiId || process.env.TG_API_ID || "", 10);
const apiHash = opts.apiHash || process.env.TG_API_HASH;

// Determine which session to test
let sessionString: string | undefined;
if (opts.session) {
  sessionString = opts.session;
} else if (opts.envVarName) {
  sessionString = process.env[opts.envVarName];
  if (!sessionString) {
    console.error(`❌ Environment variable ${opts.envVarName} not found`);
    process.exit(1);
  }
} else {
  sessionString = process.env.TG_SESSION;
}

if (!apiId || !apiHash) {
  console.error("❌ Missing API credentials");
  console.error("   Set TG_API_ID and TG_API_HASH in .env or use --api-id and --api-hash flags");
  process.exit(1);
}

if (!sessionString) {
  console.error("❌ No session string provided");
  console.error("   Options:");
  console.error("   1. Set TG_SESSION in .env");
  console.error("   2. Use --session <string> flag");
  console.error("   3. Use --env-var-name <name> to test a specific env var");
  process.exit(1);
}

(async () => {
  console.log("🔍 Testing Telegram session...\n");
  
  // Show session fingerprint (first 8 and last 8 chars) for verification
  const sessionFingerprint = sessionString.length > 16 
    ? `${sessionString.substring(0, 8)}...${sessionString.substring(sessionString.length - 8)}`
    : "***";
  console.log(`Session fingerprint: ${sessionFingerprint}\n`);

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 3,
      timeout: 10000, // 10 second timeout
    }
  );

  try {
    console.log("⏳ Connecting to Telegram...");
    await client.connect();
    console.log("✅ Connected successfully\n");

    console.log("⏳ Verifying session...");
    const me = await client.getMe();
    
    console.log("\n✅ Session is VALID!\n");
    console.log("────────────────────────────────────");
    console.log("Account Information:");
    console.log(`  User ID:      ${me.id}`);
    console.log(`  First Name:   ${me.firstName || "(none)"}`);
    console.log(`  Last Name:    ${me.lastName || "(none)"}`);
    if (me.username) {
      console.log(`  Username:     @${me.username}`);
    }
    console.log(`  Phone:        ${me.phone || "(none)"}`);
    console.log(`  Premium:      ${me.premium ? "Yes" : "No"}`);
    console.log(`  Verified:     ${me.verified ? "Yes" : "No"}`);
    console.log(`  Bot:          ${me.bot ? "Yes" : "No"}`);
    console.log("────────────────────────────────────\n");

    // Test getting dialogs to ensure full functionality
    console.log("⏳ Testing full session functionality...");
    const dialogs = await client.getDialogs({ limit: 1 });
    console.log(`✅ Can access dialogs (found ${dialogs.length} dialog(s))\n`);

    await client.disconnect();
    console.log("🏁 Test completed successfully\n");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Session is INVALID or connection failed\n");
    console.error("────────────────────────────────────");
    
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
      
      // Provide helpful error messages for common issues
      if (error.message.includes("AUTH_KEY_INVALID") || 
          error.message.includes("SESSION_PASSWORD_NEEDED") ||
          error.message.includes("PHONE_CODE_INVALID")) {
        console.error("\n💡 This usually means:");
        console.error("   - The session has expired or been revoked");
        console.error("   - The session was created with different API credentials");
        console.error("   - You need to regenerate the session");
        console.error("\n   Run: npm run generate-session");
      } else if (error.message.includes("FLOOD_WAIT")) {
        console.error("\n💡 Rate limited by Telegram. Please wait and try again.");
      } else if (error.message.includes("TIMEOUT") || error.message.includes("timeout")) {
        console.error("\n💡 Connection timeout. Check your internet connection.");
      }
    } else {
      console.error(`Error: ${String(error)}`);
    }
    
    console.error("────────────────────────────────────\n");
    
    try {
      await client.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    
    process.exit(1);
  }
})().catch((err) => {
  console.error("❌ Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});

