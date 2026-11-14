export interface PublicKey {
  id: string;
  label: string;
  key: string; // 已掩码形态
  enabled: boolean;
  concurrency: number;
  createdAt: string;
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
}

/** PUT /channels/:id/keys 的请求条目（key 留空 = 不改） */
export interface KeyInput {
  id?: string;
  label: string;
  key?: string;
  enabled: boolean;
  concurrency: number;
}
