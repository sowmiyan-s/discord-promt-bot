import { test } from 'node:test';
import assert from 'node:assert';
import { llmPlan, needsConfirmation, describeAction } from '../src/llm.js';
import { executeAction, executePlan } from '../src/actions.js';

// ---------- risk / confirmation logic ----------
test('needsConfirmation: ban always risky', () => {
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'ban', userId: '1' }] }), true);
});

test('needsConfirmation: embed is safe', () => {
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'embed', title: 'x' }] }), false);
});

test('needsConfirmation: long timeout risky, short safe', () => {
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'timeout', minutes: 120 }] }), true);
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'timeout', minutes: 10 }] }), false);
});

test('needsConfirmation: big purge risky, small safe', () => {
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'purge', count: 50 }] }), true);
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'purge', count: 10 }] }), false);
});

test('needsConfirmation: real prune risky, dry run safe', () => {
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'prune', dryRun: false }] }), true);
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'prune', dryRun: true }] }), false);
});

test('needsConfirmation: everyone announce risky', () => {
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'announce', mention: 'everyone' }] }), true);
  assert.strictEqual(needsConfirmation({ actions: [{ type: 'announce', mention: 'none' }] }), false);
});

test('needsConfirmation: honors LLM confirm=true even for safe actions', () => {
  assert.strictEqual(needsConfirmation({ confirm: true, actions: [{ type: 'say', text: 'hi' }] }), true);
});

test('describeAction: renders ban summary', () => {
  const d = describeAction({ type: 'ban', userId: '42', reason: 'spam' });
  assert.ok(d.includes('Ban') && d.includes('<@42>') && d.includes('spam'));
});

// ---------- llm planner (mocked fetch) ----------
test('llmPlan: parses valid JSON plan', async () => {
  const mockFetch = async (url, opts) => {
    assert.ok(url.endsWith('/chat/completions'));
    const body = JSON.parse(opts.body);
    assert.strictEqual(body.model, 'test-model');
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"actions":[{"type":"ban","userId":"123","reason":"spam"}],"note":"done"}' } }],
      }),
    };
  };
  const plan = await llmPlan('ban that guy', 'ctx', { apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'test-model' }, mockFetch);
  assert.strictEqual(plan.actions[0].type, 'ban');
  assert.strictEqual(plan.note, 'done');
});

test('llmPlan: strips markdown fences', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '```json\n{"actions":[{"type":"reply","text":"hi"}]}\n```' } }] }),
  });
  const plan = await llmPlan('hi', '', { apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' }, mockFetch);
  assert.strictEqual(plan.actions[0].text, 'hi');
});

test('llmPlan: throws on API error', async () => {
  const mockFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  await assert.rejects(
    () => llmPlan('x', '', { apiKey: 'bad', baseUrl: 'https://x.test/v1', model: 'm' }, mockFetch),
    /LLM API error 401/
  );
});

test('llmPlan: throws on non-JSON', async () => {
  const mockFetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'sure thing boss!' } }] }) });
  await assert.rejects(
    () => llmPlan('x', '', { apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' }, mockFetch),
    /non-JSON/
  );
});

// ---------- action executor (mocked discord objects) ----------
function makeMocks() {
  const calls = [];
  const voiceChannel = { name: 'Lounge', isVoiceBased: () => true, isTextBased: () => false, isThread: () => false };
  const channel = {
    name: 'general',
    send: async (x) => { calls.push(['send', x]); return { react: async e => calls.push(['sent-react', e]) }; },
    bulkDelete: async (n) => { calls.push(['bulkDelete', n]); return { size: n }; },
    setRateLimitPerUser: async (s) => calls.push(['slowmode', s]),
    createInvite: async (o) => { calls.push(['invite', o]); return { code: 'testcode' }; },
    threads: { create: async (o) => { calls.push(['thread-create', o.name]); return { name: o.name, toString: () => '#' + o.name }; } },
    messages: {
      fetch: async () => ({ filter: () => ({ first: () => ({
        id: 'prev',
        author: { id: 'someone-else' },
        react: async e => calls.push(['react', e]),
        pin: async () => calls.push(['pin']),
        unpin: async () => calls.push(['unpin']),
        delete: async () => calls.push(['msg-delete']),
        startThread: async (o) => { calls.push(['thread-from-msg', o.name]); return { toString: () => '#' + o.name }; },
      }) }) }),
    },
    permissionOverwrites: { edit: async (r, p) => calls.push(['perm', p]) },
    toString: () => '#general',
  };
  const guildChannelsCache = new Map([['vc1', voiceChannel]]);
  guildChannelsCache.find = (fn) => [...guildChannelsCache.values()].find(fn);
  guildChannelsCache.filter = (fn) => [...guildChannelsCache.values()].filter(fn);
  const rolesCache = new Map();
  rolesCache.find = function (fn) { return [...this.values()].find(fn); };
  rolesCache.filter = function (fn) { return [...this.values()].filter(fn); };
  const guild = {
    name: 'TestServer',
    roles: { everyone: { id: 'g' }, cache: rolesCache },
    members: {
      fetch: async (id) => ({ id, bannable: true, kickable: true, moderatable: true,
        kick: async r => calls.push(['kick', id, r]),
        timeout: async (ms, r) => calls.push(['timeout', id, ms, r]),
        roles: { add: async r => calls.push(['addRole']), remove: async () => {}, cache: new Map() },
        voice: {
          channel: voiceChannel,
          disconnect: async () => calls.push(['voice-disconnect']),
          setChannel: async (c) => calls.push(['voice-setchannel', c.name]),
          setMute: async (m) => calls.push(['voice-mute', m]),
          setDeaf: async (d) => calls.push(['voice-deaf', d]),
        },
      }),
      ban: async (id, o) => calls.push(['ban', id, o]),
      unban: async (id) => calls.push(['unban', id]),
      prune: async (o) => { calls.push(['prune', o]); return 7; },
    },
    channels: { fetch: async (id) => channel, cache: guildChannelsCache, create: async (o) => { calls.push(['chan-create', o]); return { name: o.name, toString: () => '#' + o.name }; } },
    emojis: { cache: new Map(), create: async (o) => ({ name: o.name, toString: () => ':' + o.name + ':' }) },
    invites: { fetch: async () => new Map() },
    scheduledEvents: { create: async (o) => { calls.push(['event', o.name]); return { name: o.name }; } },
    fetchAuditLogs: async () => ({ entries: new Map() }),
  };
  const message = {
    id: 'cmd', guild, channel,
    client: { user: { id: 'bot-id' }, users: { fetch: async id => ({ id, send: async t => calls.push(['dm', id, t]) }) } },
    reply: async t => calls.push(['reply', t]),
  };
  return { calls, message };
}

test('executeAction: ban calls guild ban', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({ type: 'ban', userId: '42', reason: 'spam' }, message);
  assert.ok(res.includes('Banned'));
  assert.ok(calls.some(c => c[0] === 'ban' && c[1] === '42'));
});

test('executeAction: timeout uses minutes', async () => {
  const { calls, message } = makeMocks();
  await executeAction({ type: 'timeout', userId: '42', minutes: 5, reason: 'x' }, message);
  assert.ok(calls.some(c => c[0] === 'timeout' && c[2] === 300000));
});

test('executeAction: embed sends embed payload', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({ type: 'embed', title: 'T', description: 'D', colorHex: '#ff0000', fields: [{ name: 'a', value: 'b' }] }, message);
  assert.ok(res.includes('Embed sent'));
  const sent = calls.find(c => c[0] === 'send');
  assert.ok(sent[1].embeds?.length === 1);
});

test('executeAction: react last reacts on previous message', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({ type: 'react', messageRef: 'last', emojis: ['\u{1F525}', '\u{1F389}'] }, message);
  assert.strictEqual(res, '✅ Added 2 reaction(s).');
});

test('executeAction: dm sends direct message', async () => {
  const { calls, message } = makeMocks();
  await executeAction({ type: 'dm', userId: '42', text: 'hello' }, message);
  assert.ok(calls.some(c => c[0] === 'dm' && c[2] === 'hello'));
});

test('executeAction: unknown type returns warning', async () => {
  const { message } = makeMocks();
  const res = await executeAction({ type: 'teleport' }, message);
  assert.ok(res.includes('Unknown action'));
});

test('executePlan: runs multiple actions and collects errors', async () => {
  const { message } = makeMocks();
  message.guild.members.ban = async () => { throw new Error('nope'); };
  const results = await executePlan({ actions: [
    { type: 'ban', userId: '42', reason: 'x' },
    { type: 'say', text: 'hi' },
  ] }, message);
  assert.strictEqual(results.length, 2);
  assert.ok(results[0].includes('failed'));
  assert.ok(results[1].includes('Sent message'));
});

// ---------- new advanced actions ----------
test('executeAction: announce with everyone mention + title embeds', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({ type: 'announce', title: 'Update', text: 'we grew!', mention: 'everyone' }, message);
  assert.ok(res.includes('Announcement'));
  const sent = calls.find(c => c[0] === 'send');
  assert.strictEqual(sent[1].content, '@everyone ');
  assert.ok(sent[1].embeds?.length === 1);
});

test('executeAction: voiceKick disconnects member', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({ type: 'voiceKick', userId: '42' }, message);
  assert.ok(res.includes('Disconnected'));
  assert.ok(calls.some(c => c[0] === 'voice-disconnect'));
});

test('executeAction: voiceMove finds channel by name', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({ type: 'voiceMove', userId: '42', channelName: 'Lounge' }, message);
  assert.ok(res.includes('Moved'));
  assert.ok(calls.some(c => c[0] === 'voice-setchannel'));
});

test('executeAction: deleteMessage deletes target', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({ type: 'deleteMessage', messageRef: 'last' }, message);
  assert.ok(res.includes('deleted'));
  assert.ok(calls.some(c => c[0] === 'msg-delete'));
});

test('executeAction: prune dry run does not kick', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({ type: 'prune', days: 30, dryRun: true }, message);
  assert.ok(res.includes('Prune preview'));
  assert.ok(calls.some(c => c[0] === 'prune' && c[1].dry === true));
});

test('executeAction: createInvite returns link', async () => {
  const { message } = makeMocks();
  const res = await executeAction({ type: 'createInvite', maxAgeHours: 24, maxUses: 5 }, message);
  assert.ok(res.includes('discord.gg/testcode'));
});

test('executeAction: createThread standalone in channel', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({ type: 'createThread', name: 'ideas' }, message);
  assert.ok(res.includes('Created thread'));
  assert.ok(calls.some(c => c[0] === 'thread-create' && c[1] === 'ideas'));
});

// ---------- buttons ----------
test('executeAction: buttonMessage sends components', async () => {
  const { calls, message } = makeMocks();
  const res = await executeAction({
    type: 'buttonMessage',
    text: 'Click below!',
    buttons: [
      { label: 'Hello', style: 'primary', replyText: 'hi there' },
      { label: 'Docs', style: 'link', url: 'https://example.com' },
    ],
  }, message);
  assert.ok(res.includes('Button message posted'));
  const sent = calls.find(c => c[0] === 'send');
  assert.strictEqual(sent[1].content, 'Click below!');
  assert.strictEqual(sent[1].components?.length, 1);
  assert.strictEqual(sent[1].components[0].components.length, 2);
});

test('executeAction: buttonMessage with no buttons warns', async () => {
  const { message } = makeMocks();
  const res = await executeAction({ type: 'buttonMessage', text: 'x', buttons: [] }, message);
  assert.ok(res.includes('⚠️'));
});

test('executeAction: roleButtons warns on unknown role', async () => {
  const { message } = makeMocks();
  const res = await executeAction({ type: 'roleButtons', text: 'pick', roles: ['NoSuchRole'] }, message);
  assert.ok(res.includes('not found'));
});

test('executeAction: roleButtons posts picker for existing role', async () => {
  const { calls, message } = makeMocks();
  message.guild.roles.cache = new Map([['r1', { id: 'r1', name: 'Gamer' }]]);
  message.guild.roles.cache.find = function (fn) { return [...this.values()].find(fn); };
  const res = await executeAction({ type: 'roleButtons', text: 'pick', roles: ['Gamer'] }, message);
  assert.ok(res.includes('Role-picker posted'));
  const sent = calls.find(c => c[0] === 'send');
  assert.strictEqual(sent[1].components[0].components.length, 1);
});

test('llmPlan: forces confirm=true server-side for risky actions', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"actions":[{"type":"ban","userId":"1"}],"confirm":false}' } }] }),
  });
  const plan = await llmPlan('ban', '', { apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' }, mockFetch);
  assert.strictEqual(plan.confirm, true); // overridden despite LLM saying false
});

test('llmPlan: caps actions at 10', async () => {
  const actions = JSON.stringify(Array.from({ length: 15 }, () => ({ type: 'say', text: 'x' })));
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: `{"actions":${actions}}` } }] }),
  });
  const plan = await llmPlan('spam', '', { apiKey: 'k', baseUrl: 'https://x.test/v1', model: 'm' }, mockFetch);
  assert.strictEqual(plan.actions.length, 10);
});
