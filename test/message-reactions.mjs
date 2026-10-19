import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { DEFAULT_CONFIG, setRuntimeConfig } from '../src/config.js';
import { SendQueue } from '../src/sender.js';
import { OneBotClient } from '../src/onebot.js';
import { buildToolDefs } from '../src/tools.js';
import { buildSystemPrompt, resolveContextTier } from '../src/prompt.js';
import { getToolAvailability } from '../src/tool-registry.js';
import { resolveMessageReaction } from '../src/reactions.js';
import { skillManager } from '../src/skills/manager.js';
import * as autonomous from '../plugins/autonomous-reactions/index.js';

const definitions = buildToolDefs();
const tool = definitions.find(t => t.id === 'send_reaction');
beforeEach(() => {
  setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  autonomous.dispose();
  skillManager.unregister('autonomous-reactions');
});
function context({ fail = false, self = false } = {}) {
  const calls = [], records = [], events = [];
  const entry = { mid: -123, self };
  const ctx = {
    kind: 'group', chatKey: 'group:456', session: { id: 'test', sent: [] },
    store: { findByMid: (key, mid) => key === 'group:456' && String(mid) === '-123' ? entry : null, recent: () => [entry], appendSelf: (...args) => records.push(args) },
    emit: (...args) => events.push(args)
  };
  ctx.sender = new SendQueue({ store: ctx.store, onebot: { reactToMessage: async (...args) => { calls.push(args); if (fail) throw new Error('QQ refused'); } } });
  return { ctx, calls, records, events };
}

test('negative message IDs reach QQ and a reaction counts as a completed response', async () => {
  const { ctx, calls, records, events } = context();
  const result = await tool.execute(ctx, { messageId: '-123', emoji: '赞' });
  assert.ok(!result.isError);
  assert.deepEqual(calls, [['456', -123, '76', false]]);
  assert.equal(ctx.session.sent.length, 1);
  assert.equal(ctx.session.sent[0].type, 'reaction');
  assert.match(records[0][1].text, /#-123 👍/);
  assert.equal(records[0][1].mid, null);
  assert.deepEqual(events[0], ['session-update', 'test']);
});

test('the gateway receives the group binding and explicit remove/add flag', async () => {
  const client = new OneBotClient({});
  const calls = [];
  client.call = async (...args) => calls.push(args);
  await client.reactToMessage('456', -123, '76', true);
  assert.deepEqual(calls[0], ['set_group_reaction', { group_id: '456', message_id: -123, code: '76', is_set: false }]);
});

test('missing, invented, unsafe and foreign message IDs never reach the sender', async () => {
  const { ctx, calls } = context();
  for (const messageId of [undefined, '', 'abc', 0, 999, '9007199254740993']) {
    assert.ok((await tool.execute(ctx, { messageId, emoji: '赞' })).isError);
  }
  assert.equal(calls.length, 0);
});

test('self messages and private messages are rejected before side effects', async () => {
  const { ctx, calls } = context({ self: true });
  assert.ok((await tool.execute(ctx, { messageId: -123, emoji: '赞' })).isError);
  ctx.kind = 'private';
  assert.ok((await tool.execute(ctx, { messageId: -123, emoji: '赞' })).isError);
  assert.equal(calls.length, 0);
});

test('unknown emoji and nonboolean cancellation do not silently send another reaction', async () => {
  const { ctx, calls } = context();
  assert.ok((await tool.execute(ctx, { messageId: -123, emoji: '不存在' })).isError);
  assert.ok((await tool.execute(ctx, { messageId: -123, emoji: '赞', cancel: 'false' })).isError);
  assert.equal(calls.length, 0);
  assert.equal(resolveMessageReaction('❤').id, '66');
});

test('duplicates are skipped but add/remove/add remains possible', async () => {
  const { ctx, calls } = context();
  for (const cancel of [false, false, true, true, false]) {
    await tool.execute(ctx, { messageId: -123, emoji: '赞', cancel });
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c[3]), [false, true, false]);
  assert.equal(ctx.session.sent.length, 3);
});

test('reactions and text share the same outbound rate limit', async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.send.maxPerMinute = 1;
  setRuntimeConfig(cfg);
  const { ctx, calls } = context();
  await tool.execute(ctx, { messageId: -123, emoji: '赞' });
  await assert.rejects(ctx.sender.sendTextBatch(ctx.chatKey, ['hello']), /频率超限/);
  assert.equal(calls.length, 1);
});

test('QQ failure leaves no successful response or history record and allows retry', async () => {
  const { ctx, calls, records } = context({ fail: true });
  for (let i = 0; i < 2; i++) assert.ok((await tool.execute(ctx, { messageId: -123, emoji: '赞' })).isError);
  assert.equal(calls.length, 2);
  assert.equal(records.length, 0);
  assert.equal(ctx.session.sent.length, 0);
});

test('turning off the tool removes both model access and its prompt guidance', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.tools.overrides = { send_reaction: false };
  setRuntimeConfig(cfg);
  assert.equal(getToolAvailability('send_reaction', { toolsCfg: cfg.tools }).enabled, false);
  assert.ok(!buildSystemPrompt({ skillContext: { kind: 'group' } }).includes('【消息表情回应'));
});

test('group-only availability is also reflected in the prompt', () => {
  assert.ok(buildSystemPrompt({ skillContext: { kind: 'group' } }).includes('【消息表情回应'));
  assert.ok(!buildSystemPrompt({ skillContext: { kind: 'private' } }).includes('【消息表情回应'));
  assert.equal(getToolAvailability('send_reaction', { runtimeContext: { kind: 'private' } }).enabled, false);
});

test('reaction support does not bypass the existing response frequency tier', () => {
  const base = { triggerEntries: [{ text: '普通聊天', atMe: false }], botName: '化海月', selfId: '123', isPrivate: false, cfg: { contextTier: 1, historyCount: 80 } };
  assert.equal(resolveContextTier(base).shouldRespond, false);
  assert.equal(resolveContextTier({ ...base, cfg: { ...base.cfg, contextTier: 4 } }).shouldRespond, true);
});

test('ordinary group opportunities get a concrete reaction hint without changing the system prefix', () => {
  const ctx = { kind: 'group', sessionId: 'ordinary', triggerEntries: [
    { mid: -123, atMe: false }, { mid: 456, atMe: false }
  ], messages: [{ role: 'system', content: 'original system' }, { role: 'user', content: 'original history' }] };
  autonomous.hooks['before-context'](ctx);
  autonomous.hooks['before-llm-messages'](ctx);
  assert.equal(ctx.messages.length, 3);
  assert.deepEqual(ctx.messages[0], { role: 'system', content: 'original system' });
  assert.match(ctx.messages[2].content, /#-123、#456/);
  assert.match(ctx.messages[2].content, /send_reaction/);
  autonomous.hooks['before-llm-messages'](ctx);
  assert.equal(ctx.messages.length, 3); // 消费一次，不残留到下次模型请求。
});

test('direct summons, private chats and proactive runs retain their normal response path', () => {
  for (const patch of [ { triggerEntries: [{ mid: 1, atMe: true }] },
    { triggerEntries: [{ mid: 1, isPoke: true }] }, { kind: 'private' }, { proactive: true } ]) {
    const ctx = { kind: 'group', sessionId: 'skip', triggerEntries: [{ mid: -123, atMe: false }], messages: [], ...patch };
    autonomous.hooks['before-context'](ctx);
    autonomous.hooks['before-llm-messages'](ctx);
    assert.equal(ctx.messages.length, 0);
  }
});

test('reaction candidates exclude self, recalled and invalid IDs and stay bound to their session', () => {
  const ctx = { kind: 'group', sessionId: 'a', messages: [], triggerEntries: [
    { mid: -123 }, { mid: -123 }, { mid: 555, self: true }, { mid: 666, recalled: true },
    { mid: 0 }, { mid: 'invented' }, { mid: '9007199254740993' }
  ] };
  autonomous.hooks['before-context'](ctx);
  const other = { kind: 'group', sessionId: 'b', messages: [] };
  autonomous.hooks['before-llm-messages'](other);
  assert.equal(other.messages.length, 0);
  autonomous.hooks['before-llm-messages'](ctx);
  assert.match(ctx.messages[0].content, /#-123/);
  assert.ok(!/#555|#666|#0|invented|9007199254740993/.test(ctx.messages[0].content));
});

test('disabled reaction tools suppress both plugin guidance and pending hints', () => {
  for (const patch of [{ enabled: false }, { categories: { messaging: false } }, { overrides: { send_reaction: false } }]) {
    const cfg = structuredClone(DEFAULT_CONFIG);
    const ctx = { kind: 'group', sessionId: 'disabled', triggerEntries: [{ mid: -123 }], messages: [] };
    autonomous.hooks['before-context'](ctx);
    cfg.tools = { ...cfg.tools, ...patch }; setRuntimeConfig(cfg);
    assert.equal(autonomous.available(ctx).ok, false);
    autonomous.hooks['before-llm-messages'](ctx);
    assert.equal(ctx.messages.length, 0);
    setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
  }
});

test('plugin enable and disable control the real prompt and hook registry together', async () => {
  const manifest = { id: 'autonomous-reactions', name: '自主表情回应', version: '1.0.0', enabledByDefault: true };
  skillManager.register({ manifest, kind: 'plugin', ...autonomous });
  const ctx = { kind: 'group', sessionId: 'registry', triggerEntries: [{ mid: -123 }], messages: [] };
  assert.ok(buildSystemPrompt({ skillContext: ctx }).includes(autonomous.REACTION_GUIDANCE));
  await skillManager.runHook('before-context', ctx);
  await skillManager.runHook('before-llm-messages', ctx);
  assert.equal(ctx.messages.length, 1);
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.skills['autonomous-reactions'] = { enabled: false }; setRuntimeConfig(cfg);
  assert.ok(!buildSystemPrompt({ skillContext: ctx }).includes(autonomous.REACTION_GUIDANCE));
  ctx.messages = [];
  await skillManager.runHook('before-context', ctx);
  await skillManager.runHook('before-llm-messages', ctx);
  assert.equal(ctx.messages.length, 0);
  skillManager.unregister('autonomous-reactions');
});
