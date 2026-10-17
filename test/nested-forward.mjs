// Run with node --test test/nested-forward.mjs. Optional disk checks use QQ_AGENT_FORWARD_TEST_DIR.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

if (process.env.QQ_AGENT_FORWARD_TEST_DIR) {
  process.env.QQ_AGENT_DATA_DIR = path.resolve(process.env.QQ_AGENT_FORWARD_TEST_DIR);
}
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
const { expandForwardNodes, readForwardMessage, forwardIdFromData } = await import('../src/onebot.js');
const { buildToolDefs, executeTool } = await import('../src/tools.js');
const toolDefs = buildToolDefs();
const reader = toolDefs.find((t) => t.id === 'read_forward');
const text = (value) => ({ type: 'text', data: { text: value } });
const ref = (id) => ({ type: 'forward', data: { id } });
const node = (name, message) => ({ sender: { user_id: 123, nickname: name }, message });

test('an empty id does not hide another valid reference field', () => {
  assert.equal(forwardIdFromData({ id: '', res_id: 'actual' }), 'actual');
});

test('reads multiple referenced levels, keeps ordering, full text and images', async () => {
  const calls = [];
  const result = await expandForwardNodes([
    node('parent', [text('start'), ref('a')]), node('last', [text('last sibling')])
  ], {
    maxChars: 6000,
    resolveForward: async (id) => {
      calls.push(id);
      return id === 'a'
        ? { messages: [node('child', [text('x'.repeat(300)), ref('b')])] }
        : { data: { messages: [node('grandchild', [text('deep'), { type: 'image', data: { url: 'https://example.com/image.jpg' } }])] } };
    }
  });
  assert.deepEqual(calls, ['a', 'b']);
  assert.ok(result.text.indexOf('parent') < result.text.indexOf('child'));
  assert.ok(result.text.indexOf('grandchild') < result.text.indexOf('last sibling'));
  assert.ok(result.text.includes('x'.repeat(300)));
  assert.equal(result.media[0].url, 'https://example.com/image.jpg');
  assert.equal(result.complete, true);
  assert.equal(result.nodesRead, 4);
});

test('supports inline forward content and node segments', async () => {
  const result = await expandForwardNodes([node('outer', [
    { type: 'forward', data: { content: [node('inner', [text('inline')])] } },
    { type: 'node', data: { nickname: 'node sender', user_id: 234, content: [text('embedded node')] } }
  ])]);
  assert.match(result.text, /inner.*inline/);
  assert.match(result.text, /node sender.*embedded node/);
  assert.equal(result.complete, true);
});

test('CQ strings retain references, text and escaped image URLs', async () => {
  const result = await expandForwardNodes([node('cq', 'before[CQ:forward,id=a]after')], {
    resolveForward: async () => [node('inner', '[CQ:image,url=https://example.com/a?x=1&#44;y=2&amp;z=3]')]
  });
  assert.match(result.text, /before.*after/);
  assert.equal(result.media[0].url, 'https://example.com/a?x=1,y=2&z=3');
  assert.equal(result.complete, true);
});

test('detects ancestor cycles without another request', async () => {
  let calls = 0;
  const result = await expandForwardNodes([node('root', [ref('b')])], {
    rootId: 'a',
    resolveForward: async () => { calls++; return [node('inner', [ref('a')])]; }
  });
  assert.equal(calls, 1);
  assert.match(result.text, /循环引用/);
  assert.equal(result.complete, false);
});

test('detects cycles in inline arrays', async () => {
  const nodes = [];
  nodes.push(node('cycle', [{ type: 'forward', data: { content: nodes } }]));
  const result = await expandForwardNodes(nodes);
  assert.match(result.text, /循环引用/);
});

test('repeated references reuse downloads while both branches remain readable', async () => {
  let calls = 0;
  const result = await expandForwardNodes([node('root', [ref('a'), ref('a')])], {
    resolveForward: async () => { calls++; return [node('shared', [text('repeated leaf')])]; }
  });
  assert.equal(calls, 1);
  assert.equal(result.text.match(/repeated leaf/g).length, 2);
  assert.equal(result.complete, true);
});

test('a failed branch is explicit and does not discard healthy siblings', async () => {
  let badCalls = 0;
  const result = await expandForwardNodes([node('root', [ref('bad'), ref('good'), ref('bad')])], {
    resolveForward: async (id) => {
      if (id === 'bad') { badCalls++; throw new Error('expired'); }
      return [node('healthy', [text('still readable')])];
    }
  });
  assert.match(result.text, /expired/);
  assert.match(result.text, /still readable/);
  assert.equal(result.complete, false);
  assert.equal(badCalls, 1);
});

test('depth budget stops requests before descending', async () => {
  let called = false;
  const result = await expandForwardNodes([node('root', [ref('a')])], {
    maxDepth: 1, resolveForward: async () => { called = true; }
  });
  assert.equal(called, false);
  assert.match(result.text, /1 层上限/);
  assert.equal(result.complete, false);
});

test('node budget is shared by all levels', async () => {
  const result = await expandForwardNodes([node('root', [ref('a')]), node('outside', [text('not read')])], {
    maxNodes: 2, resolveForward: async () => [node('inner', [text('read')]), node('extra', [text('not read')])]
  });
  assert.equal(result.nodesRead, 2);
  assert.match(result.text, /节点数上限/);
  assert.ok(!result.text.includes('not read'));
});

test('character budget is shared and includes a truncation explanation', async () => {
  const result = await expandForwardNodes([node('root', [text('x'.repeat(1000))])], { maxChars: 100 });
  assert.ok(result.text.length <= 100);
  assert.match(result.text, /文本长度上限/);
  assert.equal(result.complete, false);
});

test('empty or missing nested references are marked incomplete', async () => {
  for (const segment of [ref(''), { type: 'forward', data: { content: [] } }]) {
    const result = await expandForwardNodes([node('root', [segment])]);
    assert.equal(result.complete, false);
    assert.match(result.text, /未展开/);
  }
});

test('negative root message IDs are resolved through the actual cached message', async () => {
  const calls = [];
  const result = await readForwardMessage({ call: async (action, params, timeout) => {
    calls.push([action, params]);
    assert.ok(timeout > 0 && timeout <= 15000);
    if (action === 'get_msg') return { message: [ref('actual-root')] };
    assert.deepEqual(params, { id: 'actual-root' });
    return { messages: [node('root', [text('negative ID works')])] };
  } }, -123);
  assert.deepEqual(calls[0], ['get_msg', { message_id: -123 }]);
  assert.match(result.text, /negative ID works/);
  assert.equal(result.forwardRead.complete, true);
});

test('incoming segments avoid an extra get_msg and fall back when no reference exists', async () => {
  const calls = [];
  const client = { call: async (action, params) => {
    calls.push([action, params]);
    return { messages: [node('root', [text('ok')])] };
  } };
  await readForwardMessage(client, -123, { segments: [ref('from-event')] });
  assert.deepEqual(calls, [['get_forward_msg', { id: 'from-event' }]]);
  calls.length = 0;
  await readForwardMessage(client, 123, { segments: [] });
  assert.deepEqual(calls, [['get_forward_msg', { message_id: 123 }]]);
});

test('tool upgrades old flattened archives, persists nested media and reuses complete results', async () => {
  const entry = { mid: -123, text: '[合并转发 共1条]\nold flat text', media: [] };
  let calls = 0;
  const ctx = {
    chatKey: 'group:1',
    onebot: { call: async (action, params) => {
      calls++;
      if (action === 'get_msg') return { message: [ref('root')] };
      return params.id === 'root'
        ? { messages: [node('root', [ref('inner')])] }
        : { messages: [node('inner', [text('nested text'), { type: 'image', data: { url: 'https://example.com/image.jpg' } }])] };
    } },
    store: {
      findByMid: () => entry,
      updateByMid: (chatKey, mid, patch) => {
        Object.assign(entry, { text: patch.text, forwardRead: patch.forwardRead });
        entry.media.push(...patch.appendMedia);
      }
    }
  };
  const first = await reader.execute(ctx, { messageId: -123 });
  assert.ok(!first.isError);
  assert.match(entry.text, /nested text/);
  assert.equal(entry.media.length, 1);
  assert.equal(entry.forwardRead.complete, true);
  const fetched = calls;
  await reader.execute(ctx, { messageId: -123 });
  assert.equal(calls, fetched);
  entry.forwardRead.complete = false;
  await reader.execute(ctx, { messageId: -123 });
  assert.ok(calls > fetched);
});

test('tool cannot read a message absent from the current chat', async () => {
  const result = await reader.execute({
    chatKey: 'group:1',
    store: { findByMid: () => null, recent: () => [] },
    onebot: { call: async () => { throw Error('must not request QQ'); } }
  }, { messageId: 123 });
  assert.equal(result.isError, true);
  assert.match(result.content, /当前会话找不到/);
});

test('both read tools accept the observed arguments envelope without losing messageId', async () => {
  for (const name of ['read_forward', 'get_message_images']) {
    for (const args of [{ messageId: '-123' }, { arguments: { messageId: '-123' } }, { arguments: '{"messageId":"-123"}' }]) {
      const ctx = {
        chatKey: 'group:1',
        store: { findByMid: (chatKey, mid) => {
          assert.equal(chatKey, 'group:1');
          assert.equal(mid, '-123');
          return { mid: -123, text: 'cached', media: [], forwardRead: { version: 1, complete: true, maxDepth: 5, maxNodes: 30, maxChars: 3000 } };
        } }
      };
      const result = await executeTool(toolDefs, ctx, name, JSON.stringify(args));
      assert.ok(!result.isError, result.content);
    }
  }
});

test('missing messageId is a parameter error rather than a nonexistent undefined message', async () => {
  for (const name of ['read_forward', 'get_message_images']) {
    const result = await executeTool(toolDefs, { store: { findByMid: () => assert.fail('must not read') } }, name, '{}');
    assert.equal(result.isError, true);
    assert.match(result.content, /缺少 messageId/);
    assert.ok(!result.content.includes('undefined'));
  }
});

test('forward-read metadata survives a real store reload', {
  skip: !process.env.QQ_AGENT_FORWARD_TEST_DIR
}, async () => {
  const { ChatStore } = await import('../src/store.js');
  const store = new ChatStore();
  const chatKey = `group:${process.pid}_${Date.now()}`;
  const forwardRead = { version: 1, complete: true, maxDepth: 5, maxNodes: 30, maxChars: 3000 };
  store.appendIncoming(chatKey, { mid: -1, text: 'nested', forwardRead });
  assert.deepEqual(new ChatStore().findByMid(chatKey, -1).forwardRead, forwardRead);
  store.updateByMid(chatKey, -1, { forwardRead: { ...forwardRead, complete: false } });
  assert.equal(new ChatStore().findByMid(chatKey, -1).forwardRead.complete, false);
  assert.ok(fs.existsSync(path.join(process.env.QQ_AGENT_FORWARD_TEST_DIR, 'messages', `${chatKey.replace(':', '_')}.json`)));
});
