// 专用音频库和本地 TTS 适配；不向模型暴露宿主路径或任意执行能力。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';

export const AUDIO_MAX_BYTES = 20 * 1024 * 1024;
export const AUDIO_TEMP_MS = 24 * 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORMATS = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', amr: 'audio/amr', silk: 'audio/silk' };

export function audioError(message, status = 400) {
  return Object.assign(new Error(message), { status, expose: true });
}

export function validAudioChat(chatKey, { optional = false } = {}) {
  const key = String(chatKey ?? '');
  if (optional && key === '') return '';
  if (!/^(group|private):[1-9]\d*$/.test(key)) throw audioError('请选择有效的群或私聊');
  return key;
}

export function assertVoiceTarget(chatKey) {
  validAudioChat(chatKey);
  const [kind, id] = chatKey.split(':');
  const cfg = getConfig();
  const field = kind === 'group' ? 'groups' : 'private';
  const deny = (cfg.deny?.[kind] ?? cfg.deny?.[field] ?? []).map(String);
  const allow = (cfg.allow?.[kind] ?? cfg.allow?.[field] ?? []).map(String);
  if (deny.includes(id) || !(allow.includes(id) || (!allow.length && cfg.allowAllWhenEmpty === true))) {
    throw audioError('该会话不在允许发送的白名单中', 403);
  }
}

export function detectAudio(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw audioError('音频为空、过短或格式不受支持');
  const starts = text => buffer.subarray(0, text.length).toString('ascii') === text;
  if (buffer.length >= 44 && starts('RIFF') && buffer.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (starts('ID3') || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0 && (buffer[1] & 0x06) !== 0)) return 'mp3';
  if (starts('OggS')) return 'ogg';
  if (starts('fLaC')) return 'flac';
  if (starts('#!AMR')) return 'amr';
  if (starts('#!SILK_V3') || buffer.subarray(1, 10).toString('ascii') === '#!SILK_V3') return 'silk';
  if (buffer.toString('ascii', 4, 8) === 'ftyp' && /^(M4A |M4B |isom|mp42)/.test(buffer.toString('ascii', 8, 12))) return 'm4a';
  throw audioError('未识别为音频文件；支持 WAV、MP3、M4A、OGG、FLAC、AMR、SILK');
}

function publicAudio(item) {
  const { id, name, format, sizeBytes, createdAt, saved, chatKey, source } = item;
  return { id, name, format, mime: FORMATS[format], sizeBytes, createdAt, saved, chatKey, source,
    expiresAt: saved ? null : createdAt + AUDIO_TEMP_MS };
}

export class AudioLibrary {
  constructor(root = path.join(DATA_DIR, 'audio')) {
    this.root = path.resolve(root);
    this.busy = new Set();
  }

  ensureRoot() {
    // 目录由程序管理；拒绝把音频库重定向到链接目标。
    fs.mkdirSync(this.root, { recursive: true });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw audioError('音频目录不能是链接', 409);
  }

  file(id, ext) {
    if (!ID.test(String(id)) || !(ext === 'json' || Object.hasOwn(FORMATS, ext))) throw audioError('无效音频编号');
    return path.join(this.root, `${id}.${ext}`);
  }

  metadata(id) {
    this.ensureRoot();
    const file = this.file(id, 'json');
    if (!fs.existsSync(file)) throw audioError('音频不存在或临时音频已过期', 404);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw audioError('音频记录异常', 409);
    const item = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (item.id !== id || !Object.hasOwn(FORMATS, item.format) || !Number.isFinite(item.createdAt)) throw audioError('音频记录异常', 409);
    validAudioChat(item.chatKey, { optional: true });
    return item;
  }

  writeMetadata(item) {
    const dest = this.file(item.id, 'json');
    const tmp = path.join(this.root, `${item.id}.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(item), { flag: 'wx' });
      fs.renameSync(tmp, dest);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }

  sweep(now = Date.now()) {
    this.ensureRoot();
    for (const file of fs.readdirSync(this.root)) {
      const id = file.endsWith('.json') ? file.slice(0, -5) : '';
      if (!ID.test(id) || this.busy.has(id)) continue;
      const item = this.metadata(id);
      if (!item.saved && item.createdAt + AUDIO_TEMP_MS <= now) this.remove(id);
    }
  }

  list(chatKey = null) {
    if (chatKey !== null) validAudioChat(chatKey);
    this.sweep();
    return fs.readdirSync(this.root).filter(f => f.endsWith('.json') && ID.test(f.slice(0, -5)))
      .map(f => this.metadata(f.slice(0, -5)))
      .filter(item => chatKey === null || !item.chatKey || item.chatKey === chatKey)
      .sort((a, b) => b.createdAt - a.createdAt).map(publicAudio);
  }

  add(buffer, { name = '', saved = false, chatKey = '', source = 'import' } = {}) {
    validAudioChat(chatKey, { optional: true });
    if (typeof saved !== 'boolean') throw audioError('保存选项必须为布尔值');
    if (buffer.length > AUDIO_MAX_BYTES) throw audioError('单个音频不能超过 20MB', 413);
    const format = detectAudio(buffer);
    const items = this.list();
    if (items.length >= 500 || items.reduce((sum, item) => sum + item.sizeBytes, 0) + buffer.length > 500 * 1024 * 1024) {
      throw audioError('音频库已达到 500 条或 500MB 上限，请先删除不需要的音频', 409);
    }
    const id = randomUUID();
    const cleanName = String(name || (source === 'tts' ? '生成语音' : '导入音频')).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 100);
    const item = { id, format, name: cleanName, saved, chatKey, source, sizeBytes: buffer.length, createdAt: Date.now() };
    const file = this.file(id, format);
    fs.writeFileSync(file, buffer, { flag: 'wx' });
    try { this.writeMetadata(item); } catch (error) { fs.unlinkSync(file); throw error; }
    return publicAudio(item);
  }

  resolve(id, chatKey = null) {
    const item = this.metadata(id);
    if (chatKey !== null) {
      validAudioChat(chatKey);
      if (item.chatKey && item.chatKey !== chatKey) throw audioError('该音频属于其他会话', 403);
    }
    if (!item.saved && item.createdAt + AUDIO_TEMP_MS <= Date.now()) throw audioError('临时音频已过期', 404);
    const file = this.file(id, item.format);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== item.sizeBytes || stat.size > AUDIO_MAX_BYTES) throw audioError('音频文件异常', 409);
    return { ...publicAudio(item), file };
  }

  setSaved(id, saved, chatKey = null) {
    if (typeof saved !== 'boolean') throw audioError('保存选项必须为布尔值');
    this.resolve(id, chatKey);
    const item = this.metadata(id);
    item.saved = saved;
    // 取消长期保存时，从现在重新计算临时保留期。
    if (!saved) item.createdAt = Date.now();
    this.writeMetadata(item);
    return publicAudio(item);
  }

  remove(id) {
    if (this.busy.has(id)) throw audioError('音频正在发送或读取，请稍后再删除', 409);
    const item = this.metadata(id);
    const file = this.file(id, item.format);
    if (fs.existsSync(file)) fs.unlinkSync(file); // 只删除音频库自己的条目，不动导入源文件。
    fs.unlinkSync(this.file(id, 'json'));
  }

  async using(id, chatKey, fn) {
    const item = this.resolve(id, chatKey);
    if (this.busy.has(id)) throw audioError('该音频正在使用，请稍后重试', 409);
    this.busy.add(id);
    try { return await fn(item); } finally { this.busy.delete(id); }
  }
}

export const audioLibrary = new AudioLibrary();
export function startAudioCleanup(log = console.warn) {
  const sweep = () => { try { audioLibrary.sweep(); } catch (error) { log(`[audio] 临时音频清理失败：${error.message}`); } };
  sweep();
  const timer = setInterval(sweep, 15 * 60 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}
let generating = false;

export async function generateAudio({ text, name, saved = false, chatKey = '' }, library = audioLibrary) {
  const cfg = getConfig().audio?.tts || {};
  if (cfg.enabled !== true) throw audioError('请先在设置 → 语音中启用并配置本地语音生成');
  text = String(text ?? '').trim();
  if (!text || text.length > 3000) throw audioError('生成文本应为 1～3000 字符');
  validAudioChat(chatKey, { optional: true });
  if (typeof saved !== 'boolean') throw audioError('保存选项必须为布尔值');
  if (generating) throw audioError('本地语音模型正在生成，请稍后重试', 409);
  let url;
  try { url = new URL(cfg.baseUrl); } catch { throw audioError('请填写有效的本地语音服务地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw audioError('语音服务地址仅支持本机 localhost、127.0.0.1 或 [::1]，且不能包含凭据或查询参数');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const speed = Number(cfg.speed ?? 1);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) throw audioError('语速应为 0.25～4');
  let body;
  if (cfg.provider === 'gpt-sovits') {
    if (!String(cfg.refAudioPath || '').trim() || !cfg.textLang || !cfg.promptLang) throw audioError('GPT-SoVITS 需要参考音频路径、文本语言和参考语言');
    url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/tts$/, '')}/tts`;
    body = { text, text_lang: cfg.textLang, ref_audio_path: cfg.refAudioPath,
      prompt_text: String(cfg.promptText || ''), prompt_lang: cfg.promptLang,
      speed_factor: speed, media_type: 'wav', streaming_mode: false };
  } else if (cfg.provider === 'openai') {
    if (!String(cfg.model || '').trim() || !String(cfg.voice || '').trim()) throw audioError('请配置本地 TTS 的模型名和音色');
    const base = url.pathname.replace(/\/$/, '');
    url.pathname = base.endsWith('/audio/speech') ? base : `${base || '/v1'}/audio/speech`;
    body = { input: text, model: cfg.model, voice: cfg.voice, speed, response_format: 'wav' };
  } else throw audioError('未知语音服务类型');
  generating = true;
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw audioError(`本地语音服务返回 HTTP ${response.status}，请检查模型服务日志`, 502);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > AUDIO_MAX_BYTES) throw audioError('生成音频超过 20MB 上限', 413);
      chunks.push(chunk);
    }
    return library.add(Buffer.concat(chunks), { name, saved, chatKey, source: 'tts' });
  } catch (error) {
    if (error.expose) throw error;
    throw audioError(error.name === 'TimeoutError' ? '本地语音生成超过 120 秒，请缩短文本后重试' : '无法完成本地语音生成，请检查服务是否已启动及输出是否为音频', 502);
  } finally { generating = false; }
}

export async function sendAudio(sender, id, chatKey, { saved } = {}, library = audioLibrary) {
  assertVoiceTarget(chatKey);
  if (saved !== undefined) library.setSaved(id, saved, chatKey);
  return library.using(id, chatKey, item => sender.sendVoice(chatKey, item));
}
