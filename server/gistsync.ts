// gistsync.ts —— Gist 三方对比同步核心（M8 §15.2，算法照搬 web-cron）
//   本地≠基线、Gist==基线 → 本地有新修改 → 推送
//   Gist≠基线、本地==基线 → 对端推过、本地是旧的 → 拉取（绝不推）
//   两边都≠基线         → 冲突 → 跳过并告警（等人工处理）
// 同步对象 = 配置态全量（channels 含 key 明文 + models 勾选 + testDefaults）；
// state（探测/矩阵结果）不同步，指纹只投影配置字段，跑一次测试不会被误判为修改。
import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './store.js';

export const GIST_API = 'https://api.github.com/gists';
export const GIST_FILE = 'api-check.json';
const UA = 'api-check';
// GFW 对 api.github.com 的连接黑洞会让无超时的 fetch 长时间挂起，卡住自动同步的单飞行标志
const GITHUB_TIMEOUT_MS = 15000;
// 测试可指向本地 mock GitHub API
const gistApiBase = (): string => process.env.GIST_API_BASE || GIST_API;

// ------------------------------------------------------------------ 配置指纹

// 规范化：按 id 排序后投影固定字段（排除 id/createdAt/at 等易变字段），同一数据稳定得到同一串
function canonicalChannels(channels: unknown): unknown[] {
  const list = Array.isArray(channels) ? (channels as Record<string, unknown>[]) : [];
  return [...list]
    .sort((a, b) => (String(a.id ?? '') < String(b.id ?? '') ? -1 : 1))
    .map((ch) => ({
      name: ch.name ?? null,
      baseUrl: ch.baseUrl ?? null,
      insecure: ch.insecure === true,
      enabled: ch.enabled !== false,
      keys: (Array.isArray(ch.keys) ? (ch.keys as Record<string, unknown>[]) : [])
        .sort((a, b) => (String(a.label ?? '') < String(b.label ?? '') ? -1 : 1))
        .map((k) => ({
          label: k.label ?? null,
          key: k.key ?? null, // key 明文参与指纹：改 key → 指纹变
          enabled: k.enabled !== false,
          concurrency: Number.isFinite(Number(k.concurrency)) ? Number(k.concurrency) : 1,
        })),
      models: (Array.isArray(ch.models) ? (ch.models as Record<string, unknown>[]) : [])
        .sort((a, b) => (String(a.id ?? '') < String(b.id ?? '') ? -1 : 1))
        .map((m) => ({
          id: m.id ?? null,
          selected: m.selected === true,
          source: m.source ?? null,
          contextHint: m.contextHint ?? null,
        })),
    }));
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// Gist 与本地共用同一投影函数，保证两侧指纹可比
export function configHash(cfg: { channels?: unknown; testDefaults?: unknown }): string {
  const td = (cfg.testDefaults && typeof cfg.testDefaults === 'object'
    ? cfg.testDefaults
    : {}) as Record<string, unknown>;
  const canon = {
    channels: canonicalChannels(cfg.channels),
    testDefaults: {
      intervalMs: num(td.intervalMs, 1000),
      timeoutMs: num(td.timeoutMs, 60000),
      repeat: num(td.repeat, 1),
    },
  };
  return createHash('sha256').update(JSON.stringify(canon), 'utf8').digest('hex');
}

// ------------------------------------------------------------------ GitHub API

function gistHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': UA,
    'content-type': 'application/json',
  };
}

async function gistError(r: Response): Promise<string> {
  if (r.status === 401) return 'GitHub Token 无效或缺少 gist 权限';
  if (r.status === 403) return 'GitHub API 拒绝访问（可能限流，或 Token 无 gist 权限）';
  if (r.status === 404) return 'Gist 不存在，请检查 Gist ID';
  return 'GitHub API HTTP ' + r.status;
}

async function setGist(
  store: Store,
  patch: Partial<ReturnType<Store['getConfig']>['gist']>,
): Promise<void> {
  const cfg = store.getConfig();
  cfg.gist = { ...cfg.gist!, ...patch };
  await store.saveConfig();
}

// ------------------------------------------------------------------ 推 / 拉核心

export interface SyncOutcome {
  action: 'pushed' | 'created' | 'pulled' | 'conflict' | 'same';
  gistId?: string;
  htmlUrl?: string;
  channels?: number;
  detail?: string;
}

// 上传：无 gist_id 时自动创建私密 Gist 并把 id 回写到本地配置
export async function pushCore(store: Store, reason: string): Promise<SyncOutcome> {
  const g = store.getConfig().gist!;
  if (!g.token) throw new Error('请先填写 GitHub Token（ghp_ xxx）');
  const cfg = store.getConfig();
  const hash = configHash(cfg);
  const content = JSON.stringify(
    {
      app: 'api-check',
      version: 1,
      exported_at: Date.now(),
      config: { channels: cfg.channels, testDefaults: cfg.testDefaults },
    },
    null,
    2,
  );
  const body = JSON.stringify({ files: { [GIST_FILE]: { content } } });
  let r: Response;
  try {
    r = g.gistId
      ? await fetch(`${gistApiBase()}/${g.gistId}`, {
          method: 'PATCH',
          headers: gistHeaders(g.token),
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
          body,
        })
      : await fetch(gistApiBase(), {
          method: 'POST',
          headers: gistHeaders(g.token),
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
          body: JSON.stringify({ description: 'api-check', public: false, files: { [GIST_FILE]: { content } } }),
        });
  } catch (e) {
    throw new Error('无法访问 GitHub API：' + String((e as Error)?.message ?? e));
  }
  if (!r.ok) throw new Error(await gistError(r));
  const j = (await r.json()) as { id?: string; html_url?: string };
  const gistId = String(j.id || g.gistId || '');
  await setGist(store, {
    ...(gistId !== g.gistId ? { gistId } : {}),
    baselineHash: hash,
    syncedAt: Date.now(),
    lastResult: reason,
  });
  return { action: g.gistId ? 'pushed' : 'created', gistId, htmlUrl: j.html_url ?? '' };
}

// Gist 内容 → 本地渠道形状的最小归一化（缺省值补齐，id 缺失时生成）
function normalizeChannel(raw: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: String(raw.id ?? '') || randomUUID(),
    name: String(raw.name ?? ''),
    baseUrl: String(raw.baseUrl ?? ''),
    insecure: raw.insecure === true,
    enabled: raw.enabled !== false,
    createdAt: String(raw.createdAt ?? '') || now,
    keys: (Array.isArray(raw.keys) ? (raw.keys as Record<string, unknown>[]) : []).map((k) => ({
      id: String(k.id ?? '') || randomUUID(),
      label: String(k.label ?? ''),
      key: String(k.key ?? ''),
      enabled: k.enabled !== false,
      concurrency: Number.isFinite(Number(k.concurrency)) && Number(k.concurrency) >= 1
        ? Number(k.concurrency)
        : 1,
      createdAt: String(k.createdAt ?? '') || now,
    })),
    models: (Array.isArray(raw.models) ? (raw.models as Record<string, unknown>[]) : []).map((m) => ({
      id: String(m.id ?? ''),
      selected: m.selected === true,
      source: m.source === 'manual' ? 'manual' : 'catalog',
      ...(m.contextHint !== undefined ? { contextHint: String(m.contextHint) } : {}),
    })),
  };
}

// 下载：用 Gist 配置态覆盖本地（channels + testDefaults）；state 保留不动。
// 拉取后本地与 Gist 一致，基线指纹成立，不会引发无谓的反向推送。
export async function pullCore(store: Store, reason: string): Promise<SyncOutcome> {
  const g = store.getConfig().gist!;
  if (!g.token) throw new Error('请先填写 GitHub Token（ghp_ xxx）');
  if (!g.gistId) throw new Error('还没有 Gist ID，可先执行「推送」自动创建');
  const j = await fetchGist(store);
  const raw = { channels: j.channels, testDefaults: j.testDefaults };
  const channels = Array.isArray(raw.channels) ? (raw.channels as Record<string, unknown>[]) : null;
  if (!channels || !channels.length) throw new Error(`Gist 备份中没有渠道数据`);
  const cfg = store.getConfig();
  cfg.channels = channels.map(normalizeChannel) as unknown as typeof cfg.channels;
  if (raw.testDefaults && typeof raw.testDefaults === 'object') {
    const td = raw.testDefaults as Record<string, unknown>;
    cfg.testDefaults = {
      intervalMs: num(td.intervalMs, 1000),
      timeoutMs: num(td.timeoutMs, 60000),
      repeat: num(td.repeat, 1),
    };
  }
  await store.saveConfig();
  await setGist(store, {
    baselineHash: configHash({ channels: raw.channels, testDefaults: raw.testDefaults }),
    syncedAt: Date.now(),
    lastResult: reason,
  });
  return { action: 'pulled', channels: cfg.channels.length, gistId: g.gistId };
}

async function fetchGist(store: Store): Promise<{ channels?: unknown; testDefaults?: unknown }> {
  const g = store.getConfig().gist!;
  let r: Response;
  try {
    r = await fetch(`${gistApiBase()}/${g.gistId}`, {
      headers: gistHeaders(g.token),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error('无法访问 GitHub API：' + String((e as Error)?.message ?? e));
  }
  if (!r.ok) throw new Error(await gistError(r));
  const j = (await r.json()) as { files?: Record<string, { content?: string }> };
  const content = j?.files?.[GIST_FILE]?.content;
  if (typeof content !== 'string' || !content) throw new Error(`Gist 中没有找到 ${GIST_FILE}`);
  try {
    const d = JSON.parse(content) as { config?: unknown };
    return d.config && typeof d.config === 'object'
      ? (d.config as { channels?: unknown; testDefaults?: unknown })
      : {};
  } catch {
    throw new Error('Gist 备份内容不是合法 JSON');
  }
}

// ------------------------------------------------------------------ 三方对比 / 自动同步

// 手动端点与自动同步共用；冲突不抛错（返回 conflict，结果记入 lastResult）
export async function syncCore(store: Store, reason: string): Promise<SyncOutcome> {
  const g = store.getConfig().gist!;
  if (!g.token) throw new Error('请先填写 GitHub Token（ghp_ xxx）');
  if (!g.gistId) throw new Error('还没有 Gist ID，可先执行「推送」自动创建');
  let remoteCfg: { channels?: unknown; testDefaults?: unknown } = {};
  try {
    remoteCfg = await fetchGist(store);
  } catch (e) {
    if (String((e as Error).message).includes(GIST_FILE)) {
      // Gist 上文件被删/为空：本地是最后一致状态，重新推上去
      return pushCore(store, reason);
    }
    throw e;
  }
  const remoteChannels = Array.isArray(remoteCfg.channels) ? remoteCfg.channels : [];
  const remoteHash = configHash({ channels: remoteChannels, testDefaults: remoteCfg.testDefaults });
  const localHash = configHash(store.getConfig());
  const base = g.baselineHash;

  if (!base) {
    // 本机从未与该 Gist 同步过：以 Gist 为准（新机器直接拿最新配置），Gist 空则推本地
    if (remoteHash === localHash) {
      await setGist(store, { baselineHash: remoteHash, syncedAt: Date.now(), lastResult: reason });
      return { action: 'same', detail: '已建立基线' };
    }
    if (!remoteChannels.length) return pushCore(store, reason);
    return pullCore(store, reason);
  }

  const localChanged = localHash !== base;
  const remoteChanged = remoteHash !== base;
  if (!localChanged && !remoteChanged) {
    await setGist(store, { syncedAt: Date.now(), lastResult: reason });
    return { action: 'same' };
  }
  if (localChanged && !remoteChanged) return pushCore(store, reason);
  if (remoteChanged && !localChanged) return pullCore(store, reason);
  const detail = '⚠ 冲突：本地与 Gist 都有修改，已跳过自动同步，请手动选择推送或拉取';
  await setGist(store, { syncedAt: Date.now(), lastResult: detail });
  return { action: 'conflict', detail };
}

let syncRunning = false;
let mutationTimer: NodeJS.Timeout | null = null;
let checkTimer: NodeJS.Timeout | null = null;

async function recordError(store: Store, e: unknown): Promise<void> {
  await setGist(store, {
    syncedAt: Date.now(),
    lastResult: '自动同步失败：' + String((e as Error)?.message ?? e),
  }).catch(() => undefined);
}

// 单飞行 + 免重入；未配置 token+gist_id 时静默跳过
async function autoSync(store: Store): Promise<void> {
  const g = store.getConfig().gist;
  if (!g?.token || !g.gistId) return;
  if (syncRunning) return;
  syncRunning = true;
  try {
    await syncCore(store, '自动同步');
  } catch (e) {
    await recordError(store, e);
  } finally {
    syncRunning = false;
  }
}

// 配置增删改后立即检查（短暂去抖合并连续编辑）；不阻塞 HTTP 响应
export function scheduleMutationSync(store: Store): void {
  if (mutationTimer) clearTimeout(mutationTimer);
  mutationTimer = setTimeout(() => {
    mutationTimer = null;
    void autoSync(store);
  }, 1500);
}

// 兜底轮询：每 5 分钟检查一次
export function startAutoSync(store: Store): void {
  if (checkTimer) return;
  checkTimer = setInterval(() => {
    void autoSync(store).catch((e) => console.error('[gistsync] tick error: ' + String(e)));
  }, 5 * 60000);
  checkTimer.unref?.();
}

export function stopAutoSync(): void {
  if (checkTimer) clearInterval(checkTimer);
  if (mutationTimer) clearTimeout(mutationTimer);
  checkTimer = null;
  mutationTimer = null;
}



