import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  initCrypto, encrypt, decrypt, maskKey,
  getGuildConfig, updateGuildConfig, resolveLlmConfig, isBotBanned,
  rememberTurn, getTurns, rememberNote, forgetNote, getNotes, clearMemory,
} from '../src/store.js';
import { renderTemplate } from '../src/commands.js';

const GID = '999999999999999999';

test.before(() => initCrypto('test-secret-for-unit-tests'));
test.after(() => {
  for (const f of [`data/guilds/${GID}.json`, `data/memory/${GID}.json`]) {
    try { fs.unlinkSync(path.resolve(f)); } catch {}
  }
});

test('encrypt/decrypt round-trips', () => {
  const blob = encrypt('sk-my-secret-key-123');
  assert.ok(blob.startsWith('enc:v1:'));
  assert.ok(!blob.includes('sk-my-secret-key-123'));
  assert.equal(decrypt(blob), 'sk-my-secret-key-123');
});

test('decrypt returns null on garbage', () => {
  assert.equal(decrypt('enc:v1:xx:yy:zz'), null);
  assert.equal(decrypt('plaintext'), null);
  assert.equal(decrypt(null), null);
});

test('maskKey hides the middle', () => {
  assert.equal(maskKey('sk-abcdefghijklmnop'), 'sk-a…mnop');
  assert.equal(maskKey('short'), '****');
  assert.equal(maskKey(null), '(not set)');
});

test('guild config: defaults, update, persist', () => {
  const cfg = getGuildConfig(GID);
  assert.equal(cfg.welcome.enabled, false);
  assert.deepEqual(cfg.botBanned, []);
  updateGuildConfig(GID, c => { c.botBanned.push('123'); c.welcome = { channelId: '42', message: 'hi {user}', enabled: true }; });
  const raw = JSON.parse(fs.readFileSync(`data/guilds/${GID}.json`, 'utf8'));
  assert.equal(raw.welcome.enabled, true);
  assert.ok(isBotBanned(GID, '123'));
  assert.ok(!isBotBanned(GID, '456'));
});

test('per-guild key overrides global; falls back otherwise', () => {
  updateGuildConfig(GID, c => { c.llm.apiKeyEnc = encrypt('guild-key'); c.llm.model = 'gpt-4o-mini'; });
  const eff = resolveLlmConfig(GID, { apiKey: 'global-key', baseUrl: 'https://x', model: 'm', temperature: 0.4 });
  assert.equal(eff.apiKey, 'guild-key');
  assert.equal(eff.model, 'gpt-4o-mini');
  assert.ok(eff.usingGuildKey);
  updateGuildConfig(GID, c => { c.llm.apiKeyEnc = null; });
  const eff2 = resolveLlmConfig(GID, { apiKey: 'global-key', baseUrl: 'https://x', model: 'm', temperature: 0.4 });
  assert.equal(eff2.apiKey, 'global-key');
  assert.ok(!eff2.usingGuildKey);
});

test('conversation turns + notes persist and can be forgotten', () => {
  clearMemory(GID);
  rememberTurn(GID, 'chan1', 'alice', 'hello');
  rememberTurn(GID, 'chan1', 'GENBOT', 'hi alice');
  assert.equal(getTurns(GID, 'chan1').length, 2);
  assert.equal(getTurns(GID, 'chan2').length, 0);
  rememberNote(GID, 'welcome channel is #lobby');
  rememberNote(GID, 'giveaway planned for friday');
  assert.equal(getNotes(GID).length, 2);
  assert.equal(forgetNote(GID, 'giveaway'), 1);
  assert.equal(getNotes(GID).length, 1);
  clearMemory(GID);
  assert.equal(getNotes(GID).length, 0);
});

test('renderTemplate fills placeholders', () => {
  const member = { id: '42', user: { username: 'bob' }, guild: { name: 'Cool Server', memberCount: 7 } };
  assert.equal(
    renderTemplate('Welcome {user} ({username}) to {server}! You are member #{count}', member),
    'Welcome <@42> (bob) to Cool Server! You are member #7'
  );
});
