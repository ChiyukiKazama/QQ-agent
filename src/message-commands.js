// 确定性消息命令：匹配在入站热路径同步完成，耗时采集/发送在后台执行。
// provider(ctx) 返回 null 或 { name, reply: async () => string }；不经过模型。
export class MessageCommandDispatcher {
  constructor({ getProviders, canRun, store, sender, sessions, emit = () => {}, log = () => {} }) {
    Object.assign(this, { getProviders, canRun, store, sender, sessions, emit, log });
  }

  handle(ctx) {
    for (const provider of this.getProviders(ctx)) {
      let command;
      try { command = provider.fn(ctx); }
      catch (error) { this.log(`[command] ${provider.skillId} 匹配失败：${error?.message ?? error}`); continue; }
      if (!command || typeof command.reply !== 'function') continue;
      // 先消费命令，避免它在已等待/运行中的 LLM 批次里再次触发回复。
      this.store.markEntryRead(ctx.chatKey, ctx.entry.id);
      this.emit('chat-update', ctx.chatKey);
      if (!this.canRun(provider.skillId, ctx)) return { handled: true, completion: Promise.resolve() };
      const completion = this.#run(provider.skillId, command, ctx);
      return { handled: true, completion };
    }
    return { handled: false, completion: null };
  }

  async #run(skillId, command, ctx) {
    const name = String(command.name || skillId);
    const session = this.sessions.create({ chatKey: ctx.chatKey, trigger: [ctx.entry], triggerSummary: `指令：${name}` });
    session.command = { skillId, name };
    session.activity = `正在读取${name}…`;
    this.sessions.update(session.id);
    this.emit('session-start', { sessionId: session.id, chatKey: ctx.chatKey, status: 'running', triggerSummary: session.triggerSummary });
    let status = 'noreply';
    try {
      const text = await command.reply();
      if (typeof text !== 'string' || !text.trim()) throw new Error('命令没有返回有效文字');
      // 采集期间可能被暂停、退出或禁用插件；发送前再检查。
      if (!this.canRun(skillId, ctx)) { status = 'aborted'; return; }
      session.activity = '正在发送…';
      session.messages.push({ role: 'assistant', content: text });
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
      const result = await this.sender.sendTextBatch(ctx.chatKey, [text]);
      session.sent.push(...result.sent.filter(s => !s.deduped));
      if (result.failed.length) throw new Error(result.failed.map(f => f.error).join('；'));
      status = session.sent.length ? 'done' : 'noreply';
      session.finishReason = `确定性指令：${name}`;
    } catch (error) {
      status = 'error';
      session.error = String(error?.message ?? error);
      this.log(`[command] ${name} 失败：${session.error}`);
    } finally {
      session.activity = '';
      this.sessions.finish(session.id, status);
      this.emit('session-end', { sessionId: session.id, chatKey: ctx.chatKey, status, sent: session.sent.length, usage: session.usage, error: session.error });
    }
  }
}
