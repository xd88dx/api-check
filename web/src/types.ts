export interface PublicKey {
  id: string;
  label: string;
  key: string; // 已掩码形态
  enabled: boolean;
  concurrency: number;
  createdAt: string;
}

export type Cls = 'ok' | 'unsupported' | 'auth' | 'rate_limited' | 'timeout' | 'error';

export interface PublicProbeResult {
  url: string;
  cls: Cls;
  latencyMs: number;
  httpStatus: number | null;
  rawSnippet: string;
  at: string;
  model?: string; // 探测实际命中的模型（目录非空时显示）
}

export interface ChannelStatePublic {
  probe?: Record<string, PublicProbeResult>;
  catalogAt?: string;
  lastTestAt?: string;
  results?: Record<string, Record<string, CellResult>>;
  task?: TaskSnapshotPublic;
}

export interface RepeatDetail {
  cls: Cls;
  latencyMs: number;
  httpStatus: number | null;
  rawSnippet: string;
  at: string;
}

export interface CellResult {
  cls: Cls;
  latencyMs: number;
  httpStatus: number | null;
  rawSnippet: string;
  at: string;
  /** M7 §14：每次尝试明细（成功即停，长度 ≤ repeat）。主字段=最后一次尝试结果。 */
  repeats?: RepeatDetail[];
}

export interface TaskSnapshotPublic {
  type: 'probe' | 'catalog' | 'test';
  running: boolean;
  stopped: boolean;
  current?: { modelId: string; keyId: string; index: number };
  total: number;
}

export interface PublicModel {
  id: string;
  selected: boolean;
  source: 'catalog' | 'manual';
  contextHint?: string;
}

export interface PublicChannel {
  id: string;
  name: string;
  baseUrl: string;
  insecure: boolean;
  enabled: boolean;
  createdAt: string;
  keys: PublicKey[];
  models: PublicModel[];
  state?: ChannelStatePublic;
}

export interface TaskState {
  type: 'probe' | 'catalog' | 'test';
  running: boolean;
  stopped: boolean;
  currentIndex: number;
  total: number;
  current?: { modelId: string; keyId: string; index: number };
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/** PUT /channels/:id/keys 的请求条目（key 留空 = 不改） */
export interface KeyInput {
  id?: string;
  label: string;
  key?: string;
  enabled: boolean;
  concurrency: number;
}

/** 全局测试默认值（M5：含 repeat） */
export interface TestDefaults {
  intervalMs: number;
  timeoutMs: number;
  repeat: number;
}

/** M8：Gist 同步状态（GET /api/gist；token 只回掩码） */
export interface GistStatus {
  configured: boolean;
  tokenMasked: string;
  gistId: string;
  syncedAt: number | null;
  lastResult: string;
}
