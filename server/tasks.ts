// 后台任务管理（SPEC §3）：单渠道同一时刻只允许一个任务（探测/目录/矩阵互斥），
// 占用中再发起返回 409。任务异步执行，前端轮询 GET /channels/:id/task。
import type { Store } from './store.js';
import { probeAll } from './probe.js';
import { fetchCatalog, mergeCatalog } from './catalog.js';
import { logger } from './logger.js';

export type TaskType = 'probe' | 'catalog' | 'test';

export interface TaskState {
  type: TaskType;
  running: boolean;
  stopped: boolean;
  currentIndex: number;
  total: number;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

const tasks = new Map<string, TaskState>(); // channelId -> task (memory only)

export function getTask(channelId: string): TaskState | undefined {
  return tasks.get(channelId);
}

/** 尝试占用渠道任务位；若已有运行中的任务返回 null（调用方应返回 409） */
export function acquireTask(channelId: string, type: TaskType, total: number): TaskState | null {
  const existing = tasks.get(channelId);
  if (existing?.running) return null;
  const task: TaskState = {
    type,
    running: true,
    stopped: false,
    currentIndex: 0,
    total,
    startedAt: new Date().toISOString(),
  };
  tasks.set(channelId, task);
  return task;
}

export function setStopped(channelId: string): void {
  const task = tasks.get(channelId);
  if (task) task.stopped = true;
}

function finish(channelId: string, error?: string): void {
  const task = tasks.get(channelId);
  if (task) {
    task.running = false;
    if (error) task.error = error;
    task.finishedAt = new Date().toISOString();
  }
}

/** 启动探测任务（取第一个启用的 key；无 key 报错） */
export async function runProbe(store: Store, channelId: string): Promise<void> {
  const task = tasks.get(channelId);
  if (!task) return;
  try {
    const ch = store.getConfig().channels.find((c) => c.id === channelId);
    if (!ch) { finish(channelId, 'channel not found'); return; }
    const key = ch.keys.find((k) => k.enabled) ?? ch.keys[0];
    if (!key) { finish(channelId, 'no key configured'); return; }
    const results = await probeAll({
      baseUrl: ch.baseUrl,
      apiKey: key.key,
      insecure: ch.insecure,
      timeoutMs: store.getConfig().testDefaults.timeoutMs,
    });
    const state = store.getState();
    if (!state.channels[channelId]) state.channels[channelId] = {};
    state.channels[channelId].probe = results;
    await store.saveState();
    logger.info(`probe done channel=${channelId}`, {
      cls: Object.fromEntries(Object.entries(results).map(([p, r]) => [p, r.cls])),
    });
    finish(channelId);
  } catch (e) {
    logger.error('probe failed', { error: (e as Error).message });
    finish(channelId, (e as Error).message);
  }
}

/** 启动目录拉取任务（取第一个启用的 key） */
export async function runCatalog(store: Store, channelId: string): Promise<void> {
  const task = tasks.get(channelId);
  if (!task) return;
  try {
    const ch = store.getConfig().channels.find((c) => c.id === channelId);
    if (!ch) { finish(channelId, 'channel not found'); return; }
    const key = ch.keys.find((k) => k.enabled) ?? ch.keys[0];
    if (!key) { finish(channelId, 'no key configured'); return; }
    const probe = store.getState().channels[channelId]?.probe;
    const result = await fetchCatalog({
      baseUrl: ch.baseUrl,
      apiKey: key.key,
      insecure: ch.insecure,
      timeoutMs: store.getConfig().testDefaults.timeoutMs,
      probe,
    });
    if (!result.ok) {
      // 失败/空目录：明确报错，保留现有目录
      finish(channelId, `catalog_failed: ${result.error ?? 'unknown'}`);
      return;
    }
    const cfg = store.getConfig();
    const idx = cfg.channels.findIndex((c) => c.id === channelId);
    if (idx < 0) { finish(channelId, 'channel not found'); return; }
    cfg.channels[idx].models = mergeCatalog(cfg.channels[idx].models, result.models);
    await store.saveConfig();
    const st = store.getState();
    if (!st.channels[channelId]) st.channels[channelId] = {};
    st.channels[channelId].catalogAt = new Date().toISOString();
    await store.saveState();
    logger.info(`catalog done channel=${channelId}`, { count: result.models.length });
    finish(channelId);
  } catch (e) {
    logger.error('catalog failed', { error: (e as Error).message });
    finish(channelId, (e as Error).message);
  }
}
