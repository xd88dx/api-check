import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'api-check-store-'));
});

afterEach?.(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('Store', () => {
  it('init 后默认 config 为空渠道 + 默认 testDefaults', async () => {
    const s = new Store(tmpDir);
    await s.init();
    expect(s.getConfig().channels).toEqual([]);
    expect(s.getConfig().testDefaults).toEqual({ intervalMs: 1000, timeoutMs: 60000 });
  });

  it('保存后再 init 能完整恢复', async () => {
    const s = new Store(tmpDir);
    await s.init();
    s.getConfig().channels.push({
      id: 'c1',
      name: 'test',
      baseUrl: 'https://example.com/v1',
      insecure: false,
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      keys: [
        {
          id: 'k1',
          label: 'main',
          key: 'sk-test-abcdefghijklmnop',
          enabled: true,
          concurrency: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      models: [{ id: 'gpt-4o-mini', selected: true, source: 'manual' }],
    });
    await s.saveConfig();

    const s2 = new Store(tmpDir);
    await s2.init();
    expect(s2.getConfig().channels).toHaveLength(1);
    expect(s2.getConfig().channels[0].keys[0].key).toBe(
      'sk-test-abcdefghijklmnop',
    );
  });

  it('并发两次 saveConfig 串行化，不产生半截文件', async () => {
    const s = new Store(tmpDir);
    await s.init();

    const big1 = 'a'.repeat(50_000);
    const big2 = 'b'.repeat(50_000);
    s.getConfig().channels.push({
      id: 'c1', name: big1, baseUrl: 'https://x.com/v1', insecure: false,
      enabled: true, createdAt: new Date().toISOString(), keys: [], models: [],
    });
    const p1 = s.saveConfig();
    s.getConfig().channels[0].name = big2;
    const p2 = s.saveConfig();
    await Promise.all([p1, p2]);

    const raw = await readFile(join(tmpDir, 'channels-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.channels[0].name).toBe(big2);
    // 没有半截：能被 JSON.parse 通过即完整
  });

  it('saveState 落盘 state 文件', async () => {
    const s = new Store(tmpDir);
    await s.init();
    s.getState().channels['c1'] = { catalogAt: '2026-01-01T00:00:00.000Z' };
    await s.saveState();
    const s2 = new Store(tmpDir);
    await s2.init();
    expect(s2.getState().channels['c1']?.catalogAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('data 目录下无 .tmp 残留', async () => {
    const s = new Store(tmpDir);
    await s.init();
    await s.saveConfig();
    await s.saveState();
    const names = await readdir(tmpDir);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(names).toContain('channels-config.json');
    expect(names).toContain('channels-state.json');
  });
});
