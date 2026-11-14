// 后台任务管理（SPEC §3）：单渠道同一时刻只允许一个任务（探测/目录/矩阵互斥），
// 占用中再发起返回 409。任务异步执行，前端轮询 GET /channels/:id/task。
import type { Store, TaskSnapshot } from './store.js';
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
  current?: { modelId: string; keyId: string; index: number };
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

/** POST /api/test/stop：中断所有运行中的矩阵任务（当前请求允许完成，队列清空） */
export function stopAllTestTasks(): number {
  let n = 0;
  for (const task of tasks.values()) {
    if (task.type === 'test' && task.running) {
      task.stopped = true;
      n++;
    }
  }
  return n;
}

/** 任务快照落盘（state.channels[id].task，SPEC §5/§8） */
export async function persistSnapshot(store: Store, channelId: string, task: TaskState): Promise<void> {
  const st = store.getState();
  if (!st.channels[channelId]) return;
  const snap: TaskSnapshot = {
    type: task.type,
    running: task.running,
    stopped: task.stopped,
    total: task.total,
    ...(task.current ? { current: { ...task.current } } : {}),
  };
  st.channels[channelId].task = snap;
  await store.saveState();
}

/** 结束任务并落盘快照（error 时记录错误） */
export async function finishTask(store: Store, channelId: string, error?: string): Promise<void> {
  const task = tasks.get(channelId);
  if (!task) return;
  task.running = false;
  if (error) task.error = error;
  task.finishedAt = new Date().toISOString();
  await persistSnapshot(store, channelId, task);
}

/** 启动探测任务（取第一个启用的 key；无 key 报错） */
export async function runProbe(store: Store, channelId: string): Promise<void> {
  const task = tasks.get(channelId);
  if (!task) return;
  try {
    const ch = store.getConfig().channels.find((c) => c.id === channelId);
    if (!ch) { await finishTask(store, channelId, 'channel not found'); return; }
    const key = ch.keys.find((k) => k.enabled) ?? ch.keys[0];
    if (!key) { await finishTask(store, channelId, 'no key configured'); return; }
    // 目录非空时探测按目录顺序最多取 3 个候选模型（坏模型自动换下一个，见 probe.ts）
    const catalogModels = ch.models.slice(0, 3).map((m) => m.id);
    const results = await probeAll({
      baseUrl: ch.baseUrl,
      apiKey: key.key,
      insecure: ch.insecure,
      timeoutMs: store.getConfig().testDefaults.timeoutMs,
      ...(catalogModels.length > 0 ? { model: catalogModels } : {}),
    });
    const state = store.getState();
    if (!state.channels[channelId]) state.channels[channelId] = {};
    state.channels[channelId].probe = results;
    await store.saveState();
    logger.info(`probe done channel=${channelId}`, {
      cls: Object.fromEntries(Object.entries(results).map(([p, r]) => [p, r.cls])),
    });
    await finishTask(store, channelId);
  } catch (e) {
    logger.error('probe failed', { error: (e as Error).message });
    await finishTask(store, channelId, (e as Error).message);
  }
}

/** 启动目录拉取任务（取第一个启用的 key） */
export async function runCatalog(store: Store, channelId: string): Promise<void> {
  const task = tasks.get(channelId);
  if (!task) return;
  try {
    const ch = store.getConfig().channels.find((c) => c.id === channelId);
    if (!ch) { await finishTask(store, channelId, 'channel not found'); return; }
    const key = ch.keys.find((k) => k.enabled) ?? ch.keys[0];
    if (!key) { await finishTask(store, channelId, 'no key configured'); return; }
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
      await finishTask(store, channelId, `catalog_failed: ${result.error ?? 'unknown'}`);
      return;
    }
    const cfg = store.getConfig();
    const idx = cfg.channels.findIndex((c) => c.id === channelId);
    if (idx < 0) { await finishTask(store, channelId, 'channel not found'); return; }
    cfg.channels[idx].models = mergeCatalog(cfg.channels[idx].models, result.models);
    await store.saveConfig();
    const st = store.getState();
    if (!st.channels[channelId]) st.channels[channelId] = {};
    st.channels[channelId].catalogAt = new Date().toISOString();
    await store.saveState();
    logger.info(`catalog done channel=${channelId}`, { count: result.models.length });
    await finishTask(store, channelId);
  } catch (e) {
    logger.error('catalog failed', { error: (e as Error).message });
    await finishTask(store, channelId, (e as Error).message);
  }
}
