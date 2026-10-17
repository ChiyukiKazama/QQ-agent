import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, beforeEach } from 'node:test';
if (!process.env.QQ_AGENT_PRICING_TEST_DIR) throw Error('Set QQ_AGENT_PRICING_TEST_DIR to an isolated directory');
process.env.QQ_AGENT_DATA_DIR = path.resolve(process.env.QQ_AGENT_PRICING_TEST_DIR);
const { DEFAULT_CONFIG, setRuntimeConfig, DATA_DIR } = await import('../src/config.js');
const { resolveModelPrice, modelLabel, pricingSignature, setRemotePrices } = await import('../src/model-prices.js');
const { findCustomPrice, hasCustomPrice, modelPriceKey } = await import('../ui/vendor/price-match.js');
const { estimateCost } = await import('../src/llm.js');
const free = 'api.omni.undertides.cn', paid = 'maas.qianwenaiapi.com';
let cfg;
beforeEach(() => {
  cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api.useOfficialPrice = true;
  cfg.api.modelPrices = { [modelLabel(free, 'deepseek-v4-flash-vision')]: { in: 0, out: 0, cached: 0 } };
  setRuntimeConfig(cfg);
  setRemotePrices({ 'qwen3.8-flash': { in: 0.8, out: 2.7, cached: 0.1 } });
});

test('explicit zero prices are free and override the official table only for that channel', () => {
  const a = resolveModelPrice(modelLabel(free, 'deepseek-v4-flash-vision'), cfg);
  const b = resolveModelPrice(modelLabel(paid, 'deepseek-v4-flash-vision'), cfg);
  assert.equal(a.source, 'custom');
  assert.equal(a.in + a.out + a.cached, 0);
  assert.equal(b.source, 'official');
  assert.ok(b.in > 0);
});

test('scoped price wins over legacy model price and clearing it restores fallback', () => {
  cfg.api.modelPrices['qwen3.8-flash'] = { in: 2, out: 3, cached: 0 };
  const key = modelLabel(paid, 'qwen3.8-flash');
  cfg.api.modelPrices[key] = { in: 1, out: 2, cached: 0 };
  assert.equal(resolveModelPrice(key, cfg).in, 1);
  delete cfg.api.modelPrices[key];
  assert.equal(resolveModelPrice(key, cfg).in, 2);
  delete cfg.api.modelPrices['qwen3.8-flash'];
  assert.equal(resolveModelPrice(key, cfg).in, 0.8);
});

test('front-end keys and price resolution agree, including free cache and zero prices', () => {
  assert.equal(modelPriceKey(paid, 'qwen3.8-flash'), modelLabel(paid, 'qwen3.8-flash'));
  assert.ok(hasCustomPrice({ in: 0, out: 0, cached: 0 }));
  assert.ok(!hasCustomPrice({}));
  assert.ok(!hasCustomPrice({ in: -1, out: 0 }));
  assert.equal(findCustomPrice(cfg.api.modelPrices, free, 'deepseek-v4-flash-vision').price.cached, 0);
});

test('live estimates use the channel identity and preserve cached-token pricing', () => {
  const usage = { promptTokens: 1_000_000, completionTokens: 50_000, cachedTokens: 800_000 };
  assert.ok(Math.abs(estimateCost(usage, { model: 'qwen3.8-flash', vendor: paid }).cost - 0.375) < 1e-10);
  assert.equal(estimateCost(usage, { model: 'deepseek-v4-flash-vision', vendor: free }).cost, 0);
});

test('pricing signatures change for rates, switches and remote prices, not API keys', () => {
  const start = pricingSignature(cfg);
  cfg.api.apiKey = 'not-a-real-key';
  assert.equal(pricingSignature(cfg), start);
  cfg.api.modelPrices[modelLabel(paid, 'qwen3.8-flash')] = { in: 3, out: 4, cached: 0 };
  assert.notEqual(pricingSignature(cfg), start);
  const custom = pricingSignature(cfg);
  setRemotePrices({ 'qwen3.8-flash': { in: 1, out: 3, cached: 0.1 } });
  assert.notEqual(pricingSignature(cfg), custom);
});

test('historical day caches reprice after editing and model totals equal aggregate totals', async () => {
  const { __testUsageDaily } = await import('../src/app.js');
  const usage = __testUsageDaily();
  const at = new Date(); at.setDate(at.getDate() - 1); at.setHours(10, 0, 0, 0);
  const day = `${at.getFullYear()}-${String(at.getMonth()+1).padStart(2,'0')}-${String(at.getDate()).padStart(2,'0')}`;
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const fixture = (id, vendor, model) => ({ id, vendor, model, chatKey: 'group:1', startedAt: at.getTime(), messages: [{ raw: { created: at.getTime()/1000, model, usage: { prompt_tokens: 1_000_000, completion_tokens: 50_000, prompt_tokens_details: { cached_tokens: 800_000 } } } }] });
  fs.writeFileSync(path.join(sessionsDir, 'free.json'), JSON.stringify(fixture('free', free, 'deepseek-v4-flash-vision')));
  fs.writeFileSync(path.join(sessionsDir, 'paid.json'), JSON.stringify(fixture('paid', paid, 'qwen3.8-flash')));
  const before = (await usage.buildUsageStatsWithSnapshots({ range: 'all' })).stats;
  assert.ok(Math.abs(before.totals.cost - 0.375) < 1e-10);
  assert.equal(before.models.reduce((n, m) => n + m.promptTokens, 0), before.totals.promptTokens);
  const file = path.join(DATA_DIR, 'usage-days', day + '.json');
  const oldSig = JSON.parse(fs.readFileSync(file)).pricingSignature;
  cfg.api.modelPrices[modelLabel(paid, 'qwen3.8-flash')] = { in: 2, out: 4, cached: 0.5 };
  const after = (await usage.buildUsageStatsWithSnapshots({ range: 'all' })).stats;
  assert.ok(Math.abs(after.totals.cost - 1) < 1e-10);
  assert.notEqual(JSON.parse(fs.readFileSync(file)).pricingSignature, oldSig);
  assert.equal(after.models.find(m => m.vendor === free).cost, 0);
  assert.equal(after.models.reduce((n,m) => n+m.promptTokens,0), after.totals.promptTokens);
  delete cfg.api.modelPrices[modelLabel(paid, 'qwen3.8-flash')];
  const cleared = (await usage.buildUsageStatsWithSnapshots({ range: 'all' })).stats;
  assert.ok(Math.abs(cleared.totals.cost - 0.375) < 1e-10);
});
