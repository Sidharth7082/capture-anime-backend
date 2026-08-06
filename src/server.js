// HTTP server bootstrap + graceful shutdown.
import { createProductionApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { pool } from './db/pool.js';
import { createAuthRepository } from './modules/auth/auth.repository.js';
import { createAuthService } from './modules/auth/auth.service.js';

const app = createProductionApp();
const server = app.listen(env.PORT, () => {
  logger.info(`Anime Platform API listening on http://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
  logger.info(`Swagger docs: http://localhost:${env.PORT}/api-docs`);
});

// Housekeeping: prune expired refresh tokens (6h default). unref() keeps the
// interval from holding the process open during shutdown.
const pruner = setInterval(async () => {
  try {
    const service = createAuthService({ repository: createAuthRepository(pool) });
    const removed = await service.pruneExpiredTokens();
    if (removed > 0) logger.info(`Pruned ${removed} expired refresh token(s)`);
  } catch (err) {
    logger.error(`Refresh-token pruning failed: ${err.message}`);
  }
}, 6 * 60 * 60 * 1000);
pruner.unref();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(async () => {
    try {
      await pool.end();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error(`Error during shutdown: ${err.message}`);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection: ${reason?.stack ?? reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.stack}`);
  process.exit(1);
});
