import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

if (!process.env.QQ_AGENT_STICKER_TEST_DIR) throw new Error('Set QQ_AGENT_STICKER_TEST_DIR to an isolated test directory');
process.env.QQ_AGENT_DATA_DIR = path.resolve(process.env.QQ_AGENT_STICKER_TEST_DIR);
const { DEFAULT_CONFIG, setRuntimeConfig, DATA_DIR } = await import('../src/config.js');
const { mergeStickerLibrary, findSticker, formatStickerList, buildStickerContext, applyStickerNote, markStickerUsed, saveStickerStore } = await import('../src/stickers.js');
const { StickerManager } = await import('../src/sticker-manager.js');
const { buildToolDefs } = await import('../src/tools.js');
setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
const tools = buildToolDefs();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nCEAAAAASUVORK5CYII=', 'base64');
const md5 = '1234567890ABCDEF1234567890ABCDEF';
const qqid = `3287132516_0_0_0_${md5}_0_0`;
const face = (id = qqid) => ({ emoji_id: id, url: 'https://p.qpic.cn/a.png', md5: id === qqid ? md5 : '', desc: '' });
const list = (entries) => formatStickerList(entries).stickers;
function manager(call, entries = []) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.sticker.collectEnabled = true;
  cfg.sticker.promptMaxStickers = 1;
  setRuntimeConfig(cfg);
  saveStickerStore(entries);
  return new StickerManager({ call });
}

test('QQ id unifies collected aliases and preserves notes, local file and use counts', () => {
  const local = 'file:///controlled/a.png';
  const merged = mergeStickerLibrary([
    { id: 'collected_1', emojiId: qqid, localFile: local, url: local, localNote: '可爱', useCount: 2, source: 'ai' },
    { id: qqid, md5, url: 'https://old', tags: ['抱抱'], useCount: 3 }
  ], [face()]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, qqid);
  assert.equal(merged[0].localNote, '可爱');
  assert.equal(merged[0].useCount, 5);
  assert.equal(merged[0].url, local);
  assert.equal(findSticker(merged, 'collected_1').id, qqid);
  assert.deepEqual(mergeStickerLibrary(merged, [face()]).map(e => [e.id, e.useCount, e.localNote]), [[qqid, 5, '可爱']]);
});

test('MD5 matches migrated ids and preserves QQ ordering without duplicating faces', () => {
  const merged = mergeStickerLibrary([{ id: 'old', md5, localNote: '笔记' }], [face('second'), face(), face()]);
  assert.deepEqual(list(merged).map(e => e.id), ['second', qqid]);
  assert.equal(findSticker(merged, 'old').localNote, '笔记');
});

test('deleted QQ entries and failed local collections are archived, never selected', () => {
  const merged = mergeStickerLibrary([{ id: qqid, md5, localNote: '留存' }, { id: 'collected_failed', source: 'ai', url: 'https://old' }], []);
  assert.equal(merged.length, 2);
  assert.equal(list(merged).length, 0);
  assert.equal(findSticker(merged, qqid), null);
  assert.equal(buildStickerContext(merged), '');
  const restored = mergeStickerLibrary(merged, [face()]);
  assert.equal(findSticker(restored, qqid).localNote, '留存');
  assert.equal(list(restored).length, 1);
});

test('old ids still update the canonical note and use counter', () => {
  const entries = mergeStickerLibrary([{ id: 'collected_1', emojiId: qqid }], [face()]);
  const noted = applyStickerNote(entries, 'collected_1', { note: '新笔记' });
  assert.equal(noted.entry.id, qqid);
  assert.equal(markStickerUsed(noted.entries, 'collected_1').entry.useCount, 1);
});

test('sync scope is independent from the number of prompt thumbnails', async () => {
  const m = manager(async (action, params) => {
    assert.equal(action, 'fetch_custom_face_detail');
    assert.ok(params.count > 500);
    return Array.from({ length: 150 }, (_, i) => face(`qq_${i}`));
  });
  assert.equal((await m.list('', 500)).total, 150);
  assert.equal((await m.sync(false)).entries.length, 150);
});

test('failed or malformed sync preserves confirmed membership and hides archives', async () => {
  let mode = 'ok';
  const m = manager(async () => {
    if (mode === 'throw') throw new Error('offline');
    if (mode === 'bad') return [{}];
    return [face()];
  }, [{ id: 'local_only', source: 'ai' }]);
  await m.sync(true);
  for (mode of ['throw', 'bad']) {
    const result = await m.sync(true);
    assert.ok(result.error);
    assert.deepEqual(result.entries.map(e => e.id), [qqid]);
  }
});

test('a successful empty QQ snapshot removes all active choices', async () => {
  const m = manager(async () => [], [{ id: qqid, localNote: '保留' }]);
  assert.equal((await m.sync(true)).entries.length, 0);
  assert.equal(m.entries[0].localNote, '保留');
});

test('failed QQ collection cannot silently create a second sendable library', async () => {
  const m = manager(async action => {
    if (action === 'fetch_custom_face_detail') return [];
    throw new Error('QQ refused');
  });
  const saved = await m.collect(1, { url: 'not-a-network-url', note: '失败' });
  assert.equal(saved.inQQ, false);
  assert.ok(saved.qqCollectError);
  assert.equal((await m.list()).total, 0);
});

test('native collection is unified on next sync and repeated collection keeps one choice', async () => {
  let saved = false;
  const m = manager(async action => {
    if (action === 'fetch_custom_face_detail') return saved ? [face()] : [];
    if (action === 'add_custom_face') { saved = true; return { emoji_id: qqid }; }
    if (action === 'modify_custom_face') return {};
    throw new Error('unexpected ' + action);
  });
  await m.collect(1, { url: 'not-a-network-url', note: '笔记' });
  assert.equal((await m.list()).total, 1);
  assert.equal((await m.find('collected_1')).id, qqid);
  await m.collect(1, { url: 'not-a-network-url', note: '更新' });
  assert.equal((await m.list()).total, 1);
  assert.equal((await m.find(qqid)).localNote, '更新');
});

test('view sticker reads controlled local PNG bytes and rejects files outside the cache', async () => {
  const root = path.join(DATA_DIR, 'sticker-images');
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, 'test.png');
  fs.writeFileSync(target, png);
  const reader = tools.find(t => t.id === 'get_sticker_image');
  const result = await reader.execute({ stickers: { find: async () => ({ id: qqid, url: `file:///${target.replace(/\\/g, '/')}` }) } }, { stickerId: qqid });
  assert.ok(!result.isError);
  assert.ok(result.content.some(c => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,')));
  const denied = await reader.execute({ stickers: { find: async () => ({ id: qqid, url: 'file:///C:/not-allowed/secret.png' }) } }, { stickerId: qqid });
  assert.ok(denied.isError);
});
