// 加载器在入口 URL 上附加重载标记；向采集模块传递它，避免重载后仍用旧代码。
const statusUrl = new URL('./status.js', import.meta.url);
statusUrl.search = new URL(import.meta.url).search;
const { collectSystemStatus, formatSystemStatus } = await import(statusUrl.href);

export function isStatusCommand({ kind, entry, segments, botName = '', selfNickname = '', selfId = '' }) {
  if (!entry || entry.self || entry.isPoke || entry.recalled) return false;
  if (kind !== 'group' && kind !== 'private') return false;
  if (kind === 'group' && entry.atMe !== true) return false;
  let text;
  if (Array.isArray(segments)) {
    if (segments.some(s => !['text', 'at', 'reply'].includes(s?.type))) return false;
    text = segments.filter(s => s.type === 'text').map(s => String(s.data?.text || '')).join('');
  } else {
    text = String(entry.text || '');
    // 兼容纯文本/CQ 字符串来源；只剥除机器人自己的 @ 前缀。
    for (const name of [...new Set([botName, selfNickname, ...(entry.atNames || [])].filter(Boolean))].sort((a, b) => b.length - a.length)) {
      const mention = name.startsWith('@') ? name : `@${name}`;
      if (text.trimStart().startsWith(mention)) text = text.trimStart().slice(mention.length);
    }
    text = text.replace(/\[CQ:at,qq=(\d+)\]/g, (whole, id) => id === String(selfId) ? '' : whole);
  }
  return ['状态', '系统状态'].includes(text.trim());
}

export function createStatusProvider(collect = collectSystemStatus) {
  return ctx => isStatusCommand(ctx)
    ? { name: '系统状态', reply: async () => formatSystemStatus(await collect()) }
    : null;
}

export const providers = { 'message.command': createStatusProvider() };
