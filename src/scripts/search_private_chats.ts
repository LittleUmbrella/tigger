#!/usr/bin/env node
import { TelegramClient, Api } from "telegram";
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
  .name("search-private-chats")
  .description("Search all private chats for messages from you containing specific text")
  .requiredOption("-t, --text <text>", "Text to search for in messages")
  .option("--api-id <id>", "Telegram API ID (override .env)")
  .option("--api-hash <hash>", "Telegram API hash (override .env)")
  .option("--session <string>", "Session string (override .env)")
  .option("--limit <number>", "Maximum number of messages to fetch per chat (default: 500)", "500")
  .option("--json", "Output results as JSON")
  .option("--debug", "Enable debug output to see what's being checked")
  .parse(process.argv);

const opts = program.opts();

const apiId = parseInt(opts.apiId || process.env.TG_API_ID || "", 10);
const apiHash = opts.apiHash || process.env.TG_API_HASH;
const sessionString = opts.session || process.env.TG_SESSION || "";
const searchText = opts.text.toLowerCase();
const messageLimit = parseInt(opts.limit || "500", 10);
const outputJson = opts.json || false;
const debugMode = opts.debug || false;

if (!apiId || !apiHash) {
  console.error("❌ Missing API credentials");
  console.error("   Set TG_API_ID and TG_API_HASH in .env or use --api-id and --api-hash flags");
  process.exit(1);
}

if (!sessionString) {
  console.error("❌ No session string provided");
  console.error("   Set TG_SESSION in .env or use --session flag");
  process.exit(1);
}

interface SearchResult {
  chat: {
    id: string;
    name: string;
    username: string | null;
  };
  message: {
    id: number;
    text: string;
    date: string;
  };
}

(async () => {
  console.log("🔍 Searching private chats for messages containing:", searchText);
  if (!outputJson) {
    console.log("");
  }

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 3,
      timeout: 10000,
    }
  );

  try {
    console.log("⏳ Connecting to Telegram...");
    await client.connect();
    if (!outputJson) {
      console.log("✅ Connected successfully\n");
    }

    // Get current user info
    const me = await client.getMe();
    const myUserId = me.id;
    if (!outputJson) {
      console.log(`👤 Searching as: ${me.firstName || ""} ${me.lastName || ""}`.trim());
      if (me.username) {
        console.log(`   Username: @${me.username}`);
      }
      console.log("");
    }

    // Get all dialogs
    if (!outputJson) {
      console.log("📋 Fetching dialogs...");
    }
    const dialogs = await client.getDialogs({ limit: 500 });

    // Filter for private chats (users)
    const privateChats = dialogs.filter((d) => {
      return d.entity instanceof Api.User;
    });

    if (!outputJson) {
      console.log(`✅ Found ${privateChats.length} private chat(s)\n`);
      console.log("🔍 Searching messages...\n");
    }

    const results: SearchResult[] = [];
    let chatsProcessed = 0;

    for (const dialog of privateChats) {
      if (!(dialog.entity instanceof Api.User)) {
        continue;
      }

      const user = dialog.entity;
      const chatName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || "(no name)";
      const chatUsername = user.username || null;

      chatsProcessed++;
      if (!outputJson && chatsProcessed % 10 === 0) {
        process.stdout.write(`\r   Processed ${chatsProcessed}/${privateChats.length} chats...`);
      }

      try {
        // Fetch messages from this chat
        const history = await client.invoke(
          new Api.messages.GetHistory({
            peer: user,
            offsetId: 0,
            limit: messageLimit,
            addOffset: 0,
            maxId: 0,
            minId: 0,
            hash: BigInt(0) as any,
          })
        );

        const messages = "messages" in history && history.messages ? history.messages : [];

        if (debugMode && messages.length > 0) {
          console.log(`\n  Debug: Checking ${messages.length} messages in chat with ${chatName}`);
        }

        // Filter messages that are from the current user and contain the search text
        for (const msg of messages) {
          if (!("message" in msg) || !msg.message) {
            continue;
          }

          // Check if message is from the current user
          // Method 1: msg.out === true means the message was sent by the current user
          const msgOut = (msg as any).out === true;
          
          // Method 2: Check fromId/senderId matches current user ID
          const msgFromId = (msg as any).fromId?.userId || (msg as any).senderId?.userId;
          const isFromMeById = msgFromId && String(msgFromId) === String(myUserId);
          
          // Use either check - msg.out is more reliable for private chats
          const isFromMe = msgOut || isFromMeById;

          if (debugMode) {
            const msgId = typeof msg.id === "bigint" ? Number(msg.id) : msg.id;
            const msgText = String(msg.message).substring(0, 50);
            console.log(`    Message ${msgId}: out=${msgOut}, fromId=${msgFromId}, myId=${myUserId}, isFromMe=${isFromMe}, text="${msgText}..."`);
          }

          if (!isFromMe) {
            continue;
          }

          // Get message text
          const messageText = String(msg.message).toLowerCase();

          // Check if message contains search text
          if (messageText.includes(searchText)) {
            // Get message date
            let msgDate: Date;
            if ("date" in msg && msg.date) {
              const dateValue = msg.date as any;
              if (dateValue instanceof Date) {
                msgDate = dateValue;
              } else {
                const numValue = typeof dateValue === "number" ? dateValue : Number(dateValue);
                msgDate = new Date(numValue < 1e12 ? numValue * 1000 : numValue);
              }
            } else {
              msgDate = new Date();
            }

            // Get message ID
            const msgIdBigInt = typeof msg.id === "bigint" ? msg.id : BigInt(msg.id);
            const msgId = Number(msgIdBigInt);

            results.push({
              chat: {
                id: String(user.id),
                name: chatName,
                username: chatUsername,
              },
              message: {
                id: msgId,
                text: String(msg.message),
                date: msgDate.toISOString(),
              },
            });
          }
        }
      } catch (error) {
        // Skip chats that can't be accessed (e.g., deleted users, blocked chats)
        if (!outputJson) {
          if (debugMode) {
            console.error(`\n⚠️  Error accessing chat with ${chatName}:`, error instanceof Error ? error.message : String(error));
          }
        }
        continue;
      }
    }

    if (!outputJson) {
      process.stdout.write(`\r   Processed ${chatsProcessed}/${privateChats.length} chats...\n\n`);
    }

    // Output results
    if (results.length === 0) {
      if (outputJson) {
        console.log(JSON.stringify({ results: [], count: 0 }, null, 2));
      } else {
        console.log("❌ No messages found matching your search criteria.");
        console.log(`\n💡 Tips:`);
        console.log(`   - Searched ${chatsProcessed} private chat(s) with limit of ${messageLimit} messages per chat`);
        console.log(`   - Try increasing the limit: --limit 1000`);
        console.log(`   - Enable debug mode to see what's being checked: --debug`);
        console.log(`   - Make sure the search text matches exactly (case-insensitive)`);
      }
    } else {
      if (outputJson) {
        console.log(JSON.stringify({ results, count: results.length }, null, 2));
      } else {
        console.log(`✅ Found ${results.length} matching message(s):\n`);
        for (const result of results) {
          console.log("────────────────────────────────────");
          console.log(`💬 Chat:        ${result.chat.name}`);
          if (result.chat.username) {
            console.log(`   Username:    @${result.chat.username}`);
          }
          console.log(`   Chat ID:     ${result.chat.id}`);
          console.log(`📨 Message ID:  ${result.message.id}`);
          console.log(`📅 Date:        ${new Date(result.message.date).toLocaleString()}`);
          console.log(`💭 Text:        ${result.message.text}`);
        }
        console.log("────────────────────────────────────");
        console.log(`\nTotal: ${results.length} message(s) found`);
      }
    }

    await client.disconnect();
    if (!outputJson) {
      console.log("\n🏁 Search completed");
    }
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error:", error instanceof Error ? error.message : String(error));
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
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

