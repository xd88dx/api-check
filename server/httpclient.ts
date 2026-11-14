// 最小 HTTP 客户端（node:http/https 原生实现）
// 静默超时：socket 空闲计时（连接挂住、头到 body 挂住均覆盖）；insecure 跳过证书校验。
import http from 'node:http';
import https from 'node:https';
import type { URL } from 'node:url';

export interface RawResponse {
  status: number | null;
  body: string; // 截断至 maxBodyBytes
  timedOut: boolean;
}

export interface RequestOptions {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number; // 静默超时
  insecure?: boolean;
  maxBodyBytes?: number;
}

function agentFor(url: URL, insecure: boolean): http.Agent | https.Agent {
  const opts = { keepAlive: false, maxSockets: 1 };
  if (url.protocol === 'https:') {
    return new https.Agent({ ...opts, rejectUnauthorized: !insecure });
  }
  return new http.Agent(opts);
}

export function request(opts: RequestOptions): Promise<RawResponse> {
  const { url, method, headers, body, timeoutMs, insecure = false } = opts;
  const maxBodyBytes = opts.maxBodyBytes ?? 1024 * 1024;
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    let silenceTimedOut = false; // 静默超时标记（区别于普通网络错误）
    const req = mod.request(
      url,
      {
        method,
        headers,
        agent: agentFor(url, insecure),
        timeout: timeoutMs, // socket 空闲超时（静默计时）
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received <= maxBodyBytes) chunks.push(chunk);
          if (received >= maxBodyBytes) req.destroy(); // 读够即断，不等挂死的连接
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString('utf8'), timedOut: false });
        });
        res.on('error', () => {
          // 静默超时触发的 destroy 会走到这里：必须保持 timedOut 标记（D3）
          resolve({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString('utf8'), timedOut: silenceTimedOut });
        });
      },
    );
    req.on('timeout', () => {
      silenceTimedOut = true;
      req.destroy();
    }); // 静默超时：触发后按 error 收尾
    req.on('error', (err: NodeJS.ErrnoException) => {
      // 静默超时（socket 空闲/主动终止）；非超时的连接错误判 error
      const timedOut = silenceTimedOut || err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.message === 'socket hang up';
      resolve({ status: null, body: '', timedOut: silenceTimedOut ? true : timedOut });
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
