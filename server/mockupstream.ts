// 本地 mock 上游（仅测试用）：node:http 起临时假上游
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockUpstream {
  port: number;
  baseUrl: string; // 形如 http://127.0.0.1:PORT
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
  close: () => Promise<void>;
}

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
) => void;

export function startMock(handler: Handler): Promise<MockUpstream> {
  return new Promise((resolve, reject) => {
    const requests: MockUpstream['requests'] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        handler(req, res, body);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
