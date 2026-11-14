import type { KeyInput, PublicChannel } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; issues?: { path: string; message: string }[] },
  ) {
    super(body?.error ?? `HTTP ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listChannels(): Promise<{ channels: PublicChannel[] }> {
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
};
