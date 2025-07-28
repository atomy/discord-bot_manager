// Import required modules
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
const mysql = require("mysql2/promise");

// Configuration
const DISCORD_BOT_CHANNEL_ID = process.env.DISCORD_BOT_CHANNEL_ID;
if (!DISCORD_BOT_CHANNEL_ID)
  throw new Error("DISCORD_BOT_CHANNEL_ID environment variable is not set.");

const LISTEN_API_PORT = process.env.LISTEN_API_PORT;
if (!LISTEN_API_PORT)
  throw new Error("LISTEN_API_PORT environment variable is not set.");

const DB_CONFIG = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

if (
  !DB_CONFIG.host ||
  !DB_CONFIG.user ||
  !DB_CONFIG.password ||
  !DB_CONFIG.database
) {
  throw new Error(
    "Database environment variables (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME) are not set."
  );
}

const BOT_MANAGER_DISCORD_TOKEN = process.env.BOT_MANAGER_DISCORD_TOKEN;
if (!BOT_MANAGER_DISCORD_TOKEN)
  throw new Error("BOT_MANAGER_DISCORD_TOKEN environment variable is not set.");

const LISTEN_API_KEY = process.env.LISTEN_API_KEY;
if (!LISTEN_API_KEY)
  throw new Error("LISTEN_API_KEY environment variable is not set.");

// Initialize Express
const app = express();
app.use(express.json());

// Middleware to protect API with API key
app.use((req, res, next) => {
  const apiKey = req.headers["x-api-key"];

  if (apiKey !== LISTEN_API_KEY) {
    const clientIp =
      req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress; // Get the client's IP
    console.log(
      `Invalid API key attempt from IP: ${clientIp}, Provided Key: ${
        apiKey || "None"
      }`
    );
    return res.status(403).json({ error: "Forbidden: Invalid API Key" });
  }

  next();
});

// MySQL Connection Pool
let db;
(async () => {
  db = await mysql.createPool(DB_CONFIG);
})();

// Map to keep track of active bots
const activeBots = new Map();

// Bot Manager Client
const botManager = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function updateBotManagerPresence() {
  const botCount = activeBots.size;
  const botNames = Array.from(activeBots.keys()).join(", "); // Get all bot names from activeBots
  const statusMessage = `over ${botCount} bot${botCount === 1 ? "" : "s"}`;

  botManager.user.setPresence({
    activities: [
      {
        name: statusMessage,
        type: 3, // 3 corresponds to "WATCHING"
      },
    ],
    status: "online",
  });
  console.log(`Bot Manager presence updated: ${statusMessage}`);

  // Update the channel topic with bot names
  try {
    botManager.channels
      .fetch(DISCORD_BOT_CHANNEL_ID)
      .then((channel) => {
        if (channel.isTextBased()) {
          // Ensure the channel is a text-based channel
          const topic =
            botCount > 0
              ? `Active bots: ${botNames}`
              : "No bots are currently active.";
          channel.edit({ topic }); // Update the channel topic
          console.log(`Channel topic updated: ${topic}`);
        } else {
          console.error("The specified channel is not text-based.");
        }
      })
      .catch((err) => {
        console.error(
          `Failed to fetch or update channel topic: ${err.message}`
        );
      });
  } catch (err) {
    console.error(`Failed to update channel topic: ${err.message}`);
  }
}

// onReady, connect all configured bots
botManager.once("ready", async () => {
  console.log(`Bot Manager logged in as ${botManager.user.tag}`);
  // Load enabled bots from database on startup
  const [rows] = await db.query(
    "SELECT name, discordToken FROM bots WHERE enabled = 1"
  );

  for (const { name, discordToken } of rows) {
    addBot(name, discordToken, true);
  }

  // ✅ Ensure the presence is updated even if no bots are loaded
  updateBotManagerPresence();
});

// onMessageCreate, listen to some configured ! commands
botManager.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!")) return;

  const [command, ...args] = message.content.slice(1).split(" ");

  if (command === "clear") {
    // Check if the command was issued in the specified channel
    if (message.channel.id !== DISCORD_BOT_CHANNEL_ID) {
      return message.reply(
        "This command can only be used in the designated bot channel."
      );
    }

    try {
      let fetched;
      do {
        // Fetch up to 100 messages at a time (Discord's limit)
        fetched = await message.channel.messages.fetch({ limit: 100 });
        await message.channel.bulkDelete(fetched, true);
      } while (fetched.size >= 2);

      await message.channel.send(
        "✅ All messages in this channel have been cleared."
      );
    } catch (error) {
      console.error(`Failed to clear messages in channel: ${error.message}`);
      await message.reply(
        "❌ Failed to clear messages. Please try again later."
      );
    }
  } else if (command === "addbot") {
    const name = args[0];
    const token = args[1];

    if (!name || !token) {
      return message.reply(
        "Please provide a bot name and token. Usage: !addbot <name> <token>"
      );
    }

    if (name.length < 1 || name.length > 50) {
      return message.reply("Bot name must be between 1 and 50 characters.");
    }

    try {
      // Delete the original message
      await message.delete();

      // Redact the token and include the user's name in the quoted response
      const redactedMessage = `!addbot ${name} xxx`;
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");

      await db.query(
        "INSERT INTO bots (name, discordToken, enabled, createdOn) VALUES (?, ?, 1, ?)",
        [name, token, now]
      );
      addBot(name, token);

      await message.channel.send(
        `> **${message.author.tag}**: ${redactedMessage}\n✅ Bot **${name}** registered successfully.`
      );
    } catch (error) {
      console.error(error);

      // Log the error and respond
      await message.channel.send("❌ Failed to add the bot: " + error.message);
    }
  } else if (command === "delbot") {
    const name = args[0];

    if (!name) {
      return message.reply("Please provide a bot name. Usage: !delbot <name>");
    }

    try {
      await db.query("UPDATE bots SET enabled = 0 WHERE name = ?", [name]);
      removeBot(name);
      message.reply("Bot unregistered and logged out successfully.");
    } catch (error) {
      console.error(error);
      message.reply("Failed to unregister the bot: " + error);
    }
  } else if (command === "init-url") {
    const name = args[0];
    const initUrl = args[1];

    if (!name || !initUrl) {
      return message.reply(
        "Please provide a bot name and a URL. Usage: !init-url <botname> <url>"
      );
    }

    try {
      // Update the initUrl for the given bot in the database
      const [result] = await db.query(
        "UPDATE bots SET initPresenceUrl = ? WHERE name = ?",
        [initUrl, name]
      );

      if (result.affectedRows === 0) {
        return message.reply(`No bot with the name **${name}** found.`);
      }

      message.reply(
        `✅ The init URL for bot **${name}** has been updated to: ${initUrl}`
      );
    } catch (error) {
      console.error(
        `Failed to update init URL for bot ${name}: ${error.message}`
      );
      message.reply(`❌ Failed to update the init URL for bot **${name}**.`);
    }
  } else if (command === "help") {
    return message.reply(
      "Available commands: !addbot, !init-url, !delbot, !clear"
    );
  }
});

// addBot, connect the discord got and mark it as connected in database
async function addBot(name, token) {
  if (activeBots.has(name)) {
    console.log(`Bot with name ${name} is already active.`);
    return;
  }

  const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

  bot.once("ready", async () => {
    console.log(`Bot logged in as ${bot.user.tag} with name ${name}`);

    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.query(
      "UPDATE bots SET lastConnectedOn = ?, logonError = NULL, enabled = 1, disabledOn = NULL WHERE name = ?",
      [now, name]
    );

    try {
      const channel = await botManager.channels.fetch(DISCORD_BOT_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await channel.send(
          `✅ Bot with name **${name}** successfully logged in as ${bot.user.tag}.`
        );
      }
    } catch (error) {
      console.error(`Failed to send log message to channel: ${error.message}`);
    }

    // Fetch initPresenceUrl from the database
    const [rows] = await db.query(
      "SELECT initPresenceUrl FROM bots WHERE name = ?",
      [name]
    );

    if (rows.length > 0 && rows[0].initPresenceUrl) {
      const initPresenceUrl = rows[0].initPresenceUrl;
      console.log(
        `Sending initial presence request to ${initPresenceUrl} for bot ${name}...`
      );

      try {
        const response = await fetch(initPresenceUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}), // Empty body
        });

        console.log(`Received response with status: ${response.status}`);

        if (response.status === 201) {
          console.log(`Initial presence request successful for bot ${name}.`);
        } else {
          console.warn(
            `Unexpected status code (${response.status}) returned from ${initPresenceUrl}`
          );
        }
      } catch (error) {
        console.error(
          `Failed to send initial presence request for bot ${name}: ${error.message}`
        );
      }
    }

    // Update bot manager's presence
    updateBotManagerPresence();
  });

  bot.on("error", async (err) => {
    console.error(`Bot error (${name}): ${err.message}`);

    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.query(
      "UPDATE bots SET enabled = 0, logonError = ?, disabledOn = ? WHERE name = ?",
      [err.message, now, name]
    );

    try {
      const channel = await botManager.channels.fetch(DISCORD_BOT_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await channel.send(`❌ Bot error for **${name}**: ${err.message}`);
      }
    } catch (error) {
      console.error(
        `Failed to send error message to channel: ${error.message}`
      );
    }
  });

  try {
    await bot.login(token);
    activeBots.set(name, { client: bot, token });
  } catch (error) {
    console.error(`Failed to log in bot with name ${name}: ${error.message}`);

    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.query(
      "UPDATE bots SET enabled = 0, logonError = ?, disabledOn = ? WHERE name = ?",
      [error.message, now, name]
    );

    try {
      const channel = await botManager.channels.fetch(DISCORD_BOT_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await channel.send(
          `❌ Failed to log in bot with name **${name}**: ${error.message}`
        );
      }
    } catch (err) {
      console.error(
        `Failed to send login failure message to channel: ${err.message}`
      );
    }
  }
}

// remove the bot by name and disconnect from discord for it
function removeBot(name) {
  const botInfo = activeBots.get(name);

  if (!botInfo) {
    console.log(`Bot with name ${name} is not active.`);
    return;
  }

  const { client } = botInfo;
  try {
    client.destroy();
    activeBots.delete(name);
    console.log(`Bot with name ${name} has been logged out and removed.`);

    // Update bot manager's presence
    updateBotManagerPresence();
  } catch (error) {
    console.error(`Failed to remove bot with name ${name}: ${error.message}`);
  }
}

// API Endpoint to set bot presence
app.post("/api/bot/presence", async (req, res) => {
  const { name, status } = req.body;

  if (!name || !status) {
    return res.status(400).json({ error: "Name and status are required." });
  }

  const botEntry = activeBots.get(name); // Retrieve the bot entry
  if (!botEntry || !botEntry.client || !botEntry.client.user) {
    return res.status(404).json({ error: "Bot not found or not logged in." });
  }

  const { client } = botEntry; // Extract the client object

  try {
    await client.user.setPresence({
      activities: [{ name: status, type: 3 }], // Type 3 = WATCHING
      status: "online",
    });
    res.json({ message: "Bot presence updated successfully." });
  } catch (error) {
    console.error(
      `Failed to update presence for bot ${name}: ${error.message}`
    );
    res.status(500).json({ error: "Failed to update bot presence." });
  }
});

// Edit the channel topic for the given channelId
function editChannelTopicWith(channelId, topic) {
  botManager.channels
    .fetch(channelId)
    .then((channel) => {
      if (channel.isTextBased()) {
        return channel
          .edit({ topic }) // Update the channel topic
          .then(() => {
            console.log(`Channel topic updated: ${topic}`);
          })
          .catch((err) => {
            console.error(`Failed to update channel topic: ${err.message}`);
          });
      } else {
        console.error("The specified channel is not text-based.");
      }
    })
    .catch((err) => {
      console.error(`Failed to fetch the channel: ${err.message}`);
    });
}

// Function to clear the channel topic and shut down gracefully
async function shutdownGracefully() {
  console.log("Shutting down gracefully...");

  // Set a timeout to force the process to exit after 10 seconds if shutdown hangs
  const shutdownTimeout = setTimeout(() => {
    console.error("Shutdown timed out, forcing exit.");
    process.exit(1);
  }, 10000); // 10 seconds

  try {
    console.log("Clearing channel topic...");

    // Clear the channel topic synchronously
    try {
      const channel = await botManager.channels.fetch(DISCORD_BOT_CHANNEL_ID);
      if (channel && channel.isTextBased()) {
        await channel.edit({ topic: "" });
        console.log("Channel topic cleared successfully.");
      } else {
        console.error(
          "The specified channel is not text-based or could not be fetched."
        );
      }
    } catch (err) {
      console.error(`Failed to clear channel topic: ${err.message}`);
    }

    // Log out all active bots
    for (const [name, { client }] of activeBots.entries()) {
      try {
        await client.destroy();
        console.log(`Bot ${name} logged out.`);
      } catch (err) {
        console.error(`Failed to log out bot ${name}: ${err.message}`);
      }
    }

    // Log out the Bot Manager
    await botManager.destroy();
    console.log("Bot Manager logged out.");

    // Clear the timeout once shutdown completes successfully
    clearTimeout(shutdownTimeout);
    process.exit(0);
  } catch (err) {
    console.error(`Error during shutdown: ${err.message}`);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

// Set up signal handlers
process.on("SIGTERM", shutdownGracefully); // For termination signals (e.g., Docker stop)
process.on("SIGQUIT", shutdownGracefully); // For quit signals
process.on("SIGINT", shutdownGracefully); // For Ctrl+C (manual interruption)

// Start the Bot Manager and API server
botManager
  .login(BOT_MANAGER_DISCORD_TOKEN)
  .then(() => {
    app.listen(LISTEN_API_PORT, () => {
      console.log(`API server running on http://localhost:${LISTEN_API_PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to log in Bot Manager:", err);
  });
