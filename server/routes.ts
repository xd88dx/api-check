import { randomUUID } from 'node:crypto';
import { json as expressJson, Router, type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import type { Store, Channel, ChannelKey } from './store';
import { mask } from './mask';

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
  })
  .refine((v) => v.selected !== undefined || v.addManual !== undefined, 'empty body');

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

/** 整表替换密钥：有 id 且已存在→更新（key 留空不改）；无 id→新增；缺席→删除 */
function replaceKeys(ch: Channel, entries: z.infer<typeof keyEntrySchema>[]): ChannelKey[] {
  const now = new Date().toISOString();
  const result: ChannelKey[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.id) {
      const existing = ch.keys.find((k) => k.id === e.id);
      if (existing) {
        seen.add(existing.id);
        result.push({
          ...existing,
          label: e.label,
          enabled: e.enabled,
          concurrency: e.concurrency,
          ...(e.key ? { key: e.key } : {}),
        });
        continue;
      }
    }
    if (!e.key) {
      throw new HttpError(400, `key is required for new entry "${e.label}"`);
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

export function createRouter(store: Store): Router {
  const r = Router();
  r.use(expressJson());

  // 渠道列表（key 掩码）
  r.get('/channels', (_req, res) => {
    res.json({ channels: store.getConfig().channels.map(toPublicChannel) });
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
    res.status(201).json({ channel: toPublicChannel(ch) });
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
    res.json({ ok: true });
  });

  // 整表替换密钥
  r.put('/channels/:id/keys', (req, res) => {
    const ch = findChannel(store, req.params.id);
    const body = keysReplaceSchema.parse(req.body);
    ch.keys = replaceKeys(ch, body.keys);
    void store.saveConfig();
    res.json({ channel: toPublicChannel(ch) });
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
    if (body.selected) {
      const set = new Set(body.selected);
      for (const m of ch.models) {
        m.selected = set.has(m.id);
      }
    }
    void store.saveConfig();
    res.json({ channel: toPublicChannel(ch) });
  });

  // ---- M2/M3/M4 占位：任务类端点 ----
  const notImplemented = (_req: Request, res: Response) => {
    res.status(501).json({ error: 'not_implemented', detail: 'planned for M2/M3/M4' });
  };
  r.post('/channels/:id/probe', notImplemented);
  r.post('/channels/:id/catalog', notImplemented);
  r.post('/channels/:id/test', notImplemented);
  r.post('/test/stop', notImplemented);
  r.get('/channels/:id/task', notImplemented);
  r.get('/channels/:id/export', notImplemented);

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
  res.status(500).json({ error: 'internal_error' });
}
