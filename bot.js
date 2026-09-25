import { Bot } from "grammy";

const token = process.env.BOT_TOKEN;

if (!token) {
  throw new Error("BOT_TOKEN is missing");
}

const bot = new Bot(token);

bot.command("start", async (ctx) => {
  await ctx.reply(
    "🛍️ Welcome to Shopper's Suggestions!\n\n" +
    "I'm your product publishing bot.\n\n" +
    "More features are coming soon."
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Available commands:\n\n" +
    "/start — Start the bot\n" +
    "/help — Show this message"
  );
});

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;

  await ctx.reply(
    "I received your message.\n\n" +
    "Product publishing will be connected soon."
  );
});

bot.start();

console.log("Shopper's Suggestions bot is running.");
