import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { Store } from './store.js';
import { createRouter, errorHandler } from './routes.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const store = new Store('data');
  await store.init();
  logger.info('store restored', { channels: store.getConfig().channels.length });

  const app = express();
  app.use('/api', createRouter(store));
  app.use(errorHandler);

  // 静态托管 web/dist
  const webDist = resolve(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(resolve(webDist, 'index.html'));
    });
  } else {
    logger.warn('web/dist not found, skipping static hosting');
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    logger.info(`api-check listening on http://localhost:${port}`);
  });
}

main().catch((e) => {
  logger.error('fatal', e);
  process.exit(1);
});
