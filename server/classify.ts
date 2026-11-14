// 错误分类全局唯一实现点（SPEC §6，探测与矩阵共用）
// 硬性规则：只看 HTTP 状态码与响应体片段，禁止对 message 文案做关键词猜测；
// 例外仅限 §6 表明确项（Gemini 400 endpoint not found）。
import type { Cls } from './store.js';

/** 2xx 判 ok 时，响应体需含的「模型回复/模型列表迹象」标记（按协议/请求形态传入） */
export interface ClassifyInput {
  httpStatus: number | null;
  body: string; // rawSnippet（上游原文片段）
  timedOut: boolean;
  okMarkers?: string[]; // 如 ['choices'] / ['models']
}

export function classify(input: ClassifyInput): Cls {
  const { httpStatus, body, timedOut, okMarkers = [] } = input;
  // 静默超时优先：未拿到完整响应，状态未定
  if (timedOut) return 'timeout';
  if (httpStatus === null) return 'error'; // 网络层失败/解析异常
  if (httpStatus === 404) return 'unsupported';
  if (httpStatus === 401 || httpStatus === 403) return 'auth';
  if (httpStatus === 429) return 'rate_limited';
  // §6 明确项：Gemini 400 且 body 明示 endpoint not found → unsupported
  if (httpStatus === 400 && /endpoint not found/i.test(body)) return 'unsupported';
  if (httpStatus >= 200 && httpStatus < 300) {
    if (hasOkMarker(body, okMarkers)) return 'ok';
    return 'error'; // 2xx 但解析失败/缺迹象
  }
  return 'error'; // 5xx 及其余
}

/** ok 判定：响应体为 JSON 且含传入迹象标记（无标记时仅要求可解析为对象/数组） */
export function hasOkMarker(body: string, okMarkers: string[]): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  if (okMarkers.length === 0) return true;
  return okMarkers.some((m) => m in parsed);
}

/** rawSnippet：上游响应原文前 300 字符，原样保存，绝不改写 */
export function snippet(body: string): string {
  return body.slice(0, 300);
}
