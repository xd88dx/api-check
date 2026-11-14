// 矩阵测试编排器（SPEC §8）
// 行=已选模型，列=已启用密钥；全局串行队列；请求间强制 intervalMs；
// 单请求按静默时长超时；stop 后当前请求允许完成、队列清空、stopped:true 落盘；
// 结果逐格写 state 即刻落盘。
import { request } from './httpclient.js';
import { classify, snippet } from './classify.js';
import { buildProbeRequest, pickMainProtocol } from './probe.js';
import type { Store, CellResult, RepeatDetail } from './store.js';
import { clampRepeat } from './store.js';
import { finishTask, getTask, persistSnapshot } from './tasks.js';
import { logger } from './logger.js';

export interface RunTestOpts {
  modelIds?: string[]; // 未指定取全部 selected 模型
  keyIds?: string[]; // 未指定取全部启用的 key
  intervalMs?: number; // 默认取 config.testDefaults
  timeoutMs?: number; // 默认取 config.testDefaults
  repeat?: number; // M7：失败重试次数（总尝试上限）1–10，默认取 config.testDefaults.repeat
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 「只选可用」：结果中存在 ok 或 rate_limited 格的模型保留勾选（429 限流≠不可用） */
export function selectAvailableModels(
  results: Record<string, Record<string, CellResult>>,
  modelIds: string[],
): string[] {
  return modelIds.filter((id) => {
    const row = results[id];
    if (!row) return false;
    return Object.values(row).some((c) => c.cls === 'ok' || c.cls === 'rate_limited');
  });
}

/** M7 §14：主字段 = 最后一次尝试。成功（ok/rate_limited）即停 → 成功那次必为最后一次；
 * 全败 → 最后一次失败结果（SPEC §14.3）。N=1 时与旧版单次完全一致。 */
export function summarizeCell(repeats: RepeatDetail[]): CellResult {
  const last = repeats[repeats.length - 1]!;
  return { ...last, repeats };
}

export async function runTest(store: Store, channelId: string, opts: RunTestOpts): Promise<void> {
  const task = getTask(channelId);
  if (!task) return;
  try {
    const ch = store.getConfig().channels.find((c) => c.id === channelId);
    if (!ch) { await finishTask(store, channelId, 'channel not found'); return; }

    const defaults = store.getConfig().testDefaults;
    const intervalMs = opts.intervalMs ?? defaults.intervalMs;
    const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs;
    const repeat = clampRepeat(opts.repeat ?? defaults.repeat);

    // 行：已选模型；列：已启用密钥
    const models = (opts.modelIds && opts.modelIds.length > 0
      ? ch.models.filter((m) => opts.modelIds!.includes(m.id))
      : ch.models.filter((m) => m.selected)
    );
    const enabledKeys = ch.keys.filter((k) => k.enabled);
    const keys = (opts.keyIds && opts.keyIds.length > 0
      ? enabledKeys.filter((k) => opts.keyIds!.includes(k.id))
      : enabledKeys
    );

    // 主协议 = 探测 ok 的第一个；无 ok 但目录非空时兜底 openai（分组限模型源上探测必 503）
    const probe = store.getState().channels[channelId]?.probe;
    const proto = pickMainProtocol(probe, ch.models.length > 0);
    if (!proto) {
      await finishTask(store, channelId, 'probe_first');
      return;
    }

    const total = models.length * keys.length;
    task.total = total;
    task.currentIndex = 0;

    if (models.length === 0 || keys.length === 0) {
      await finishTask(store, channelId, models.length === 0 ? 'no_selected_models' : 'no_enabled_keys');
      return;
    }

    const st = store.getState();
    if (!st.channels[channelId]) st.channels[channelId] = {};
    if (!st.channels[channelId].results) st.channels[channelId].results = {};

    let first = true;
    let index = 0;
    for (const model of models) {
      for (const key of keys) {
        if (task.stopped) {
          logger.info(`test stopped channel=${channelId} at index=${index}/${total}`);
          await finishTask(store, channelId);
          return;
        }

        // M7 §14：失败重试语义——先发 1 次，cls ∈ {ok, rate_limited} 即定案；
        // 其余 cls 自动重试，最多共 repeat 次尝试（N=1 等价旧版单次），中途成功即停
        const repeats: RepeatDetail[] = [];
        const spec = buildProbeRequest(proto, ch.baseUrl, key.key, model.id);
        for (let n = 0; n < repeat; n++) {
          if (task.stopped) break;
          // 请求间强制间隔（含格与格之间、重试请求之间）
          if (!first) await sleep(intervalMs);
          first = false;

          task.current = { modelId: model.id, keyId: key.id, index };
          task.currentIndex = index;
          await persistSnapshot(store, channelId, task);

          const startedAt = Date.now();
          const res = await request({
            url: spec.fetchUrl,
            method: spec.method,
            headers: spec.headers,
            body: spec.body,
            timeoutMs,
            insecure: ch.insecure,
          });
          const latency = Date.now() - startedAt;
          const detail: RepeatDetail = {
            cls: classify({ httpStatus: res.status, body: res.body, timedOut: res.timedOut, okMarkers: spec.okMarkers }),
            latencyMs: latency,
            httpStatus: res.status,
            rawSnippet: snippet(res.body),
            at: new Date().toISOString(),
          };
          repeats.push(detail);
          if (detail.cls === 'ok' || detail.cls === 'rate_limited') break; // 成功即停
        }
        if (repeats.length === 0) {
          // stop 发生在本格开始前
          logger.info(`test stopped channel=${channelId} at index=${index}/${total}`);
          await finishTask(store, channelId);
          return;
        }

        const cell = summarizeCell(repeats);
        if (!st.channels[channelId].results![model.id]) st.channels[channelId].results![model.id] = {};
        st.channels[channelId].results![model.id][key.id] = cell;
        // 逐格写 state 即刻落盘
        await persistSnapshot(store, channelId, task);
        index++;
      }
    }

    st.channels[channelId].lastTestAt = new Date().toISOString();
    await store.saveState();
    logger.info(`test done channel=${channelId}`, { total });
    await finishTask(store, channelId);
  } catch (e) {
    logger.error('test failed', { error: (e as Error).message });
    await finishTask(store, channelId, (e as Error).message);
  }
}
