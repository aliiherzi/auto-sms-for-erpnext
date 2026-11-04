/** Entry point: `npm start` (after `npm run build`) or `npm run dev`. */
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { App } from './app.js';
import { loadEnv } from './config/env.js';
import { createLogger, type Logger } from './util/logger.js';
import { createServer } from './web/server.js';

/** Opens the dashboard in the default browser (used by the start-on-my-computer scripts). */
function openBrowser(url: string, logger: Logger): void {
  const [command, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' });
    child.on('error', () => logger.info(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    logger.info(`Open ${url} in your browser.`);
  }
}

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

  // AUTO_PORT=1 (start scripts): if the port is busy, try the next ones.
  const autoPort = process.env.AUTO_PORT === '1';
  let server: Server | undefined;
  const listen = (port: number, triesLeft: number) => {
    const candidate = createServer(app).listen(port, env.HOST);
    candidate.once('listening', () => {
      server = candidate;
      const url = `http://${env.HOST === '0.0.0.0' ? 'localhost' : env.HOST}:${port}`;
      logger.info(`Dashboard: ${url}`);
      if (process.env.OPEN_BROWSER === '1') openBrowser(url, logger);
    });
    candidate.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && autoPort && triesLeft > 0) {
        logger.warn(`Port ${port} is used by another program, trying ${port + 1}`);
        listen(port + 1, triesLeft - 1);
        return;
      }
      logger.error(
        error.code === 'EADDRINUSE'
          ? `Port ${port} is already used by another program. Close it, or set another PORT in .env.`
          : `Cannot start the dashboard: ${error.message}`,
      );
      process.exit(1);
    });
  };
  listen(env.PORT, 10);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down…`);
    server?.close();
    await app.stop().catch((error) => logger.error({ err: error }, 'Error while stopping'));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
}

void main();
