import { EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { addTask, saveButtonHandler } from './store.js';

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
  link: ButtonStyle.Link,
};

const MSG_LINK_RE = /discord\.com\/channels\/\d+\/(\d+)\/(\d+)/;

async function resolveChannel(action, message) {
  if (!action.channelId) return message.channel;
  return message.guild.channels.fetch(action.channelId);
}

async function resolveTargetMessage(ref, message) {
  if (!ref || ref === 'last') {
    const msgs = await message.channel.messages.fetch({ limit: 5 });
    return msgs.filter(m => m.id !== message.id).first() ?? null;
  }
  const link = String(ref).match(MSG_LINK_RE);
  if (link) {
    const ch = await message.guild.channels.fetch(link[1]).catch(() => null);
    if (!ch) return null;
    return ch.messages.fetch(link[2]).catch(() => null);
  }
  if (/^\d{17,20}$/.test(String(ref))) {
    return message.channel.messages.fetch(ref).catch(() => null);
  }
  return null;
}

function resolveRole(guild, action) {
  if (action.roleId) return guild.roles.cache.get(action.roleId) ?? null;
  const name = (action.roleName ?? '').toLowerCase();
  return guild.roles.cache.find(r => r.name.toLowerCase() === name) ?? null;
}

function hexToInt(hex, fallback = 0x5865f2) {
  if (!hex) return fallback;
  const m = String(hex).replace('#', '');
  return /^[0-9a-f]{6}$/i.test(m) ? parseInt(m, 16) : fallback;
}

// Executes ONE action; returns a short human-readable result string.
export async function executeAction(action, message) {
  const guild = message.guild;

  switch (action.type) {
    // ---------- MODERATION ----------
    case 'ban': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (member && !member.bannable) return `⚠️ Cannot ban <@${action.userId}> (role hierarchy/permissions).`;
      await guild.members.ban(action.userId, {
        reason: action.reason || 'No reason provided',
        deleteMessageSeconds: (action.deleteMessageDays ?? 0) * 86400,
      });
      return `🔨 Banned <@${action.userId}> — ${action.reason || 'no reason'}`;
    }

    case 'unban':
      await guild.members.unban(action.userId);
      return `✅ Unbanned \`${action.userId}\``;

    case 'kick': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return `⚠️ User <@${action.userId}> not in this server.`;
      if (!member.kickable) return `⚠️ Cannot kick <@${action.userId}>.`;
      await member.kick(action.reason || 'No reason provided');
      return `👢 Kicked <@${action.userId}> — ${action.reason || 'no reason'}`;
    }

    case 'timeout': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return `⚠️ User not found.`;
      if (!member.moderatable) return `⚠️ Cannot timeout <@${action.userId}>.`;
      const mins = Math.min(Math.max(action.minutes ?? 10, 1), 40320); // max 28 days
      await member.timeout(mins * 60000, action.reason || 'No reason provided');
      return `🤐 Timed out <@${action.userId}> for ${mins} min — ${action.reason || 'no reason'}`;
    }

    case 'untimeout': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return `⚠️ User not found.`;
      await member.timeout(null);
      return `🔊 Removed timeout from <@${action.userId}>`;
    }

    case 'warn': {
      const user = await message.client.users.fetch(action.userId).catch(() => null);
      if (!user) return `⚠️ User not found.`;
      await user.send(`⚠️ **Warning from ${guild.name}:** ${action.reason || 'Please follow the rules.'}`).catch(() => null);
      return `⚠️ Warned <@${action.userId}> — ${action.reason || 'no reason'}`;
    }

    case 'purge': {
      const count = Math.min(Math.max(action.count ?? 10, 1), 100);
      const deleted = await message.channel.bulkDelete(count + 1, true);
      return `🧹 Deleted ${Math.max(deleted.size - 1, 0)} messages.`;
    }

    case 'slowmode': {
      const ch = await resolveChannel(action, message);
      await ch.setRateLimitPerUser(Math.min(Math.max(action.seconds ?? 0, 0), 21600));
      return action.seconds > 0 ? `🐢 Slowmode ${action.seconds}s in ${ch}` : `🚀 Slowmode disabled in ${ch}`;
    }

    case 'lock': {
      const ch = await resolveChannel(action, message);
      await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
      return `🔒 Locked ${ch}`;
    }

    case 'unlock': {
      const ch = await resolveChannel(action, message);
      await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
      return `🔓 Unlocked ${ch}`;
    }

    // ---------- ROLES / MEMBERS ----------
    case 'addRole': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      const role = resolveRole(guild, action);
      if (!member) return `⚠️ User not found.`;
      if (!role) return `⚠️ Role "${action.roleName ?? action.roleId}" not found.`;
      await member.roles.add(role);
      return `➕ Gave **${role.name}** to <@${action.userId}>`;
    }

    case 'removeRole': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      const role = resolveRole(guild, action);
      if (!member) return `⚠️ User not found.`;
      if (!role) return `⚠️ Role not found.`;
      await member.roles.remove(role);
      return `➖ Removed **${role.name}** from <@${action.userId}>`;
    }

    case 'createRole': {
      const role = await guild.roles.create({
        name: action.name || 'new-role',
        color: hexToInt(action.colorHex, null) ?? undefined,
      });
      return `🎨 Created role **${role.name}**`;
    }

    case 'nickname': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return `⚠️ User not found.`;
      await member.setNickname(action.nick || null);
      return action.nick ? `🏷️ Nicknamed <@${action.userId}> to "${action.nick}"` : `🏷️ Reset nickname of <@${action.userId}>`;
    }

    // ---------- MESSAGING ----------
    case 'say': {
      const ch = await resolveChannel(action, message);
      await ch.send(action.text ?? '');
      return `🗣️ Sent message in ${ch}`;
    }

    case 'embed': {
      const ch = await resolveChannel(action, message);
      const embed = new EmbedBuilder().setColor(hexToInt(action.colorHex)).setTimestamp();
      if (action.title) embed.setTitle(action.title);
      if (action.description) embed.setDescription(action.description);
      if (Array.isArray(action.fields)) {
        for (const f of action.fields.slice(0, 25)) {
          if (f?.name && f?.value) embed.addFields({ name: f.name, value: f.value, inline: !!f.inline });
        }
      }
      if (action.footer) embed.setFooter({ text: action.footer });
      if (action.imageUrl) embed.setImage(action.imageUrl);
      if (action.thumbnailUrl) embed.setThumbnail(action.thumbnailUrl);
      await ch.send({ embeds: [embed] });
      return `📨 Embed sent in ${ch}`;
    }

    case 'dm': {
      const user = await message.client.users.fetch(action.userId).catch(() => null);
      if (!user) return `⚠️ User not found.`;
      await user.send(action.text ?? '');
      return `✉️ DM sent to <@${action.userId}>`;
    }

    case 'react': {
      const target = await resolveTargetMessage(action.messageRef, message);
      if (!target) return `⚠️ Target message not found.`;
      let ok = 0;
      for (const emoji of action.emojis ?? []) {
        await target.react(emoji).then(() => ok++).catch(() => {});
      }
      return `✅ Added ${ok} reaction(s).`;
    }

    case 'pin': {
      const target = await resolveTargetMessage(action.messageRef, message);
      if (!target) return `⚠️ Target message not found.`;
      await target.pin();
      return `📌 Pinned message.`;
    }

    case 'unpin': {
      const target = await resolveTargetMessage(action.messageRef, message);
      if (!target) return `⚠️ Target message not found.`;
      await target.unpin();
      return `📌 Unpinned message.`;
    }

    case 'poll': {
      const ch = await resolveChannel(action, message);
      const nums = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
      const options = (action.options ?? []).slice(0, 10);
      const embed = new EmbedBuilder()
        .setTitle(`📊 ${action.question ?? 'Poll'}`)
        .setDescription(options.map((o, i) => `${nums[i]} ${o}`).join('\n'))
        .setColor(0x5865f2);
      const sent = await ch.send({ embeds: [embed] });
      for (let i = 0; i < options.length; i++) await sent.react(nums[i]).catch(() => {});
      return `📊 Poll posted in ${ch}`;
    }

    case 'buttonMessage': {
      const ch = await resolveChannel(action, message);
      const row = new ActionRowBuilder();
      (action.buttons ?? []).slice(0, 5).forEach((b, i) => {
        const style = BUTTON_STYLES[b.style] ?? ButtonStyle.Primary;
        const btn = new ButtonBuilder().setLabel(b.label ?? `Button ${i + 1}`).setStyle(style);
        if (style === ButtonStyle.Link) {
          btn.setURL(b.url || 'https://discord.com');
        } else {
          const id = `btnmsg:${Date.now()}:${i}`;
          btn.setCustomId(id);
          saveButtonHandler(id, b.replyText ?? 'Thanks for clicking!');
        }
        row.addComponents(btn);
      });
      if (row.components.length === 0) return `⚠️ buttonMessage needs at least one button.`;
      await ch.send({ content: action.text ?? '', components: [row] });
      return `🔘 Button message posted in ${ch}`;
    }

    case 'roleButtons': {
      const ch = await resolveChannel(action, message);
      const row = new ActionRowBuilder();
      for (const [i, roleName] of (action.roles ?? []).slice(0, 5).entries()) {
        const role = guild.roles.cache.find(r => r.name.toLowerCase() === String(roleName).toLowerCase());
        if (!role) return `⚠️ Role "${roleName}" not found.`;
        const id = `rolebtn:${role.id}`;
        row.addComponents(new ButtonBuilder().setCustomId(id).setLabel(role.name).setStyle(ButtonStyle.Secondary));
      }
      if (row.components.length === 0) return `⚠️ roleButtons needs at least one role.`;
      await ch.send({ content: action.text ?? 'Pick your roles:', components: [row] });
      return `🎭 Role-picker posted in ${ch} (${action.roles.length} roles)`;
    }

    // ---------- VOICE ----------
    case 'voiceMove': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return `⚠️ User not found.`;
      if (!member.voice.channel) return `⚠️ <@${action.userId}> is not in a voice channel.`;
      let vc = action.channelId
        ? await guild.channels.fetch(action.channelId).catch(() => null)
        : guild.channels.cache.find(c => c.isVoiceBased?.() && c.name.toLowerCase() === (action.channelName ?? '').toLowerCase());
      if (!vc) return `⚠️ Voice channel not found.`;
      await member.voice.setChannel(vc);
      return `🔀 Moved <@${action.userId}> to ${vc.name}`;
    }

    case 'voiceKick': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member?.voice.channel) return `⚠️ User not in a voice channel.`;
      await member.voice.disconnect();
      return `📴 Disconnected <@${action.userId}> from voice.`;
    }

    case 'voiceMute': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member?.voice.channel) return `⚠️ User not in a voice channel.`;
      await member.voice.setMute(action.mute !== false);
      return action.mute !== false ? `🔇 Server-muted <@${action.userId}>` : `🔊 Unmuted <@${action.userId}>`;
    }

    case 'voiceDeafen': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member?.voice.channel) return `⚠️ User not in a voice channel.`;
      await member.voice.setDeaf(action.deafen !== false);
      return action.deafen !== false ? `🙉 Deafened <@${action.userId}>` : `👂 Undeafened <@${action.userId}>`;
    }

    // ---------- THREADS ----------
    case 'createThread': {
      if (action.messageRef) {
        const target = await resolveTargetMessage(action.messageRef, message);
        if (!target) return `⚠️ Target message not found.`;
        const th = await target.startThread({ name: action.name || 'discussion' });
        return `🧵 Created thread ${th} from message.`;
      }
      const ch = await resolveChannel(action, message);
      const th = await ch.threads.create({ name: action.name || 'discussion' });
      return `🧵 Created thread ${th}`;
    }

    case 'archiveThread': {
      const th = action.threadId
        ? await guild.channels.fetch(action.threadId).catch(() => null)
        : guild.channels.cache.find(c => c.isThread?.() && c.name.toLowerCase() === (action.threadName ?? '').toLowerCase());
      if (!th?.isThread?.()) return `⚠️ Thread not found.`;
      await th.setArchived(true);
      return `🗄️ Archived thread "${th.name}"`;
    }

    // ---------- MESSAGES (advanced) ----------
    case 'deleteMessage': {
      const target = await resolveTargetMessage(action.messageRef, message);
      if (!target) return `⚠️ Target message not found.`;
      await target.delete();
      return `🗑️ Message deleted.`;
    }

    case 'editBotMessage': {
      const target = await resolveTargetMessage(action.messageRef, message);
      if (!target) return `⚠️ Target message not found.`;
      if (target.author.id !== message.client.user.id) return `⚠️ I can only edit my own messages.`;
      await target.edit(action.text ?? '');
      return `✏️ Message edited.`;
    }

    case 'announce': {
      const ch = await resolveChannel(action, message);
      const mention = action.mention === 'everyone' ? '@everyone ' : action.mention === 'here' ? '@here ' : '';
      if (action.title) {
        const embed = new EmbedBuilder()
          .setTitle(`📢 ${action.title}`)
          .setDescription(action.text ?? '')
          .setColor(hexToInt(action.colorHex))
          .setTimestamp();
        await ch.send({ content: mention || undefined, embeds: [embed] });
      } else {
        await ch.send(`${mention}📢 ${action.text ?? ''}`);
      }
      return `📢 Announcement posted in ${ch}`;
    }

    case 'schedule': {
      const ch = await resolveChannel(action, message);
      const mins = Math.min(Math.max(action.minutes ?? 1, 1), 10080); // max 7 days
      addTask('schedule', Date.now() + mins * 60000, {
        channelId: ch.id,
        text: action.text ?? '⏰ Reminder!'
      });
      return `⏰ Scheduled message in ${ch} in ${mins} min.`;
    }

    case 'giveaway': {
      const ch = await resolveChannel(action, message);
      const mins = Math.min(Math.max(action.minutes ?? 60, 1), 10080);
      const embed = new EmbedBuilder()
        .setTitle('🎉 GIVEAWAY 🎉')
        .setDescription(`**Prize:** ${action.prize ?? 'Mystery prize'}\nReact with 🎉 to enter!\nEnds <t:${Math.floor(Date.now() / 1000) + mins * 60}:R>`)
        .setColor(0xf1c40f);
      const sent = await ch.send({ embeds: [embed] });
      await sent.react('🎉');
      addTask('giveaway', Date.now() + mins * 60000, {
        channelId: ch.id,
        messageId: sent.id,
        prize: action.prize ?? 'Mystery prize'
      });
      return `🎉 Giveaway started in ${ch} for "${action.prize}" (${mins} min).`;
    }

    // ---------- CHANNELS / SERVER ----------
    case 'createChannel': {
      let parent;
      if (action.categoryName) {
        parent = guild.channels.cache.find(
          c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === action.categoryName.toLowerCase()
        );
      }
      const ch = await guild.channels.create({
        name: action.name || 'new-channel',
        type: action.kind === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText,
        parent: parent?.id,
      });
      return `📁 Created channel ${ch}`;
    }

    case 'deleteChannel': {
      const ch = await guild.channels.fetch(action.channelId).catch(() => null);
      if (!ch) return `⚠️ Channel not found.`;
      const name = ch.name;
      await ch.delete();
      return `🗑️ Deleted channel #${name}`;
    }

    case 'renameChannel': {
      const ch = await resolveChannel(action, message);
      await ch.setName(action.name);
      return `✏️ Renamed channel to #${action.name}`;
    }

    case 'topic': {
      const ch = await resolveChannel(action, message);
      await ch.setTopic(action.text ?? '');
      return `📝 Topic updated in ${ch}`;
    }

    case 'setChannelCategory': {
      const ch = await resolveChannel(action, message);
      if (!action.categoryName) {
        await ch.setParent(null);
        return `📂 Removed channel ${ch} from its category.`;
      }
      const cat = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === action.categoryName.toLowerCase()
      );
      if (!cat) return `⚠️ Category "${action.categoryName}" not found.`;
      await ch.setParent(cat.id);
      return `📂 Moved channel ${ch} into category **${cat.name}**.`;
    }

    case 'serverInfo': {
      const embed = new EmbedBuilder()
        .setTitle(guild.name)
        .setThumbnail(guild.iconURL())
        .addFields(
          { name: 'Members', value: String(guild.memberCount), inline: true },
          { name: 'Channels', value: String(guild.channels.cache.size), inline: true },
          { name: 'Roles', value: String(guild.roles.cache.size), inline: true },
          { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
        )
        .setColor(0x2b2d31);
      return { embeds: [embed] };
    }

    case 'userInfo': {
      const member = await guild.members.fetch(action.userId).catch(() => null);
      if (!member) return `⚠️ User not found.`;
      const embed = new EmbedBuilder()
        .setTitle(member.user.tag)
        .setThumbnail(member.user.displayAvatarURL())
        .addFields(
          { name: 'ID', value: member.id, inline: true },
          { name: 'Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true },
          { name: 'Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'Roles', value: member.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).join(', ') || 'none' },
        )
        .setColor(0x2b2d31);
      return { embeds: [embed] };
    }

    case 'listBans': {
      const bans = await guild.bans.fetch();
      if (bans.size === 0) return `📋 No banned users.`;
      const list = bans.map(b => `• ${b.user.tag} (\`${b.user.id}\`) — ${b.reason ?? 'no reason'}`).slice(0, 30).join('\n');
      return { text: `**Bans (${bans.size}):**\n${list}` };
    }

    case 'createCategory': {
      const cat = await guild.channels.create({ name: action.name || 'new-category', type: ChannelType.GuildCategory });
      return `📂 Created category **${cat.name}**`;
    }

    case 'createInvite': {
      const ch = await resolveChannel(action, message);
      const invite = await ch.createInvite({
        maxAge: Math.min(Math.max((action.maxAgeHours ?? 24), 0), 168) * 3600,
        maxUses: Math.min(Math.max(action.maxUses ?? 0, 0), 100),
      });
      return `🔗 Invite created: https://discord.gg/${invite.code} (expires: ${action.maxAgeHours === 0 ? 'never' : `${action.maxAgeHours ?? 24}h`}, uses: ${action.maxUses || 'unlimited'})`;
    }

    case 'createEmoji': {
      if (!action.imageUrl) return `⚠️ createEmoji needs an imageUrl.`;
      const emoji = await guild.emojis.create({ attachment: action.imageUrl, name: action.name || 'new_emoji' });
      return `😀 Created emoji ${emoji} \`:${emoji.name}:\``;
    }

    case 'deleteEmoji': {
      const emoji = guild.emojis.cache.find(e => e.name.toLowerCase() === (action.name ?? '').toLowerCase());
      if (!emoji) return `⚠️ Emoji "${action.name}" not found.`;
      await emoji.delete();
      return `🗑️ Deleted emoji :${action.name}:`;
    }

    case 'createEvent': {
      const start = new Date(Date.now() + Math.max(action.startInMinutes ?? 60, 1) * 60000);
      const end = new Date(start.getTime() + Math.max(action.durationMinutes ?? 60, 1) * 60000);
      const vc = action.voiceChannelName
        ? guild.channels.cache.find(c => c.isVoiceBased?.() && c.name.toLowerCase() === action.voiceChannelName.toLowerCase())
        : null;
      const event = await guild.scheduledEvents.create({
        name: action.name || 'Server Event',
        description: action.description || '',
        scheduledStartTime: start,
        scheduledEndTime: end,
        privacyLevel: 2, // GUILD_ONLY
        entityType: vc ? 2 : 3, // VOICE : EXTERNAL
        channel: vc ?? undefined,
        entityMetadata: vc ? undefined : { location: 'Discord' },
      });
      return `📅 Event **${event.name}** scheduled <t:${Math.floor(start.getTime() / 1000)}:R>`;
    }

    case 'prune': {
      const days = Math.min(Math.max(action.days ?? 30, 1), 30);
      if (action.dryRun !== false) {
        const count = await guild.members.prune({ days, dry: true });
        return `🧮 Prune preview: **${count}** members inactive ${days}+ days would be kicked. Say "prune for real" to execute.`;
      }
      const count = await guild.members.prune({ days, dry: false, reason: 'Owner-requested prune' });
      return `🧹 Pruned **${count}** members inactive ${days}+ days.`;
    }

    case 'avatar': {
      const user = await message.client.users.fetch(action.userId).catch(() => null);
      if (!user) return `⚠️ User not found.`;
      const embed = new EmbedBuilder()
        .setTitle(`${user.tag}'s avatar`)
        .setImage(user.displayAvatarURL({ size: 1024 }))
        .setColor(0x2b2d31);
      return { embeds: [embed] };
    }

    case 'listRoles': {
      const roles = guild.roles.cache
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .map(r => `• ${r.name} (${r.members.size} members)`)
        .slice(0, 40);
      return { text: `**Roles (${roles.length}):**\n${roles.join('\n') || 'none'}` };
    }

    case 'listChannels': {
      const chans = guild.channels.cache
        .filter(c => !c.isThread?.())
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
        .map(c => `• ${c.type === ChannelType.GuildCategory ? '📂' : c.isVoiceBased?.() ? '🔊' : '#'} ${c.name}`)
        .slice(0, 60);
      return { text: `**Channels (${chans.length}):**\n${chans.join('\n')}` };
    }

    case 'listEmojis': {
      const emojis = guild.emojis.cache.map(e => `${e} \`:${e.name}:\``).slice(0, 50);
      return { text: emojis.length ? `**Emojis (${emojis.length}):**\n${emojis.join(' ')}` : 'No custom emojis.' };
    }

    case 'listInvites': {
      const invites = await guild.invites.fetch();
      if (invites.size === 0) return `📋 No active invites.`;
      const list = invites.map(i => `• discord.gg/${i.code} — by ${i.inviter?.tag ?? '?'} (${i.uses}/${i.maxUses || '∞'} uses)`).slice(0, 25).join('\n');
      return { text: `**Invites (${invites.size}):**\n${list}` };
    }

    case 'auditLog': {
      const count = Math.min(Math.max(action.count ?? 10, 1), 25);
      const log = await guild.fetchAuditLogs({ limit: count });
      if (log.entries.size === 0) return `📋 Audit log is empty.`;
      const lines = log.entries.map(e =>
        `• <t:${Math.floor(e.createdTimestamp / 1000)}:R> **${e.executor?.tag ?? '?'}** → ${e.action} ${e.target?.tag ?? e.target?.name ?? ''}${e.reason ? ` (${e.reason})` : ''}`
      ).slice(0, count);
      return { text: `**Recent audit log:**\n${lines.join('\n')}`.slice(0, 2000) };
    }

    // ---------- OTHER ----------
    case 'reply':
      return action.text ?? '…';

    case 'remember': {
      const { rememberNote } = await import('./store.js');
      rememberNote(guild?.id, action.note);
      return `🧠 Noted: ${String(action.note).slice(0, 120)}`;
    }

    case 'forget': {
      const { forgetNote } = await import('./store.js');
      const n = forgetNote(guild?.id, action.match);
      return `🧹 Forgot ${n} note(s) matching "${action.match}".`;
    }

    case 'runScript': {
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const fn = new AsyncFunction('guild', 'message', 'client', action.code);
      const res = await fn(guild, message, message.client);
      return `💻 Script executed. Result: ${res !== undefined ? String(res).slice(0, 500) : 'Done'}`;
    }

    default:
      return `⚠️ Unknown action type "${action.type}".`;
  }
}

// Executes a whole plan, returns array of result strings and embeds.
export async function executePlan(plan, message) {
  const results = [];
  const embeds = [];
  for (const action of plan.actions.slice(0, 50)) {
    try {
      const res = await executeAction(action, message);
      if (typeof res === 'string') {
        results.push(res);
      } else if (res && typeof res === 'object') {
        if (res.text) results.push(res.text);
        if (res.embeds) embeds.push(...res.embeds);
      }
    } catch (err) {
      results.push(`❌ ${action.type} failed: ${err.message}`);
    }
  }
  return { results, embeds };
}
