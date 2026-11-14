// 模型目录拉取（SPEC §7）
// 优先用探测 ok 的协议拉目录；多协议 ok 时按 openai → anthropic → gemini 取第一个。
// 失败/空目录明确报错并保留现有目录，绝不清空。
import { URL } from 'node:url';
import { request } from './httpclient.js';
import { classify } from './classify.js';
import { firstOkProtocol, buildProbeUrl, type Protocol } from './probe.js';
import type { ProbeResult, ChannelModel } from './store.js';

export interface CatalogModel {
  id: string;
  contextHint?: string;
}

export interface CatalogFetchResult {
  ok: boolean;
  models: CatalogModel[]; // ok=true 时为拉到的模型；空数组需区分「空目录」语义
  error?: string; // ok=false 时的错误说明
}

/** 构造各协议的目录 URL */
export function buildCatalogUrl(baseUrl: string, proto: Protocol): string {
  // 直接复用探测 URL 归一化，再替换路径段
  const probeUrl = buildProbeUrl(baseUrl, proto);
  const u = new URL(probeUrl);
  switch (proto) {
    case 'openai':
      u.pathname = u.pathname.replace(/\/chat\/completions$/, '/models');
      break;
    case 'responses':
      u.pathname = u.pathname.replace(/\/responses$/, '/models');
      break;
    case 'anthropic':
      u.pathname = u.pathname.replace(/\/messages$/, '/models');
      break;
    case 'gemini':
      u.pathname = u.pathname.replace(/\/v1beta\/models$/, '/v1beta/models');
      break;
  }
  return u.toString();
}

interface FetchOpts {
  baseUrl: string;
  apiKey: string;
  insecure?: boolean;
  timeoutMs?: number;
}

async function fetchOpenAI(urlStr: string, opts: FetchOpts): Promise<CatalogFetchResult> {
  const url = new URL(urlStr);
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.apiKey}` };
  const res = await request({ url, method: 'GET', headers, timeoutMs: opts.timeoutMs ?? 60000, insecure: opts.insecure });
  const cls = classify({ httpStatus: res.status, body: res.body, timedOut: res.timedOut, okMarkers: ['data'] });
  if (cls !== 'ok') {
    return { ok: false, models: [], error: `${cls}:${res.status ?? 'net'}` };
  }
  try {
    const data = JSON.parse(res.body) as { data?: Array<{ id: string; context_window?: number }> };
    const list = data.data ?? [];
    if (list.length === 0) return { ok: false, models: [], error: 'empty_catalog' };
    return {
      ok: true,
      models: list.map((m) => ({ id: m.id, ...(m.context_window ? { contextHint: String(m.context_window) } : {}) })),
    };
  } catch {
    return { ok: false, models: [], error: 'parse_failed' };
  }
}

async function fetchAnthropic(urlStr: string, opts: FetchOpts): Promise<CatalogFetchResult> {
  const url = new URL(urlStr);
  const headers: Record<string, string> = {
    'x-api-key': opts.apiKey,
    'anthropic-version': '2023-06-01',
  };
  const res = await request({ url, method: 'GET', headers, timeoutMs: opts.timeoutMs ?? 60000, insecure: opts.insecure });
  const cls = classify({ httpStatus: res.status, body: res.body, timedOut: res.timedOut, okMarkers: ['data'] });
  if (cls !== 'ok') {
    return { ok: false, models: [], error: `${cls}:${res.status ?? 'net'}` };
  }
  try {
    const data = JSON.parse(res.body) as { data?: Array<{ id: string }> };
    const list = data.data ?? [];
    if (list.length === 0) return { ok: false, models: [], error: 'empty_catalog' };
    return { ok: true, models: list.map((m) => ({ id: m.id })) };
  } catch {
    return { ok: false, models: [], error: 'parse_failed' };
  }
}

async function fetchGemini(urlStr: string, opts: FetchOpts): Promise<CatalogFetchResult> {
  const url = new URL(urlStr);
  url.searchParams.set('pageSize', '1000');
  url.searchParams.set('key', opts.apiKey);
  const res = await request({ url, method: 'GET', headers: {}, timeoutMs: opts.timeoutMs ?? 60000, insecure: opts.insecure });
  const cls = classify({ httpStatus: res.status, body: res.body, timedOut: res.timedOut, okMarkers: ['models'] });
  if (cls !== 'ok') {
    return { ok: false, models: [], error: `${cls}:${res.status ?? 'net'}` };
  }
  try {
    const data = JSON.parse(res.body) as {
      models?: Array<{ name: string; supportedGenerationMethods?: string[] }>;
    };
    const list = data.models ?? [];
    const filtered = list.filter(
      (m) => (m.supportedGenerationMethods ?? []).includes('generateContent'),
    );
    if (filtered.length === 0) return { ok: false, models: [], error: 'empty_catalog' };
    return {
      ok: true,
      models: filtered.map((m) => ({ id: m.name.replace(/^models\//, '') })),
    };
  } catch {
    return { ok: false, models: [], error: 'parse_failed' };
  }
}

const FETCHERS: Record<Protocol, (url: string, opts: FetchOpts) => Promise<CatalogFetchResult>> = {
  openai: fetchOpenAI,
  responses: fetchOpenAI, // responses 与 openai 共用 /models
  anthropic: fetchAnthropic,
  gemini: fetchGemini,
};

interface CatalogOpts {
  baseUrl: string;
  apiKey: string;
  insecure?: boolean;
  timeoutMs?: number;
  probe?: Record<string, ProbeResult>;
}

/** 决定用哪个协议拉目录：优先探测 ok 的协议（openai → anthropic → gemini 顺序；responses 归入 openai 处理） */
export function pickCatalogProtocol(probe: Record<string, ProbeResult> | undefined): Protocol {
  const ok = firstOkProtocol(probe);
  if (ok) return ok;
  return 'openai'; // 无 ok 时退回 openai，由分类报错反馈
}

export async function fetchCatalog(opts: CatalogOpts): Promise<CatalogFetchResult> {
  const proto = pickCatalogProtocol(opts.probe);
  const urlStr = buildCatalogUrl(opts.baseUrl, proto);
  return FETCHERS[proto](urlStr, opts);
}

/** 将拉到的目录合并到现有 models：
 * - manual 模型永不删除；
 * - 已勾选的 catalog 模型即使已从上游消失也保留（只增不删已勾选项）；
 * - 未勾选且已从上游消失的 catalog 模型移除；
 * - 新目录项默认不勾选。 */
export function mergeCatalog(
  existing: ChannelModel[],
  fetched: CatalogModel[],
): ChannelModel[] {
  const fetchedIds = new Set(fetched.map((f) => f.id));
  const result: ChannelModel[] = [];
  const staleSelected: ChannelModel[] = [];
  for (const m of existing) {
    if (m.source === 'manual') {
      result.push(m); // manual 永不删
    } else if (m.selected && !fetchedIds.has(m.id)) {
      staleSelected.push(m); // 已勾选但上游已无 → 保留
    }
    // 未勾选且上游已无的 catalog 模型 → 移除（下方按新目录重排）
  }
  const existingById = new Map(existing.map((m) => [m.id, m]));
  for (const f of fetched) {
    const old = existingById.get(f.id);
    result.push({
      id: f.id,
      selected: old ? old.selected : false,
      source: 'catalog',
      ...(f.contextHint ? { contextHint: f.contextHint } : {}),
    });
  }
  result.push(...staleSelected);
  return result;
}
