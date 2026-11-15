// J4/J5：Gist 三方对比算法（推/拉/冲突）与指纹稳定性测试
// GitHub API 打点全部注入 mock fetch（vi.stubGlobal），不发真实网络请求
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type Channel, type ChannelKey, type TestDefaults } from './store.js';
import { configHash, syncCore, GIST_FILE } from './gistsync.js';

const TD: TestDefaults = { intervalMs: 1000, timeoutMs: 60000, repeat: 1 };

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'api-check-gistsync-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(tmpDir, { recursive: true, force: true });
});

function mkKey(key: string): ChannelKey {
  return {
    id: 'k1',
    label: 'main',
    key,
    enabled: true,
    concurrency: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'c1',
    name: 'ch',
    baseUrl: 'https://example.com/v1',
    insecure: false,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    keys: [],
    models: [],
    ...overrides,
  };
}

/** Gist 文件内容（与 pushCore 写入的负载同构） */
function gistBody(channels: unknown, testDefaults: unknown = TD): string {
  return JSON.stringify({
    app: 'api-check',
    version: 1,
    exported_at: 1700000000000,
    config: { channels, testDefaults },
  });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * mock fetch：GET → fetchGist（返回 Gist 文件内容）；PATCH/POST → pushCore（返回 gist 元数据）。
 * 所有请求都落在本地 mock，绝不触网。
 */
function mockFetch(gistContent: string) {
  return vi.fn(async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      return jsonResponse({ files: { [GIST_FILE]: { content: gistContent } } });
    }
    return jsonResponse({ id: 'gist1', html_url: 'https://gist.github.com/x/gist1' });
  });
}

async function setupStore(
  channels: Channel[],
  gist: { token?: string; gistId?: string; baselineHash?: string },
): Promise<Store> {
  const store = new Store(tmpDir);
  await store.init();
  store.getConfig().channels = channels;
  const g = store.getConfig().gist!;
  if (gist.token !== undefined) g.token = gist.token;
  if (gist.gistId !== undefined) g.gistId = gist.gistId;
  if (gist.baselineHash !== undefined) g.baselineHash = gist.baselineHash;
  await store.saveConfig();
  return store;
}

function callsWithMethod(f: ReturnType<typeof mockFetch>, method: string): number {
  return f.mock.calls.filter(
    ([, i]) => ((i as RequestInit | undefined)?.method ?? 'GET').toUpperCase() === method,
  ).length;
}

describe('Gist 三方对比（J4）', () => {
  it('a) 本地≠基线且 Gist==基线 → push（PATCH 既有 Gist，基线更新为本地指纹）', async () => {
    const base = [makeChannel()];
    const baseHash = configHash({ channels: base, testDefaults: TD });
    const store = await setupStore([makeChannel({ name: 'local-edit' })], {
      token: 'tok',
      gistId: 'g1',
      baselineHash: baseHash,
    });
    const f = mockFetch(gistBody(base));
    vi.stubGlobal('fetch', f);

    const out = await syncCore(store, '测试');

    expect(out.action).toBe('pushed');
    expect(callsWithMethod(f, 'PATCH')).toBe(1);
    expect(callsWithMethod(f, 'GET')).toBe(1); // 先对比，再推送
    expect(store.getConfig().gist!.baselineHash).toBe(configHash(store.getConfig()));
  });

  it('b) Gist≠基线且本地==基线 → pull（本地被远端覆盖，基线=远端指纹，不再反向推送）', async () => {
    const base = [makeChannel()];
    const baseHash = configHash({ channels: base, testDefaults: TD });
    const remote = [makeChannel({ name: 'remote-edit', keys: [mkKey('sk-remote')] })];
    const store = await setupStore(base, { token: 'tok', gistId: 'g1', baselineHash: baseHash });
    const f = mockFetch(gistBody(remote));
    vi.stubGlobal('fetch', f);

    const out = await syncCore(store, '测试');

    expect(out.action).toBe('pulled');
    expect(out.channels).toBe(1);
    expect(callsWithMethod(f, 'PATCH')).toBe(0); // 拉取绝不推送
    expect(store.getConfig().channels[0].name).toBe('remote-edit');
    expect(store.getConfig().channels[0].keys[0].key).toBe('sk-remote');
    expect(store.getConfig().gist!.baselineHash).toBe(
      configHash({ channels: remote, testDefaults: TD }),
    );

    // 二次同步：本地已与远端一致 → same，无 ping-pong
    const out2 = await syncCore(store, '测试');
    expect(out2.action).toBe('same');
  });

  it('c) 两边都≠基线 → 冲突跳过：不改本地、不推送、lastResult 告警', async () => {
    const base = [makeChannel()];
    const baseHash = configHash({ channels: base, testDefaults: TD });
    const store = await setupStore([makeChannel({ name: 'local-edit' })], {
      token: 'tok',
      gistId: 'g1',
      baselineHash: baseHash,
    });
    const f = mockFetch(gistBody([makeChannel({ name: 'remote-edit' })]));
    vi.stubGlobal('fetch', f);

    const out = await syncCore(store, '测试');

    expect(out.action).toBe('conflict');
    expect(callsWithMethod(f, 'PATCH')).toBe(0);
    expect(store.getConfig().channels[0].name).toBe('local-edit'); // 跳过，不覆盖
    expect(store.getConfig().gist!.lastResult).toContain('冲突');
  });
});

describe('配置指纹稳定性（J5）', () => {
  it('d) state 变化（跑测试写 results/lastTestAt）不改变指纹', async () => {
    const store = await setupStore([makeChannel({ keys: [mkKey('sk-x')] })], {});
    const before = configHash(store.getConfig());

    store.getState().channels['c1'] = {
      lastTestAt: '2026-01-02T00:00:00.000Z',
      results: {
        'gpt-4o-mini': {
          k1: { cls: 'ok', latencyMs: 12, httpStatus: 200, rawSnippet: 'x', at: '2026-01-02T00:00:00.000Z' },
        },
      },
    };
    await store.saveState();

    expect(configHash(store.getConfig())).toBe(before);
  });

  it('e) 改 key 明文 → 指纹变；改易变字段（id/createdAt）→ 指纹不变', () => {
    const withKey = (key: string) => configHash({ channels: [makeChannel({ keys: [mkKey(key)] })], testDefaults: TD });
    expect(withKey('sk-aaa')).not.toBe(withKey('sk-bbb'));

    const a = configHash({ channels: [makeChannel()], testDefaults: TD });
    const b = configHash({
      channels: [makeChannel({ id: 'other-id', createdAt: '2030-01-01T00:00:00.000Z' })],
      testDefaults: TD,
    });
    expect(a).toBe(b);
  });
});
