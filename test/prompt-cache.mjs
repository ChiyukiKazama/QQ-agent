import assert from 'node:assert/strict';
import path from 'node:path';
import { test, beforeEach } from 'node:test';

if (!process.env.QQ_AGENT_PROMPT_TEST_DIR) throw new Error('Set QQ_AGENT_PROMPT_TEST_DIR to an isolated test directory');
process.env.QQ_AGENT_DATA_DIR = path.resolve(process.env.QQ_AGENT_PROMPT_TEST_DIR);
const { DEFAULT_CONFIG, setRuntimeConfig, stripObsoleteFields } = await import('../src/config.js');
const { buildUserPrompt } = await import('../src/prompt.js');
const { buildStickerContext } = await import('../src/stickers.js');

let cfg;
beforeEach(() => {
  cfg = structuredClone(DEFAULT_CONFIG);
  cfg.persona.roleText = '测试群友';
  cfg.store.historyCount = 2;
  cfg.store.promptAnchor = { enabled: true, maxExtraRead: 5 };
  cfg.globalBlocklist = [];
  cfg.blocklist = {};
  setRuntimeConfig(cfg);
});

const entry = (id, senderId, text = `消息${id}`) => ({ id, mid: -id, senderId, senderName: senderId, text, ts: 1792200000000 + id * 1000, media: [] });
const beforeUnread = prompt => prompt.slice(0, prompt.indexOf('\n\n【未读信息】'));
const beforeExtraRead = prompt => prompt.slice(0, prompt.indexOf('\n\n【新已读信息】'));
const memoryText = prompt => prompt.match(/【记忆】\n([\s\S]*?)(?=\n\n【(?:已读信息|新已读信息|未读信息)】)/)?.[1] || '';
function fixture() {
  const state = {
    history: [entry(1, 'old'), entry(2, 'old'), entry(3, 'one'), entry(4, 'two')],
    notes: new Map([['old', '窗口以外的旧群友'], ['one', '喜欢画画'], ['two', '喜欢音乐']])
  };
  state.store = { recent: (_chat, { limit }) => state.history.slice(-limit) };
  state.memory = { formatForPrompt: (_chat, { userIds }) => {
    const lines = [...state.notes].filter(([id, text]) => userIds.includes(id) && text).map(([id, text]) => `- ${id}：${text}`);
    return lines.length ? `【对群友的印象】\n${lines.join('\n')}` : '';
  } };
  state.run = (prev = null, trigger = entry(5, 'two'), stickerEntries = []) => {
    const session = {};
    const prompt = buildUserPrompt({ chatKey: 'group:test', kind: 'group', chatId: 'test', triggerEntries: [trigger],
      store: state.store, memory: state.memory, stickerEntries, contextLimit: 2, promptAnchor: { prev }, session });
    return { prompt, session, anchor: session.promptAnchorState };
  };
  return state;
}

test('reset to anchored reuses the exact memory prefix, without injecting the larger pool', () => {
  const f = fixture();
  const first = f.run();
  assert.equal(first.session.promptAnchorMode, 'reset');
  assert.ok(first.anchor.memberIds.includes('old'));
  assert.ok(!first.anchor.memoryUserIds.includes('old'));
  const snapshot = structuredClone(first.anchor);
  f.history.push(entry(5, 'two'));
  const next = f.run(first.anchor, entry(6, 'one'));
  assert.equal(next.session.promptAnchorMode, 'anchored');
  assert.equal(next.anchor.memoryText, first.anchor.memoryText);
  assert.equal(memoryText(next.prompt), memoryText(first.prompt));
  assert.ok(!memoryText(next.prompt).includes('窗口以外'));
  assert.equal(beforeExtraRead(next.prompt), beforeUnread(first.prompt));
  assert.deepEqual(first.anchor, snapshot, 'the previous anchor must not be mutated');
  assert.equal(next.session.pastStateCount, 3);
});

test('an empty memory snapshot remains empty and does not expand to old pool members', () => {
  const f = fixture();
  f.notes.delete('one'); f.notes.delete('two');
  const first = f.run();
  assert.equal(first.anchor.memoryText, '');
  f.history.push(entry(5, 'two'));
  const next = f.run(first.anchor, entry(6, 'one'));
  assert.equal(next.session.promptAnchorMode, 'anchored');
  assert.equal(next.anchor.memoryText, '');
  assert.equal(beforeExtraRead(next.prompt), beforeUnread(first.prompt));
});

test('old anchors without an actual memory snapshot are rebuilt once', () => {
  const f = fixture();
  const first = f.run();
  delete first.anchor.memoryText; delete first.anchor.memoryUserIds;
  const next = f.run(first.anchor);
  assert.equal(next.session.promptAnchorMode, 'reset');
  assert.equal(next.anchor.memoryText, memoryText(next.prompt));
});

test('genuinely updated memory rebuilds the anchor and takes effect immediately', () => {
  const f = fixture();
  const first = f.run();
  f.notes.set('one', '现在喜欢摄影');
  const next = f.run(first.anchor);
  assert.equal(next.session.promptAnchorMode, 'reset');
  assert.match(memoryText(next.prompt), /现在喜欢摄影/);
  assert.ok(!next.prompt.includes('喜欢画画'));
  assert.equal(first.anchor.memoryText.includes('喜欢画画'), true);
});

test('deleted memory is removed from the next input, including empty snapshots', () => {
  const f = fixture();
  const first = f.run();
  f.notes.delete('one'); f.notes.delete('two');
  const next = f.run(first.anchor);
  assert.equal(next.session.promptAnchorMode, 'reset');
  assert.equal(next.anchor.memoryText, '');
  assert.ok(!next.prompt.includes('喜欢画画'));
  assert.ok(!next.prompt.includes('喜欢音乐'));
});

test('unrelated memory changes leave the anchor intact', () => {
  const f = fixture();
  const first = f.run();
  f.notes.set('old', '旧群友的新印象');
  f.history.push(entry(5, 'two'));
  const next = f.run(first.anchor, entry(6, 'one'));
  assert.equal(next.session.promptAnchorMode, 'anchored');
  assert.equal(beforeExtraRead(next.prompt), beforeUnread(first.prompt));
  assert.ok(!next.prompt.includes('旧群友的新印象'));
});

test('a known pool member outside the snapshot gets their memory after the stable prefix', () => {
  const f = fixture();
  const first = f.run();
  f.history.push(entry(5, 'two'));
  const next = f.run(first.anchor, entry(6, 'old'));
  assert.equal(next.session.promptAnchorMode, 'anchored');
  assert.equal(beforeExtraRead(next.prompt), beforeUnread(first.prompt));
  assert.ok(!memoryText(next.prompt).includes('窗口以外'));
  assert.ok(next.prompt.indexOf('窗口以外的旧群友') > next.prompt.indexOf('【未读信息】'));
});

test('disabled anchoring always uses current memory and does not retain a snapshot', () => {
  const f = fixture();
  const first = f.run();
  cfg.store.promptAnchor.enabled = false;
  f.notes.set('two', '最新印象');
  const next = f.run(first.anchor);
  assert.equal(next.session.promptAnchorMode, 'none');
  assert.equal(next.anchor, null);
  assert.match(memoryText(next.prompt), /最新印象/);
});

test('history recall and append limits still invalidate a snapshot', () => {
  const f = fixture();
  const first = f.run();
  f.history.find(m => m.id === 3).recalled = true;
  assert.equal(f.run(first.anchor).session.promptAnchorMode, 'reset');
  const g = fixture();
  const initial = g.run();
  for (let id = 5; id <= 10; id++) g.history.push(entry(id, 'two'));
  assert.equal(g.run(initial.anchor, entry(11, 'two')).session.promptAnchorMode, 'reset');
});

test('all sticker summaries include IDs and stay stable across hours, use counts and input ordering', () => {
  const entries = Array.from({ length: 75 }, (_, i) => ({ id: `qq_${String(i).padStart(3, '0')}`, localNote: `表情${i}`, useCount: i }));
  const original = structuredClone(entries);
  const first = buildStickerContext(entries);
  assert.equal(first.split('\n').length - 1, 75);
  for (const e of entries) assert.ok(first.includes(`id=${e.id}`));
  const now = Date.now;
  try {
    Date.now = () => now() + 3600000;
    const changed = entries.toReversed().map((e, i) => ({ ...e, useCount: 10000 - i }));
    assert.equal(buildStickerContext(changed), first);
  } finally { Date.now = now; }
  assert.deepEqual(entries, original);
});

test('the full prompt ignores the legacy sticker limit and excludes removed QQ favorites', () => {
  cfg.sticker.promptMaxStickers = 1;
  const f = fixture();
  const entries = Array.from({ length: 24 }, (_, i) => ({ id: `qq_${i}`, desc: `表情${i}` }));
  const first = f.run(null, entry(5, 'two'), [...entries, { id: 'archived', desc: '已删除的收藏', inQQ: false }]);
  assert.match(first.prompt, /全部 24 个 QQ 收藏表情摘要/);
  for (const e of entries) assert.ok(first.prompt.includes(`id=${e.id}`));
  assert.ok(!first.prompt.includes('已删除的收藏'));
  const second = f.run(first.anchor, entry(6, 'two'), entries.slice(1));
  assert.match(second.prompt, /全部 23 个 QQ 收藏表情摘要/);
  assert.ok(!second.prompt.includes(' id=qq_0\n'));
});

test('config migration removes the obsolete sticker limit without changing other settings', () => {
  const input = { sticker: { enabled: true, encourage: 2, promptMaxStickers: 10 }, store: { historyCount: 80 } };
  assert.deepEqual(stripObsoleteFields(input), { sticker: { enabled: true, encourage: 2 }, store: { historyCount: 80 } });
});
