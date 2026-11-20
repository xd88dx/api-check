import { mkdir, readFile, readdir, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// ---------- 数据模型（SPEC §5） ----------

export interface ChannelKey {
  id: string;
  label: string;
  key: string; // 明文，只存在于 config 文件与内存
  enabled: boolean;
  concurrency: number; // 默认 1
  createdAt: string;
}

export type ModelSource = 'catalog' | 'manual';

export interface ChannelModel {
  id: string;
  selected: boolean;
  source: ModelSource;
  contextHint?: string;
  /** 最近一次目录拉取中已不存在(仅对保留的已勾选模型置位) */
  stale?: boolean;
}

export interface Channel {
  id: string;
  name: string;
  baseUrl: string;
  insecure: boolean;
  enabled: boolean;
  createdAt: string;
  keys: ChannelKey[];
  models: ChannelModel[];
}

export interface TestDefaults {
  intervalMs: number; // 默认 1000
  timeoutMs: number; // 默认 60000
  repeat: number; // M7 §14：失败重试次数（总尝试上限）1–10，默认 1
}

// M8 §15.2：Gist 同步配置；密钥明文随配置态同步（私密 Gist，威胁模型同 web-cron）
export interface GistConfig {
  token: string;
  gistId: string;
  baselineHash: string;
  syncedAt: number | null;
  lastResult: string;
}

export function defaultGistConfig(): GistConfig {
  return { token: '', gistId: '', baselineHash: '', syncedAt: null, lastResult: '' };
}

export function normalizeGistConfig(raw: unknown): GistConfig {
  const g = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    token: String(g.token ?? ''),
    gistId: String(g.gistId ?? ''),
    baselineHash: String(g.baselineHash ?? ''),
    syncedAt: typeof g.syncedAt === 'number' ? g.syncedAt : null,
    lastResult: String(g.lastResult ?? ''),
  };
}

export interface ChannelsConfig {
  channels: Channel[];
  testDefaults: TestDefaults;
  gist?: GistConfig;
}

export type Cls = 'ok' | 'unsupported' | 'auth' | 'rate_limited' | 'timeout' | 'error';

export interface ProbeResult {
  url: string;
  cls: Cls;
  latencyMs: number;
  httpStatus: number | null;
  rawSnippet: string;
  at: string;
  model?: string; // 探测实际命中的模型（目录非空时记录）
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

export interface TaskSnapshot {
  type: 'probe' | 'catalog' | 'test';
  running: boolean;
  stopped: boolean;
  current?: { modelId: string; keyId: string; index: number };
  total: number;
}

export interface ChannelState {
  probe?: Record<string, ProbeResult>;
  catalogAt?: string;
  lastTestAt?: string;
  results?: Record<string, Record<string, CellResult>>;
  task?: TaskSnapshot;
}

export interface ChannelsState {
  channels: Record<string, ChannelState>;
}

// ---------- 默认值 ----------

/** repeat 合法范围 1–10，越界/缺失回落默认 1 */
export function clampRepeat(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10 ? v : 1;
}

export function defaultConfig(): ChannelsConfig {
  return {
    channels: [],
    testDefaults: { intervalMs: 1000, timeoutMs: 60000, repeat: 1 },
    gist: defaultGistConfig(),
  };
}

export function defaultState(): ChannelsState {
  return { channels: {} };
}

// ---------- 原子写 ----------

/** tmp + rename，写前 fsync，串行队列防并发交错 */
async function atomicWriteFile(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.write(content, null, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}

/** 清理上次崩溃可能遗留的 .tmp 文件 */
async function cleanTmpFiles(dir: string): Promise<void> {
  try {
    const names = await readdir(dir);
    await Promise.all(
      names.filter((n) => n.endsWith('.tmp')).map((n) => unlink(join(dir, n))),
    );
  } catch {
    // 目录不存在则无需清理
  }
}

// ---------- Store ----------

export class Store {
  readonly dataDir: string;
  private configPath: string;
  private statePath: string;
  private config: ChannelsConfig;
  private state: ChannelsState;
  private configQueue: Promise<void> = Promise.resolve();
  private stateQueue: Promise<void> = Promise.resolve();

  constructor(dataDir = 'data') {
    this.dataDir = dataDir;
    this.configPath = join(dataDir, 'channels-config.json');
    this.statePath = join(dataDir, 'channels-state.json');
    this.config = defaultConfig();
    this.state = defaultState();
  }

  /** 启动全量恢复；文件缺失/损坏时用默认值；旧版本字段缺失补默认值 */
  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await cleanTmpFiles(this.dataDir);
    this.config = await this.loadJson(this.configPath, defaultConfig());
    // M5 迁移：旧配置缺 repeat 时补默认值
    const td = this.config.testDefaults ?? defaultConfig().testDefaults;
    this.config.testDefaults = {
      intervalMs: td.intervalMs ?? 1000,
      timeoutMs: td.timeoutMs ?? 60000,
      repeat: clampRepeat(td.repeat),
    };
    // M8：Gist 段缺失/损坏时补默认值
    this.config.gist = normalizeGistConfig(this.config.gist);
    this.state = await this.loadJson(this.statePath, defaultState());
  }

  private async loadJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(file, 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  getConfig(): ChannelsConfig {
    return this.config;
  }

  getState(): ChannelsState {
    return this.state;
  }

  /** 原子落盘 config；并发调用串行化 */
  saveConfig(): Promise<void> {
    const run = () => atomicWriteFile(this.configPath, JSON.stringify(this.config, null, 2));
    const write = this.configQueue.then(run, run);
    this.configQueue = write.catch(() => {});
    return write;
  }

  /** 原子落盘 state；并发调用串行化 */
  saveState(): Promise<void> {
    const run = () => atomicWriteFile(this.statePath, JSON.stringify(this.state, null, 2));
    const write = this.stateQueue.then(run, run);
    this.stateQueue = write.catch(() => {});
    return write;
  }

  async flush(): Promise<void> {
    await this.configQueue;
    await this.stateQueue;
  }
}
