import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType,
} from 'discord.js';
import { llmPlan, describeAction } from './llm.js';
import { executePlan } from './actions.js';

const { DISCORD_TOKEN, OWNERS, OWNER_ID, COMMAND_CHANNEL_ID, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL } = process.env;

const ownerList = (OWNERS ?? OWNER_ID ?? '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

if (!DISCORD_TOKEN || ownerList.length === 0 || !COMMAND_CHANNEL_ID) {
  console.error('Missing env vars. Copy .env.example to .env and set DISCORD_TOKEN, OWNERS, COMMAND_CHANNEL_ID.');
  process.exit(1);
}

if (!LLM_API_KEY) {
  console.error('LLM_API_KEY is required — this bot is fully LLM-driven (no rule-based mode).');
  console.error('Get a free key at https://console.mistral.ai and set it in .env');
  process.exit(1);
}

const llmCfg = {
  apiKey: LLM_API_KEY,
  baseUrl: LLM_BASE_URL || 'https://api.mistral.ai/v1',
  model: LLM_MODEL || 'mistral-small-latest',
};

function isOwner(author) {
  return (
    ownerList.includes(author.id) ||
    ownerList.includes(author.username.toLowerCase()) ||
    (author.globalName && ownerList.includes(author.globalName.toLowerCase()))
  );
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
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Rolling conversation history so the LLM can resolve "him", "that channel", "do it again"
const history = []; // { role: 'owner'|'bot', text }
function remember(role, text) {
  history.push({ role, text: String(text).slice(0, 300) });
  while (history.length > 12) history.shift();
}

function buildContext(message) {
  return [
    `Server: ${message.guild.name}`,
    `Current channel: #${message.channel.name} (${message.channel.id})`,
    `Roles: ${message.guild.roles.cache.filter(r => r.id !== message.guild.id).map(r => r.name).slice(0, 40).join(', ')}`,
    `Text channels: ${message.guild.channels.cache.filter(c => c.isTextBased?.()).map(c => `#${c.name}`).slice(0, 40).join(', ')}`,
    `Voice channels: ${message.guild.channels.cache.filter(c => c.isVoiceBased?.()).map(c => c.name).slice(0, 20).join(', ')}`,
    history.length ? `Recent conversation:\n${history.map(h => `${h.role}: ${h.text}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

function resultsEmbed(plan, results) {
  const ok = results.filter(r => !r.startsWith('❌') && !r.startsWith('⚠️')).length;
  const failed = results.length - ok;
  return new EmbedBuilder()
    .setTitle(plan.summary ? `✅ ${plan.summary}` : '✅ Done')
    .setDescription(results.join('\n').slice(0, 4000) || 'No output.')
    .setColor(failed === 0 ? 0x57f287 : ok === 0 ? 0xed4245 : 0xfee75c)
    .setFooter({ text: `${ok} ok · ${failed} failed · ${llmCfg.model}` })
    .setTimestamp();
}

// Ask the owner to confirm a risky plan with buttons. Resolves true/false.
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
      filter: (i) => isOwner(i.user),
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

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Command channel: ${COMMAND_CHANNEL_ID}`);
  console.log(`Owners: ${ownerList.join(', ')}`);
  console.log(`LLM: ${llmCfg.model} @ ${llmCfg.baseUrl}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channelId !== COMMAND_CHANNEL_ID) return; // default command channel only
    if (!isOwner(message.author)) return;                  // owner(s) only

    await message.channel.sendTyping().catch(() => {});

    let plan;
    try {
      plan = await llmPlan(message.content, buildContext(message), llmCfg);
    } catch (err) {
      console.error('LLM error:', err.message);
      const embed = new EmbedBuilder()
        .setTitle('🧠 LLM error')
        .setDescription(`Couldn't plan that: ${err.message}`.slice(0, 4000))
        .setColor(0xed4245);
      await message.reply({ embeds: [embed] });
      return;
    }

    remember('owner', message.content);

    // Pure conversational answer -> plain embed, no confirmation ceremony.
    if (plan.actions.length === 1 && plan.actions[0].type === 'reply') {
      const text = plan.actions[0].text ?? '…';
      remember('bot', text);
      await message.reply({
        embeds: [new EmbedBuilder().setDescription(text.slice(0, 4000)).setColor(0x5865f2)],
      });
      return;
    }

    // Risky plan -> button confirmation first.
    if (plan.confirm) {
      const approved = await confirmPlan(plan, message);
      if (!approved) {
        remember('bot', `cancelled: ${plan.summary ?? 'plan'}`);
        return;
      }
    }

    const results = await executePlan(plan, message);
    remember('bot', results.join(' | '));
    await message.reply({ embeds: [resultsEmbed(plan, results)] });
  } catch (err) {
    console.error('Handler error:', err);
    await message.reply({
      embeds: [new EmbedBuilder().setTitle('❌ Error').setDescription(String(err.message).slice(0, 4000)).setColor(0xed4245)],
    }).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
