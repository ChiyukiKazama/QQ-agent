// 上游第一批择项移植：真实回环 HTTP 请求与 DOM 交互，不连接真实 QQ/模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';

if (!process.env.QQ_AGENT_UPSTREAM_TEST_DIR) throw new Error('Set QQ_AGENT_UPSTREAM_TEST_DIR to an isolated directory');
process.env.QQ_AGENT_DATA_DIR = path.resolve(process.env.QQ_AGENT_UPSTREAM_TEST_DIR);
const { DEFAULT_CONFIG, getConfig, setRuntimeConfig, updateConfig, loadConfig } = await import('../src/config.js');
const { chatCompletion, chatCompletionWithRetry } = await import('../src/llm.js');
const { skillManager } = await import('../src/skills/manager.js');
const { vendorOfConfig } = await import('../src/model-prices.js');
let cfg;
beforeEach(() => {
  cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api = { ...cfg.api, provider: 'main', model: 'same-model', apiKey: 'manual-main-secret',
    visionModel: 'same-model', videoModel: 'same-model', visionProvider: 'vision', videoProvider: 'video' };
  setRuntimeConfig(cfg);
});
const image = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }];
const video = [{ role: 'user', content: [...image[0].content, { type: 'video_url', video_url: { url: 'https://example.invalid/video.mp4' } }] }];
const text = [{ role: 'user', content: '测试' }];

async function endpoints(t, { failVision = false } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ url: req.url, authorization: req.headers.authorization, body });
    if (failVision && req.url.startsWith('/vision/')) { res.writeHead(503); return res.end('test unavailable'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  cfg.providers = ['main', 'vision', 'video', 'backup', 'pool'].map(id => ({ id, displayName: id.toUpperCase(), baseURL: `${base}/${id}/v1`, models: ['same-model'] }));
  cfg.dshProviderKeys = { main: 'main-key', vision: 'vision-key', video: 'video-key', backup: 'backup-key' };
  cfg.api.baseUrl = `${base}/main/v1`;
  return { calls, base };
}

test('same model ID routes text, images and video to their own endpoints and credentials', async t => {
  const { calls } = await endpoints(t);
  const original = structuredClone(cfg);
  await chatCompletion({ messages: text });
  await chatCompletion({ messages: image });
  await chatCompletion({ messages: video });
  assert.deepEqual(calls.map(c => c.url), ['/main/v1/chat/completions', '/vision/v1/chat/completions', '/video/v1/chat/completions']);
  assert.deepEqual(calls.map(c => c.authorization), ['Bearer main-key', 'Bearer vision-key', 'Bearer video-key']);
  assert.ok(calls.every(c => c.body.model === 'same-model'));
  assert.deepEqual(cfg, original, 'request routing must not rewrite saved configuration');
});

test('video without a video model falls back to the configured image model and channel', async t => {
  const { calls } = await endpoints(t);
  cfg.api.videoModel = '';
  await chatCompletion({ messages: video });
  assert.equal(calls[0].url, '/vision/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer vision-key');
});

test('legacy model-only settings retain the main endpoint and resolve no ambiguous provider by model ID', async t => {
  const { calls } = await endpoints(t);
  delete cfg.api.visionProvider;
  cfg.api.visionModel = 'legacy-vision';
  await chatCompletion({ messages: image });
  assert.equal(calls[0].url, '/main/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer main-key');
  assert.equal(calls[0].body.model, 'legacy-vision');
});

test('empty specialized models follow the main model even with obsolete provider bindings', async t => {
  const { calls } = await endpoints(t);
  cfg.api.visionModel = ''; cfg.api.videoModel = '';
  cfg.api.visionProvider = 'deleted'; cfg.api.videoProvider = 'deleted';
  await chatCompletion({ messages: video });
  assert.equal(calls[0].url, '/main/v1/chat/completions');
});

test('specialized channels with no credential never reuse the main key; legacy provider keys still work', async t => {
  const { calls } = await endpoints(t);
  delete cfg.dshProviderKeys.vision;
  await chatCompletion({ messages: image });
  assert.equal(calls[0].authorization, undefined);
  cfg.providers.find(p => p.id === 'vision').apiKey = 'legacy-vision-key';
  await chatCompletion({ messages: image });
  assert.equal(calls[1].authorization, 'Bearer legacy-vision-key');
  cfg.dshProviderKeys.vision = 'preferred-key';
  await chatCompletion({ messages: image });
  assert.equal(calls[2].authorization, 'Bearer preferred-key');
});

test('missing, duplicate and invalid channel identities fail before any network request', async t => {
  const { calls } = await endpoints(t);
  const original = structuredClone(cfg.providers);
  cfg.api.visionProvider = 'missing';
  await assert.rejects(chatCompletion({ messages: image }), /渠道不存在/);
  cfg.api.visionProvider = 'vision';
  cfg.providers.push({ ...cfg.providers.find(p => p.id === 'vision') });
  await assert.rejects(chatCompletion({ messages: image }), /身份重复/);
  cfg.providers = structuredClone(original);
  for (const badUrl of ['', 'file:///tmp/test', 'http://user:pass@127.0.0.1/v1', 'http://127.0.0.1/v1?token=test']) {
    cfg.providers.find(p => p.id === 'vision').baseURL = badUrl;
    await assert.rejects(chatCompletion({ messages: image }), /渠道地址无效/);
  }
  cfg.providers = structuredClone(original);
  cfg.providers.find(p => p.id === 'vision').baseUrl = 'http://127.0.0.1/other';
  await assert.rejects(chatCompletion({ messages: image }), /地址别名冲突/);
  assert.equal(calls.length, 0);
});

test('explicit overrides remain independent of media bindings and use their own credentials', async t => {
  const { calls, base } = await endpoints(t);
  cfg.api.visionProvider = 'deleted';
  await chatCompletion({ messages: image, overrides: { baseUrl: `${base}/override/v1`, model: 'override-model', apiKey: 'override-key' } });
  assert.equal(calls[0].url, '/override/v1/chat/completions');
  assert.equal(calls[0].authorization, 'Bearer override-key');
  assert.equal(calls[0].body.model, 'override-model');
});

test('an explicitly bound channel bypasses the main account pool while legacy settings retain it', async t => {
  const { calls, base } = await endpoints(t);
  const original = skillManager.getCapabilityProviders;
  let picks = 0;
  skillManager.getCapabilityProviders = function(name, ctx) {
    if (name === 'llm.endpoint-pick') return [{ fn: () => { picks++; return { id: 'pool-1', baseUrl: `${base}/pool/v1`, apiKey: 'pool-key' }; } }];
    return original.call(this, name, ctx);
  };
  try {
    await chatCompletion({ messages: image });
    assert.equal(picks, 0);
    cfg.api.visionProvider = '';
    await chatCompletion({ messages: image });
    assert.equal(picks, 1);
    assert.equal(calls[1].url, '/pool/v1/chat/completions');
    assert.equal(calls[1].authorization, 'Bearer pool-key');
  } finally { skillManager.getCapabilityProviders = original; }
});

test('retry wrapper returns the actual media channel for pricing without exposing its key', async t => {
  await endpoints(t);
  const result = await chatCompletionWithRetry({ messages: image }, 0);
  assert.equal(result._usedApi.provider, 'vision');
  assert.equal(vendorOfConfig({ api: result._usedApi, providers: cfg.providers }), 'VISION');
  assert.equal('apiKey' in result._usedApi, false);
});

test('a configured fallback after media failure keeps its explicit endpoint and identity', async t => {
  const { calls } = await endpoints(t, { failVision: true });
  cfg.api.fallbackModels = [{ provider: 'backup', model: 'backup-model' }];
  const result = await chatCompletionWithRetry({ messages: image }, 0);
  assert.deepEqual(calls.map(c => c.url), ['/vision/v1/chat/completions', '/backup/v1/chat/completions']);
  assert.equal(calls[1].authorization, 'Bearer backup-key');
  assert.equal(result._usedApi.provider, 'backup');
  assert.equal(result._usedModel, 'backup-model');
});

function ui() {
  const dom = new JSDOM('<div id="provider-hint"></div>', { url: 'http://127.0.0.1', runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  cfg.providers = [
    { id: 'main', displayName: '主渠道', baseURL: 'http://127.0.0.1/main/v1', models: ['same-model', 'main'], modelNames: { 'same-model': '主渠道同名模型' } },
    { id: 'vision', displayName: '视觉渠道', baseURL: 'http://127.0.0.1/vision/v1', models: ['same-model'], modelNames: { 'same-model': '视觉渠道同名模型' } },
    { id: 'video', displayName: '视频渠道', baseURL: 'http://127.0.0.1/video/v1', models: ['same-model'], modelNames: { 'same-model': '视频渠道同名模型' } }
  ];
  const safeConfig = () => { const c = structuredClone(getConfig()); delete c.api.apiKey; delete c.dshProviderKeys; return c; };
  w.state = { config: safeConfig(), providers: structuredClone(cfg.providers) };
  w.$ = selector => w.document.querySelector(selector);
  w.$$ = selector => [...w.document.querySelectorAll(selector)];
  w.esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  w.visionBadge = () => '';
  w.alert = message => { throw new Error(message); };
  w.loadSettings = async () => { w.state.config = safeConfig(); };
  w.api = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (url === '/api/config' && body) updateConfig(body);
    return { config: safeConfig() };
  };
  w.eval(fs.readFileSync(new URL('../ui/app/08-modals.js', import.meta.url), 'utf8') + '\nwindow.batch1 = { openModelConfigModal, openModelPicker, openModelAddModal };');
  const active = () => [...w.document.querySelectorAll('.model-modal-overlay:not(.closing)')].at(-1);
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  return { w, calls, active, settle, close: () => w.close() };
}

test('specialized selectors keep channel/model together, show the correct alias, and persist after reload', async () => {
  const page = ui();
  try {
    page.w.batch1.openModelConfigModal();
    const outer = page.active();
    assert.equal(outer.querySelector('#mc-vision-model-pick').value, '视觉渠道 / 视觉渠道同名模型');
    outer.querySelector('#mc-vision-model-pick').click();
    const picker = page.active();
    assert.ok(picker.querySelector('#msp-left [data-pid="vision"]').classList.contains('active'));
    picker.querySelector('#msp-left [data-pid="video"]').click();
    picker.querySelector('#msp-right [data-model="same-model"]').click();
    assert.equal(outer.querySelector('#mc-vision-model-pick').value, '视频渠道 / 视频渠道同名模型');
    outer.querySelector('#mc-save').click(); await page.settle();
    const patch = page.calls.at(-1).body.api;
    assert.equal(patch.visionProvider, 'video'); assert.equal(patch.visionModel, 'same-model');
    assert.equal('apiKey' in patch, false);
    loadConfig();
    assert.equal(getConfig().api.visionProvider, 'video');
    assert.equal(getConfig().api.apiKey, 'manual-main-secret');
  } finally { page.close(); }
});

test('clearing or following the main model clears both specialized fields', async () => {
  const page = ui();
  try {
    page.w.batch1.openModelConfigModal(); const outer = page.active();
    outer.querySelector('#mc-vision-model-clear').click();
    outer.querySelector('#mc-video-model-pick').click();
    page.active().querySelector('#msp-follow').click();
    outer.querySelector('#mc-save').click(); await page.settle();
    assert.equal(getConfig().api.visionModel, ''); assert.equal(getConfig().api.visionProvider, '');
    assert.equal(getConfig().api.videoModel, ''); assert.equal(getConfig().api.videoProvider, '');
  } finally { page.close(); }
});

test('opening/saving unchanged legacy settings does not infer a provider from duplicate model names', async () => {
  delete cfg.api.visionProvider;
  const page = ui();
  try {
    page.w.batch1.openModelConfigModal(); page.active().querySelector('#mc-save').click(); await page.settle();
    assert.equal('visionProvider' in page.calls.at(-1).body.api, false);
    assert.equal(getConfig().api.visionProvider, undefined);
  } finally { page.close(); }
});

test('canceling a specialized selection leaves both the saved model and channel untouched', async () => {
  const page = ui();
  try {
    page.w.batch1.openModelConfigModal(); const outer = page.active();
    outer.querySelector('#mc-vision-model-pick').click();
    page.active().querySelector('#msp-cancel').click();
    outer.querySelector('#mc-save').click(); await page.settle();
    assert.equal(getConfig().api.visionProvider, 'vision');
    assert.equal('visionProvider' in page.calls.at(-1).body.api, false);
  } finally { page.close(); }
});

test('switching main models preserves explicit specialized settings even when a model ID equals the old provider ID', async () => {
  cfg.api.visionModel = 'main';
  const page = ui();
  try {
    page.w.batch1.openModelPicker(); const picker = page.active();
    picker.querySelector('#mm-left [data-pid="video"]').click();
    picker.querySelector('#mm-right [data-model="same-model"]').click(); await page.settle();
    assert.equal(getConfig().api.provider, 'video');
    assert.equal(getConfig().api.visionProvider, 'vision');
    assert.equal(getConfig().api.visionModel, 'main');
    assert.equal('visionModel' in page.calls.at(-1).body.api, false);
  } finally { page.close(); }
});

test('model import preserves choices across vendors, search, empty results and deselection', async () => {
  const page = ui();
  try {
    page.w.state.providers[0].models = ['a/known'];
    page.w.batch1.openModelAddModal('http://127.0.0.1/main/v1', '', ['a/one', 'a/two', 'a/known', 'b/three', 'b/four', 'a/one'], 'main');
    const picker = page.active();
    const select = (value, checked) => { const el = [...picker.querySelectorAll('.ma-check')].find(el => el.value === value); el.checked = checked; el.dispatchEvent(new page.w.Event('change', { bubbles: true })); };
    const search = value => { const el = picker.querySelector('#ma-search'); el.value = value; el.dispatchEvent(new page.w.Event('input', { bubbles: true })); };
    select('a/one', true); select('a/two', true);
    assert.equal(picker.querySelector('input[value="a/known"]').disabled, true);
    picker.querySelector('#ma-left [data-vendor="b"]').click();
    select('b/three', true);
    search('no results'); assert.equal(picker.querySelectorAll('.ma-check').length, 0);
    search('a/one'); assert.equal(picker.querySelector('.ma-check').checked, true);
    select('a/one', false);
    search('b/three'); assert.equal(picker.querySelector('.ma-check').checked, true);
    picker.querySelector('#ma-apply').click(); await page.settle();
    const request = page.calls.find(c => c.url === '/api/providers/models');
    assert.deepEqual(request.body.models, [{ id: 'a/two', name: 'a/two' }, { id: 'b/three', name: 'b/three' }]);
    assert.equal(request.body.providerId, 'main');
  } finally { page.close(); }
});

test('model import cancel and an empty selection never submit a provider update', async () => {
  const page = ui();
  try {
    page.w.batch1.openModelAddModal('http://127.0.0.1/main/v1', '', ['simple'], 'main');
    page.active().querySelector('#ma-cancel').click();
    page.w.batch1.openModelAddModal('http://127.0.0.1/main/v1', '', ['simple'], 'main');
    page.active().querySelector('#ma-apply').click(); await page.settle();
    assert.equal(page.calls.length, 0);
  } finally { page.close(); }
});

test('release file selection excludes the entire third-party runtime and retains the app itself', async () => {
  const { minimatch } = await import('minimatch');
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const excluded = file => pkg.build.files.filter(p => p.startsWith('!')).some(p => minimatch(file, p.slice(1), { dot: true }));
  for (const file of ['snowluma/index.mjs', 'snowluma/node.exe', 'snowluma/native/module.node', 'snowluma/config/user.json', 'snowluma/data/login.db', 'snowluma/.private']) assert.equal(excluded(file), true, file);
  for (const file of ['src/llm.js', 'src/audio.js', 'ui/index.html', 'ui/app/08-modals.js']) assert.equal(excluded(file), false, file);
});
