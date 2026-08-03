// Slash commands: per-guild admin configuration.
// /config, /welcome, /bye, /botban, /customcmd, /memory
//
// Registered globally on startup. All admin-only commands require ManageGuild.

import {
  SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags, REST, Routes,
} from 'discord.js';
import {
  getGuildConfig, updateGuildConfig, encrypt, decrypt, maskKey,
  getNotes, clearMemory, forgetNote,
} from './store.js';

export function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName('config')
      .setDescription('Configure GENBOT for this server (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addSubcommand(s => s.setName('setkey')
        .setDescription('Set this server\'s own LLM API key (stored encrypted)')
        .addStringOption(o => o.setName('key').setDescription('API key').setRequired(true))
        .addStringOption(o => o.setName('base_url').setDescription('OpenAI-compatible base URL (default: Mistral)'))
        .addStringOption(o => o.setName('model').setDescription('Model name (default: mistral-small-latest)')))
      .addSubcommand(s => s.setName('clearkey').setDescription('Remove this server\'s LLM key (falls back to bot default)'))
      .addSubcommand(s => s.setName('show').setDescription('Show current server configuration'))
      .addSubcommand(s => s.setName('channel')
        .setDescription('Set the command channel where GENBOT always listens')
        .addChannelOption(o => o.setName('channel').setDescription('Channel').setRequired(true)))
      .addSubcommand(s => s.setName('mode')
        .setDescription('When should GENBOT respond?')
        .addStringOption(o => o.setName('mode').setDescription('Respond mode').setRequired(true)
          .addChoices(
            { name: 'mention — @mentions, replies & command channel', value: 'mention' },
            { name: 'all — every message it can see', value: 'all' },
            { name: 'command — only the command channel', value: 'command' },
          ))),

    new SlashCommandBuilder()
      .setName('welcome')
      .setDescription('Welcome message for new members (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addSubcommand(s => s.setName('set')
        .setDescription('Set the welcome message')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to post in').setRequired(true))
        .addStringOption(o => o.setName('message').setDescription('Use {user} {server} {count}').setRequired(true)))
      .addSubcommand(s => s.setName('off').setDescription('Disable welcome messages'))
      .addSubcommand(s => s.setName('test').setDescription('Preview the welcome message')),

    new SlashCommandBuilder()
      .setName('bye')
      .setDescription('Goodbye message when members leave (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addSubcommand(s => s.setName('set')
        .setDescription('Set the goodbye message')
        .addChannelOption(o => o.setName('channel').setDescription('Channel to post in').setRequired(true))
        .addStringOption(o => o.setName('message').setDescription('Use {user} {server} {count}').setRequired(true)))
      .addSubcommand(s => s.setName('off').setDescription('Disable goodbye messages')),

    new SlashCommandBuilder()
      .setName('botban')
      .setDescription('Block/unblock a user from using GENBOT in this server (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addSubcommand(s => s.setName('add').setDescription('Block a user')
        .addUserOption(o => o.setName('user').setDescription('User to block').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Unblock a user')
        .addUserOption(o => o.setName('user').setDescription('User to unblock').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List blocked users')),

    new SlashCommandBuilder()
      .setName('customcmd')
      .setDescription('Custom prompt-powered commands (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .setDMPermission(false)
      .addSubcommand(s => s.setName('create')
        .setDescription('Create a custom command backed by a prompt')
        .addStringOption(o => o.setName('name').setDescription('Command name, e.g. rules').setRequired(true))
        .addStringOption(o => o.setName('prompt').setDescription('What GENBOT should do when someone runs !name').setRequired(true)))
      .addSubcommand(s => s.setName('delete').setDescription('Delete a custom command')
        .addStringOption(o => o.setName('name').setDescription('Command name').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('List custom commands')),

    new SlashCommandBuilder()
      .setName('memory')
      .setDescription('GENBOT\'s memory for this server')
      .setDMPermission(false)
      .addSubcommand(s => s.setName('show').setDescription('Show what GENBOT remembers'))
      .addSubcommand(s => s.setName('forget')
        .setDescription('Forget notes containing some text (admin only)')
        .addStringOption(o => o.setName('text').setDescription('Text to match').setRequired(true)))
      .addSubcommand(s => s.setName('clear').setDescription('Wipe all memory for this server (admin only)')),
  ].map(c => c.toJSON());
}

export async function registerCommands(token, appId) {
  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationCommands(appId), { body: buildCommands() });
}

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

function ok(desc) {
  return { embeds: [new EmbedBuilder().setDescription(desc).setColor(0x57f287)], ...EPHEMERAL };
}
function err(desc) {
  return { embeds: [new EmbedBuilder().setDescription(desc).setColor(0xed4245)], ...EPHEMERAL };
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

export function renderTemplate(tpl, member) {
  return String(tpl ?? '')
    .replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{username}', member.user?.username ?? member.username ?? 'user')
    .replaceAll('{server}', member.guild?.name ?? '')
    .replaceAll('{count}', String(member.guild?.memberCount ?? ''));
}

// Handle a slash-command interaction. Returns true if handled.
export async function handleSlash(interaction) {
  if (!interaction.isChatInputCommand()) return false;
  const { commandName } = interaction;
  const gid = interaction.guildId;
  if (!gid) { await interaction.reply(err('Server-only command.')); return true; }
  const sub = interaction.options.getSubcommand(false);

  try {
    switch (commandName) {
      case 'config': {
        if (!isAdmin(interaction)) { await interaction.reply(err('You need **Manage Server** for this.')); return true; }
        if (sub === 'setkey') {
          const key = interaction.options.getString('key', true);
          const baseUrl = interaction.options.getString('base_url');
          const model = interaction.options.getString('model');
          updateGuildConfig(gid, c => {
            c.llm.apiKeyEnc = encrypt(key);
            if (baseUrl) c.llm.baseUrl = baseUrl.replace(/\/$/, '');
            if (model) c.llm.model = model;
          });
          await interaction.reply(ok(`🔐 LLM key saved **encrypted** for this server (\`${maskKey(key)}\`).${model ? `\nModel: \`${model}\`` : ''}${baseUrl ? `\nBase URL: \`${baseUrl}\`` : ''}\n\n⚠️ Tip: for safety, delete the message if the key was ever pasted in a public channel.`));
        } else if (sub === 'clearkey') {
          updateGuildConfig(gid, c => { c.llm = { apiKeyEnc: null, baseUrl: null, model: null, temperature: null }; });
          await interaction.reply(ok('🗑️ Server LLM key removed — using the bot\'s default key now.'));
        } else if (sub === 'channel') {
          const ch = interaction.options.getChannel('channel', true);
          updateGuildConfig(gid, c => { c.commandChannelId = ch.id; });
          await interaction.reply(ok(`📌 Command channel set to ${ch}.`));
        } else if (sub === 'mode') {
          const mode = interaction.options.getString('mode', true);
          updateGuildConfig(gid, c => { c.respondMode = mode; });
          await interaction.reply(ok(`🎚️ Respond mode set to **${mode}**.`));
        } else { // show
          const c = getGuildConfig(gid);
          const key = c.llm.apiKeyEnc ? decrypt(c.llm.apiKeyEnc) : null;
          const e = new EmbedBuilder().setTitle('⚙️ GENBOT config').setColor(0x5865f2).addFields(
            { name: 'LLM key', value: key ? `\`${maskKey(key)}\` (server's own, encrypted at rest)` : 'Bot default', inline: true },
            { name: 'Model', value: c.llm.model ?? 'default', inline: true },
            { name: 'Base URL', value: c.llm.baseUrl ?? 'default', inline: true },
            { name: 'Respond mode', value: c.respondMode ?? 'default (mention)', inline: true },
            { name: 'Command channel', value: c.commandChannelId ? `<#${c.commandChannelId}>` : 'not set', inline: true },
            { name: 'Welcome', value: c.welcome.enabled ? `<#${c.welcome.channelId}>` : 'off', inline: true },
            { name: 'Goodbye', value: c.bye.enabled ? `<#${c.bye.channelId}>` : 'off', inline: true },
            { name: 'Bot-banned users', value: String(c.botBanned.length), inline: true },
            { name: 'Custom commands', value: Object.keys(c.customCommands).length ? Object.keys(c.customCommands).map(n => `\`!${n}\``).join(' ') : 'none', inline: true },
          );
          await interaction.reply({ embeds: [e], ...EPHEMERAL });
        }
        return true;
      }

      case 'welcome':
      case 'bye': {
        if (!isAdmin(interaction)) { await interaction.reply(err('You need **Manage Server** for this.')); return true; }
        const kind = commandName;
        if (sub === 'set') {
          const ch = interaction.options.getChannel('channel', true);
          const msg = interaction.options.getString('message', true);
          updateGuildConfig(gid, c => { c[kind] = { channelId: ch.id, message: msg, enabled: true }; });
          await interaction.reply(ok(`✅ ${kind === 'welcome' ? 'Welcome' : 'Goodbye'} message set for ${ch}:\n> ${msg}\nPlaceholders: \`{user}\` \`{username}\` \`{server}\` \`{count}\``));
        } else if (sub === 'off') {
          updateGuildConfig(gid, c => { c[kind].enabled = false; });
          await interaction.reply(ok(`🔕 ${kind === 'welcome' ? 'Welcome' : 'Goodbye'} messages disabled.`));
        } else if (sub === 'test') {
          const c = getGuildConfig(gid);
          if (!c.welcome.enabled) { await interaction.reply(err('Welcome is not configured. Use `/welcome set` first.')); return true; }
          await interaction.reply({ content: renderTemplate(c.welcome.message, interaction.member), ...EPHEMERAL });
        }
        return true;
      }

      case 'botban': {
        if (!isAdmin(interaction)) { await interaction.reply(err('You need **Manage Server** for this.')); return true; }
        if (sub === 'add') {
          const user = interaction.options.getUser('user', true);
          if (user.id === interaction.user.id) { await interaction.reply(err('You can\'t bot-ban yourself. 🙃')); return true; }
          if (user.bot) { await interaction.reply(err('Bots are already ignored.')); return true; }
          updateGuildConfig(gid, c => { if (!c.botBanned.includes(user.id)) c.botBanned.push(user.id); });
          await interaction.reply(ok(`🚫 ${user} can no longer use GENBOT in this server.`));
        } else if (sub === 'remove') {
          const user = interaction.options.getUser('user', true);
          updateGuildConfig(gid, c => { c.botBanned = c.botBanned.filter(id => id !== user.id); });
          await interaction.reply(ok(`✅ ${user} can use GENBOT again.`));
        } else {
          const c = getGuildConfig(gid);
          await interaction.reply({
            embeds: [new EmbedBuilder().setTitle('🚫 Bot-banned users').setColor(0x5865f2)
              .setDescription(c.botBanned.length ? c.botBanned.map(id => `<@${id}>`).join('\n') : 'Nobody is blocked.')],
            ...EPHEMERAL,
          });
        }
        return true;
      }

      case 'customcmd': {
        if (!isAdmin(interaction)) { await interaction.reply(err('You need **Manage Server** for this.')); return true; }
        if (sub === 'create') {
          const name = interaction.options.getString('name', true).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
          const prompt = interaction.options.getString('prompt', true);
          if (!name) { await interaction.reply(err('Invalid name — use letters, numbers, - or _.')); return true; }
          updateGuildConfig(gid, c => {
            c.customCommands[name] = { prompt, createdBy: interaction.user.id, createdAt: Date.now() };
          });
          await interaction.reply(ok(`✨ Custom command \`!${name}\` created.\nWhen someone types \`!${name}\`, GENBOT will run:\n> ${prompt.slice(0, 500)}`));
        } else if (sub === 'delete') {
          const name = interaction.options.getString('name', true).toLowerCase();
          const c = getGuildConfig(gid);
          if (!c.customCommands[name]) { await interaction.reply(err(`No custom command \`!${name}\`.`)); return true; }
          updateGuildConfig(gid, cc => { delete cc.customCommands[name]; });
          await interaction.reply(ok(`🗑️ Deleted \`!${name}\`.`));
        } else {
          const c = getGuildConfig(gid);
          const names = Object.entries(c.customCommands);
          await interaction.reply({
            embeds: [new EmbedBuilder().setTitle('✨ Custom commands').setColor(0x5865f2)
              .setDescription(names.length
                ? names.map(([n, v]) => `\`!${n}\` — ${String(v.prompt).slice(0, 80)}`).join('\n')
                : 'None yet. Create one with `/customcmd create`.')],
            ...EPHEMERAL,
          });
        }
        return true;
      }

      case 'memory': {
        if (sub === 'show') {
          const notes = getNotes(gid);
          await interaction.reply({
            embeds: [new EmbedBuilder().setTitle('🧠 What I remember here').setColor(0x5865f2)
              .setDescription(notes.length ? notes.map((n, i) => `${i + 1}. ${n}`).join('\n').slice(0, 4000) : 'Nothing saved yet. I remember things when you ask me to, or during multi-step jobs.')],
            ...EPHEMERAL,
          });
        } else if (sub === 'forget') {
          if (!isAdmin(interaction)) { await interaction.reply(err('You need **Manage Server** for this.')); return true; }
          const n = forgetNote(gid, interaction.options.getString('text', true));
          await interaction.reply(ok(`🧹 Forgot ${n} note(s).`));
        } else {
          if (!isAdmin(interaction)) { await interaction.reply(err('You need **Manage Server** for this.')); return true; }
          clearMemory(gid);
          await interaction.reply(ok('🧠 Memory wiped for this server.'));
        }
        return true;
      }
    }
  } catch (e) {
    console.error('Slash handler error:', e);
    const payload = err(`Something went wrong: ${e.message}`.slice(0, 1000));
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
    return true;
  }
  return false;
}
