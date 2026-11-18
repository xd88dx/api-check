// catalog.ts 测试：C4 目录成功/空目录两路 + 手动模型不受同步影响
import { describe, it, expect, afterAll } from 'vitest';
import { buildCatalogUrl, fetchCatalog, mergeCatalog } from './catalog.js';
import { startMock, type MockUpstream } from './mockupstream.js';

const KEY = 'sk-test-0000abcdefgh';
const mocks: MockUpstream[] = [];
afterAll(async () => {
  await Promise.all(mocks.map((m) => m.close()));
});

async function start(handler: Parameters<typeof startMock>[0]): Promise<MockUpstream> {
  const m = await startMock(handler);
  mocks.push(m);
  return m;
}

const fiveModels = {
  data: [
    { id: 'mock-model-1', context_window: 128000 },
    { id: 'mock-model-2' },
    { id: 'mock-model-3' },
    { id: 'mock-model-4' },
    { id: 'mock-model-5' },
  ],
};

describe('fetchCatalog（C4）', () => {
  it('成功：返回 5 模型，带 contextHint 的字段保留', async () => {
    const m = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fiveModels));
    });
    const r = await fetchCatalog({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 3000 });
    expect(r.ok).toBe(true);
    expect(r.models).toHaveLength(5);
    expect(r.models[0]).toEqual({ id: 'mock-model-1', contextHint: '128000' });
    expect(r.models[1]).toEqual({ id: 'mock-model-2' });
    // 目录 URL 归一化：/v1 不剥尾
    expect(m.requests[0].url).toBe(`/v1/models`);
    expect(m.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('空目录：明确报错（ok=false），不是假成功', async () => {
    const m = await start((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
    const r = await fetchCatalog({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 3000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('empty_catalog');
  });

  it('失败（401）：报错而非清空', async () => {
    const m = await start((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"MOCK_CATALOG_AUTH_FAIL"}}');
    });
    const r = await fetchCatalog({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 3000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('auth');
  });

  it('buildCatalogUrl：anthropic 剥尾 /v1 拼接 /v1/models；gemini 拼接 /v1beta/models', () => {
    expect(buildCatalogUrl('https://x.com/v1', 'anthropic')).toMatch(/^https:\/\/x\.com\/v1\/models$/);
    expect(buildCatalogUrl('https://x.com', 'gemini')).toMatch(/^https:\/\/x\.com\/v1beta\/models$/);
  });
});

describe('mergeCatalog（手动模型不删、只增不删已勾选）', () => {
  it('catalog 模型同步更新，manual 保留，勾选状态保持', () => {
    const existing = [
      { id: 'mock-model-1', selected: true, source: 'catalog' as const },
      { id: 'manual-x', selected: true, source: 'manual' as const },
    ];
    const merged = mergeCatalog(existing, [
      { id: 'mock-model-1', contextHint: '128000' },
      { id: 'mock-model-2' },
    ]);
    const ids = merged.map((m) => m.id).sort();
    expect(ids).toEqual(['manual-x', 'mock-model-1', 'mock-model-2']);
    const m1 = merged.find((m) => m.id === 'mock-model-1');
    expect(m1).toMatchObject({ selected: true, contextHint: '128000' });
    // 已有目录项不在新目录中 → 被移除（只增不删已勾选，但此例取消勾选场景见下）
  });

  it('目录拉取失败时传入空列表也不清空既有目录', () => {
    const existing = [{ id: 'a', selected: true, source: 'catalog' as const }];
    const merged = mergeCatalog(existing, []);
    expect(merged.map((m) => m.id)).toEqual(['a']);
  });

  it('新目录项默认不勾选', () => {
    const merged = mergeCatalog([], [{ id: 'new-model' }]);
    expect(merged[0]).toMatchObject({ id: 'new-model', selected: false, source: 'catalog' });
  });

  it('上游顺序不稳定时,合并结果按 id 稳定排序', () => {
    const a = mergeCatalog([], [{ id: 'b' }, { id: 'a' }, { id: 'c' }]);
    const b = mergeCatalog([], [{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
    expect(a.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(b.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('manual 与目录同 id 时只保留 manual 一行', () => {
    const merged = mergeCatalog([{ id: 'x', selected: true, source: 'manual' }], [{ id: 'x' }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'x', source: 'manual' });
  });

  it('已勾选但目录中消失的模型标记 stale,重新出现后清除', () => {
    const existing = [{ id: 'gone', selected: true, source: 'catalog' as const }];
    const stale = mergeCatalog(existing, [{ id: 'kept' }]);
    expect(stale.find((m) => m.id === 'gone')).toMatchObject({ stale: true });
    expect(stale.find((m) => m.id === 'kept')?.stale).toBeUndefined();
    const back = mergeCatalog(stale, [{ id: 'gone' }, { id: 'kept' }]);
    expect(back.find((m) => m.id === 'gone')?.stale).toBeUndefined();
  });
});
