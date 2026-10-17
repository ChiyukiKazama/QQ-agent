// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    // QQ 原生收藏身份（add_custom_face 的 emoji_id）：入了 QQ 收藏的条目靠它
    // 做幂等补录、备注回写（modify_custom_face）与长效地址回查。
    emojiId: String(entry.emojiId || '').trim(),
    // QQ 收藏是成员列表；移除的条目只保留认知，不再出现在选择/发送中。
    inQQ: entry.inQQ !== false,
    aliases: [...new Set((Array.isArray(entry.aliases) ? entry.aliases : []).map(String).filter(Boolean))],
    // 消息里的协议端缓存文件 id：转存失败后的重试线索（get_image 认它）。
    qqFile: String(entry.qqFile || '').trim(),
    // 本地转存产物（file:///）。搬家自愈后由 healLocalPaths 重写。
    localFile: String(entry.localFile || '').trim(),
    // 本地转存失败标记：提示这条目当前靠 url 存活（QQ 图床 rkey ~1h，僵尸预警）。
    persistFailed: entry.persistFailed === true,
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function mergeStickerLibrary(existing, fetched) {
  const previous = existing.map(normalizeStickerEntry).filter(Boolean);
  const used = new Set();
  const out = [];
  const seen = new Set();
  const keys = (e) => [e.id, e.resId, e.emojiId, ...(e.aliases || [])].filter(Boolean);
  const digest = (e) => e.md5 || keys(e).map((key) => key.match(/_([a-f\d]{32})_0_0$/i)?.[1]?.toUpperCase()).find(Boolean) || '';
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const md5 = String(item.md5 || digest({ id })).toUpperCase();
    const matches = previous.filter((e) => !used.has(e) && (keys(e).includes(id) || (md5 && digest(e) === md5)));
    matches.forEach((e) => used.add(e));
    const old = matches.find((e) => e.id === id) || matches[0];
    const local = matches.find((e) => e.localFile || e.url.startsWith('file:///'));
    const latest = [...matches].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: id,
      emojiId: id,
      inQQ: true,
      aliases: matches.flatMap(keys).filter((key) => key !== id),
      localFile: local?.localFile || local?.url || '',
      qqFile: matches.find((e) => e.qqFile)?.qqFile || '',
      persistFailed: false,
      url: local?.localFile || local?.url || String(item.url || old?.url || '').trim(),
      md5,
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: matches.map((e) => e.localNote).filter(Boolean).filter((note, i, all) => all.indexOf(note) === i).join('；'),
      tags: [...new Set(matches.flatMap((e) => e.tags))],
      usage: matches.find((e) => e.usage)?.usage || '',
      source: 'qq',
      useCount: matches.reduce((sum, e) => sum + e.useCount, 0),
      lastUsedAt: latest?.lastUsedAt || 0,
      lastContext: latest?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    out.push(merged);
  }
  // 不删除旧笔记和文件；QQ 中已删除/收藏失败的图片保留为不可选的归档。
  return [...out, ...previous.filter((e) => !used.has(e)).map((e) => ({ ...e, inQQ: false }))];
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e || e.inQQ === false) return false;
    if (e.id === raw || e.resId === raw || e.emojiId === raw || e.aliases?.includes(raw)) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter((e) => e && e.inQQ !== false);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    useCount: e.useCount || 0
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/**
 * 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。
 * 全量列举当前 QQ 收藏，按 id 固定排序，不随时间和使用次数改变。
 * 这里只列文字摘要和可发送的 id，图片仍由 get_sticker_image 按需读取。
 */
export function buildStickerContext(entries) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry)
    .filter((e) => e && e.inQQ !== false)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (!list.length) return '';
  const lines = list.map((e) => {
    const label = e.desc || e.localNote || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    // 不展示使用次数：真实计数每发一次表情就 +1，写进提示词会让【可用表情包】
    // 段每次运行都变（把它后面的全部段落挤出缓存前缀）。模型只需要知道
    // "有哪些表情"；使用次数不参与摘要排序，也不进入文本。
    return `- ${label}${extra} id=${e.id}`;
  });
  return `【可用表情包】以下是你的全部 ${list.length} 个 QQ 收藏表情摘要（固定顺序；需要看图时用 get_sticker_image）：\n${lines.join('\n')}`;
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint(level = 1) {
  // 活跃度引导放在系统提示的策略段里（而不是"本次输入"的【表情包用法】）——
  // 同一主题两处引导会左右脑互搏（Kondius 2026-09-07）：策略讲时机、档位讲频率，
  // 合并成一处由档位直接改写频率行。
  // ⚠️ 索引严格对应 0~3 档，与 ui 的 STICKER_LEVELS 一致。
  const freqByLevel = [
    '表情包是备选项，不勉强；纯文字回应完全没问题。',
    '频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '频率：回应、吐槽、接梗时优先考虑配一个贴切的表情，让对话更有活人感；别每次都用同一张。',
    '频率：你是表情包爱好者——能配表情的地方尽量配，接梗/调侃/附和时几乎都会带一张，聊天要有表情包的烟火气；注意换着用，不要连发同一张。'
  ][Math.min(3, Math.max(0, Number(level) || 0))];
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    `- ${freqByLevel}`,
    '- 选择：优先用备注（desc）和你的记忆（localNote/tags）能准确对上语境的；没有备注/不确定的表情，先 get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 send_message 作为单独气泡发出，再单独发表情。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
