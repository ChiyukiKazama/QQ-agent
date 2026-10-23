import { registerTool } from './tool-registry.js';
import { audioLibrary, generateAudio, sendAudio } from './audio.js';

export function registerAudioTools() {
  registerTool({
    id: 'list_audio', name: '音频列表', category: 'media', icon: '🎵',
    description: '列出管理员导入的共享音频和本会话生成的音频编号。只能发送已有编号，不能读取宿主路径。临时音频保留 24 小时，saved=true 的长期保存。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) { return { content: JSON.stringify({ items: audioLibrary.list(ctx.chatKey) }) }; }
  });
  registerTool({
    id: 'generate_audio', name: '生成语音', category: 'media', icon: '🎙️',
    description: '调用管理员配置的本地 TTS 生成语音，返回音频编号；随后用 send_voice 发送。服务未配置时会报错，此时不能声称已生成。仅在用户要求长期保留时传 saved=true。',
    parameters: { type: 'object', properties: {
      text: { type: 'string', description: '要朗读的文本，最多 3000 字符' },
      name: { type: 'string', description: '可选音频名称' },
      saved: { type: 'boolean', description: '是否长期保存，默认 false' }
    }, required: ['text'] },
    async execute(ctx, args) {
      const item = await generateAudio({ text: args.text, name: args.name, saved: args.saved ?? false, chatKey: ctx.chatKey });
      return { content: JSON.stringify({ item, note: '已生成，尚未发送；调用 send_voice 发送到当前聊天。' }) };
    }
  });
  registerTool({
    id: 'send_voice', name: '发送语音', category: 'messaging', icon: '🔊',
    description: '将 list_audio 或 generate_audio 返回的音频编号作为真正的语音消息发送到当前聊天。仅在用户明确要求保存或取消保存时传 saved。',
    parameters: { type: 'object', properties: {
      audioId: { type: 'string', description: '音频编号，必须从工具结果原样复制' },
      saved: { type: 'boolean', description: '可选：设置是否长期保存；不传则保持原状态' }
    }, required: ['audioId'] },
    async execute(ctx, args) {
      const result = await sendAudio(ctx.sender, args.audioId, ctx.chatKey, { saved: args.saved });
      ctx.session.sent.push({ type: 'voice', text: '[语音]', at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
      ctx.emit('session-update', ctx.session.id);
      return { content: JSON.stringify({ sent: true, messageId: result.message_id ?? null }) };
    }
  });
}
