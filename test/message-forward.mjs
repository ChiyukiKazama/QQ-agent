import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import { test, beforeEach } from 'node:test';

if (!process.env.QQ_AGENT_FORWARD_SEND_TEST_DIR) throw new Error('Set QQ_AGENT_FORWARD_SEND_TEST_DIR to an isolated test directory');
process.env.QQ_AGENT_DATA_DIR = process.env.QQ_AGENT_FORWARD_SEND_TEST_DIR;
const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig, loadConfig } = await import('../src/config.js');
const { SendQueue } = await import('../src/sender.js');
const { OneBotClient } = await import('../src/onebot.js');
const { buildToolDefs } = await import('../src/tools.js');
let cfg;
beforeEach(() => {
  cfg = structuredClone(DEFAULT_CONFIG);
  cfg.send.forwardThreshold = 10;
  cfg.send.minGapMs = 200;
  cfg.send.maxGapMs = 200;
  setRuntimeConfig(cfg);
});

function context({ fail = false } = {}) {
  const calls = [], records = [], events = [];
  const onebot = new OneBotClient({});
  onebot.selfInfo = { user_id: 12345, nickname: '测试机器人' };
  onebot.call = async (action, params) => {
    calls.push({ action, params });
    if (fail) throw new Error('QQ refused');
    return { message_id: -123, forward_id: 'forward-resource' };
  };
  const store = { appendSelf: (...args) => records.push(args) };
  const sender = new SendQueue({ onebot, store, onSent: event => events.push(event) });
  const ctx = { kind: 'group', chatKey: 'group:456', sender, store,
    session: { id: 'forward-test', sent: [] }, emit() {} };
  return { sender, onebot, calls, records, events, ctx };
}
const nodeTexts = call => call.params.messages.map(node => node.data.content.find(s => s.type === 'text').data.text);

test('multiple texts over the threshold become one forward with ordered nodes and one history entry', async () => {
  const { sender, calls, records, events } = context();
  const result = await sender.sendTextBatch('group:456', ['第一条消息内容', '第二条消息内容']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'send_group_forward_msg');
  assert.equal(calls[0].params.group_id, 456);
  assert.deepEqual(nodeTexts(calls[0]), ['第一条消息内容', '第二条消息内容']);
  for (const node of calls[0].params.messages) {
    assert.equal(node.type, 'node');
    assert.equal(node.data.user_id, '12345');
    assert.equal(node.data.nickname, '测试机器人');
  }
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0].messageId, -123);
  assert.equal(result.sent[0].forwarded, true);
  assert.equal(result.sent[0].nodeCount, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(records.length, 1);
  assert.equal(records[0][1].mid, -123);
  assert.match(records[0][1].text, /第一条消息内容\n\n第二条消息内容/);
  assert.equal(events.length, 1);
});

test('private messages use the private forwarding endpoint', async () => {
  const { sender, calls } = context();
  await sender.sendTextBatch('private:789', ['很长很长的第一条内容', '第二条']);
  assert.equal(calls[0].action, 'send_private_forward_msg');
  assert.equal(calls[0].params.user_id, 789);
  assert.ok(!('group_id' in calls[0].params));
});

test('below and exactly at the threshold keep normal sending', async () => {
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['1234']);
  await sender.sendTextBatch('group:456', ['1234567890']);
  assert.deepEqual(calls.map(c => c.action), ['send_group_msg', 'send_group_msg']);
});

test('a zero threshold disables forwarding, including a long split message', async () => {
  cfg.send.forwardThreshold = 0;
  cfg.send.hardSplitAt = 6;
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['abcdefghijkl']);
  assert.deepEqual(calls.map(c => c.action), ['send_group_msg', 'send_group_msg']);
});

test('one long text can become multiple nodes without multiple sends', async () => {
  cfg.send.hardSplitAt = 6;
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['abcdefghijkl']);
  assert.equal(calls.length, 1);
  assert.deepEqual(nodeTexts(calls[0]), ['abcdef', 'ghijkl']);
});

test('character counting uses plain Unicode text before splitting', async () => {
  cfg.send.forwardThreshold = 3;
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['**😀😀😀**']);
  assert.equal(calls[0].action, 'send_group_msg');
  await sender.sendTextBatch('group:456', ['**😀😀😀😀**']);
  assert.equal(calls[1].action, 'send_group_forward_msg');
  assert.deepEqual(nodeTexts(calls[1]), ['😀😀😀😀']);
});

test('blank and invalid object text do not contribute to the threshold', async () => {
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['   ', {}, '**短消息**']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'send_group_msg');
  await assert.rejects(sender.sendTextBatch('group:456', [' ', {}]), /消息内容为空/);
});

test('CQ escaping and reply/at validation apply to the first forward node only', async () => {
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['[CQ:at,qq=all]', '第二条消息'], { replyToMessageId: -456, atUserId: 789 });
  const nodes = calls[0].params.messages;
  assert.deepEqual(nodes[0].data.content.slice(0, 2), [
    { type: 'reply', data: { id: '-456' } }, { type: 'at', data: { qq: '789' } }
  ]);
  assert.match(nodeTexts(calls[0])[0], /\[CQ：/);
  assert.equal(nodes[1].data.content.length, 1);
  await assert.rejects(sender.sendTextBatch('group:456', ['另一段很长很长很长的内容'], { atUserId: 'all' }), /atUserId/);
  assert.equal(calls.length, 1);
});

test('forwarding shares the text/reaction rate budget and consumes only one slot', async () => {
  cfg.send.maxPerMinute = 1;
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['123456', 'abcdef']);
  assert.equal(sender.minuteTimes.get('group:456').length, 1);
  assert.equal(sender.hourTimes.get('group:456').length, 1);
  await assert.rejects(sender.sendTextBatch('group:456', ['another long message']), /频率超限/);
  await assert.rejects(sender.sendTextBatch('group:456', ['短消息']), /频率超限/);
  assert.equal(calls.length, 1);
});

test('concurrent identical batches are deduped before spending another rate slot', async () => {
  cfg.send.maxPerMinute = 1;
  const { sender, calls, records } = context();
  const batch = ['123456', 'abcdef'];
  const results = await Promise.all([sender.sendTextBatch('group:456', batch), sender.sendTextBatch('group:456', batch)]);
  assert.equal(calls.length, 1);
  assert.equal(records.length, 1);
  assert.equal(results[1].sent[0].deduped, true);
  assert.equal(sender.minuteTimes.get('group:456').length, 1);
});

test('forwarding skips text already sent normally, and successful nodes dedupe normal retries', async () => {
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['123456']);
  await sender.sendTextBatch('group:456', ['123456', 'abcdef']);
  assert.deepEqual(nodeTexts(calls[1]), ['abcdef']);
  const result = await sender.sendTextBatch('group:456', ['abcdef']);
  assert.equal(result.sent[0].deduped, true);
  assert.equal(calls.length, 2);
});

test('dedupe disabled preserves repeated nodes and repeated batches', async () => {
  cfg.send.dedupeWindowMs = 0;
  const { sender, calls } = context();
  for (let i = 0; i < 2; i++) await sender.sendTextBatch('group:456', ['123456', '123456']);
  assert.equal(calls.length, 2);
  assert.deepEqual(nodeTexts(calls[0]), ['123456', '123456']);
});

test('identical chunks inside one long text are preserved even with dedupe enabled', async () => {
  cfg.send.hardSplitAt = 6;
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['abcdefabcdef']);
  assert.deepEqual(nodeTexts(calls[0]), ['abcdef', 'abcdef']);
});

test('hourly rate protection also applies to forwarded cards', async () => {
  cfg.send.maxPerHour = 1;
  const { sender, calls } = context();
  await sender.sendTextBatch('group:456', ['123456', 'abcdef']);
  await assert.rejects(sender.sendTextBatch('group:456', ['a different long response']), /每小时最多/);
  assert.equal(calls.length, 1);
});

test('failure is explicit, never falls back to many sends, and does not mark success', async () => {
  const { sender, calls, records, events } = context({ fail: true });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(sender.sendTextBatch('group:456', ['123456', 'abcdef']), /合并转发发送失败.*QQ refused.*未自动拆发/);
  }
  assert.deepEqual(calls.map(c => c.action), ['send_group_forward_msg', 'send_group_forward_msg']);
  assert.equal(records.length, 0);
  assert.equal(events.length, 0);
  assert.equal(sender.recentSent.size, 0);
});

test('missing login identity is fetched once and is never replaced by a made-up sender', async () => {
  const { onebot, calls } = context();
  onebot.selfInfo = null;
  const call = onebot.call;
  onebot.call = async (action, params) => action === 'get_login_info'
    ? { user_id: 12345, nickname: '已登录账号' } : call(action, params);
  await onebot.sendForward('group', '456', ['文本']);
  assert.equal(calls[0].params.messages[0].data.nickname, '已登录账号');
  onebot.selfInfo = null;
  onebot.call = async () => ({});
  await assert.rejects(onebot.sendForward('group', '456', ['文本']), /无法取得当前 QQ 账号/);
});

test('old and invalid configurations use the default threshold', async () => {
  for (const value of [undefined, NaN, -1, 'invalid']) {
    cfg.send.forwardThreshold = value;
    const { sender, calls } = context();
    await sender.sendTextBatch('group:456', ['a'.repeat(801)]);
    assert.equal(calls[0].action, 'send_group_forward_msg');
  }
});

test('send_message reports one actual outgoing card and keeps the full response in the session', async () => {
  const { ctx, calls } = context();
  const tool = buildToolDefs().find(t => t.id === 'send_message');
  const result = await tool.execute(ctx, { messages: ['123456', 'abcdef'] });
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content).sent, 1);
  assert.equal(ctx.session.sent.length, 1);
  assert.match(ctx.session.sent[0].text, /123456\n\nabcdef/);
  assert.equal(calls.length, 1);
});

test('settings save a custom threshold and explicit zero, preserve other settings, and reload from disk', async () => {
  const input = { value: '1234' };
  const sandbox = { state: { config: cfg, settingsSection: 'chat' },
    document: { querySelector: selector => selector === '#sc-forward-threshold' ? input : null },
    api: async (url, options) => ({ config: updateConfig(JSON.parse(options.body)) }) };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(new URL('../ui/app/08-modals.js', import.meta.url), 'utf8'), sandbox);
  for (const [raw, expected] of [['1234', 1234], ['0', 0], ['42.9', 42], ['', 800]]) {
    input.value = raw;
    await sandbox.saveConfig({ quiet: true });
    assert.equal(sandbox.state.config.send.forwardThreshold, expected);
    assert.equal(loadConfig().send.forwardThreshold, expected);
    assert.equal(loadConfig().send.hardSplitAt, cfg.send.hardSplitAt);
    assert.equal(loadConfig().persona.botName, cfg.persona.botName);
  }
});

test('real HTTP transport serializes group and private forwards as one request each', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({ url: req.url, params: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: -321 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new OneBotClient({ httpUrl: `http://127.0.0.1:${server.address().port}` });
    client.selfInfo = { user_id: 12345, nickname: '测试账号' };
    const sender = new SendQueue({ onebot: client, store: { appendSelf() {} } });
    for (const key of ['group:456', 'private:789']) {
      const result = await sender.sendTextBatch(key, ['第一条很长的内容', '第二条很长的内容']);
      assert.equal(result.sent[0].messageId, -321);
    }
    assert.deepEqual(requests.map(r => r.url), ['/send_group_forward_msg', '/send_private_forward_msg']);
    assert.equal(requests[0].params.messages.length, 2);
    assert.equal(requests[1].params.messages.length, 2);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
