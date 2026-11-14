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

/** 候选模型上限与单候选超时上限（避免 3×60s 等待） */
const MAX_CANDIDATES = 3;
const CANDIDATE_TIMEOUT_CAP_MS = 30000;

/** 「模型/上游侧失败」才换候选重试：timeout 或 5xx 系 error；端点级 404/401/429 不换 */
function shouldSwitchCandidate(r: ProbeResult): boolean {
  if (r.cls === 'timeout') return true;
  return r.cls === 'error' && r.httpStatus !== null && r.httpStatus >= 500;
}

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
    model,
  };
}

/** 对单渠道执行四协议探测（取第一个启用的 key）。结果按协议名记录。 */
export interface ProbeAllOpts {
  baseUrl: string;
  apiKey: string;
  insecure?: boolean;
  timeoutMs?: number;
  model?: string | string[]; // 目录非空时传候选模型（string 单候选或 string[] 最多取前 3 个），否则用占位模型
}

export async function probeAll(opts: ProbeAllOpts): Promise<Record<string, ProbeResult>> {
  const result: Record<string, ProbeResult> = {};
  // 候选模型：目录非空时按目录顺序最多取 3 个；否则占位单候选
  const rawCandidates = opts.model
    ? Array.isArray(opts.model) ? opts.model : [opts.model]
    : [FALLBACK_MODEL];
  const candidates: string[] = rawCandidates.slice(0, MAX_CANDIDATES);
  const hasCatalog = !!opts.model;
  // 单候选超时收紧（仅目录非空时），避免 3×60s 等待
  const perTimeout = hasCatalog
    ? Math.min(opts.timeoutMs ?? 60000, CANDIDATE_TIMEOUT_CAP_MS)
    : (opts.timeoutMs ?? 60000);
  for (const proto of PROTOCOLS) {
    let last: ProbeResult | null = null;
    for (const model of candidates) {
      try {
        last = await probeOne(proto, { ...opts, model, timeoutMs: perTimeout });
      } catch {
        last = {
          url: buildProbeUrl(opts.baseUrl, proto),
          cls: 'error',
          latencyMs: 0,
          httpStatus: null,
          rawSnippet: '',
          at: new Date().toISOString(),
          model,
        };
      }
      if (!shouldSwitchCandidate(last)) break; // 非 timeout/error → 定案
    }
    // 全部候选失败：cls 取最后一个候选结果，rawSnippet 前缀注明
    if (last && shouldSwitchCandidate(last) && candidates.length > 1) {
      last = {
        ...last,
        rawSnippet: `candidates:${candidates.join(',')} all failed\n${last.rawSnippet}`,
      };
    }
    result[proto] = last!;
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

/** 主协议判定（矩阵前置）：探测存在 ok 协议 → 取第一个；无 ok 但渠道目录非空 → 兜底 openai；否则 null（拒绝启动）。 */
export function pickMainProtocol(
  probe: Record<string, ProbeResult> | undefined,
  hasCatalog: boolean,
): Protocol | null {
  const ok = firstOkProtocol(probe);
  if (ok) return ok;
  return hasCatalog ? 'openai' : null;
}
