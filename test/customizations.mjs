// 便携包迁入功能的离线回归测试；所有落盘数据使用独立临时目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-customizations-'));
const suites = {
  FORWARD: 'nested-forward', STICKER: 'sticker-unify', REACTION: 'message-reactions',
  PRICING: 'channel-pricing', PROMPT: 'prompt-cache', STATUS: 'system-status',
  FORWARD_SEND: 'message-forward', AUDIO: 'audio', UPSTREAM: 'upstream-batch1'
};
const env = { ...process.env, QQ_AGENT_DATA_DIR: path.join(dataRoot, 'default') };
for (const [key, name] of Object.entries(suites)) env[`QQ_AGENT_${key}_TEST_DIR`] = path.join(dataRoot, name);
try {
  const result = spawnSync(process.execPath, ['--test', ...Object.values(suites).map(name => `test/${name}.mjs`)], {
    cwd: root, env, stdio: 'inherit'
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(dataRoot, { recursive: true });
}
