import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
} from 'discord.js';
import { llmPlan, describeAction, isPrivilegedAction } from './llm.js';
import { executePlan } from './actions.js';
import {
  initCrypto, getGuildConfig, resolveLlmConfig, isBotBanned,
  rememberTurn, getTurns, getNotes,
  getTasks, removeTask, getButtonHandler,
} from './store.js';
import { registerCommands, handleSlash, renderTemplate } from './commands.js';

const {
  DISCORD_TOKEN, OWNERS, OWNER_ID, COMMAND_CHANNEL_ID, CONFIG_SECRET,
  LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TEMPERATURE,
  RESPOND_MODE, MAX_STEPS,
} = process.env;

const ownerList = (OWNERS ?? OWNER_ID ?? '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

if (!DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN. Copy .env.example to .env and set it.');
  process.exit(1);
}
if (!CONFIG_SECRET) {
  console.error('Missing CONFIG_SECRET — required to encrypt per-server API keys.');
  console.error('Add a long random string to .env, e.g.:  CONFIG_SECRET=' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  process.exit(1);
}
initCrypto(CONFIG_SECRET);

// Global fallback LLM config (used when a guild hasn't set its own key).
const globalLlm = {
  apiKey: LLM_API_KEY || null,
  baseUrl: (LLM_BASE_URL || 'https://api.mistral.ai/v1').replace(/\/$/, ''),
  model: LLM_MODEL || 'mistral-small-latest',
  temperature: LLM_TEMPERATURE != null ? Number(LLM_TEMPERATURE) : 0.4,
};

const defaultRespondMode = (RESPOND_MODE || 'mention').toLowerCase();
const maxSteps = Math.min(Math.max(Number(MAX_STEPS) || 3, 1), 6);

// ---------- role tiers: bot owner > server owner > admin/staff > member ----------

function isBotOwner(author) {
  return (
    ownerList.includes(author.id) ||
    ownerList.includes(author.username?.toLowerCase()) ||
    (author.globalName && ownerList.includes(author.globalName.toLowerCase()))
  );
}

// 'botowner' | 'serverowner' | 'staff' | 'member'
function userTier(message) {
  if (isBotOwner(message.author)) return 'botowner';
  if (message.guild && message.guild.ownerId === message.author.id) return 'serverowner';
  const perms = message.member?.permissions;
  if (perms && (
    perms.has(PermissionsBitField.Flags.Administrator) ||
    perms.has(PermissionsBitField.Flags.ManageGuild) ||
    perms.has(PermissionsBitField.Flags.BanMembers) ||
    perms.has(PermissionsBitField.Flags.KickMembers) ||
    perms.has(PermissionsBitField.Flags.ModerateMembers)
  )) return 'staff';
  return 'member';
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildExpressions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember],
});

// DM history (guild memory lives in store.js and persists to disk).
const dmHistories = new Map();
function rememberDm(channelId, role, text) {
  const h = dmHistories.get(channelId) ?? [];
  h.push({ role, text: String(text).slice(0, 300) });
  while (h.length > 14) h.shift();
  dmHistories.set(channelId, h);
}

function remember(message, role, text) {
  if (message.guild) rememberTurn(message.guild.id, message.channelId, role, text);
  else rememberDm(message.channelId, role, text);
}

function buildContext(message, tier) {
  const g = message.guild;
  const tierLabel = {
    botowner: 'BOT OWNER (full access)',
    serverowner: 'SERVER OWNER (full access in this server)',
    staff: 'STAFF/ADMIN (may run moderation & destructive actions)',
    member: 'REGULAR MEMBER (safe/info/chat actions only)',
  }[tier];
  const lines = [
    `Requester: ${message.author.username} (${message.author.id})`,
    `Requester role: ${tierLabel}`,
  ];
  if (g) {
    lines.push(
      `Server: ${g.name}`,
      `Current channel: #${message.channel.name} (${message.channel.id})`,
      `Roles: ${g.roles.cache.filter(r => r.id !== g.id).map(r => r.name).slice(0, 40).join(', ')}`,
      `Text channels: ${g.channels.cache.filter(c => c.isTextBased?.()).map(c => `#${c.name}`).slice(0, 40).join(', ')}`,
      `Voice channels: ${g.channels.cache.filter(c => c.isVoiceBased?.()).map(c => c.name).slice(0, 20).join(', ')}`,
    );
    const notes = getNotes(g.id);
    if (notes.length) lines.push(`SAVED NOTES (long-term memory for this server):\n${notes.map(n => `- ${n}`).join('\n')}`);
    const h = getTurns(g.id, message.channelId);
    if (h.length) lines.push(`Recent conversation:\n${h.map(x => `${x.role}: ${x.text}`).join('\n')}`);
  } else {
    lines.push('Context: Direct Message (no guild — only conversational replies and info are possible).');
    const h = dmHistories.get(message.channelId) ?? [];
    if (h.length) lines.push(`Recent conversation:\n${h.map(x => `${x.role}: ${x.text}`).join('\n')}`);
  }
  return lines.filter(Boolean).join('\n');
}

function resultsEmbed(plan, results, model) {
  const ok = results.filter(r => !r.startsWith('❌') && !r.startsWith('⚠️')).length;
  const failed = results.length - ok;
  return new EmbedBuilder()
    .setTitle(plan.summary ? `✨ ${plan.summary}` : '✨ Done')
    .setDescription(results.join('\n').slice(0, 4000) || 'Task completed successfully.')
    .setColor(failed === 0 ? 0x2b2d31 : ok === 0 ? 0xed4245 : 0xfee75c)
    .setFooter({ text: `Gen AI Powered | Multipurpose Devil Player Bot • ${model}` })
    .setTimestamp();
}

async function confirmPlan(plan, message) {
  const preview = new EmbedBuilder()
    .setTitle(`⚠️ Confirm: ${plan.summary ?? 'planned actions'}`)
    .setDescription(plan.actions.map((a, i) => `**${i + 1}.** ${describeAction(a)}`).join('\n').slice(0, 4000))
    .setColor(0xfee75c)
    .setFooter({ text: plan.thinking ? String(plan.thinking).slice(0, 100) : 'Review before executing' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm').setLabel('✅ Execute').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('cancel').setLabel('❌ Cancel').setStyle(ButtonStyle.Danger),
  );

  const prompt = await message.reply({ embeds: [preview], components: [row] });

  try {
    const click = await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === message.author.id || isBotOwner(i.user),
      time: 60_000,
    });
    const confirmed = click.customId === 'confirm';
    await click.update({
      embeds: [preview.setColor(confirmed ? 0x57f287 : 0xed4245).setTitle(
        confirmed ? `▶️ Executing: ${plan.summary ?? ''}` : `🚫 Cancelled: ${plan.summary ?? ''}`
      )],
      components: [],
    });
    return confirmed;
  } catch {
    await prompt.edit({
      embeds: [preview.setColor(0x99aab5).setTitle(`⏰ Timed out (not executed): ${plan.summary ?? ''}`)],
      components: [],
    }).catch(() => {});
    return false;
  }
}

function gatePlan(plan, tier) {
  const privileged = tier !== 'member';
  if (privileged) return { allowed: plan.actions, blocked: [] };
  const allowed = [];
  const blocked = [];
  for (const a of plan.actions) {
    if (isPrivilegedAction(a.type)) blocked.push(a);
    else allowed.push(a);
  }
  return { allowed, blocked };
}

async function shouldRespond(message) {
  if (message.author.bot) return false;
  if (!message.guild) return true; // DMs: always
  const gcfg = getGuildConfig(message.guild.id);
  const mode = (gcfg.respondMode || defaultRespondMode).toLowerCase();
  const cmdChannel = gcfg.commandChannelId || COMMAND_CHANNEL_ID;
  if (mode === 'all') return true;
  if (mode === 'command') return message.channelId === cmdChannel;
  if (cmdChannel && message.channelId === cmdChannel) return true;
  if (message.mentions.has(client.user)) return true;
  if (message.reference?.messageId) {
    try {
      const repliedTo = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
      if (repliedTo && repliedTo.author.id === client.user.id) return true;
    } catch {}
  }
  return false;
}

function cleanPrompt(message) {
  let text = message.content;
  if (message.mentions.users.has(client.user.id)) {
    text = text.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '');
  }
  if (message.guild?.members.me) {
    message.mentions.roles.forEach(role => {
      if (message.guild.members.me.roles.cache.has(role.id)) {
        text = text.replace(new RegExp(`<@&${role.id}>`, 'g'), '');
      }
    });
  }
  return text.trim();
}

// ---------- the core: run a prompt through the agent loop ----------

async function runPrompt(message, promptText, tier) {
  const llmCfg = resolveLlmConfig(message.guild?.id, globalLlm);
  if (!llmCfg.apiKey) {
    await message.reply({
      embeds: [new EmbedBuilder().setTitle('🔑 No LLM key configured')
        .setDescription('This server has no LLM API key yet.\nAn admin can set one (free at console.mistral.ai) with:\n`/config setkey`\nKeys are stored **encrypted** and only used for this server.')
        .setColor(0xfee75c)],
    });
    return;
  }

  await message.channel.sendTyping().catch(() => {});
  remember(message, message.author.username, promptText);

  let followup = '';
  for (let step = 0; step < maxSteps; step++) {
    let plan;
    try {
      const ctx = buildContext(message, tier) + followup;
      plan = await llmPlan(promptText, ctx, llmCfg);
    } catch (err) {
      console.error('LLM error:', err.message);
      await message.reply({
        embeds: [new EmbedBuilder().setTitle('🧠 LLM error')
          .setDescription(`Couldn't plan that: ${err.message}`.slice(0, 4000)).setColor(0xed4245)],
      });
      return;
    }

    if (plan.actions.length === 1 && plan.actions[0].type === 'reply') {
      const text = plan.actions[0].text ?? '…';
      remember(message, 'GENBOT', text);
      await message.reply({
        embeds: [new EmbedBuilder().setDescription(text.slice(0, 4000)).setColor(0x2b2d31).setFooter({ text: 'Gen AI Powered | Multipurpose Devil Player Bot' }).setTimestamp()],
      });
      return;
    }

    const { allowed, blocked } = gatePlan(plan, tier);
    if (blocked.length) {
      const names = [...new Set(blocked.map(a => a.type))].join(', ');
      await message.reply({
        embeds: [new EmbedBuilder().setTitle('🔒 Staff only')
          .setDescription(`Sorry ${message.author}, I can only do **${names}** for server staff. Ask a mod/admin, or I'm happy to help with anything else! 🙂`)
          .setColor(0xed4245)],
      });
      if (allowed.length === 0) return;
      plan.actions = allowed;
    }

    if (!message.guild && plan.actions.some(a => a.type !== 'reply')) {
      await message.reply('I can only run server actions inside a server channel — but ask me anything here! 🙂');
      return;
    }

    if (plan.confirm) {
      const approved = await confirmPlan(plan, message);
      if (!approved) {
        remember(message, 'GENBOT', `cancelled: ${plan.summary ?? 'plan'}`);
        return;
      }
    }

    let { results, embeds } = await executePlan(plan, message);
    remember(message, 'GENBOT', results.join(' | '));
    
    if (results.length > 0 || embeds.length === 0) {
      embeds.push(resultsEmbed(plan, results, llmCfg.model));
    }
    await message.reply({ embeds: embeds.slice(0, 10) });

    const failed = results.filter(r => r.startsWith('❌') || r.startsWith('⚠️'));
    if (failed.length === 0 || step === maxSteps - 1) return;
    followup = `\n\nACTION RESULTS (previous step — fix failures or finish with a reply):\n${results.join('\n')}`;
  }
}

// ---------- events ----------

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Default respond mode: ${defaultRespondMode}`);
  console.log(`Bot owners: ${ownerList.join(', ') || '(none — Discord permissions only)'}`);
  console.log(`Fallback LLM: ${globalLlm.model} @ ${globalLlm.baseUrl} ${globalLlm.apiKey ? '(key set)' : '(NO global key — servers must bring their own)'}`);
  try {
    await registerCommands(DISCORD_TOKEN, client.application.id);
    console.log('Slash commands registered.');
  } catch (e) {
    console.error('Slash command registration failed:', e.message);
  }

  // Persistent task runner (schedules, giveaways)
  setInterval(async () => {
    const tasks = getTasks();
    const now = Date.now();
    for (const task of tasks) {
      if (now >= task.executeAt) {
        removeTask(task.id);
        try {
          if (task.type === 'schedule') {
            const ch = await client.channels.fetch(task.data.channelId).catch(() => null);
            if (ch?.isTextBased?.()) {
              await ch.send(task.data.text);
            }
          } else if (task.type === 'giveaway') {
            const ch = await client.channels.fetch(task.data.channelId).catch(() => null);
            if (ch?.isTextBased?.()) {
              const msg = await ch.messages.fetch(task.data.messageId).catch(() => null);
              if (msg) {
                const reaction = msg.reactions.cache.get('🎉');
                const users = reaction ? (await reaction.users.fetch()).filter(u => !u.bot) : null;
                if (!users || users.size === 0) {
                  await ch.send(`🎉 Giveaway for **${task.data.prize}** ended — no entries.`);
                } else {
                  const winner = users.random();
                  await ch.send(`🎉 Giveaway ended! Winner of **${task.data.prize}**: ${winner} — congratulations!`);
                }
              }
            }
          }
        } catch (e) {
          console.error(`Task ${task.id} failed:`, e.message);
        }
      }
    }
  }, 10000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('btnmsg:')) {
        const text = getButtonHandler(interaction.customId);
        if (text) await interaction.reply({ content: text, ephemeral: true }).catch(() => {});
        else await interaction.reply({ content: 'Thanks!', ephemeral: true }).catch(() => {});
        return;
      }
      if (interaction.customId.startsWith('rolebtn:')) {
        const roleId = interaction.customId.split(':')[1];
        const role = interaction.guild?.roles.cache.get(roleId);
        if (!role) {
          await interaction.reply({ content: '⚠️ Role no longer exists.', ephemeral: true }).catch(() => {});
          return;
        }
        const member = interaction.member;
        if (member.roles.cache.has(role.id)) {
          await member.roles.remove(role);
          await interaction.reply({ content: `➖ Removed **${role.name}**`, ephemeral: true }).catch(() => {});
        } else {
          await member.roles.add(role);
          await interaction.reply({ content: `➕ Added **${role.name}**`, ephemeral: true }).catch(() => {});
        }
        return;
      }
    }
    await handleSlash(interaction);
  } catch (e) {
    console.error('Interaction error:', e);
  }
});

client.on('guildMemberAdd', async (member) => {
  try {
    const cfg = getGuildConfig(member.guild.id);
    if (!cfg.welcome.enabled || !cfg.welcome.channelId) return;
    const ch = await member.guild.channels.fetch(cfg.welcome.channelId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    await ch.send({
      embeds: [new EmbedBuilder()
        .setDescription(renderTemplate(cfg.welcome.message, member))
        .setColor(0x57f287)
        .setThumbnail(member.user.displayAvatarURL())],
    });
  } catch (e) { console.error('welcome error:', e.message); }
});

client.on('guildMemberRemove', async (member) => {
  try {
    const cfg = getGuildConfig(member.guild.id);
    if (!cfg.bye.enabled || !cfg.bye.channelId) return;
    const ch = await member.guild.channels.fetch(cfg.bye.channelId).catch(() => null);
    if (!ch?.isTextBased?.()) return;
    await ch.send({
      embeds: [new EmbedBuilder()
        .setDescription(renderTemplate(cfg.bye.message, member))
        .setColor(0x99aab5)],
    });
  } catch (e) { console.error('bye error:', e.message); }
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    // Per-server bot-ban: silently ignore blocked users.
    if (message.guild && isBotBanned(message.guild.id, message.author.id)) return;

    const tier = message.guild ? userTier(message) : (isBotOwner(message.author) ? 'botowner' : 'member');

    // Custom commands: "!name [extra words]" -> run the stored prompt through the LLM.
    if (message.guild && message.content.startsWith('!')) {
      const [raw, ...rest] = message.content.slice(1).split(/\s+/);
      const name = raw?.toLowerCase();
      const custom = name && getGuildConfig(message.guild.id).customCommands[name];
      if (custom) {
        const extra = rest.join(' ');
        const prompt = extra
          ? `${custom.prompt}\n\nAdditional input from the user: ${extra}`
          : custom.prompt;
        await runPrompt(message, prompt, tier);
        return;
      }
    }

    if (!(await shouldRespond(message))) return;

    const promptText = cleanPrompt(message) || '(no text — greet the user and offer help)';
    await runPrompt(message, promptText, tier);
  } catch (err) {
    console.error('Handler error:', err);
    await message.reply({
      embeds: [new EmbedBuilder().setTitle('❌ Error').setDescription(String(err.message).slice(0, 4000)).setColor(0xed4245)],
    }).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
