import { getConfig } from '../../src/config.js';

const pending = new Map();
export const REACTION_GUIDANCE = [
  '消息下方的小表情是轻量参与，不等于插话或发送收藏表情包。',
  '普通群友聊天时，看到明确值得赞同、开心、喜欢、鼓励、安慰或接梗的消息，优先用 send_reaction 贴一个符合语境的表情，然后结束；不必等别人 @你或要求点赞。',
  '“没叫我”“他们在互相聊天”“没必要发文字”不等于不能贴表情。决定 finish 前先检查是否有适合的小表情回应；有明确合适对象时优先贴表情，不要习惯性全部跳过。',
  '只选本轮未读的一条，messageId 照抄 #数字。不回头给旧消息补贴，不给自己贴，不逐条操作。看不懂的图、严肃争执、明显不合适或没有态度的内容仍可安静结束。',
  '被直接提问、需要解释或具体帮助时照常回答，不用表情敷衍；贴完表情不需要汇报“已点赞”。'
].join('\n');

export function available({ kind } = {}) {
  if (kind && kind !== 'group') return { ok: false, reason: '自主表情回应仅用于群聊' };
  const tools = getConfig().tools || {};
  if (tools.enabled === false || tools.categories?.messaging === false || tools.overrides?.send_reaction === false) {
    return { ok: false, reason: '消息表情回应工具已关闭' };
  }
  return true;
}

export function promptSections() {
  return [{ id: 'autonomous-reactions-policy', title: '自主表情回应', priority: 50, content: REACTION_GUIDANCE }];
}

export const hooks = {
  'before-context'(context) {
    const { kind, sessionId, triggerEntries = [], proactive } = context;
    if (!sessionId || kind !== 'group' || proactive || available(context) !== true) return;
    // 直接召唤优先正常答复；普通消息只使用核心已允许的这次处理机会。
    if (triggerEntries.some(e => e.atMe === true || e.isPoke)) return;
    const ids = [...new Set(triggerEntries
      .filter(e => !e.self && !e.recalled && /^-?\d+$/.test(String(e.mid ?? '')) && Number.isSafeInteger(Number(e.mid)) && Number(e.mid) !== 0)
      .map(e => String(e.mid)))];
    if (ids.length) pending.set(sessionId, ids);
  },
  'before-llm-messages'(context) {
    const ids = pending.get(context.sessionId);
    pending.delete(context.sessionId);
    if (!ids || available(context) !== true || !Array.isArray(context.messages)) return;
    context.messages.push({ role: 'user', content: [
      '【本轮普通群聊：先考虑轻量表情回应】',
      '本轮已由现有响应档位获得处理机会，无需再次等待 @。先判断未读消息里有没有适合赞同、接梗、鼓励或安慰的对象。',
      `可选的本轮群友消息：${ids.map(id => '#' + id).join('、')}。只从这里照抄 messageId，表情根据上文实际内容选择。`,
      '有明确合适对象时，优先调用 send_reaction，再 finish；没必要写文字本身不应成为直接跳过表情回应的理由。确实没有合适内容则 finish，不强行贴。'
    ].join('\n') });
  }
};

export function deactivate() { pending.clear(); }
export function dispose() { pending.clear(); }
