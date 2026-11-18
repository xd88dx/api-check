import { randomUUID } from 'node:crypto';
import { json as expressJson, Router, type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import type { Store, Channel, ChannelKey, ChannelState, ProbeResult } from './store.js';
import { mask } from './mask.js';
import { acquireTask, getTask, runProbe, runCatalog, stopAllTestTasks } from './tasks.js';
import { runTest } from './runner.js';
import { pickMainProtocol } from './probe.js';
import { pushCore, pullCore, syncCore, scheduleMutationSync, normalizeChannel } from './gistsync.js';

// ---------- zod schemas ----------

const baseUrlSchema = z
  .string()
  .min(1)
  .refine((s) => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'baseUrl must be a valid http(s) URL');

const channelCreateSchema = z.object({
  name: z.string().min(1).max(100),
  baseUrl: baseUrlSchema,
  insecure: z.boolean().optional().default(false),
});

const channelUpdateSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    baseUrl: baseUrlSchema.optional(),
    insecure: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'empty body');

const keyEntrySchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1).max(100),
  key: z.string().optional(), // 编辑留空 = 不改
  enabled: z.boolean(),
  concurrency: z.number().int().min(1).max(16).optional().default(1),
});

const keysReplaceSchema = z.object({
  keys: z.array(keyEntrySchema).max(100),
});

const modelsUpdateSchema = z
  .object({
    selected: z.array(z.string().min(1)).optional(),
    addManual: z.array(z.string().min(1)).optional(),
    removeManual: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (v) =>
      v.selected !== undefined || v.addManual !== undefined || v.removeManual !== undefined,
    'empty body',
  );

const channelOrderSchema = z.object({
  ids: z.array(z.string().min(1)).max(1000),
});

const backupChannelSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(100),
  baseUrl: baseUrlSchema,
  insecure: z.boolean().optional(),
  enabled: z.boolean().optional(),
  createdAt: z.string().optional(),
  keys: z
    .array(
      z.object({
        id: z.string().optional(),
        label: z.string().trim().min(1).max(100),
        key: z.string().min(1),
        enabled: z.boolean().optional(),
        concurrency: z.number().int().min(1).max(16).optional(),
        createdAt: z.string().optional(),
      }),
    )
    .max(100)
    .optional()
    .default([]),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        selected: z.boolean().optional(),
        source: z.enum(['catalog', 'manual']).optional(),
        contextHint: z.string().optional(),
      }),
    )
    .optional()
    .default([]),
});

const backupSchema = z.object({
  config: z.object({
    channels: z.array(z.unknown()),
    testDefaults: z
      .object({
        intervalMs: z.number().optional(),
        timeoutMs: z.number().optional(),
        repeat: z.number().optional(),
      })
      .optional(),
  }),
});

const testStartSchema = z.object({
  modelIds: z.array(z.string().min(1)).optional(),
  keyIds: z.array(z.string().min(1)).optional(),
  intervalMs: z.number().int().min(0).max(600000).optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
  repeat: z.number().int().min(1).max(10).optional(),
});

const probeStartSchema = z.object({
  model: z.string().min(1).max(200).optional(),
});

const gistConfigSchema = z
  .object({
    token: z.string().optional(),
    gistId: z.string().max(200).optional(),
  })
  .refine((v) => v.token !== undefined || v.gistId !== undefined, 'empty body');

// ---------- 认证（M8 §15.1，模式照搬 web-cron：密码即凭据，无 session/token） ----------

/** PANEL_PASSWORD 非空时拦截 /api/*（/api/login 放行）；密码即凭据，比对请求头 x-auth */
export function authGuard(password: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!password) {
      next();
      return;
    }
    if (req.path === '/login') {
      next();
      return;
    }
    if (req.headers['x-auth'] !== password) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

// ---------- helpers ----------

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function toPublicChannel(ch: Channel) {
  return {
    id: ch.id,
    name: ch.name,
    baseUrl: ch.baseUrl,
    insecure: ch.insecure,
    enabled: ch.enabled,
    createdAt: ch.createdAt,
    keys: ch.keys.map((k) => ({
      id: k.id,
      label: k.label,
      key: mask(k.key),
      enabled: k.enabled,
      concurrency: k.concurrency,
      createdAt: k.createdAt,
    })),
    models: ch.models,
  };
}

function findChannel(store: Store, id: string): Channel {
  const ch = store.getConfig().channels.find((c) => c.id === id);
  if (!ch) throw new HttpError(404, 'channel not found');
  return ch;
}

/** 导出负载：渠道信息 + 勾选模型清单 + 最近矩阵结果摘要；不含任何 key 字段（连掩码/id 也不出） */
export function buildExportPayload(ch: Channel, st?: ChannelState) {
  const labelById = new Map(ch.keys.map((k) => [k.id, k.label]));
  const results = st?.results
    ? Object.fromEntries(
        Object.entries(st.results).map(([modelId, row]) => [
          modelId,
          Object.fromEntries(
            Object.entries(row).map(([keyId, cell]) => [
              labelById.get(keyId) ?? keyId,
              { cls: cell.cls, latencyMs: cell.latencyMs, httpStatus: cell.httpStatus, at: cell.at },
            ]),
          ),
        ]),
      )
    : null;
  return {
    exportedAt: new Date().toISOString(),
    channel: {
      name: ch.name,
      baseUrl: ch.baseUrl,
      insecure: ch.insecure,
      enabled: ch.enabled,
      createdAt: ch.createdAt,
      keyCount: ch.keys.length,
    },
    selectedModels: ch.models
      .filter((m) => m.selected)
      .map((m) => ({
        id: m.id,
        source: m.source,
        ...(m.contextHint ? { contextHint: m.contextHint } : {}),
      })),
    lastTestAt: st?.lastTestAt ?? null,
    results,
  };
}

/** 渠道状态（probe/catalog/矩阵结果与任务快照），供前端展示 */
function channelStatePublic(store: Store, id: string) {
  const st = store.getState().channels[id];
  if (!st) return {};
  const probe: Record<string, ProbeResult> | undefined = st.probe
    ? Object.fromEntries(
        Object.entries(st.probe).map(([k, v]) => [k, { ...v, rawSnippet: v.rawSnippet }]),
      )
    : undefined;
  return {
    probe,
    catalogAt: st.catalogAt,
    lastTestAt: st.lastTestAt,
    results: st.results,
    task: st.task,
  };
}

/** 掩码形态判定：含 U+2026 省略号，或与既有 key 的 mask() 输出一致（防掩码回填覆盖真 key） */
function isMaskShaped(key: string, existingKey?: string): boolean {
  return key.includes('…') || (existingKey !== undefined && key === mask(existingKey));
}

/** 整表替换密钥：有 id 且已存在→更新（key 留空/掩码形态 = 不改）；无 id→新增；缺席→删除 */
function replaceKeys(ch: Channel, entries: z.infer<typeof keyEntrySchema>[]): ChannelKey[] {
  const now = new Date().toISOString();
  const result: ChannelKey[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.id) {
      const existing = ch.keys.find((k) => k.id === e.id);
      if (existing) {
        seen.add(existing.id);
        // 提交掩码形态 key（含前端掩码回填污染）→ 视为未修改，保留原 key
        const keepKey = !e.key || isMaskShaped(e.key, existing.key);
        result.push({
          ...existing,
          label: e.label,
          enabled: e.enabled,
          concurrency: e.concurrency,
          ...(!keepKey ? { key: e.key! } : {}),
        });
        continue;
      }
    }
    if (!e.key) {
      throw new HttpError(400, `key is required for new entry "${e.label}"`);
    }
    // 新行提交掩码形态 key 必是误输入（掩码只应出现在展示侧）→ 拒绝
    if (isMaskShaped(e.key)) {
      throw new HttpError(
        400,
        `key for new entry "${e.label}" looks like a masked value; paste the plaintext key`,
      );
    }
    const created: ChannelKey = {
      id: randomUUID(),
      label: e.label,
      key: e.key,
      enabled: e.enabled,
      concurrency: e.concurrency,
      createdAt: now,
    };
    seen.add(created.id);
    result.push(created);
  }
  return result;
}

// ---------- router ----------

export function createRouter(store: Store, password = ''): Router {
  const r = Router();
  r.use(expressJson({ limit: '5mb' }));
  r.use(authGuard(password));

  // 登录：校验密码 → {ok:true}；密码即凭据，不发 session/token
  r.post('/login', (req, res) => {
    const body = (req.body ?? {}) as { password?: string };
    if (String(body.password ?? '') === password) {
      res.json({ ok: true });
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  });

  // 渠道列表（key 掩码；附带探测/目录状态；附全局测试默认值供前端预填；附鉴权启用状态）
  r.get('/channels', (_req, res) => {
    res.json({
      channels: store.getConfig().channels.map((ch) => ({
        ...toPublicChannel(ch),
        state: channelStatePublic(store, ch.id),
      })),
      testDefaults: store.getConfig().testDefaults,
      authRequired: Boolean(password),
    });
  });

  // 新建渠道
  r.post('/channels', (req, res) => {
    const body = channelCreateSchema.parse(req.body);
    const now = new Date().toISOString();
    const ch: Channel = {
      id: randomUUID(),
      name: body.name,
      baseUrl: body.baseUrl,
      insecure: body.insecure,
      enabled: true,
      createdAt: now,
      keys: [],
      models: [],
    };
    store.getConfig().channels.push(ch);
    void store.saveConfig();
    scheduleMutationSync(store);
    res.status(201).json({ channel: toPublicChannel(ch) });
  });

  // 拖动排序:按 ids 重排;未列出或重复的渠道按原顺序补到末尾
  r.put('/channels/order', (req, res) => {
    const { ids } = channelOrderSchema.parse(req.body);
    const cfg = store.getConfig();
    const byId = new Map(cfg.channels.map((c) => [c.id, c]));
    const next: Channel[] = [];
    for (const id of ids) {
      const ch = byId.get(id);
      if (!ch) continue;
      next.push(ch);
      byId.delete(id);
    }
    for (const ch of cfg.channels) {
      if (byId.has(ch.id)) next.push(ch);
    }
    cfg.channels = next;
    void store.saveConfig();
    res.json({ ok: true, ids: next.map((c) => c.id) });
  });

  // 更新渠道
  r.put('/channels/:id', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const body = channelUpdateSchema.parse(req.body);
    if (body.name !== undefined) ch.name = body.name;
    if (body.baseUrl !== undefined) ch.baseUrl = body.baseUrl;
    if (body.insecure !== undefined) ch.insecure = body.insecure;
    if (body.enabled !== undefined) ch.enabled = body.enabled;
    void store.saveConfig();
    scheduleMutationSync(store);
    res.json({ channel: toPublicChannel(ch) });
  });

  // 删除渠道
  r.delete('/channels/:id', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const cfg = store.getConfig();
    cfg.channels = cfg.channels.filter((c) => c.id !== ch.id);
    delete store.getState().channels[ch.id];
    void store.saveConfig();
    void store.saveState();
    scheduleMutationSync(store);
    res.json({ ok: true });
  });

  // 整表替换密钥
  r.put('/channels/:id/keys', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const body = keysReplaceSchema.parse(req.body);
    ch.keys = replaceKeys(ch, body.keys);
    void store.saveConfig();
    scheduleMutationSync(store);
    res.json({ channel: toPublicChannel(ch) });
  });

  // M6 §13.2：单 key 明文（全站唯一明文出口，仅本地工具用途；不加缓存头）
  r.get('/channels/:id/keys/:keyId/plaintext', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const k = ch.keys.find((x) => x.id === req.params.keyId);
    if (!k) throw new HttpError(404, 'key not found');
    res.json({ key: k.key });
  });

  // 勾选集与手动添加模型
  r.put('/channels/:id/models', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const body = modelsUpdateSchema.parse(req.body);
    if (body.addManual) {
      const existing = new Set(ch.models.map((m) => m.id));
      for (const id of body.addManual) {
        if (!existing.has(id)) {
          ch.models.push({ id, selected: true, source: 'manual' });
        }
      }
    }
    if (body.removeManual) {
      const rm = new Set(body.removeManual);
      ch.models = ch.models.filter((m) => !(m.source === 'manual' && rm.has(m.id)));
    }
    if (body.selected) {
      const set = new Set(body.selected);
      for (const m of ch.models) {
        m.selected = set.has(m.id);
      }
    }
    void store.saveConfig();
    scheduleMutationSync(store);
    res.json({ channel: toPublicChannel(ch) });
  });

  // ---- M2：探测 / 目录 / 任务轮询 ----

  // 四协议探测（后台任务；body.model 可选：指定时四协议全部用该模型，不走目录候选循环）
  r.post('/channels/:id/probe', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const body = probeStartSchema.parse(req.body ?? {});
    const task = acquireTask(ch.id, 'probe', 4);
    if (!task) throw new HttpError(409, 'task_already_running');
    void runProbe(store, ch.id, body.model ? { model: body.model } : undefined);
    res.status(202).json({ task });
  });

  // 拉取模型目录（后台任务）
  r.post('/channels/:id/catalog', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const task = acquireTask(ch.id, 'catalog', 1);
    if (!task) throw new HttpError(409, 'task_already_running');
    void runCatalog(store, ch.id);
    res.status(202).json({ task });
  });

  // 任务进度轮询（无内存任务时回退到 state 快照，重启恢复场景）
  r.get('/channels/:id/task', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const mem = getTask(ch.id);
    if (mem) {
      res.json({ task: mem });
      return;
    }
    const snap = store.getState().channels[ch.id]?.task;
    if (snap) {
      res.json({
        task: {
          type: snap.type,
          running: snap.running,
          stopped: snap.stopped,
          currentIndex: snap.current?.index ?? snap.total,
          total: snap.total,
          ...(snap.current ? { current: snap.current } : {}),
          startedAt: '',
        },
      });
      return;
    }
    res.json({ task: null });
  });

  // ---- M3：矩阵测试 ----

  // 启动矩阵（后台任务；body.repeat / body.intervalMs 显式给出时持久化至 testDefaults）
  r.post('/channels/:id/test', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const body = testStartSchema.parse(req.body ?? {});
    // 主协议 = 探测 ok 的第一个；无 ok 但目录非空时兜底 openai
    if (!pickMainProtocol(store.getState().channels[ch.id]?.probe, ch.models.length > 0)) {
      throw new HttpError(409, 'probe_first');
    }
    const task = acquireTask(ch.id, 'test', 0);
    if (!task) throw new HttpError(409, 'task_already_running');
    // M6 §13.5：显式给出的 intervalMs 持久化至 testDefaults（与 repeat 同模式）
    if (body.repeat !== undefined) {
      store.getConfig().testDefaults.repeat = body.repeat;
      void store.saveConfig();
    }
    if (body.intervalMs !== undefined) {
      store.getConfig().testDefaults.intervalMs = body.intervalMs;
      void store.saveConfig();
    }
    scheduleMutationSync(store);
    void runTest(store, ch.id, body);
    res.status(202).json({ task });
  });

  // 中断矩阵：当前请求允许完成、队列清空、stopped:true 落盘
  r.post('/test/stop', (_req, res) => {
    const n = stopAllTestTasks();
    res.json({ ok: true, stopped: n });
  });

  // ---- M8：Gist 同步（配置态全量，key 明文进私密 Gist；三方对比决策在 gistsync.ts） ----

  // 配置状态：token 只回掩码，gist_id / 最近同步结果回原文
  r.get('/gist', (_req, res) => {
    const g = store.getConfig().gist!;
    res.json({
      configured: Boolean(g.token && g.gistId),
      tokenMasked: g.token ? mask(g.token) : '',
      gistId: g.gistId,
      syncedAt: g.syncedAt,
      lastResult: g.lastResult,
    });
  });

  // 保存 token/gist_id；token 留空或掩码形态 = 不改（与 key 编辑同防线）；gist_id 变更时基线作废
  r.put('/gist', (req, res) => {
    const body = gistConfigSchema.parse(req.body);
    const g = store.getConfig().gist!;
    const nextToken = (body.token ?? '').trim();
    if (nextToken && nextToken !== g.token && !isMaskShaped(nextToken, g.token)) {
      g.token = nextToken;
    }
    const nextGistId = (body.gistId ?? g.gistId).trim();
    if (nextGistId !== g.gistId) {
      g.gistId = nextGistId;
      g.baselineHash = '';
    }
    void store.saveConfig();
    res.json({ ok: true });
  });

  // 推送（无 gist_id 时自动创建私密 Gist）
  r.post('/gist/push', async (_req, res) => {
    try {
      const out = await pushCore(store, '手动推送');
      res.json({ ok: true, action: out.action, gistId: out.gistId ?? '', htmlUrl: out.htmlUrl ?? '' });
    } catch (e) {
      res.status(502).json({ error: String((e as Error)?.message ?? e) });
    }
  });

  // 拉取：Gist 配置态覆盖本地（state 保留）
  r.post('/gist/pull', async (_req, res) => {
    try {
      const out = await pullCore(store, '手动拉取');
      res.json({ ok: true, action: out.action, channels: out.channels ?? 0 });
    } catch (e) {
      res.status(502).json({ error: String((e as Error)?.message ?? e) });
    }
  });

  // 三方对比同步：本地/Gist/基线 → 自动推送/拉取/冲突跳过
  r.post('/gist/sync', async (_req, res) => {
    try {
      const out = await syncCore(store, '手动同步');
      res.json({ ok: true, action: out.action, ...(out.detail ? { detail: out.detail } : {}) });
    } catch (e) {
      res.status(502).json({ error: String((e as Error)?.message ?? e) });
    }
  });

  // ---- M4：导出（渠道信息 + 勾选模型清单 + 最近矩阵结果摘要；不含任何 key 字段） ----
  // ---- 备份:导出配置态全量(含 key 明文,与 Gist 负载同构);导入覆盖本地配置 ----
  r.get('/backup/export', (_req, res) => {
    const cfg = store.getConfig();
    res.json({
      app: 'api-check',
      version: 1,
      exported_at: Date.now(),
      config: { channels: cfg.channels, testDefaults: cfg.testDefaults },
    });
  });

  r.post('/backup/import', (req, res) => {
    const body = backupSchema.parse(req.body);
    const imported: Channel[] = [];
    let skipped = 0;
    for (const raw of body.config.channels) {
      const parsed = backupChannelSchema.safeParse(raw);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      imported.push(normalizeChannel(parsed.data as Record<string, unknown>) as unknown as Channel);
    }
    if (imported.length === 0) throw new HttpError(400, '备份中没有可用渠道');
    const cfg = store.getConfig();
    cfg.channels = imported;
    const td = body.config.testDefaults;
    if (td) {
      const num = (v: number | undefined, d: number) => (Number.isFinite(v) ? Number(v) : d);
      cfg.testDefaults = {
        intervalMs: num(td.intervalMs, cfg.testDefaults.intervalMs),
        timeoutMs: num(td.timeoutMs, cfg.testDefaults.timeoutMs),
        repeat: num(td.repeat, cfg.testDefaults.repeat),
      };
    }
    void store.saveConfig();
    res.json({ ok: true, imported: imported.length, skipped });
  });

  r.get('/channels/:id/export', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const payload = buildExportPayload(ch, store.getState().channels[ch.id]);
    const encoded = encodeURIComponent(`api-check-export-${new Date().toISOString().slice(0, 10)}.json`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="api-check-export.json"; filename*=UTF-8''${encoded}`,
    );
    res.send(JSON.stringify(payload, null, 2));
  });

  return r;
}

// ---------- 错误处理中间件 ----------

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'validation_failed',
      issues: err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[api] unhandled error at', _req.path, (err as Error)?.stack ?? err);
  res.status(500).json({ error: 'internal_error' });
}
