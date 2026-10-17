import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { test, beforeEach } from 'node:test';

if (!process.env.QQ_AGENT_STATUS_TEST_DIR) throw new Error('Set QQ_AGENT_STATUS_TEST_DIR to an isolated test directory');
process.env.QQ_AGENT_DATA_DIR = path.resolve(process.env.QQ_AGENT_STATUS_TEST_DIR);
const { DEFAULT_CONFIG, setRuntimeConfig, DATA_DIR } = await import('../src/config.js');
const { MessageCommandDispatcher } = await import('../src/message-commands.js');
const { SendQueue } = await import('../src/sender.js');
const { isStatusCommand, createStatusProvider } = await import('../plugins/system-status/index.js');
const { formatSystemStatus, cpuUsage } = await import('../plugins/system-status/status.js');
const { skillManager } = await import('../src/skills/manager.js');
const manifest = JSON.parse(fs.readFileSync(new URL('../plugins/system-status/plugin.json', import.meta.url)));
const sample = { system: 'Windows', release: '10.0', arch: 'x64', bootTime: '2026-10-15T00:00:00Z', uptime: 172860,
  cpuName: 'Test CPU', cores: 4, threads: 8, cpuPercent: 3, cpuFrequencyMHz: 2531, memory: { used: 4 * 1024 ** 3, total: 8 * 1024 ** 3 },
  disks: [{ name: 'C:', fileSystem: 'NTFS', total: 100 * 1024 ** 3, free: 40 * 1024 ** 3 }] };
let cfg;
beforeEach(() => {
  cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona.botName = '化海月'; cfg.persona.selfNickname = '化海月';
  setRuntimeConfig(cfg);
});
const txt = text => ({ type: 'text', data: { text } });
const at = qq => ({ type: 'at', data: { qq } });
function context(overrides = {}) {
  return { kind: 'group', chatKey: 'group:456', botName: '化海月', selfNickname: '化海月', selfId: '100',
    segments: [at('100'), txt(' 状态')], entry: { id: 1, mid: -123, text: '@化海月 状态', atMe: true, atNames: ['@化海月'] }, ...overrides };
}
function dispatcher({ collect = async () => sample, canRun = () => true, failSend = false } = {}) {
  const sends = [], history = [], reads = [], records = [], events = [];
  const store = { markEntryRead: (key, id) => reads.push([key, id]), appendSelf: (key, entry) => history.push([key, entry]) };
  const sender = new SendQueue({ store, onebot: { sendText: async (...args) => {
    if (failSend) throw new Error('QQ disconnected'); sends.push(args); return { message_id: 55 };
  } } });
  const sessions = { create: args => { const s = { ...args, id: `command-${records.length}`, messages: [], sent: [], error: null, rounds: 0, usage: { calls: 0 } }; records.push(s); return s; },
    update: () => {}, finish: (id, status) => { records.find(s => s.id === id).status = status; } };
  const d = new MessageCommandDispatcher({ getProviders: () => [{ skillId: 'system-status', fn: createStatusProvider(collect) }],
    canRun, store, sender, sessions, emit: (...args) => events.push(args) });
  return { d, sends, history, reads, records, events };
}

test('group command requires the authoritative atMe flag and exact standalone text', () => {
  assert.equal(isStatusCommand(context()), true);
  for (const text of ['系统状态', ' 状态\n']) assert.equal(isStatusCommand(context({ segments: [at('100'), txt(text)] })), true);
  for (const text of ['今天状态怎么样', '状态;执行命令', '状态 CPU', '查看状态', '这句话包含系统状态']) {
    assert.equal(isStatusCommand(context({ segments: [at('100'), txt(text)] })), false);
  }
  assert.equal(isStatusCommand(context({ entry: { id: 1, atMe: false }, segments: [at('999'), txt('状态')] })), false);
  assert.equal(isStatusCommand(context({ entry: { id: 1, atMe: false }, segments: [at('all'), txt('状态')] })), false);
});

test('private commands work without mentions; media, recalled and self entries do not trigger', () => {
  assert.equal(isStatusCommand(context({ kind: 'private', segments: [txt('状态')], entry: { text: '状态' } })), true);
  for (const flag of ['self', 'recalled', 'isPoke']) assert.equal(isStatusCommand(context({ entry: { atMe: true, [flag]: true } })), false);
  assert.equal(isStatusCommand(context({ segments: [at('100'), txt('状态'), { type: 'image' }] })), false);
});

test('string source strips only a bot mention and does not trigger on quoted command text', () => {
  assert.equal(isStatusCommand(context({ segments: null })), true);
  assert.equal(isStatusCommand(context({ segments: null, entry: { atMe: true, text: '[CQ:at,qq=100] 状态' } })), true);
  assert.equal(isStatusCommand(context({ segments: null, entry: { atMe: true, text: '@另一个人 状态' } })), false);
  assert.equal(isStatusCommand(context({ segments: null, entry: { atMe: true, text: '[引用 状态] @化海月 你好' } })), false);
});

test('format is two plain-text sections with CPU frequency and disks inside resource monitoring', () => {
  const text = formatSystemStatus(sample), parts = text.split('\n\n');
  assert.equal(parts.length, 2);
  assert.ok(parts[0].startsWith('✨ 系统状态 ✨'));
  assert.ok(!parts[0].includes('存储空间'));
  assert.match(parts[0], /2天0小时1分/);
  assert.ok(parts[1].startsWith('📈 资源监控'));
  assert.match(parts[1], /4C\/8T/);
  assert.match(parts[1], /📊 使用: 3\.0% · 频率: 2\.53 GHz/);
  assert.match(parts[1], /4\.00\/8\.00 GB \(50\.0%\)/);
  assert.match(parts[1], /C: \[NTFS\] 60\.00\/100\.00 GB \(60\.0%\)/);
  assert.ok(!text.includes('转发'));
});

test('missing metadata is explicit and CPU load uses a real interval delta', () => {
  assert.equal(cpuUsage({ idle: 80, total: 100 }, { idle: 170, total: 200 }).toFixed(1), '10.0');
  assert.equal(cpuUsage({ idle: 10, total: 10 }, { idle: 10, total: 10 }), null);
  const text = formatSystemStatus({ ...sample, cores: null, cpuPercent: null, cpuFrequencyMHz: null, disks: [] });
  assert.match(text, /\(8T\)/);
  assert.ok(!text.includes('null'));
  assert.match(text, /暂不可用/);
  assert.match(text, /频率: 暂不可用/);
});

test('command is consumed synchronously and sent through the normal queue with zero LLM calls', async () => {
  const f = dispatcher(); const job = f.d.handle(context());
  assert.equal(job.handled, true);
  assert.deepEqual(f.reads, [['group:456', 1]]);
  await job.completion;
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0].slice(0, 2), ['group', '456']);
  assert.equal(f.history.length, 1);
  assert.equal(f.records[0].usage.calls, 0);
  assert.equal(f.records[0].status, 'done');
  assert.equal(f.records[0].sent[0].messageId, 55);
  assert.equal(f.records[0].command.skillId, 'system-status');
});

test('noncommands are not consumed and stay on the normal conversation path', () => {
  const f = dispatcher(); const job = f.d.handle(context({ segments: [txt('你好')] }));
  assert.equal(job.handled, false);
  assert.equal(f.reads.length + f.records.length + f.sends.length, 0);
});

test('pause suppresses collection and consumes the command without a delayed model reply', async () => {
  let calls = 0;
  const f = dispatcher({ canRun: () => false, collect: async () => { calls++; return sample; } });
  await f.d.handle(context()).completion;
  assert.equal(calls, 0);
  assert.equal(f.reads.length, 1);
  assert.equal(f.records.length + f.sends.length, 0);
});

test('pause or disable during collection prevents a late send', async () => {
  let allowed = true, resolve;
  const f = dispatcher({ canRun: () => allowed, collect: () => new Promise(r => { resolve = r; }) });
  const job = f.d.handle(context());
  allowed = false; resolve(sample);
  await job.completion;
  assert.equal(f.sends.length, 0);
  assert.equal(f.records[0].status, 'aborted');
});

test('status uses the existing outbound rate limit and duplicate suppression', async () => {
  const f = dispatcher();
  await f.d.handle(context()).completion;
  await f.d.handle(context({ entry: { id: 2, atMe: true } })).completion;
  assert.equal(f.sends.length, 1);
  assert.equal(f.records[1].status, 'noreply');
  cfg.send.maxPerMinute = 1;
  const limited = dispatcher();
  await limited.d.handle(context()).completion;
  await limited.d.handle(context({ entry: { id: 2, atMe: true } })).completion;
  assert.equal(limited.sends.length, 1);
  assert.equal(limited.records[1].status, 'error');
  assert.match(limited.records[1].error, /频率超限/);
});

test('collection and QQ failures are recorded without a model fallback or fake successful send', async () => {
  for (const options of [{ collect: async () => { throw new Error('sample failed'); } }, { failSend: true }]) {
    const f = dispatcher(options);
    await f.d.handle(context()).completion;
    assert.equal(f.records[0].status, 'error');
    assert.equal(f.records[0].sent.length + f.history.length, 0);
    assert.equal(f.records[0].usage.calls, 0);
  }
});

test('actual OneBot ingestion keeps allowlists, blocks, plugin switch and zero-token command routing', async () => {
  const { createApp } = await import('../src/app.js');
  cfg.allow.group = ['456']; cfg.allow.private = ['789']; cfg.allowAllWhenEmpty = false;
  cfg.api.model = 'configured-but-never-called';
  skillManager.register({ manifest, kind: 'plugin', providers: { 'message.command': createStatusProvider(async () => sample) } });
  const app = createApp({ log: () => {} });
  app.onebot.selfInfo = { user_id: 100, nickname: '化海月' };
  const sends = []; let normalCalls = 0;
  app.onebot.call = async (action, params) => {
    if (action === 'get_group_member_info') return { user_id: 100, nickname: '化海月' };
    if (action === 'send_group_msg' || action === 'send_private_msg') { sends.push([action, params]); return { message_id: sends.length }; }
    throw new Error('unexpected OneBot action: ' + action);
  };
  app.orchestrator.onIncoming = () => { normalCalls++; };
  let mid = 100;
  const event = (group = 456, user = 321, message = [at('100'), txt('状态')]) => ({ post_type: 'message', message_type: 'group', group_id: group,
    user_id: user, sender: { user_id: user, nickname: 'tester' }, message_id: ++mid, time: Date.now()/1000, message });
  await app.onebot.onEvent(event(999));
  cfg.globalBlocklist = ['321']; await app.onebot.onEvent(event()); cfg.globalBlocklist = [];
  cfg.blocklist['456'] = ['321']; await app.onebot.onEvent(event()); cfg.blocklist['456'] = [];
  assert.equal(app.store.recent('group:456', { limit: 10 }).length, 0);
  assert.equal(sends.length + normalCalls, 0);
  await app.onebot.onEvent(event());
  for (let i = 0; i < 100 && app.sessions.current.size; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(sends.length, 1);
  assert.equal(normalCalls, 0);
  assert.equal(app.store.unreadCount('group:456'), 0);
  assert.match(sends[0][1].message[0].data.text, /✨ 系统状态/);
  assert.ok(sends.every(([action]) => action === 'send_group_msg'));
  const archived = fs.readdirSync(path.join(DATA_DIR, 'sessions')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions', f))));
  assert.ok(archived.some(s => s.command?.skillId === 'system-status' && s.status === 'done' && s.usage.calls === 0));
  app.orchestrator.paused = true; await app.onebot.onEvent(event());
  assert.equal(app.store.unreadCount('group:456'), 0); assert.equal(sends.length, 1);
  app.orchestrator.paused = false;
  cfg.skills['system-status'] = { enabled: false };
  await app.onebot.onEvent(event()); assert.equal(normalCalls, 1); assert.equal(sends.length, 1);
  skillManager.unregister('system-status');
});
