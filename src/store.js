// Per-guild persistent store with encrypted secrets.
//
// Layout on disk:  data/guilds/<guildId>.json
//                  data/memory/<guildId>.json   (conversation history, plain)
//
// LLM API keys are NEVER stored in plaintext — they're encrypted with
// AES-256-GCM using a key derived from CONFIG_SECRET (.env). Without that
// secret the stored blobs are useless.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const GUILD_DIR = path.join(DATA_DIR, 'guilds');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');

for (const d of [DATA_DIR, GUILD_DIR, MEMORY_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// Persistent storage files for long-term activities
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const BUTTONS_FILE = path.join(DATA_DIR, 'buttons.json');

// ---------- encryption ----------

let masterKey = null;
export function initCrypto(secret) {
  if (!secret || secret.length < 8) {
    throw new Error('CONFIG_SECRET must be set (min 8 chars) — used to encrypt per-server API keys.');
  }
  masterKey = crypto.scryptSync(secret, 'genbot-guild-secrets-v1', 32);
}

export function encrypt(plaintext) {
  if (!masterKey) throw new Error('Crypto not initialised — call initCrypto() first.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob) {
  if (!masterKey) throw new Error('Crypto not initialised — call initCrypto() first.');
  if (!blob || !String(blob).startsWith('enc:v1:')) return null;
  try {
    const [, , ivB64, tagB64, dataB64] = String(blob).split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null; // wrong CONFIG_SECRET or corrupted blob
  }
}

// Mask a key for display: sk-abc...xyz
export function maskKey(key) {
  if (!key) return '(not set)';
  const s = String(key);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// ---------- guild config ----------

const DEFAULT_CONFIG = () => ({
  llm: { apiKeyEnc: null, baseUrl: null, model: null, temperature: null },
  welcome: { channelId: null, message: null, enabled: false },
  bye: { channelId: null, message: null, enabled: false },
  botBanned: [],           // user IDs forbidden from using the bot in this guild
  customCommands: {},      // name -> { prompt, createdBy, createdAt }
  respondMode: null,       // per-guild override of RESPOND_MODE
  commandChannelId: null,  // per-guild command channel
});

const cache = new Map(); // guildId -> config

function guildFile(guildId) {
  if (!/^\d{17,20}$/.test(String(guildId))) throw new Error('Bad guild id');
  return path.join(GUILD_DIR, `${guildId}.json`);
}

export function getGuildConfig(guildId) {
  if (cache.has(guildId)) return cache.get(guildId);
  let cfg = DEFAULT_CONFIG();
  try {
    const raw = JSON.parse(fs.readFileSync(guildFile(guildId), 'utf8'));
    cfg = { ...cfg, ...raw, llm: { ...cfg.llm, ...raw.llm }, welcome: { ...cfg.welcome, ...raw.welcome }, bye: { ...cfg.bye, ...raw.bye } };
  } catch { /* no file yet */ }
  cache.set(guildId, cfg);
  return cfg;
}

export function saveGuildConfig(guildId, cfg) {
  cache.set(guildId, cfg);
  fs.writeFileSync(guildFile(guildId), JSON.stringify(cfg, null, 2));
}

export function updateGuildConfig(guildId, fn) {
  const cfg = getGuildConfig(guildId);
  fn(cfg);
  saveGuildConfig(guildId, cfg);
  return cfg;
}

// Resolve the effective LLM settings for a guild: per-guild key first, global .env fallback.
export function resolveLlmConfig(guildId, globalCfg) {
  const cfg = guildId ? getGuildConfig(guildId) : null;
  const guildKey = cfg?.llm?.apiKeyEnc ? decrypt(cfg.llm.apiKeyEnc) : null;
  return {
    apiKey: guildKey || globalCfg.apiKey || null,
    baseUrl: cfg?.llm?.baseUrl || globalCfg.baseUrl,
    model: cfg?.llm?.model || globalCfg.model,
    temperature: cfg?.llm?.temperature ?? globalCfg.temperature,
    usingGuildKey: Boolean(guildKey),
  };
}

// ---------- bot-ban ----------

export function isBotBanned(guildId, userId) {
  if (!guildId) return false;
  return getGuildConfig(guildId).botBanned.includes(userId);
}

// ---------- persistent conversation memory ----------
// Per guild: { channels: { channelId: [{role, text, t}] }, notes: [ "fact", ... ] }
// "notes" are long-term facts the LLM asked to remember (welcome setup progress, etc.)

const memCache = new Map();
const MAX_TURNS = 20;   // per channel rolling window
const MAX_NOTES = 40;   // long-term facts per guild

function memFile(guildId) {
  if (!/^\d{17,20}$/.test(String(guildId))) throw new Error('Bad guild id');
  return path.join(MEMORY_DIR, `${guildId}.json`);
}

export function getMemory(guildId) {
  if (memCache.has(guildId)) return memCache.get(guildId);
  let mem = { channels: {}, notes: [] };
  try { mem = { channels: {}, notes: [], ...JSON.parse(fs.readFileSync(memFile(guildId), 'utf8')) }; } catch {}
  memCache.set(guildId, mem);
  return mem;
}

let saveTimers = new Map();
function saveMemoryDebounced(guildId) {
  clearTimeout(saveTimers.get(guildId));
  saveTimers.set(guildId, setTimeout(() => {
    try { fs.writeFileSync(memFile(guildId), JSON.stringify(getMemory(guildId))); } catch (e) { console.error('memory save failed:', e.message); }
  }, 1500));
}

export function rememberTurn(guildId, channelId, role, text) {
  if (!guildId) return;
  const mem = getMemory(guildId);
  const h = mem.channels[channelId] ?? (mem.channels[channelId] = []);
  h.push({ role, text: String(text).slice(0, 400), t: Date.now() });
  while (h.length > MAX_TURNS) h.shift();
  saveMemoryDebounced(guildId);
}

export function getTurns(guildId, channelId) {
  if (!guildId) return [];
  return getMemory(guildId).channels[channelId] ?? [];
}

export function rememberNote(guildId, note) {
  if (!guildId || !note) return;
  const mem = getMemory(guildId);
  const n = String(note).slice(0, 300);
  if (!mem.notes.includes(n)) {
    mem.notes.push(n);
    while (mem.notes.length > MAX_NOTES) mem.notes.shift();
  }
  saveMemoryDebounced(guildId);
}

export function forgetNote(guildId, needle) {
  if (!guildId) return 0;
  const mem = getMemory(guildId);
  const before = mem.notes.length;
  mem.notes = mem.notes.filter(n => !n.toLowerCase().includes(String(needle).toLowerCase()));
  saveMemoryDebounced(guildId);
  return before - mem.notes.length;
}

export function getNotes(guildId) {
  if (!guildId) return [];
  return getMemory(guildId).notes;
}

export function clearMemory(guildId, channelId = null) {
  const mem = getMemory(guildId);
  if (channelId) delete mem.channels[channelId];
  else { mem.channels = {}; mem.notes = []; }
  saveMemoryDebounced(guildId);
}

// ---------- persistent tasks & buttons ----------
// Used to survive bot restarts for schedules, giveaways, and button interactions

let _tasks = null;
export function getTasks() {
  if (_tasks) return _tasks;
  try {
    _tasks = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch {
    _tasks = [];
  }
  return _tasks;
}

export function saveTasks(tasks) {
  _tasks = tasks;
  fs.writeFileSync(TASKS_FILE, JSON.stringify(_tasks, null, 2));
}

export function addTask(type, executeAt, data) {
  const tasks = getTasks();
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  tasks.push({ id, type, executeAt, data });
  saveTasks(tasks);
  return id;
}

export function removeTask(id) {
  const tasks = getTasks();
  saveTasks(tasks.filter(t => t.id !== id));
}

let _buttons = null;
export function getButtonHandlers() {
  if (_buttons) return _buttons;
  try {
    _buttons = JSON.parse(fs.readFileSync(BUTTONS_FILE, 'utf8'));
  } catch {
    _buttons = {};
  }
  return _buttons;
}

export function saveButtonHandler(customId, replyText) {
  const btns = getButtonHandlers();
  btns[customId] = replyText;
  fs.writeFileSync(BUTTONS_FILE, JSON.stringify(btns, null, 2));
}

export function getButtonHandler(customId) {
  return getButtonHandlers()[customId] ?? null;
}
