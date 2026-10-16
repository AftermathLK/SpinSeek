import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { authMiddleware, authRouter, authSource } from './auth.js';
import { APP_VERSION, CLIENT_DIST, DB_PATH, HOST, PORT } from './config.js';
import { db, purgeExpiredCache } from './db.js';
import { KEY_FILE } from './secrets.js';
import { startDripWorker } from './drip.js';
import { ApiError } from './http.js';
import { discoverRouter } from './routes/discover.js';
import { libraryRouter } from './routes/library.js';
import { lidarrRouter } from './routes/lidarr.js';
import { recsRouter } from './routes/recs.js';
import { settingsRouter } from './routes/settings.js';
import { webhookRouter } from './routes/webhook.js';
import { startSyncScheduler } from './sync.js';

process.on('unhandledRejection', (reason) => {
  console.error('[spinseek] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[spinseek] uncaught exception:', err);
});

const app = express();
app.disable('x-powered-by');
// Forwarded headers are NOT trusted unless TRUST_PROXY names your reverse proxy (e.g. "172.17.0.1"),
// so a client can't spoof X-Forwarded-For to dodge the login rate limit.
const trustProxy = process.env.TRUST_PROXY?.trim();
app.set('trust proxy', trustProxy ? trustProxy.split(',').map((s) => s.trim()) : false);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '2mb' }));

const api = express.Router();
// Default deny: authentication runs before any route handler is mounted.
api.use(authMiddleware);
api.get('/health', (_req, res) => {
  res.json({ ok: true });
});
api.use(authRouter);
api.use(webhookRouter);
api.use(settingsRouter);
api.use(discoverRouter);
api.use(recsRouter);
api.use(libraryRouter);
api.use(lidarrRouter);
api.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
app.use('/api', api);

// Production: serve the compiled Vite app from the same port.
const indexHtml = path.join(CLIENT_DIST, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(
    '/assets',
    express.static(path.join(CLIENT_DIST, 'assets'), { immutable: true, maxAge: '365d', fallthrough: false }),
  );
  app.use(express.static(CLIENT_DIST, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
} else {
  app.get('/', (_req, res) => {
    res
      .type('text/plain')
      .send('Spin Seek API is running. The web UI is served by Vite in development (npm run dev → http://localhost:5173).');
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  let status = 500;
  let message = 'Internal server error';
  if (err instanceof ApiError) {
    status = err.status;
    message = err.message;
  } else if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.parse.failed') {
    status = 400;
    message = 'Request body is not valid JSON';
  } else if (err && typeof err === 'object' && 'status' in err && (err as { status?: number }).status === 404) {
    status = 404;
    message = 'Not found';
  } else {
    console.error('[spinseek] request error:', err);
  }
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: message });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`[spinseek] v${APP_VERSION} listening on http://${HOST}:${PORT}`);
  console.log(`[spinseek] database: ${DB_PATH} (API keys encrypted with ${process.env.APP_SECRET ? 'APP_SECRET' : KEY_FILE})`);
  if (trustProxy) console.log(`[spinseek] trusting X-Forwarded-For from: ${trustProxy}`);
  const source = authSource();
  console.log(
    source === 'none'
      ? '[spinseek] auth: no login yet: open the web UI to create one (everything else is locked until then)'
      : `[spinseek] auth: ${source}`,
  );
});

startSyncScheduler();
startDripWorker();
purgeExpiredCache();
setInterval(() => purgeExpiredCache(), 6 * 60 * 60 * 1000).unref();

function shutdown(signal: string): void {
  console.log(`[spinseek] ${signal} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => {
    db.close();
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
