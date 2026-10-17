// QQ 原生表情编号与 Unicode code point 都由 SnowLuma set_group_reaction 支持。
export const MESSAGE_REACTIONS = [
  { name: '赞', emoji: '👍', id: '76' },
  { name: '爱心', emoji: '❤️', id: '66' },
  { name: '笑哭', emoji: '😂', id: '182' },
  { name: '思考', emoji: '🤔', id: '129300' },
  { name: '惊讶', emoji: '😲', id: '128562' },
  { name: '难过', emoji: '😭', id: '128557' },
  { name: '加油', emoji: '💪', id: '128170' },
  { name: 'OK', emoji: '👌', id: '128076' }
];

export function resolveMessageReaction(value) {
  const raw = String(value ?? '').trim().replace(/\uFE0F/g, '');
  return MESSAGE_REACTIONS.find(r => [r.name, r.emoji.replace(/\uFE0F/g, ''), r.id].includes(raw)) || null;
}
