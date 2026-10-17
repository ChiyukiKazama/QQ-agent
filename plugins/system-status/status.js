import os from 'node:os';
import path from 'node:path';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// 固定只读查询；不接受来自消息的命令、脚本、路径或额外参数。
const WINDOWS_QUERY = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$system = Get-CimInstance Win32_OperatingSystem -Property Caption,LastBootUpTime
$processors = @(Get-CimInstance Win32_Processor -Property Name,NumberOfCores,NumberOfLogicalProcessors)
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -Property DeviceID,FileSystem,Size,FreeSpace)
$frequencyMHz = $null
try {
  # 整体实际频率；ProcessorFrequency 在现代调频 CPU 上可能偏离实际速度。
  $performance = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'" -Property ActualFrequency
  if ($performance.ActualFrequency -gt 0) { $frequencyMHz = $performance.ActualFrequency }
} catch { }
[pscustomobject]@{
  system = $system.Caption
  bootTime = $system.LastBootUpTime.ToUniversalTime().ToString('o')
  cpuName = (($processors | Select-Object -ExpandProperty Name -Unique) -join ' / ')
  cores = ($processors | Measure-Object -Property NumberOfCores -Sum).Sum
  threads = ($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
  cpuFrequencyMHz = $frequencyMHz
  disks = @($volumes | Where-Object { $_.Size -gt 0 } | Sort-Object DeviceID | ForEach-Object {
    [pscustomobject]@{ name = $_.DeviceID; fileSystem = $_.FileSystem; total = $_.Size; free = $_.FreeSpace }
  })
} | ConvertTo-Json -Depth 4 -Compress
`;

async function platformDetails() {
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execFileAsync(executable, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY], {
      windowsHide: true, timeout: 6000, maxBuffer: 256 * 1024, encoding: 'utf8'
    });
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    return { ...result, disks: Array.isArray(result.disks) ? result.disks : [] };
  }
  const disk = await statfs('/');
  return { disks: [{ name: '/', total: disk.blocks * disk.bsize, free: disk.bfree * disk.bsize }] };
}

function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    sum.idle += cpu.times.idle;
    sum.total += Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return sum;
  }, { idle: 0, total: 0 });
}

export function cpuUsage(before, after) {
  const total = after.total - before.total;
  return total > 0 ? Math.max(0, Math.min(100, (1 - (after.idle - before.idle) / total) * 100)) : null;
}

let inFlight = null;
export function collectSystemStatus() {
  // 同时到来的状态请求共享同一次采样；完成后释放，下次读取仍是实时数据。
  if (!inFlight) inFlight = collect().finally(() => { inFlight = null; });
  return inFlight;
}

async function collect() {
  const before = cpuTimes();
  const metadata = platformDetails().catch(() => ({ disks: [], metadataUnavailable: true }));
  await new Promise(resolve => setTimeout(resolve, 500));
  const usage = cpuUsage(before, cpuTimes());
  const details = await metadata;
  const uptime = Math.max(0, os.uptime());
  const total = os.totalmem();
  const used = Math.max(0, total - os.freemem());
  return {
    system: details.system || os.version(), release: os.release(), arch: os.arch(),
    bootTime: details.bootTime || new Date(Date.now() - uptime * 1000).toISOString(), uptime,
    cpuName: details.cpuName || os.cpus()[0]?.model || '未知',
    cores: Number(details.cores) || null, threads: Number(details.threads) || os.cpus().length,
    cpuPercent: usage, cpuFrequencyMHz: Number(details.cpuFrequencyMHz) > 0 ? Number(details.cpuFrequencyMHz) : null,
    memory: { total, used }, disks: details.disks,
    metadataUnavailable: details.metadataUnavailable === true
  };
}

const gb = bytes => (Number(bytes) / 1024 ** 3).toFixed(2);
const percent = (used, total) => total > 0 ? `${(used / total * 100).toFixed(1)}%` : '暂不可用';
function localTime(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '暂不可用';
  const pad = v => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatSystemStatus(s) {
  const minutes = Math.floor(Math.max(0, s.uptime) / 60);
  const uptime = `${Math.floor(minutes / 1440)}天${Math.floor(minutes % 1440 / 60)}小时${minutes % 60}分`;
  const disks = s.disks.filter(d => Number(d.total) > 0).map(d => {
    const used = Math.max(0, d.total - d.free);
    return `    💿 ${d.name}${d.fileSystem ? ` [${d.fileSystem}]` : ''} ${gb(used)}/${gb(d.total)} GB (${percent(used, d.total)})`;
  });
  const topology = s.cores ? `${s.cores}C/${s.threads}T` : `${s.threads}T`;
  const frequency = Number.isFinite(s.cpuFrequencyMHz) && s.cpuFrequencyMHz > 0
    ? `${(s.cpuFrequencyMHz / 1000).toFixed(2)} GHz` : '暂不可用';
  return [
    '✨ 系统状态 ✨',
    `  🖥️ 系统: ${s.system} ${s.release} ${s.arch}`,
    `  ⏱️ 启动时间: ${localTime(s.bootTime)}`,
    `  ⌛ 已运行: ${uptime}`,
    '',
    '📈 资源监控',
    `  🧠 CPU: ${s.cpuName} (${topology})`,
    `  📊 使用: ${Number.isFinite(s.cpuPercent) ? s.cpuPercent.toFixed(1) + '%' : '暂不可用'} · 频率: ${frequency}`,
    `  🐏 内存使用: ${gb(s.memory.used)}/${gb(s.memory.total)} GB (${percent(s.memory.used, s.memory.total)})`,
    '  💾 存储空间:',
    ...(disks.length ? disks : ['    暂不可用'])
  ].join('\n');
}
