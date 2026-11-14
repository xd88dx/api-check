// runner.ts 测试：D1 串行 / D2 中断 / D3 静默超时 / D4 429 与只选可用 / D7 互斥（ACCEPTANCE）
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type CellResult, type ProbeResult } from './store.js';
import { runTest, selectAvailableModels, summarizeCell } from './runner.js';
import { acquireTask, stopAllTestTasks, getTask, runProbe } from './tasks.js';
import { startMock, type MockUpstream } from './mockupstream.js';

const KEY = 'sk-test-0000abcdefgh';
const mocks: MockUpstream[] = [];
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(mocks.map((m) => m.close()));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function start(handler: Parameters<typeof startMock>[0]): Promise<MockUpstream> {
  const m = await startMock(handler);
  mocks.push(m);
  return m;
}

function okBody(): string {
  return JSON.stringify({ choices: [{ message: { content: 'pong' } }] });
}

async function setupChannel(mock: MockUpstream, modelIds: string[]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'api-check-runner-'));
  dirs.push(dataDir);
  const store = new Store(dataDir);
  await store.init();
  const now = new Date().toISOString();
  store.getConfig().channels.push({
    id: 'c1',
    name: 'mock',
    baseUrl: `${mock.baseUrl}/v1`,
    insecure: false,
    enabled: true,
    createdAt: now,
    keys: ['k1', 'k2'].map((id, i) => ({
      id,
      label: `key${i + 1}`,
      key: KEY,
      enabled: true,
      concurrency: 1,
      createdAt: now,
    })),
    models: modelIds.map((id) => ({ id, selected: true, source: 'catalog' as const })),
  });
  const probe: Record<string, ProbeResult> = {
    openai: { url: `${mock.baseUrl}/v1/chat/completions`, cls: 'ok', latencyMs: 1, httpStatus: 200, rawSnippet: '', at: now },
  };
  store.getState().channels['c1'] = { probe };
  await store.saveConfig();
  await store.saveState();
  return { store, channelId: 'c1', keyIds: ['k1', 'k2'] as const };
}

describe('runTest', () => {
  it('D1 串行：请求到达时刻间隔 ≥ intervalMs', async () => {
    const arrivals: number[] = [];
    const m = await start((_req, res) => {
      arrivals.push(Date.now());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okBody());
    });
    const { store, channelId } = await setupChannel(m, ['m1', 'm2']);
    acquireTask(channelId, 'test', 0);
    await runTest(store, channelId, { intervalMs: 250, timeoutMs: 3000 });
    expect(arrivals).toHaveLength(4);
    for (let i = 1; i < arrivals.length; i++) {
      expect(arrivals[i] - arrivals[i - 1]).toBeGreaterThanOrEqual(250);
    }
    const results = store.getState().channels['c1']!.results!;
    expect(Object.keys(results).sort()).toEqual(['m1', 'm2']);
    expect(results['m1']!['k1']!.cls).toBe('ok');
    expect(store.getState().channels['c1']!.lastTestAt).toBeTruthy();
  });

  it('D2 中断：队列清空、stopped 落盘、已完成格保留、无僵尸请求', async () => {
    const m = await start((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(okBody());
      }, 100);
    });
    const { store, channelId } = await setupChannel(m, ['m1', 'm2', 'm3']);
    acquireTask(channelId, 'test', 0);
    const runP = runTest(store, channelId, { intervalMs: 60, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 350));
    expect(stopAllTestTasks()).toBe(1);
    await runP;
    const task = getTask(channelId)!;
    expect(task.running).toBe(false);
    expect(task.stopped).toBe(true);
    const snap = store.getState().channels['c1']!.task!;
    expect(snap.running).toBe(false);
    expect(snap.stopped).toBe(true);
    const results = store.getState().channels['c1']!.results!;
    const cells: CellResult[] = Object.values(results).flatMap((row) => Object.values(row));
    expect(cells.length).toBe(m.requests.length);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(6);
    await new Promise((r) => setTimeout(r, 300));
    expect(m.requests.length).toBe(cells.length);
  });

  it('D3 头已到、body 挂住 → 按 timeoutMs 判 timeout（非等满整体计时）', async () => {
    const m = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"choices":[');
    });
    const { store, channelId } = await setupChannel(m, ['m1']);
    acquireTask(channelId, 'test', 0);
    const t0 = Date.now();
    await runTest(store, channelId, { intervalMs: 0, timeoutMs: 1500 });
    const elapsed = Date.now() - t0;
    const cell = store.getState().channels['c1']!.results!['m1']!['k1']!;
    expect(cell.cls).toBe('timeout');
    expect(elapsed).toBeLessThan(6000);
  });

  it('D3 正常慢响应（小间隔吐字节、总时长 > timeoutMs）不被误杀', async () => {
    const m = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const payload = okBody() + ' '.repeat(10);
      let i = 0;
      const timer = setInterval(() => {
        if (i < payload.length) res.write(payload[i++]);
        else {
          clearInterval(timer);
          res.end();
        }
      }, 50);
    });
    const { store, channelId } = await setupChannel(m, ['m1']);
    acquireTask(channelId, 'test', 0);
    await runTest(store, channelId, { intervalMs: 0, timeoutMs: 1000 });
    const cell = store.getState().channels['c1']!.results!['m1']!['k1']!;
    expect(cell.cls).toBe('ok');
    expect(cell.latencyMs).toBeGreaterThan(1000);
  }, 15000);

  it('D4 429 → rate_limited；只选可用保留 429 模型、剔除其他失败', async () => {
    const m = await start((_req, res, body) => {
      let model = '';
      try {
        model = (JSON.parse(body) as { model: string }).model;
      } catch {
        /* ignore */
      }
      if (model === 'm-429') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"MOCK_RATE_LIMITED"}}');
      } else if (model === 'm-auth') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"MOCK_AUTH_FAIL"}}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(okBody());
      }
    });
    const { store, channelId, keyIds } = await setupChannel(m, ['m-ok', 'm-429', 'm-auth']);
    acquireTask(channelId, 'test', 0);
    await runTest(store, channelId, { intervalMs: 10, timeoutMs: 3000 });
    const results = store.getState().channels['c1']!.results!;
    expect(results['m-ok']![keyIds[0]]!.cls).toBe('ok');
    expect(results['m-429']![keyIds[0]]!.cls).toBe('rate_limited');
    expect(results['m-auth']![keyIds[0]]!.cls).toBe('auth');
    const keep = selectAvailableModels(results, ['m-ok', 'm-429', 'm-auth']);
    expect(keep).toContain('m-ok');
    expect(keep).toContain('m-429');
    expect(keep).not.toContain('m-auth');
  });

  it('全部协议非 ok 且目录为空 → 拒绝启动，报 probe_first', async () => {
    const m = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const { store, channelId } = await setupChannel(m, []);
    delete store.getState().channels['c1']!.probe;
    acquireTask(channelId, 'test', 0);
    await runTest(store, channelId, { intervalMs: 0, timeoutMs: 2000 });
    const task = getTask(channelId)!;
    expect(task.running).toBe(false);
    expect(task.error).toBe('probe_first');
    expect(m.requests).toHaveLength(0);
  });

  it('无探测 ok 但目录非空 → 放行启动，主协议兜底 openai（分组限模型源）', async () => {
    const m = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okBody());
    });
    const { store, channelId } = await setupChannel(m, ['crowllm-model-1']);
    // 模拟四协议全 error（占位模型触发 503）但目录非空
    const now = new Date().toISOString();
    const probe: Record<string, ProbeResult> = {
      openai: { url: '', cls: 'error', latencyMs: 1, httpStatus: 503, rawSnippet: '', at: now },
      responses: { url: '', cls: 'error', latencyMs: 1, httpStatus: 503, rawSnippet: '', at: now },
      anthropic: { url: '', cls: 'error', latencyMs: 1, httpStatus: 503, rawSnippet: '', at: now },
      gemini: { url: '', cls: 'error', latencyMs: 1, httpStatus: 503, rawSnippet: '', at: now },
    };
    store.getState().channels['c1']!.probe = probe;
    acquireTask(channelId, 'test', 0);
    await runTest(store, channelId, { intervalMs: 0, timeoutMs: 2000 });
    const task = getTask(channelId)!;
    expect(task.running).toBe(false);
    expect(task.error).toBeUndefined();
    // 主协议为 openai：请求打到 /chat/completions
    expect(m.requests).toHaveLength(2); // 1 model × 2 keys
    for (const r of m.requests) {
      expect(r.url).toContain('/chat/completions');
    }
    const cell = store.getState().channels['c1']!.results!['crowllm-model-1']!['k1']!;
    expect(cell.cls).toBe('ok');
  });

  it('D7 互斥：矩阵运行中再占用 probe/catalog/test 一律被拒（routes 映射 409）', async () => {
    const m = await start(() => {
      /* 挂住不响应 */
    });
    const { store, channelId } = await setupChannel(m, ['m1', 'm2']);
    acquireTask(channelId, 'test', 0);
    const runP = runTest(store, channelId, { intervalMs: 10, timeoutMs: 800 });
    await new Promise((r) => setTimeout(r, 100));
    expect(acquireTask(channelId, 'probe', 4)).toBeNull();
    expect(acquireTask(channelId, 'catalog', 1)).toBeNull();
    expect(acquireTask(channelId, 'test', 0)).toBeNull();
    stopAllTestTasks();
    await runP;
    expect(acquireTask(channelId, 'probe', 4)).not.toBeNull();
  });
});

describe('selectAvailableModels', () => {
  it('ok / rate_limited 保留，timeout / error / unsupported / 无结果剔除', () => {
    const mk = (cls: CellResult['cls']): CellResult => ({
      cls,
      latencyMs: 1,
      httpStatus: 200,
      rawSnippet: '',
      at: '',
    });
    const results: Record<string, Record<string, CellResult>> = {
      a: { k1: mk('ok') },
      b: { k1: mk('rate_limited') },
      c: { k1: mk('timeout') },
      d: { k1: mk('error') },
      e: { k1: mk('unsupported') },
    };
    expect(selectAvailableModels(results, ['a', 'b', 'c', 'd', 'e', 'f'])).toEqual(['a', 'b']);
  });
});

describe('M5 探测可指定模型（G5）', () => {
  it('指定模型 → 探测请求体 model=该值，单候选不换候选循环', async () => {
    const m = await start((_req, res, body) => {
      let model = '';
      try { model = (JSON.parse(body) as { model: string }).model; } catch { /* ignore */ }
      if (model === 'user-model') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('MOCK_USER_MODEL_500');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(okBody());
      }
    });
    // 目录非空（含 cat-model）：若误走目录候选循环会换候选，这里必须单候选
    const { store, channelId } = await setupChannel(m, ['cat-model']);
    acquireTask(channelId, 'probe', 4);
    await runProbe(store, channelId, { model: 'user-model' });
    const chatReqs = m.requests.filter((q) => q.url.endsWith('/chat/completions'));
    expect(chatReqs).toHaveLength(1);
    expect(JSON.parse(chatReqs[0]!.body ?? '{}')).toMatchObject({ model: 'user-model' });
    const probeState = store.getState().channels['c1']!.probe!;
    expect(probeState.openai.cls).toBe('error');
    expect(probeState.openai.model).toBe('user-model');
  });

  it('留空 → 目录非空时按目录候选循环（现状回归不回退）', async () => {
    const m = await start((_req, res, body) => {
      let model = '';
      try { model = (JSON.parse(body) as { model: string }).model; } catch { /* ignore */ }
      if (model === 'cat-model') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('MOCK_CAT_MODEL_500');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(okBody());
      }
    });
    const { store, channelId } = await setupChannel(m, ['cat-model', 'cat-model-2']);
    acquireTask(channelId, 'probe', 4);
    await runProbe(store, channelId);
    const chatReqs = m.requests.filter((q) => q.url.endsWith('/chat/completions'));
    expect(chatReqs.length).toBeGreaterThanOrEqual(2);
    const probeState = store.getState().channels['c1']!.probe!;
    expect(probeState.openai.cls).toBe('ok');
    expect(probeState.openai.model).toBe('cat-model-2');
  });
});

describe('M5 测试次数与连通率（G1）', () => {
  it('repeat=3 → 每格请求数=N×模型×密钥，429 计入连通', async () => {
    const m = await start((_req, res, body) => {
      let model = '';
      try { model = (JSON.parse(body) as { model: string }).model; } catch { /* ignore */ }
      if (model === 'm-429') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{}');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(okBody());
      }
    });
    const { store, channelId, keyIds } = await setupChannel(m, ['m-ok', 'm-429']);
    acquireTask(channelId, 'test', 0);
    await runTest(store, channelId, { intervalMs: 5, timeoutMs: 3000, repeat: 3 });
    // 2 模型 × 2 密钥 × 3 次 = 12 请求
    expect(m.requests).toHaveLength(12);
    const results = store.getState().channels['c1']!.results!;
    const okCell = results['m-ok']![keyIds[0]]!;
    expect(okCell.repeats).toHaveLength(3);
    expect(okCell.repeats!.every((r) => r.cls === 'ok')).toBe(true);
    const limitedCell = results['m-429']![keyIds[0]]!;
    expect(limitedCell.cls).toBe('rate_limited');
    expect(limitedCell.repeats!.filter((r) => r.cls === 'rate_limited')).toHaveLength(3);
  });

  it('连通率色块规则：1 ok+2 503→warn；全 timeout→muted；全 error(503)→bad；主 cls=最后一次非失败', () => {
    const mk = (cls: CellResult['cls'], status: number | null = 200) => ({
      cls, latencyMs: 1, httpStatus: status, rawSnippet: '', at: '',
    });
    const tone = (r: CellResult): string => {
      const ok = r.repeats!.filter((x) => x.cls === 'ok' || x.cls === 'rate_limited').length;
      const total = r.repeats!.length;
      const ratio = ok / total;
      if (ratio >= 0.5) return 'ok';
      if (ratio > 0) return 'warn';
      if (r.repeats!.every((x) => x.cls === 'timeout')) return 'muted';
      return 'bad';
    };
    const a = summarizeCell([mk('ok'), mk('error', 503), mk('error', 503)]);
    expect(tone(a)).toBe('warn');
    const b = summarizeCell([mk('timeout'), mk('timeout'), mk('timeout')]);
    expect(tone(b)).toBe('muted');
    const c = summarizeCell([mk('error', 503), mk('error', 503), mk('error', 503)]);
    expect(tone(c)).toBe('bad');
    // 主 cls：最后一次非失败结果；全失败取最后一次
    expect(a.cls).toBe('ok');
    expect(b.cls).toBe('timeout');
    expect(c.cls).toBe('error');
  });

  it('N=1 形态与旧版一致：repeats 长度=1，主字段等于该次结果', async () => {
    const m = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okBody());
    });
    const { store, channelId, keyIds } = await setupChannel(m, ['m1']);
    acquireTask(channelId, 'test', 0);
    await runTest(store, channelId, { intervalMs: 5, timeoutMs: 3000, repeat: 1 });
    const cell = store.getState().channels['c1']!.results!['m1']![keyIds[0]]!;
    expect(cell.repeats).toHaveLength(1);
    expect(cell.cls).toBe('ok');
    expect(cell.latencyMs).toBe(cell.repeats![0]!.latencyMs);
  });
});
