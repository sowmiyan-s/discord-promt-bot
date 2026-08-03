# GENBOT — 100% LLM-Powered Discord Bot

A state-of-the-art Discord bot with a real **brain**, long-term memory, and the power of dynamic automation. Unlike traditional rule-based bots that parse `!commands`, GENBOT understands natural language intent. It doesn't just execute predefined tasks—it can **dynamically write and execute JavaScript code on the fly** to perform complex bulk server operations based on your requests. 

It's a genuine Discord server administrator, moderator, and conversationalist.

```
You:    "yo GENBOT, timeout @Spammer for half an hour for flooding, and post a red embed
         in #announcements titled 'Rules Reminder' telling people to stop spamming"

GENBOT: ✨ Done
        [Embed sent in #announcements]
```

## ✨ Features

- **100% LLM-Powered (`runScript`)**: GENBOT can generate raw `discord.js` scripts natively in the background to handle infinitely complex automation, restructuring, and bulk-operations. 
  *Example: "Rename every channel in the Archive category to start with 🔒"*
- **Persistent Long-Term Memory**: Tasks, schedules, and button interactions are saved to disk (`data/tasks.json`, `data/buttons.json`). You can ask GENBOT to schedule a message 3 weeks from now, restart your server 100 times, and the task will still execute exactly on time.
- **Dynamic Styling**: Features a unified, cohesive, and premium dark-themed embed design out of the box (`#2b2d31`), replacing spammy duplicate messages.
- **Talks to everyone**: @mention it, DM it, reply to it (even without a ping), or drop a message in its dedicated command channel.
- **Personality**: Warm, witty, and concise; matches your language and energy (tunable via `LLM_TEMPERATURE`).
- **Permission-aware & Secure**: Anyone can chat, but **only server owners/staff** can trigger moderation or destructive actions. Dangerous bulk actions will **always** trigger a red-box Confirm/Cancel preview, showing you exactly what the AI intends to do (and the code it wrote) before execution.

## ⚙️ How it works

```
Any message (mention / reply / command channel)
        │
        ▼
  Is the requester owner/staff?  (config OWNERS or Discord mod permissions)
        │
        ▼
  LLM planner — returns { thinking, actions: [...], confirm, summary }
        │
        ├─ non-staff asked for a destructive action?  → politely refused
        │
        ├─ confirm=true (risky: runScript/ban/kick/bulkDelete/...)
        │        │
        │        ▼
        │  ⚠️ Preview embed + [✅ Execute] [❌ Cancel] buttons (60s auto-cancel)
        │
        ▼
  Action executor → runs each action or evaluates dynamic scripts natively
        │
        ▼
  ✨ Unified Embed Result → if a step failed, results are fed back to the LLM for another pass
```

## 🚀 Setup

1. **Clone this repository**
   ```bash
   git clone https://github.com/rdx-sparrow/discord-prompt-bot.git
   cd discord-prompt-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment Setup**
   Copy `.env.example` to `.env` and fill it out:
   - `DISCORD_TOKEN`: Your Discord bot token (enable Message Content, Server Members, and Presence intents).
   - `COMMAND_CHANNEL_ID`: (Optional) The channel where the bot listens to every message without needing a ping.
   - `LLM_API_KEY`: API key for your LLM (Mistral API recommended for top-tier JSON parsing).
   - `LLM_MODEL`: e.g., `mistral-small-latest`.

4. **Start the bot**
   ```bash
   npm start
   ```

## ⚖️ License
This project is open-source under the [MIT License](LICENSE).
