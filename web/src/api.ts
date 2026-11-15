import type { GistStatus, KeyInput, PublicChannel, TaskState, TestDefaults } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; issues?: { path: string; message: string }[] },
  ) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

// ---------- M8 §15.1：密码即凭据（localStorage 持久化，X-Auth 头携带） ----------

const AUTH_KEY = 'api-check.password';

export function getStoredPassword(): string {
  try {
    return localStorage.getItem(AUTH_KEY) ?? '';
  } catch {
    return '';
  }
}

export function storePassword(password: string): void {
  try {
    if (password) localStorage.setItem(AUTH_KEY, password);
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    // 环境受限时忽略（该次会话内已登录态丢失，401 会再弹）
  }
}

// 收到 401 → 通知 App 弹登录框；登录成功后唤醒等待中的请求重放
let unauthorizedHandler: (() => void) | null = null;
let loginWaiter: (() => void) | null = null;

export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function notifyLoginSuccess(): void {
  const w = loginWaiter;
  loginWaiter = null;
  w?.();
}

export async function login(password: string): Promise<boolean> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) return false;
  storePassword(password);
  return true;
}

export function logout(): void {
  storePassword('');
}

async function request<T>(path: string, init?: RequestInit, replay = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const password = getStoredPassword();
  if (password) headers['X-Auth'] = password;
  const res = await fetch(`/api${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  if (res.status === 401) {
    // 首次 401 → 弹登录框并等成功后重放一次；重放仍 401 → 按错误抛出
    if (replay && unauthorizedHandler) {
      await new Promise<void>((resolve) => {
        loginWaiter = resolve;
        unauthorizedHandler!();
      });
      return request<T>(path, init, false);
    }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listChannels(): Promise<{
    channels: PublicChannel[];
    testDefaults: TestDefaults;
    authRequired: boolean;
  }> {
    return request('/channels');
  },
  createChannel(body: {
    name: string;
    baseUrl: string;
    insecure: boolean;
  }): Promise<{ channel: PublicChannel }> {
    return request('/channels', { method: 'POST', body: JSON.stringify(body) });
  },
  updateChannel(
    id: string,
    body: { name?: string; baseUrl?: string; insecure?: boolean; enabled?: boolean },
  ): Promise<{ channel: PublicChannel }> {
    return request(`/channels/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  },
  deleteChannel(id: string): Promise<{ ok: boolean }> {
    return request(`/channels/${id}`, { method: 'DELETE' });
  },
  replaceKeys(id: string, keys: KeyInput[]): Promise<{ channel: PublicChannel }> {
    return request(`/channels/${id}/keys`, {
      method: 'PUT',
      body: JSON.stringify({ keys }),
    });
  },
  // M6 §13.2：单 key 明文（全站唯一明文出口）
  getKeyPlaintext(id: string, keyId: string): Promise<{ key: string }> {
    return request(`/channels/${id}/keys/${keyId}/plaintext`);
  },
  updateModels(
    id: string,
    body: { selected?: string[]; addManual?: string[]; removeManual?: string[] },
  ): Promise<{ channel: PublicChannel }> {
    return request(`/channels/${id}/models`, { method: 'PUT', body: JSON.stringify(body) });
  },
  startProbe(id: string, body: { model?: string } = {}): Promise<{ task: TaskState }> {
    return request(`/channels/${id}/probe`, { method: 'POST', body: JSON.stringify(body) });
  },
  startCatalog(id: string): Promise<{ task: TaskState }> {
    return request(`/channels/${id}/catalog`, { method: 'POST' });
  },
  getTask(id: string): Promise<{ task: TaskState | null }> {
    return request(`/channels/${id}/task`);
  },
  startTest(
    id: string,
    body: {
      modelIds?: string[];
      keyIds?: string[];
      intervalMs?: number;
      timeoutMs?: number;
      repeat?: number;
    } = {},
  ): Promise<{ task: TaskState }> {
    return request(`/channels/${id}/test`, { method: 'POST', body: JSON.stringify(body) });
  },
  stopTest(): Promise<{ ok: boolean; stopped: number }> {
    return request('/test/stop', { method: 'POST', body: JSON.stringify({}) });
  },
  // M8：改为经 fetch 下载（直链无法携带 X-Auth 头，设密码后会 401）
  exportChannel(id: string): Promise<unknown> {
    return request(`/channels/${id}/export`);
  },
  // ---- M8：Gist 同步 ----
  getGist(): Promise<GistStatus> {
    return request('/gist');
  },
  putGist(body: { token?: string; gistId?: string }): Promise<{ ok: boolean }> {
    return request('/gist', { method: 'PUT', body: JSON.stringify(body) });
  },
  gistPush(): Promise<{ ok: boolean; action: string; gistId?: string; htmlUrl?: string }> {
    return request('/gist/push', { method: 'POST', body: JSON.stringify({}) });
  },
  gistPull(): Promise<{ ok: boolean; action: string; channels: number }> {
    return request('/gist/pull', { method: 'POST', body: JSON.stringify({}) });
  },
  gistSync(): Promise<{ ok: boolean; action: string; detail?: string }> {
    return request('/gist/sync', { method: 'POST', body: JSON.stringify({}) });
  },
};
