/** Entry point: `npm start` (after `npm run build`) or `npm run dev`. */
import { App } from './app.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './util/logger.js';
import { createServer } from './web/server.js';

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnv();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
  const logger = createLogger(env.LOG_LEVEL);
  logger.info('Starting Auto SMS for ERPNext');

  const app = new App(env, logger);
  await app.start();

  const server = createServer(app).listen(env.PORT, env.HOST, () => {
    logger.info(`Dashboard: http://${env.HOST === '0.0.0.0' ? 'localhost' : env.HOST}:${env.PORT}`);
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down…`);
    server.close();
    await app.stop().catch((error) => logger.error({ err: error }, 'Error while stopping'));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
}

void main();
