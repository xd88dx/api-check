// 四协议探测（SPEC §4）
// URL 归一化：去掉尾部 / ；「去尾 /v1」只剥结尾的 /v1（大小写敏感、仅一次）。
// OpenAI/Responses 不剥 /v1；Anthropic/Gemini 剥。
import { request } from './httpclient.js';
import { classify, snippet } from './classify.js';
import type { ProbeResult } from './store.js';

export type Protocol = 'openai' | 'responses' | 'anthropic' | 'gemini';

const PROTOCOLS: Protocol[] = ['openai', 'responses', 'anthropic', 'gemini'];

/** 去掉尾部的 /（仅一次） */
function stripTrailingSlash(base: string): string {
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

/** 只剥结尾的 /v1（大小写敏感、仅一次） */
function stripTrailingV1(base: string): string {
  return base.endsWith('/v1') ? base.slice(0, -3) : base;
}

/** 按 SPEC §4 表拼接各协议探测 URL */
export function buildProbeUrl(baseUrl: string, proto: Protocol): string {
  const clean = stripTrailingSlash(baseUrl);
  switch (proto) {
    case 'openai':
      return `${clean}/chat/completions`;
    case 'responses':
      return `${clean}/responses`;
    case 'anthropic':
      return `${stripTrailingV1(clean)}/v1/messages`;
    case 'gemini':
      return `${stripTrailingV1(clean)}/v1beta/models`;
  }
}

const FALLBACK_MODEL = 'gpt-4o-mini';

interface ProbeOpts {
  baseUrl: string;
  apiKey: string;
  insecure?: boolean;
  timeoutMs?: number;
  model?: string;
}

async function probeOne(proto: Protocol, opts: ProbeOpts): Promise<ProbeResult> {
  const { baseUrl, apiKey, insecure = false, timeoutMs = 60000, model = FALLBACK_MODEL } = opts;
  const urlStr = buildProbeUrl(baseUrl, proto);
  const url = new URL(urlStr);
  const startedAt = Date.now();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: string | undefined;
  let okMarkers: string[] = [];

  switch (proto) {
    case 'openai': {
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      });
      okMarkers = ['choices'];
      const res = await request({ url, method: 'POST', headers, body, timeoutMs, insecure });
      const latency = Date.now() - startedAt;
      return {
        url: urlStr,
        cls: classify({ httpStatus: res.status, body: snippet(res.body), timedOut: res.timedOut, okMarkers }),
        latencyMs: latency,
        httpStatus: res.status,
        rawSnippet: snippet(res.body),
        at: new Date().toISOString(),
      };
    }
    case 'responses': {
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = JSON.stringify({ model, input: 'ping', max_output_tokens: 16 });
      okMarkers = ['output_text'];
      const res = await request({ url, method: 'POST', headers, body, timeoutMs, insecure });
      const latency = Date.now() - startedAt;
      return {
        url: urlStr,
        cls: classify({ httpStatus: res.status, body: snippet(res.body), timedOut: res.timedOut, okMarkers }),
        latencyMs: latency,
        httpStatus: res.status,
        rawSnippet: snippet(res.body),
        at: new Date().toISOString(),
      };
    }
    case 'anthropic': {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
      okMarkers = ['content'];
      const res = await request({ url, method: 'POST', headers, body, timeoutMs, insecure });
      const latency = Date.now() - startedAt;
      return {
        url: urlStr,
        cls: classify({ httpStatus: res.status, body: snippet(res.body), timedOut: res.timedOut, okMarkers }),
        latencyMs: latency,
        httpStatus: res.status,
        rawSnippet: snippet(res.body),
        at: new Date().toISOString(),
      };
    }
    case 'gemini': {
      // GET ?key= 或头 x-goog-api-key，这里走 query
      url.searchParams.set('key', apiKey);
      okMarkers = ['models'];
      const res = await request({ url, method: 'GET', headers, timeoutMs, insecure });
      const latency = Date.now() - startedAt;
      return {
        url: urlStr, // 探测行展示原始 URL（?key= 不出现在展示中，避免泄漏）
        cls: classify({ httpStatus: res.status, body: snippet(res.body), timedOut: res.timedOut, okMarkers }),
        latencyMs: latency,
        httpStatus: res.status,
        rawSnippet: snippet(res.body),
        at: new Date().toISOString(),
      };
    }
  }
}

/** 对单渠道执行四协议探测（取第一个启用的 key）。结果按协议名记录。 */
export interface ProbeAllOpts {
  baseUrl: string;
  apiKey: string;
  insecure?: boolean;
  timeoutMs?: number;
}

export async function probeAll(opts: ProbeAllOpts): Promise<Record<string, ProbeResult>> {
  const result: Record<string, ProbeResult> = {};
  for (const proto of PROTOCOLS) {
    // 任一协议失败（异常）不阻断其余；错误计入 error
    try {
      result[proto] = await probeOne(proto, opts);
    } catch {
      const urlStr = buildProbeUrl(opts.baseUrl, proto);
      result[proto] = {
        url: urlStr,
        cls: 'error',
        latencyMs: 0,
        httpStatus: null,
        rawSnippet: '',
        at: new Date().toISOString(),
      };
    }
  }
  return result;
}

/** 取探测 ok 的第一个协议（顺序 openai → responses → anthropic → gemini） */
export function firstOkProtocol(probe: Record<string, ProbeResult> | undefined): Protocol | null {
  if (!probe) return null;
  for (const proto of PROTOCOLS) {
    if (probe[proto]?.cls === 'ok') return proto;
  }
  return null;
}
