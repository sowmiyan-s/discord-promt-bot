# GENBOT — LLM-Powered Discord Bot

A 100% LLM-powered Discord bot that generates and executes dynamic automation scripts, manages long-term activities, and engages in natural conversation. No hardcoded commands — you talk to it like a person and it takes real Discord actions.

## Quick Start

```bash
# 1. Copy env template and fill in
cp .env.example .env
# Edit .env: set DISCORD_TOKEN, CONFIG_SECRET (random string), and optionally LLM_API_KEY

# 2. Install
npm install

# 3. Start
npm start
```

## Architecture

See [docs/architecture.html](docs/architecture.html) for the full system diagram (open in any browser).

```
Discord Gateway → discord.js Client → Event Handlers → LLM Agent Loop →
Action Executor → Discord API
                              ↕
                    Persistent Store (encrypted)
```

**Core modules:**
- `src/index.js` — event wiring, agent loop, 9 gateway intents
- `src/llm.js` — SYSTEM_PROMPT, JSON plan parser, risk gates (50 action types)
- `src/actions.js` — 50 `executeAction` handlers: moderation, roles, messaging, voice, threads, channels, info, memory, runScript
- `src/store.js` — AES-256-GCM encrypted guild config, conversation memory, scheduled tasks
- `src/commands.js` — 6 slash command groups: /config, /welcome, /bye, /botban, /customcmd, /memory

## Features

### LLM Agent Loop
- Single efficient LLM call per step (JSON mode, any OpenAI-compatible endpoint)
- Up to 6 retry steps with ACTION RESULTS feedback — the LLM sees what worked and what failed
- Confirmation dialog for risky plans (ban/kick/prune/lock/@everyone)
- Server-side risk enforcement as a belt-and-braces safety net
- 50-action cap per plan

### Role-Based Access
- **Bot owner** — full access everywhere
- **Server owner** — full access in their server
- **Staff/admin** — moderation and destructive actions
- **Member** — safe/info/chat actions only

### Persistent Storage
- Per-guild config (welcome/bye messages, custom commands, bot bans, respond mode)
- Conversation turns (20 per channel rolling window)
- Long-term notes (40 per server — LLM-remembered facts and job state)
- Scheduled tasks and giveaways survive bot restarts
- Button message handlers persist across restarts

### Per-Guild LLM Keys
- Each server can bring its own API key (encrypted at rest with AES-256-GCM)
- Falls back to the bot's global key if not set
- Supports any OpenAI-compatible endpoint (Mistral, OpenAI, local models)

### 50 Action Types
**Moderation:** ban, unban, kick, timeout, untimeout, warn, purge, slowmode, lock, unlock
**Roles/Members:** addRole, removeRole, createRole, nickname
**Messaging:** say, embed, dm, react, pin, unpin, poll, buttonMessage, roleButtons
**Voice:** voiceMove, voiceKick, voiceMute, voiceDeafen
**Threads:** createThread, archiveThread
**Advanced messaging:** deleteMessage, editBotMessage, announce, schedule, giveaway
**Channels/Server:** createChannel, deleteChannel, renameChannel, topic, createCategory, setChannelCategory, createInvite, createEmoji, deleteEmoji, createEvent, prune
**Info/Lists:** serverInfo, userInfo, avatar, listBans, listRoles, listChannels, listEmojis, listInvites, auditLog
**Memory:** remember, forget
**Advanced:** runScript (dynamic discord.js code execution)

## Security

- `DISCORD_TOKEN` — bot token from Discord Developer Portal
- `CONFIG_SECRET` — long random string used to derive the encryption key for per-guild API keys (min 8 chars)
- Per-guild LLM API keys are encrypted with AES-256-GCM using a key derived from CONFIG_SECRET via scrypt
- Without CONFIG_SECRET, stored blobs are unreadable
- Role tiers + privileged action gates prevent members from running destructive actions

## Commands

### Slash Commands (admin-only unless noted)
- `/config setkey` — set per-guild LLM API key (encrypted)
- `/config clearkey` — remove per-guild key
- `/config show` — show current config
- `/config channel` — set command channel
- `/config mode` — set respond mode (mention/all/command)
- `/welcome set` / `/welcome off` / `/welcome test`
- `/bye set` / `/bye off`
- `/botban add` / `/botban remove` / `/botban list`
- `/customcmd create` / `/customcmd delete` / `/customcmd list`
- `/memory show` / `/memory forget` / `/memory clear`

### Chat
- `!commandname [extra]` — run a custom command (powered by LLM)
- Mention the bot or send a message in the command channel — the LLM handles the rest

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | yes | — | Bot token |
| `CONFIG_SECRET` | yes | — | Encryption secret (min 8 chars) |
| `OWNER_ID` / `OWNERS` | no | — | Bot owner ID(s) |
| `COMMAND_CHANNEL_ID` | no | — | Default command channel |
| `LLM_API_KEY` | no | — | Global fallback LLM key |
| `LLM_BASE_URL` | no | `https://api.mistral.ai/v1` | OpenAI-compatible endpoint |
| `LLM_MODEL` | no | `mistral-small-latest` | Model name |
| `LLM_TEMPERATURE` | no | `0.4` | Temperature |
| `RESPOND_MODE` | no | `mention` | Default respond mode |
| `MAX_STEPS` | no | `3` | Max agent loop steps (1-6) |

## Running Tests

```bash
npm test
```

39 tests cover: LLM plan parsing, action execution, guild config persistence, encryption, and risk gating.

## License

MIT
