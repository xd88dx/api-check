import { describe, it, expect } from 'vitest';
import { buildExportPayload } from './routes.js';
import type { Channel, ChannelsState } from './store.js';

function makeChannel(): Channel {
  return {
    id: 'c1',
    name: '测试渠道',
    baseUrl: 'https://example.com/v1',
    insecure: false,
    enabled: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    keys: [
      {
        id: 'k1',
        label: 'key-1',
        key: 'sk-real-secret-must-not-leak',
        enabled: true,
        concurrency: 1,
        createdAt: '2026-11-01T00:00:00.000Z',
      },
    ],
    models: [
      { id: 'm-selected', selected: true, source: 'catalog', contextHint: '8k' },
      { id: 'm-unselected', selected: false, source: 'manual' },
    ],
  };
}

function stateWithResults(): ChannelsState['channels']['c1'] {
  return {
    lastTestAt: '2026-11-02T00:00:00.000Z',
    results: {
      'm-selected': {
        k1: { cls: 'ok', latencyMs: 123, httpStatus: 200, rawSnippet: 'raw', at: '2026-11-02T00:00:01.000Z' },
      },
    },
  };
}

describe('buildExportPayload', () => {
  it('不含任何 key 字段（明文/掩码/id 均不出现）', () => {
    const ch = makeChannel();
    const payload = buildExportPayload(ch, stateWithResults());
    const text = JSON.stringify(payload);
    // 明文 key 不出现在导出内容中
    expect(text).not.toContain('sk-real-secret-must-not-leak');
    // 连 mask 形态（前5…后5）也不出现
    expect(text).not.toContain('sk-re');
    // key id 不出现（结果键已映射为 label）
    expect(text).not.toContain('k1');
    // channel.keys 字段不存在
    expect(payload.channel).not.toHaveProperty('keys');
    expect(payload.channel.keyCount).toBe(1);
  });

  it('结果键映射为密钥 label 而非 id', () => {
    const payload = buildExportPayload(makeChannel(), stateWithResults());
    expect(payload.results?.['m-selected']).toHaveProperty('key-1');
    expect(payload.results?.['m-selected']['key-1'].cls).toBe('ok');
  });

  it('仅导出勾选模型', () => {
    const payload = buildExportPayload(makeChannel(), stateWithResults());
    expect(payload.selectedModels.map((m) => m.id)).toEqual(['m-selected']);
    expect(payload.selectedModels[0].contextHint).toBe('8k');
  });

  it('无 state 时结果为 null', () => {
    const payload = buildExportPayload(makeChannel(), undefined);
    expect(payload.results).toBeNull();
    expect(payload.lastTestAt).toBeNull();
  });
});
