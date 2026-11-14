// probe.ts 测试：C1 五分类 + C2 URL 归一化（ACCEPTANCE）
import { describe, it, expect, afterAll } from 'vitest';
import { buildProbeUrl, probeAll, firstOkProtocol, type Protocol } from './probe.js';
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

// ---------- C2：URL 归一化 ----------

describe('buildProbeUrl（C2 三形态）', () => {
  const forms = ['https://x.com/v1', 'https://x.com/v1/', 'https://x.com'];
  const expectTable: Record<Protocol, string[]> = {
    openai: forms.map((f) => `${f.replace(/\/$/, '')}/chat/completions`),
    responses: forms.map((f) => `${f.replace(/\/$/, '')}/responses`),
    anthropic: forms.map(() => 'https://x.com/v1/messages'),
    gemini: forms.map(() => 'https://x.com/v1beta/models'),
  };
  for (let i = 0; i < forms.length; i++) {
    it(`baseUrl=${forms[i]}`, () => {
      expect(buildProbeUrl(forms[i], 'openai')).toBe(expectTable.openai[i]);
      expect(buildProbeUrl(forms[i], 'responses')).toBe(expectTable.responses[i]);
      expect(buildProbeUrl(forms[i], 'anthropic')).toBe(expectTable.anthropic[i]);
      expect(buildProbeUrl(forms[i], 'gemini')).toBe(expectTable.gemini[i]);
    });
  }
  it('仅剥一次 /v1：https://x.com/v1/v1 → anthropic https://x.com/v1/v1/messages', () => {
    expect(buildProbeUrl('https://x.com/v1/v1', 'anthropic')).toBe('https://x.com/v1/v1/messages');
  });
  it('大小写敏感：/V1 不剥', () => {
    expect(buildProbeUrl('https://x.com/V1', 'anthropic')).toBe('https://x.com/V1/v1/messages');
  });
});

// ---------- C1：五分类 ----------

describe('probeAll 分类（C1 五分类各一例）', () => {
  it('2xx 含回复迹象 → ok', async () => {
    const m = await start((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    });
    const r = await probeAll({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 3000 });
    expect(r.openai.cls).toBe('ok');
    expect(r.openai.httpStatus).toBe(200);
    expect(r.openai.url).toBe(`${m.baseUrl}/v1/chat/completions`);
  });

  it('404 → unsupported', async () => {
    const m = await start((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'MOCK_UPSTREAM_404_NOT_FOUND' } }));
    });
    const r = await probeAll({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 3000 });
    expect(r.openai.cls).toBe('unsupported');
    // C3：rawSnippet 透传上游原文特征串，未改写
    expect(r.openai.rawSnippet).toContain('MOCK_UPSTREAM_404_NOT_FOUND');
  });

  it('401 → auth', async () => {
    const m = await start((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'MOCK_UPSTREAM_INVALID_KEY' } }));
    });
    const r = await probeAll({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 3000 });
    expect(r.openai.cls).toBe('auth');
    expect(r.openai.rawSnippet).toContain('MOCK_UPSTREAM_INVALID_KEY');
  });

  it('429 → rate_limited', async () => {
    const m = await start((req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'MOCK_UPSTREAM_RATE_LIMIT' } }));
    });
    const r = await probeAll({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 3000 });
    expect(r.openai.cls).toBe('rate_limited');
  });

  it('挂住（不响应）→ timeout（短超时加速）', async () => {
    const m = await start(() => {
      /* 永不响应 */
    });
    const t0 = Date.now();
    const r = await probeAll({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 800 });
    const elapsed = Date.now() - t0;
    expect(r.openai.cls).toBe('timeout');
    expect(elapsed).toBeLessThan(5000); // 静默超时生效，不是等满长时
  });

  it('5xx → error', async () => {
    const m = await start((req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('MOCK_UPSTREAM_INTERNAL_ERROR');
    });
    const r = await probeAll({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 3000 });
    expect(r.openai.cls).toBe('error');
  });

  it('请求形态核对：OpenAI POST Bearer / Anthropic POST x-api-key+版本头 / Gemini GET ?key', async () => {
    const m = await start((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url?.includes('/v1beta/models')) {
        res.end(JSON.stringify({ models: [{ name: 'models/gemini-mock' }] }));
      } else if (req.url?.endsWith('/v1/messages')) {
        res.end(JSON.stringify({ content: [{ text: 'pong' }] }));
      } else {
        res.end(JSON.stringify({ choices: [] }));
      }
    });
    await probeAll({ baseUrl: `${m.baseUrl}/v1`, apiKey: KEY, timeoutMs: 3000 });
    const post = m.requests.find((r) => r.url.endsWith('/chat/completions'));
    expect(post?.method).toBe('POST');
    expect(post?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({
      model: 'gpt-4o-mini',
      max_tokens: 1,
      stream: false,
    });
    const anth = m.requests.find((r) => r.url.endsWith('/v1/messages'));
    expect(anth?.headers['x-api-key']).toBe(KEY);
    expect(anth?.headers['anthropic-version']).toBe('2023-06-01');
    const gem = m.requests.find((r) => r.url.includes('/v1beta/models'));
    expect(gem?.method).toBe('GET');
    expect(gem?.url).toContain(`key=${KEY}`);
  });
});

describe('firstOkProtocol', () => {
  it('按 openai → responses → anthropic → gemini 顺序取第一个 ok', () => {
    const probe = {
      openai: { url: '', cls: 'unsupported' as const, latencyMs: 0, httpStatus: 404, rawSnippet: '', at: '' },
      responses: { url: '', cls: 'ok' as const, latencyMs: 1, httpStatus: 200, rawSnippet: '', at: '' },
      anthropic: { url: '', cls: 'ok' as const, latencyMs: 1, httpStatus: 200, rawSnippet: '', at: '' },
      gemini: { url: '', cls: 'auth' as const, latencyMs: 1, httpStatus: 401, rawSnippet: '', at: '' },
    };
    expect(firstOkProtocol(probe)).toBe('responses');
    expect(firstOkProtocol(undefined)).toBeNull();
  });
});
