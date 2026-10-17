import assert from 'node:assert/strict';
import { buildStickerContext } from '../src/stickers.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    fail++;
    console.error(`  ✗ ${name}: ${error.message}`);
  }
}

const entries = [
  { id: 'id-high', desc: '高频', tags: ['开心'], useCount: 100 },
  { id: 'id-second', localNote: '次高频', useCount: 80 },
  { id: 'id-third', desc: '第三', useCount: 30 },
  { id: 'id-fourth', tags: ['冷门'], useCount: 20 },
  { id: 'id-five', desc: '第五', useCount: 10 },
  { id: 'id-six', useCount: 5 },
  { id: 'id-seven', desc: '第七', useCount: 2 },
  { id: 'id-eight', useCount: 0 }
];

check('旧 max 参数不再截断：全量列出所有收藏', () => {
  const output = buildStickerContext(entries, 4, { rotatePeriodMin: 60, now: 0 });
  const lines = output.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, entries.length);
  for (const entry of entries) assert.ok(lines.some(line => line.includes(`id=${entry.id}`)));
});

check('同一轮次输出完全一致', () => {
  const options = { rotatePeriodMin: 10, now: 25 * 60000, withId: true };
  assert.equal(buildStickerContext(entries, 4, options), buildStickerContext(entries, 4, options));
});

check('时间变化不再轮换摘要，输入顺序也不影响结果', () => {
  const first = buildStickerContext(entries, 4, { rotatePeriodMin: 10, now: 0, withId: true });
  const second = buildStickerContext([...entries].reverse(), 4, { rotatePeriodMin: 10, now: 10 * 60000, withId: true });
  assert.equal(first, second);
});

check('所有摘要保留可供工具使用的 ID，不受旧数量选项影响', () => {
  const withId = buildStickerContext(entries, 4, { rotatePeriodMin: 0, withId: true });
  assert.ok(withId.split('\n').filter((line) => line.startsWith('- ')).every((line) => line.includes('id=')));
  const withoutId = buildStickerContext(entries, 16, { rotatePeriodMin: 0 });
  assert.ok(withoutId.split('\n').filter((line) => line.startsWith('- ')).every((line) => line.includes('id=')));
});

// ── 前缀缓存稳定性：useCount 不进提示词文本 ──────────────────────────────
// 使用计数不再参与摘要排序；写进文本会让每发一次表情就改动【可用表情包】段，
// 把它后面的全部段落挤出缓存前缀。
check('useCount 任意变化都不改变输出文本（计数不进提示词）', () => {
  const a = [
    { id: 'id-a', desc: '甲', useCount: 1 },
    { id: 'id-b', desc: '乙', useCount: 3 },
    { id: 'id-c', desc: '丙', useCount: 10 },
    { id: 'id-d', desc: '丁', useCount: 30 }
  ];
  const b = [
    { id: 'id-a', desc: '甲', useCount: 2 },
    { id: 'id-b', desc: '乙', useCount: 9 },
    { id: 'id-c', desc: '丙', useCount: 29 },
    { id: 'id-d', desc: '丁', useCount: 99 }
  ];
  const opts = { rotatePeriodMin: 0, now: 0 };
  const out = buildStickerContext(a, 4, opts);
  assert.equal(out, buildStickerContext(b, 4, opts));
  // 检查条目行：不含任何使用频次标注
  const itemLines = out.split('\n').filter((line) => line.startsWith('- '));
  assert.ok(itemLines.every((l) => !/用过|次|常用|高频|偶尔/.test(l)), '条目行不应含使用频次标注');
});

check('少量收藏也全部列出', () => {
  const output = buildStickerContext(entries.slice(0, 3), 4, { rotatePeriodMin: 60 });
  assert.equal(output.split('\n').filter((line) => line.startsWith('- ')).length, 3);
});

check('空数组和无效条目不抛错并返回空串', () => {
  assert.equal(buildStickerContext([]), '');
  assert.equal(buildStickerContext([null, {}, { id: '' }]), '');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
