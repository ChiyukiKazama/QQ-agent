// 使用独立音频库、回环 TTS/协议桩；不会向真实 QQ 或模型发送请求。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { test, beforeEach } from 'node:test';
import { JSDOM } from 'jsdom';

const testRoot = process.env.QQ_AGENT_AUDIO_TEST_DIR;
if (!testRoot) throw new Error('Set QQ_AGENT_AUDIO_TEST_DIR to an isolated test directory');
fs.mkdirSync(testRoot, { recursive: true });
process.env.QQ_AGENT_DATA_DIR = testRoot;
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig, updateConfig } = await import('../src/config.js');
const { AudioLibrary, audioLibrary, AUDIO_TEMP_MS, AUDIO_MAX_BYTES, detectAudio, generateAudio, sendAudio } = await import('../src/audio.js');
const { createAudioRoutes } = await import('../src/audio-routes.js');
const { SendQueue } = await import('../src/sender.js');
const { OneBotClient } = await import('../src/onebot.js');
const { buildToolDefs, executeTool } = await import('../src/tools.js');

beforeEach(() => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.allow = { groups: ['123'], private: ['456'] };
  setRuntimeConfig(cfg);
});
function wav() {
  const b = Buffer.alloc(204);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  return b;
}
const library = () => new AudioLibrary(path.join(testRoot, randomUUID()));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
function queue({ remote = false, fail = false } = {}) {
  const calls = [], history = [];
  const onebot = new OneBotClient({ httpUrl: remote ? 'http://192.0.2.1:3000' : 'http://127.0.0.1:3000' });
  onebot.call = async (action, params) => { calls.push({ action, params }); if (fail) throw new Error('协议端拒绝音频'); return { message_id: -987 }; };
  const sender = new SendQueue({ onebot, store: { appendSelf: (...args) => history.push(args) } });
  return { sender, calls, history };
}

test('imports a managed copy, detects content instead of trusting the extension, and removes only its copy', () => {
  const lib = library();
  const source = path.join(testRoot, `${randomUUID()}.wav`);
  fs.writeFileSync(source, wav());
  const item = lib.add(fs.readFileSync(source), { name: '中文 #?.mp3' });
  assert.equal(item.format, 'wav');
  assert.equal(item.saved, false);
  assert.equal(item.expiresAt, item.createdAt + AUDIO_TEMP_MS);
  assert.equal('file' in item, false);
  assert.deepEqual(fs.readFileSync(lib.resolve(item.id).file), wav());
  lib.remove(item.id);
  assert.equal(lib.list().length, 0);
  assert.equal(fs.existsSync(source), true);
});

test('rejects non-audio, empty and oversized files', () => {
  const lib = library();
  assert.throws(() => lib.add(Buffer.from('<html>not audio</html>')), /未识别/);
  assert.throws(() => lib.add(Buffer.alloc(0)), /为空/);
  assert.throws(() => lib.add(Buffer.alloc(AUDIO_MAX_BYTES + 1)), /20MB/);
});

test('recognizes common audio containers including SILK', () => {
  for (const [header, type] of [['ID3', 'mp3'], ['OggS', 'ogg'], ['fLaC', 'flac'], ['#!AMR\n', 'amr'], ['#!SILK_V3', 'silk']]) {
    const b = Buffer.alloc(30); b.write(header); assert.equal(detectAudio(b), type);
  }
  const b = Buffer.alloc(30); b.write('ftypM4A ', 4); assert.equal(detectAudio(b), 'm4a');
});

test('scope checks permit shared assets but deny audio owned by another chat', () => {
  const lib = library();
  const shared = lib.add(wav());
  const privateItem = lib.add(wav(), { chatKey: 'private:456' });
  assert.equal(lib.list('group:123').length, 1);
  assert.ok(lib.resolve(shared.id, 'group:123'));
  assert.throws(() => lib.resolve(privateItem.id, 'group:123'), /其他会话/);
  assert.throws(() => lib.resolve('../config'), /无效音频/);
});

test('saved assets survive expiry and restart; unsaving starts a fresh retention period', () => {
  const lib = library();
  const saved = lib.add(wav(), { saved: true });
  const temp = lib.add(wav());
  lib.sweep(Date.now() + AUDIO_TEMP_MS + 1);
  assert.equal(new AudioLibrary(lib.root).list().length, 1);
  assert.throws(() => lib.resolve(temp.id), /不存在/);
  const unsaved = lib.setSaved(saved.id, false);
  assert.equal(unsaved.saved, false);
  assert.ok(unsaved.expiresAt > Date.now());
  assert.equal(lib.setSaved(saved.id, true).expiresAt, null);
});

test('an active send protects its file from deletion and expiration cleanup', async () => {
  const lib = library();
  const item = lib.add(wav());
  await lib.using(item.id, null, async audio => {
    assert.throws(() => lib.remove(item.id), /正在发送/);
    lib.sweep(Date.now() + AUDIO_TEMP_MS + 1);
    assert.ok(fs.existsSync(audio.file));
  });
  lib.remove(item.id);
});

test('rejects a library directory redirected through a junction', t => {
  const target = path.join(testRoot, randomUUID()); fs.mkdirSync(target);
  const link = path.join(testRoot, randomUUID());
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('symlinks unavailable'); throw error; }
  try { assert.throws(() => new AudioLibrary(link).add(wav()), /不能是链接/); }
  finally { fs.unlinkSync(link); }
});

test('voice sending uses a record message, small local file URI, content dedupe and successful history', async () => {
  const lib = library(); const item = lib.add(wav()); const q = queue();
  await sendAudio(q.sender, item.id, 'group:123', {}, lib);
  assert.equal(q.calls[0].action, 'send_group_msg');
  assert.deepEqual(q.calls[0].params.message.map(s => s.type), ['record']);
  assert.match(q.calls[0].params.message[0].data.file, /^file:\/\//);
  assert.equal(q.history[0][0], 'group:123');
  const same = lib.add(wav());
  await assert.rejects(sendAudio(q.sender, same.id, 'group:123', {}, lib), /重复发送/);
  assert.equal(q.calls.length, 1);
});

test('remote protocol endpoints receive base64 and private messages use private routing', async () => {
  const lib = library(); const item = lib.add(wav()); const q = queue({ remote: true });
  await sendAudio(q.sender, item.id, 'private:456', { saved: true }, lib);
  assert.equal(q.calls[0].action, 'send_private_msg');
  assert.equal(q.calls[0].params.user_id, 456);
  assert.match(q.calls[0].params.message[0].data.file, /^base64:\/\//);
  assert.equal(lib.resolve(item.id).saved, true);
});

test('voice honors deny/allow lists and the shared per-chat send quota', async () => {
  const lib = library(); const item = lib.add(wav()); const q = queue();
  await assert.rejects(sendAudio(q.sender, item.id, 'group:999', {}, lib), /白名单/);
  getConfig().deny.groups = ['123'];
  await assert.rejects(sendAudio(q.sender, item.id, 'group:123', {}, lib), /白名单/);
  getConfig().deny.groups = [];
  getConfig().send.maxPerMinute = 1;
  q.sender.minuteTimes.set('group:123', [Date.now()]);
  await assert.rejects(sendAudio(q.sender, item.id, 'group:123', {}, lib), /频率超限/);
  assert.equal(q.calls.length, 0);
});

test('failed protocol sending preserves the audio for retry and writes no success history', async () => {
  const lib = library(); const item = lib.add(wav()); const q = queue({ fail: true });
  await assert.rejects(sendAudio(q.sender, item.id, 'group:123', {}, lib), /协议端拒绝/);
  assert.ok(lib.resolve(item.id));
  assert.equal(q.calls.length, 1);
  assert.equal(q.history.length, 0);
});

test('generation without configuration fails without making a request', async () => {
  await assert.rejects(generateAudio({ text: '测试' }, library()), /启用并配置/);
});

test('both TTS adapters send the documented fields and persist the returned audio', async () => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(text) });
    res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav());
  });
  const port = await listen(server);
  try {
    getConfig().audio.tts = { enabled: true, provider: 'openai', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'local-test', voice: 'voice-test', speed: 1.2, apiKey: 'private-key' };
    const lib = library();
    const item = await generateAudio({ text: '中文语音', chatKey: 'group:123', saved: true }, lib);
    assert.equal(item.format, 'wav'); assert.equal(item.saved, true);
    assert.equal(calls[0].url, '/v1/audio/speech');
    assert.equal(calls[0].headers.authorization, 'Bearer private-key');
    assert.deepEqual(calls[0].body, { input: '中文语音', model: 'local-test', voice: 'voice-test', speed: 1.2, response_format: 'wav' });
    Object.assign(getConfig().audio.tts, { provider: 'gpt-sovits', baseUrl: `http://127.0.0.1:${port}`, refAudioPath: 'C:/voices/ref.wav', promptText: '参考文本', textLang: 'zh', promptLang: 'zh' });
    await generateAudio({ text: '测试' }, lib);
    assert.equal(calls[1].url, '/tts');
    assert.equal(calls[1].body.ref_audio_path, 'C:/voices/ref.wav');
    assert.equal(calls[1].body.streaming_mode, false);
    assert.equal(calls[1].body.text_lang, 'zh');
  } finally { await close(server); }
});

test('generation rejects non-local URLs and missing model parameters', async () => {
  Object.assign(getConfig().audio.tts, { enabled: true, baseUrl: 'http://example.com/v1' });
  await assert.rejects(generateAudio({ text: '测试' }, library()), /仅支持本机/);
  getConfig().audio.tts.baseUrl = 'http://127.0.0.1:1/v1';
  await assert.rejects(generateAudio({ text: '测试' }, library()), /模型名和音色/);
  await assert.rejects(generateAudio({ text: 'a'.repeat(3001) }, library()), /3000/);
});

test('service errors, invalid audio and redirects fail without creating an artifact', async () => {
  let mode = 'http';
  const server = http.createServer((req, res) => {
    if (mode === 'http') { res.writeHead(500); return res.end('private diagnostics'); }
    if (mode === 'redirect') { res.writeHead(302, { location: 'http://example.com/' }); return res.end(); }
    res.end('<html>not audio</html>');
  });
  const port = await listen(server);
  try {
    Object.assign(getConfig().audio.tts, { enabled: true, baseUrl: `http://127.0.0.1:${port}/v1`, model: 'test', voice: 'test' });
    const lib = library();
    await assert.rejects(generateAudio({ text: '测试' }, lib), /HTTP 500/);
    mode = 'invalid'; await assert.rejects(generateAudio({ text: '测试' }, lib), /未识别/);
    mode = 'redirect'; await assert.rejects(generateAudio({ text: '测试' }, lib), /无法完成/);
    assert.equal(lib.list().length, 0);
  } finally { await close(server); }
});

test('the Agent sees only permitted audio and can generate/send by ID with session bookkeeping', async () => {
  const item = audioLibrary.add(wav(), { chatKey: 'group:123' });
  audioLibrary.add(wav(), { chatKey: 'private:456' });
  const ctx = { chatKey: 'group:123', session: { id: 'audio-session', sent: [] }, emit() {}, sender: { sendVoice: async () => ({ message_id: 42 }) } };
  const defs = buildToolDefs();
  const listed = await executeTool(defs, ctx, 'list_audio', '{}');
  assert.equal(JSON.parse(listed.content).items.some(a => a.chatKey === 'private:456'), false);
  assert.equal(listed.content.includes(testRoot), false);
  const sent = await executeTool(defs, ctx, 'send_voice', { audioId: item.id });
  assert.equal(JSON.parse(sent.content).sent, true);
  assert.equal(ctx.session.sent[0].type, 'voice');
  const disabled = await executeTool(defs, ctx, 'generate_audio', { text: '测试' });
  assert.equal(disabled.isError, true);
});

test('audio routes support binary upload, preview, save, send and deletion', async () => {
  const q = queue();
  const routes = createAudioRoutes({ sender: q.sender, readBody: async req => { let s = ''; for await (const c of req) s += c; return JSON.parse(s); } });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      for (const route of routes) {
        const match = route.pattern instanceof RegExp ? route.pattern.exec(url.pathname) : null;
        if (route.method === req.method && (match || route.pattern === url.pathname)) return await route.handler({ req, res, url, json, match });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, e.status || 500, { error: e.message }); }
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${base}/api/audio/import?name=test.wav&chatKey=group%3A123`, { method: 'POST', body: wav() });
    assert.equal(response.status, 200); const { item } = await response.json();
    const content = await fetch(`${base}/api/audio/${item.id}/content`);
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), wav());
    const saved = await fetch(`${base}/api/audio/${item.id}/save`, { method: 'POST', body: JSON.stringify({ saved: true }) });
    assert.equal((await saved.json()).item.saved, true);
    const denied = await fetch(`${base}/api/audio/${item.id}/send`, { method: 'POST', body: JSON.stringify({ chatKey: 'group:999' }) });
    assert.equal(denied.status, 403);
    const sent = await fetch(`${base}/api/audio/${item.id}/send`, { method: 'POST', body: JSON.stringify({ chatKey: 'group:123' }) });
    assert.equal((await sent.json()).messageId, -987);
    assert.equal((await fetch(`${base}/api/audio/${item.id}`, { method: 'DELETE' })).status, 200);
  } finally { await close(server); }
});

test('audio page renders, preserves a configured secret when left blank, and exposes both providers', () => {
  const dom = new JSDOM('<div id="settings-form"></div>', { runScripts: 'outside-only', url: 'http://127.0.0.1' });
  const w = dom.window;
  w.state = { config: getConfig(), chats: [] };
  w.esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  w.switchHtml = (id, checked) => `<input id="${id}" type="checkbox" ${checked ? 'checked' : ''}>`;
  w.eval(fs.readFileSync(new URL('../ui/app/13-audio.js', import.meta.url), 'utf8') + '\nwindow.audioTest = { renderAudioSection, collectAudioSettings };');
  w.document.getElementById('settings-form').innerHTML = w.audioTest.renderAudioSection(w.state.config);
  assert.ok(w.document.getElementById('audio-import-file'));
  assert.equal(w.document.querySelectorAll('#cfg-audio-provider option').length, 2);
  assert.equal(w.document.querySelectorAll('#audio-target option').length, 3);
  updateConfig({ audio: { tts: { apiKey: 'keep-me' } } });
  const patch = w.audioTest.collectAudioSettings();
  assert.equal('apiKey' in patch.tts, false);
  updateConfig({ audio: JSON.parse(JSON.stringify(patch)) });
  assert.equal(getConfig().audio.tts.apiKey, 'keep-me');
  dom.window.close();
});

test('audio page buttons import, generate, preview, save and send with the selected scope', async () => {
  const dom = new JSDOM('<div id="settings-form"></div>', { runScripts: 'outside-only', url: 'http://127.0.0.1' });
  const w = dom.window;
  let items = [{ id: randomUUID(), name: '测试音频', format: 'wav', sizeBytes: 204, saved: false, chatKey: '', expiresAt: Date.now() + AUDIO_TEMP_MS }];
  const calls = [];
  w.state = { settingsSection: 'audio', config: getConfig(), chats: [] };
  w.$ = selector => w.document.querySelector(selector);
  w.esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  w.fmtTime = String;
  w.switchHtml = (id, checked) => `<input id="${id}" type="checkbox" ${checked ? 'checked' : ''}>`;
  w.CONSOLE_MARKER = 'test-marker';
  w.uiConfirm = async () => true;
  w.saveConfig = async () => { calls.push({ action: 'config' }); };
  w.api = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (url === '/api/audio') return { items };
    if (url.endsWith('/save')) { items = items.map(item => ({ ...item, saved: body.saved })); return { item: items[0] }; }
    if (url.endsWith('/send')) return { messageId: 1234 };
    if (url.endsWith('/generate')) return { item: { name: '生成语音' } };
    if (options.method === 'DELETE') { items = []; return { ok: true }; }
    throw new Error(url);
  };
  w.URL.createObjectURL = () => 'blob:audio-test';
  w.URL.revokeObjectURL = () => {};
  w.HTMLMediaElement.prototype.play = async () => {};
  w.fetch = async (url, options = {}) => {
    calls.push({ uploadUrl: String(url), options });
    return { ok: true, blob: async () => new w.Blob([wav()]), json: async () => ({ item: { name: '导入语音' } }) };
  };
  w.eval(fs.readFileSync(new URL('../ui/app/13-audio.js', import.meta.url), 'utf8') + '\nwindow.audioTest = { renderAudioSection, bindAudioEvents };');
  w.$('#settings-form').innerHTML = w.audioTest.renderAudioSection(w.state.config);
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));
  const input = (selector, value) => { const el = w.$(selector); el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  try {
    w.audioTest.bindAudioEvents(); await tick();
    input('#audio-target', 'group:123');
    w.$('[data-audio-action="preview"]').click(); await tick();
    assert.equal(w.$('audio').classList.contains('hidden'), false);
    w.$('[data-audio-action="send"]').click(); await tick();
    assert.equal(calls.find(call => call.url?.endsWith('/send')).body.chatKey, 'group:123');
    w.$('[data-audio-action="save"]').click(); await tick();
    assert.equal(items[0].saved, true);
    input('#audio-text', '要生成的中文语音');
    w.$('#audio-generate').click(); await tick();
    const generation = calls.find(call => call.url?.endsWith('/generate'));
    assert.equal(generation.body.text, '要生成的中文语音');
    assert.equal(generation.body.chatKey, 'group:123');
    const file = new File([wav()], 'source.wav', { type: 'audio/wav' });
    Object.defineProperty(w.$('#audio-import-file'), 'files', { value: [file] });
    w.$('#audio-import').click(); await tick();
    const upload = calls.find(call => call.uploadUrl?.startsWith('/api/audio/import'));
    assert.equal(upload.options.body, file);
    assert.match(upload.uploadUrl, /chatKey=group%3A123/);
    assert.equal(upload.options.headers['x-console-token'], 'test-marker');
    w.$('[data-audio-action="delete"]').click(); await tick();
    assert.equal(items.length, 0);
    w.$('#cfg-audio-provider').value = 'gpt-sovits';
    w.$('#cfg-audio-provider').dispatchEvent(new w.Event('change', { bubbles: true }));
    assert.equal(w.$('#cfg-audio-url').value, 'http://127.0.0.1:9880');
    assert.equal(w.$('#audio-sovits-fields').classList.contains('hidden'), false);
  } finally { w.close(); }
});
