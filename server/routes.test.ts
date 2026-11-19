// routes.ts HTTP 层测试（M6）：plaintext 端点为全站唯一明文出口；intervalMs 持久化
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type ProbeResult } from './store.js';
import { createRouter, errorHandler } from './routes.js';
import { stopAllTestTasks } from './tasks.js';
import { mask } from './mask.js';

const KEY = 'sk-test-0000abcdefgh';
let server: ReturnType<express.Express['listen']> | null = null;
let baseUrl = '';
const dirs: string[] = [];
const stores: Store[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});
afterEach(async () => {
  stopAllTestTasks();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function setup(): Promise<{ store: Store; channelId: string; keyId: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), 'api-check-routes-'));
  dirs.push(dataDir);
  const store = new Store(dataDir);
  await store.init();
  const now = new Date().toISOString();
  store.getConfig().channels.push({
    id: 'c1',
    name: 'mock',
    // 立即拒绝的本地地址：让 runTest 的请求快速失败，避免后台任务跨用例挂起
    baseUrl: 'http://127.0.0.1:9/v1',
    insecure: false,
    enabled: true,
    createdAt: now,
    keys: [
      { id: 'k1', label: 'key1', key: KEY, enabled: true, concurrency: 1, createdAt: now },
    ],
    models: [{ id: 'm1', selected: true, source: 'catalog' }],
  });
  const probe: Record<string, ProbeResult> = {
    openai: { url: 'https://example.com/v1/chat/completions', cls: 'ok', latencyMs: 1, httpStatus: 200, rawSnippet: '', at: now },
  };
  store.getState().channels['c1'] = { probe };
  await store.saveConfig();
  await store.saveState();
  stores.push(store);

  const app = express();
  app.use('/api', createRouter(store));
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const addr = server!.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/api`;
  return { store, channelId: 'c1', keyId: 'k1' };
}

describe('密钥编辑掩码防线（防掩码回填覆盖真 key）', () => {
  it('PUT 存量行带掩码形态 key → 原 key 不变', async () => {
    await setup();
    const res = await fetch(`${baseUrl}/channels/c1/keys`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [{ id: 'k1', label: 'key1', key: mask(KEY), enabled: true, concurrency: 1 }] }),
    });
    expect(res.status).toBe(200);
    const ch = await fetch(`${baseUrl}/channels`).then((r) => r.json()) as { channels: { keys: { key: string }[] }[] };
    expect(ch.channels[0]!.keys[0]!.key).toBe(mask(KEY)); // 掩码仍在 = 真 key 未被覆盖
    const plain = await fetch(`${baseUrl}/channels/c1/keys/k1/plaintext`).then((r) => r.json()) as { key: string };
    expect(plain.key).toBe(KEY);
  });

  it('PUT 存量行带明文 key → 正常更新', async () => {
    await setup();
    const newKey = 'sk-updated-0000abcdefgh';
    const res = await fetch(`${baseUrl}/channels/c1/keys`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [{ id: 'k1', label: 'key1', key: newKey, enabled: true, concurrency: 1 }] }),
    });
    expect(res.status).toBe(200);
    const plain = await fetch(`${baseUrl}/channels/c1/keys/k1/plaintext`).then((r) => r.json()) as { key: string };
    expect(plain.key).toBe(newKey);
  });

  it('PUT 新行带掩码形态 key → 400', async () => {
    await setup();
    const res = await fetch(`${baseUrl}/channels/c1/keys`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [{ label: 'new', key: 'sk-84…GVEQJ', enabled: true, concurrency: 1 }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('masked');
  });

  it('PUT 新行带明文 key → 正常新增', async () => {
    await setup();
    const res = await fetch(`${baseUrl}/channels/c1/keys`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [
        { id: 'k1', label: 'key1', enabled: true, concurrency: 1 },
        { label: 'new', key: 'sk-new-000000000000', enabled: true, concurrency: 1 },
      ] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { channel: { keys: { id: string; label: string }[] } };
    expect(body.channel.keys).toHaveLength(2);
    expect(body.channel.keys.find((k) => k.label === 'new')).toBeTruthy();
  });
});

describe('M6 plaintext 端点（H2/H6）', () => {
  it('GET /keys/:keyId/plaintext 返回明文（全站唯一豁免出口）', async () => {
    await setup();
    const res = await fetch(`${baseUrl}/channels/c1/keys/k1/plaintext`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string };
    expect(body.key).toBe(KEY);
  });

  it('其余出口仍掩码：GET /channels 的 key 为 mask 形态，不出现明文', async () => {
    await setup();
    const res = await fetch(`${baseUrl}/channels`);
    const body = (await res.json()) as { channels: { keys: { key: string }[] }[] };
    expect(body.channels[0]!.keys[0]!.key).toBe(mask(KEY));
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it('key 不存在 → 404', async () => {
    await setup();
    const res = await fetch(`${baseUrl}/channels/c1/keys/nope/plaintext`);
    expect(res.status).toBe(404);
  });
});

describe('M6 间隔持久化（H5/H6）', () => {
  it('POST /test 显式 intervalMs → 写回 testDefaults.intervalMs', async () => {
    const { store } = await setup();
    const res = await fetch(`${baseUrl}/channels/c1/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // repeat=1：单格单请求，intervalMs 不触发格间 sleep；请求立即失败、任务毫秒级收尾
      body: JSON.stringify({ intervalMs: 12000, repeat: 1 }),
    });
    expect(res.status).toBe(202);
    expect(store.getConfig().testDefaults.intervalMs).toBe(12000);
    expect(store.getConfig().testDefaults.repeat).toBe(1);
    // 等后台任务收尾，避免测试清理目录后任务仍在写盘
    for (let i = 0; i < 20; i++) {
      const t = await fetch(`${baseUrl}/channels/c1/task`);
      const { task } = (await t.json()) as { task: { running: boolean } | null };
      if (!task?.running) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
});

describe('拖动排序(PUT /channels/order)', () => {
  it('按 ids 重排,未列出的渠道按原顺序补到末尾', async () => {
    const { store } = await setup();
    const now = new Date().toISOString();
    for (const id of ['c2', 'c3']) {
      store.getConfig().channels.push({
        id,
        name: id,
        baseUrl: 'http://127.0.0.1:9/v1',
        insecure: false,
        enabled: true,
        createdAt: now,
        keys: [],
        models: [],
      });
    }
    await store.saveConfig();
    const res = await fetch(`${baseUrl}/channels/order`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ['c3', 'c1'] }),
    });
    expect(res.status).toBe(200);
    const list = (await fetch(`${baseUrl}/channels`).then((r) => r.json())) as {
      channels: { id: string }[];
    };
    expect(list.channels.map((c) => c.id)).toEqual(['c3', 'c1', 'c2']);
    expect(store.getConfig().channels.map((c) => c.id)).toEqual(['c3', 'c1', 'c2']);
  });
});

describe('备份导入导出', () => {
  it('导出含明文 key;导入覆盖配置、跳过非法渠道并恢复 testDefaults', async () => {
    const { store } = await setup();
    const exp = (await fetch(`${baseUrl}/backup/export`).then((r) => r.json())) as {
      config: { channels: Record<string, unknown>[] };
    };
    expect(exp.config.channels).toHaveLength(1);
    const rawKeys = exp.config.channels[0]!.keys as { key: string }[];
    expect(rawKeys[0]!.key).toBe(KEY);

    await fetch(`${baseUrl}/channels/c1`, { method: 'DELETE' });
    const res = await fetch(`${baseUrl}/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          channels: [
            { ...exp.config.channels[0], id: 'imported', name: 'backup' },
            { name: '', baseUrl: 'not-a-url' },
          ],
          testDefaults: { intervalMs: 2500, timeoutMs: 5000, repeat: 3 },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 1, skipped: 1 });

    const list = (await fetch(`${baseUrl}/channels`).then((r) => r.json())) as {
      channels: { id: string; keys: { key: string }[] }[];
      testDefaults: { intervalMs: number; repeat: number };
    };
    expect(list.channels.map((c) => c.id)).toEqual(['imported']);
    expect(list.channels[0]!.keys[0]!.key).toBe(mask(KEY));
    expect(list.testDefaults).toMatchObject({ intervalMs: 2500, repeat: 3 });
    expect(store.getConfig().channels[0]!.keys[0]!.key).toBe(KEY);
  });

  it('备份中没有合法渠道 → 400', async () => {
    await setup();
    const res = await fetch(`${baseUrl}/backup/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { channels: [{ name: '', baseUrl: 'bad' }] } }),
    });
    expect(res.status).toBe(400);
  });
});

describe('目录外模型删除(removeModels)', () => {
  it('按 id 删除任意来源的模型', async () => {
    const { store } = await setup();
    const res = await fetch(`${baseUrl}/channels/c1/models`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeModels: ['m1'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { channel: { models: { id: string }[] } };
    expect(body.channel.models).toEqual([]);
    expect(store.getConfig().channels[0]!.models).toEqual([]);
  });
});
