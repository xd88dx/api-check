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

/** 按 SPEC §4 表拼接各协议探测 URL（不含 key，可直接展示） */
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

/** 单协议最小请求规格（探测与矩阵共用） */
export interface ProbeRequestSpec {
  displayUrl: string; // 展示用，不含 key
  fetchUrl: URL; // 实际请求 URL（gemini 含 ?key=）
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  okMarkers: string[];
}

export function buildProbeRequest(
  proto: Protocol,
  baseUrl: string,
  apiKey: string,
  model = FALLBACK_MODEL,
): ProbeRequestSpec {
  const displayUrl = buildProbeUrl(baseUrl, proto);
  const fetchUrl = new URL(displayUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: string | undefined;
  let okMarkers: string[] = [];

  switch (proto) {
    case 'openai':
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      });
      okMarkers = ['choices'];
      break;
    case 'responses':
      headers['Authorization'] = `Bearer ${apiKey}`;
      body = JSON.stringify({ model, input: 'ping', max_output_tokens: 16 });
      okMarkers = ['output_text'];
      break;
    case 'anthropic':
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] });
      okMarkers = ['content'];
      break;
    case 'gemini':
      fetchUrl.searchParams.set('key', apiKey);
      okMarkers = ['models'];
      break;
  }
  return { displayUrl, fetchUrl, method: proto === 'gemini' ? 'GET' : 'POST', headers, body, okMarkers };
}

interface ProbeOpts {
  baseUrl: string;
  apiKey: string;
  insecure?: boolean;
  timeoutMs?: number;
  model?: string;
}

async function probeOne(proto: Protocol, opts: ProbeOpts): Promise<ProbeResult> {
  const { baseUrl, apiKey, insecure = false, timeoutMs = 60000, model = FALLBACK_MODEL } = opts;
  const spec = buildProbeRequest(proto, baseUrl, apiKey, model);
  const startedAt = Date.now();
  const res = await request({
    url: spec.fetchUrl,
    method: spec.method,
    headers: spec.headers,
    body: spec.body,
    timeoutMs,
    insecure,
  });
  const latency = Date.now() - startedAt;
  return {
    url: spec.displayUrl,
    cls: classify({ httpStatus: res.status, body: res.body, timedOut: res.timedOut, okMarkers: spec.okMarkers }),
    latencyMs: latency,
    httpStatus: res.status,
    rawSnippet: snippet(res.body),
    at: new Date().toISOString(),
  };
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
    try {
      result[proto] = await probeOne(proto, opts);
    } catch {
      result[proto] = {
        url: buildProbeUrl(opts.baseUrl, proto),
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
