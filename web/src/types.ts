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

export interface CellResult {
  cls: Cls;
  latencyMs: number;
  httpStatus: number | null;
  rawSnippet: string;
  at: string;
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
