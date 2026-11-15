import express from 'express';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { Store } from './store.js';
import { createRouter, errorHandler } from './routes.js';
import { startAutoSync, stopAutoSync } from './gistsync.js';
import { logger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';

async function main() {
  const store = new Store(process.env.DATA_DIR || 'data');
  await store.init();
  logger.info('store restored', { channels: store.getConfig().channels.length });

  // 进程重启 = 后台任务全部中断：把 running 快照折算为 stopped（D6）
  let folded = false;
  for (const st of Object.values(store.getState().channels)) {
    if (st.task?.running) {
      st.task.running = false;
      st.task.stopped = true;
      folded = true;
    }
  }
  if (folded) await store.saveState();

  const app = express();
  // M8 §15.1：PANEL_PASSWORD 非空时拦截 /api/*（/api/login 放行）；静态资源与登录框放行
  app.use('/api', createRouter(store, PANEL_PASSWORD));
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
    // M8 §15.1：未设密码时提示裸奔风险（本地默认可选）
    if (!PANEL_PASSWORD) {
      logger.warn('PANEL_PASSWORD is not set, the panel is exposed without authentication');
    }
  });
  // M8 §15.2：Gist 自动同步定时检查（每 5 分钟）
  startAutoSync(store);
  const shutdown = () => {
    stopAutoSync();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error('fatal', e);
  process.exit(1);
});
