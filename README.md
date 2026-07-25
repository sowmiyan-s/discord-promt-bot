# Discord LLM Prompt-to-Action Bot

A Discord bot with a **brain**. The owner talks to it in plain natural language inside one
designated "command channel", an LLM understands the intent, plans one or more actions,
and the bot executes them for real — bans, kicks, embeds, reactions, polls, channel
management, and more.

```
Owner:  "yo, timeout @Spammer for half an hour for flooding, and post a red embed
         in #announcements titled 'Rules Reminder' telling people to stop spamming"

Bot:    🤐 Timed out @Spammer for 30 min — flooding
        📨 Embed sent in #announcements
```

## How it works

```
Owner message (command channel only)
        │
        ▼
  Is author an owner? (matched by user ID OR username)
        │
        ▼
  LLM planner — ONE efficient call returns:
  { thinking, actions: [...], confirm, summary }
        │
        ├─ confirm=true (risky: ban/kick/prune/deletes/@everyone/...)
        │        │
        │        ▼
        │  ⚠️ Preview embed + [✅ Execute] [❌ Cancel] buttons
        │  (60s timeout = auto-cancel; only owners can click)
        │
        ▼
  Action executor → runs each action via discord.js
        │
        ▼
  ✅ Result embed (green=all ok, yellow=partial, red=failed)
```

Fully LLM-driven — there is **no rule-based parser**. The LLM understands intent,
resolves pronouns from conversation history, plans multi-step workflows, and flags
risky plans for button confirmation. `LLM_API_KEY` is required.

## Capabilities

| Category | Actions |
|---|---|
| Moderation | ban (with message-delete days), unban, kick, timeout / untimeout, warn (DM), purge, slowmode, lock / unlock channel, member prune (with dry-run preview) |
| Roles & members | add role, remove role, create role (with color), change/reset nickname |
| Messaging | say, rich embeds (title, description, color, fields, footer, image, thumbnail), DM a user, react to messages (last / ID / link), pin / unpin, delete message, edit bot's own messages, polls, announcements (@everyone/@here + embed), scheduled messages & reminders, giveaways with auto winner pick |
| Interactive buttons | custom button messages (primary/secondary/success/danger/link styles, per-button ephemeral replies), self-assign **role-picker buttons** (click to toggle a role), confirm/cancel safety buttons on risky plans |
| Voice | move member between voice channels, disconnect from voice, server mute/unmute, deafen/undeafen |
| Threads | create thread (from a message or standalone), archive thread |
| Channels & server | create text/voice channel (optionally in category), create category, delete/rename channel, set topic, create invite (custom expiry/uses), create/delete custom emoji, scheduled server events, server info |
| Info & lists | user info, avatar, list bans / roles / channels / emojis / invites, recent audit log |
| Conversational | plain replies, clarifying questions, **conversation memory** — follow-ups like "now unban him" or "do that again in #general" work |

One prompt can trigger **multiple actions** — the LLM returns them in order and the bot
executes them sequentially, reporting each result (including per-action failures).

## Setup

### 1. Create the Discord bot

1. Go to https://discord.com/developers/applications → **New Application**
2. **Bot** tab → **Reset Token** → copy the token
3. On the same page, enable Privileged Gateway Intents:
   - ✅ **SERVER MEMBERS INTENT**
   - ✅ **MESSAGE CONTENT INTENT**
4. **OAuth2 → URL Generator**: scope `bot`, permissions: Ban Members, Kick Members,
   Moderate Members, Manage Channels, Manage Roles, Manage Messages, Manage Nicknames,
   Send Messages, Embed Links, Add Reactions, Read Message History.
   Or just use Administrator for a private server. Open the generated URL and invite the bot.

### 2. Get your IDs

Enable Developer Mode in Discord (User Settings → Advanced → Developer Mode), then:
- Right-click the channel you want as the command channel → **Copy Channel ID**
- (Optional) Right-click yourself → **Copy User ID** — or just use your username

### 3. Configure

```bash
cd discord-prompt-bot
cp .env.example .env
```

Edit `.env`:

```ini
DISCORD_TOKEN=your-bot-token

# Owners: comma-separated user IDs and/or usernames — either works, mix freely
OWNERS=123456789012345678,coolusername

COMMAND_CHANNEL_ID=1234567890123456789

# LLM — Mistral free tier (default)
LLM_API_KEY=your-mistral-api-key
LLM_BASE_URL=https://api.mistral.ai/v1
LLM_MODEL=mistral-small-latest
```

**Getting a free Mistral API key:**

1. Go to https://console.mistral.ai and sign up (free)
2. When asked to choose a plan, pick the free **Experiment** tier (no credit card)
3. Left sidebar → **API Keys** → **Create new key** → copy it into `LLM_API_KEY`

Free-tier models: `mistral-small-latest` (recommended) or `open-mistral-nemo`.
Note: the free tier is rate-limited (~1 request/second) — fine for a command channel.

**Other providers also work** (the bot speaks the OpenAI-compatible API):

| Provider | LLM_BASE_URL | LLM_MODEL (example) |
|---|---|---|
| Mistral (default, free) | `https://api.mistral.ai/v1` | `mistral-small-latest` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Groq (free tier) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct` |
| Ollama (local) | `http://localhost:11434/v1` | `llama3.1` (key can be `ollama`) |

Leave `LLM_API_KEY` empty to run in regex-fallback mode.

### 4. Run

```bash
npm install
npm start
```

You should see:

```
Logged in as YourBot#1234
Command channel: 1234567890123456789
Owners: 123456789012345678, coolusername
LLM: gpt-4o-mini @ https://api.openai.com/v1
```

## Example prompts (LLM mode)

```
ban @Troll he keeps posting scam links, delete his messages from the last day
kick @Rude for insulting members
timeout @Spammer 2 hours flooding the chat
remove the timeout from @Spammer
warn @Newbie please read the rules in #rules
give @Helper the Moderator role
create a role called VIP with gold color
nickname @Bob "Bob the Builder"
send an embed in #announcements titled "Server Update" saying we hit 1000 members, green color, add a field "Next goal" with value "2000!"
say in #general good morning everyone!
dm @Winner congrats, you won the giveaway!
react to the last message with 🔥 and 💯
pin the last message
make a poll in #general asking "pizza or burgers?" with options pizza, burgers, both
purge 50
set slowmode to 10 seconds
lock this channel        /        unlock #general
create a text channel called memes under the Fun category
set this channel topic to "owner commands only"
show server info         /        who is @SomeUser
list all bans / roles / channels / emojis / invites
show the last 10 audit log entries
-- voice --
move @User to the Lounge voice channel
disconnect @User from voice        /        server mute @User
-- threads --
create a thread called "bug reports" from the last message
archive the "bug reports" thread
-- advanced --
announce in #news with @everyone: title "Big News", we just hit 10k members!
remind me in 45 minutes to check the giveaway
start a giveaway in #general for "Discord Nitro" lasting 2 hours
create an invite that expires in 12 hours with max 10 uses
create an emoji called partyblob from https://example.com/blob.gif
schedule an event "Movie Night" tomorrow-ish (e.g. "in 3 hours, 2 hours long, in the Cinema voice channel")
how many members would a 30-day prune kick?   (dry run first, then "prune for real")
-- buttons --
post a message in #roles with buttons for the Gamer, Artist and Musician roles so people can self-assign
send a message with a green button saying "Claim reward" that replies "You claimed it!" to whoever clicks
post a message with a link button to our website https://example.com
```

Risky prompts get a **confirmation embed with buttons** before anything happens:

```
Owner: ban @Troll and purge his last 50 messages
Bot:   ⚠️ Confirm: Ban @Troll + purge 50
       1. 🔨 Ban @Troll — no reason
       2. 🧹 Purge 50 messages
       [ ✅ Execute ]  [ ❌ Cancel ]     (auto-cancels after 60s)
```

Follow-ups work thanks to conversation memory:

```
Owner: timeout @Spammer 1 hour
Bot:   🤐 Timed out @Spammer for 60 min
Owner: actually remove it
Bot:   🔊 Removed timeout from @Spammer
```

Ambiguous prompt? The bot asks for clarification instead of guessing:

```
Owner: ban him
Bot:   Who should I ban? Please mention the user or provide their ID.
```

## Security model

- Only messages in `COMMAND_CHANNEL_ID` are processed — everything else is ignored.
- Only authors matching `OWNERS` (by user ID, username, or display name) are obeyed.
- Bots are always ignored (no bot-loop).
- **Confirm-before-acting**: destructive plans (ban, kick, real prune, channel/message
  deletes, big purges, @everyone pings, timeouts >1h) require clicking ✅ Execute on a
  preview embed. The risk check is enforced server-side too — even if the LLM claims a
  ban is "safe", the bot still demands confirmation. Only owners can click the buttons.
- The LLM only ever returns a JSON plan from a fixed action whitelist — it cannot
  invent arbitrary code, and each plan is capped at 10 actions.
- All action failures are caught per-action and reported in the result embed.

## Project structure

```
discord-prompt-bot/
├── src/
│   ├── index.js             # Discord client, owner/channel gate, confirmation buttons, embed replies
│   ├── llm.js               # LLM planner (single-call plan+risk+summary), server-side risk check
│   └── actions.js           # Executor for 50+ action types incl. interactive buttons
├── scripts/
│   └── check-intents.mjs    # Intent verification script for Discord application flags
├── test/
│   └── bot.test.js          # 32 tests (risk logic, LLM planner w/ mocked fetch, executor w/ mocked discord)
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Helper Scripts & Testing

```bash
# Run 32 unit tests (confirmation logic, LLM JSON handling, action executor)
npm test

# Verify Discord Bot Gateway Intents setup
npm run check-intents
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Bot doesn't respond at all | Check it's the right channel ID, and MESSAGE CONTENT intent is enabled in the dev portal |
| "Cannot ban that user" | Bot's role must be ABOVE the target's highest role (drag it up in Server Settings → Roles) |
| "Missing Permissions" | Re-invite with the permissions listed above |
| LLM errors in console | Check `LLM_API_KEY` / `LLM_BASE_URL`; bot auto-falls back to regex mode per message |
| purge misses old messages | Discord API cannot bulk-delete messages older than 14 days |

## Extending

Add a new capability in two places:
1. `src/llm.js` — document the new action type in `SYSTEM_PROMPT` so the LLM can plan it.
2. `src/actions.js` — add a `case 'yourType':` in `executeAction`.

That's it — no command registration needed.
