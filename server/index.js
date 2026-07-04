/**
 * GrabIt Server v3.0
 * Local-first download server for YouTube, Instagram, and generic websites.
 * Starts HTTP + WebSocket on port 7272.
 */

const express = require('express');
const { createServer } = require('http');
const cors = require('cors');
const path = require('path');

const { initWebSocket } = require('./modules/websocket');
const { initDB } = require('./modules/db');
const { startupCookieExtract } = require('./modules/cookies');
const { initQueue } = require('./modules/queue');
const { log, LOG_FILE, ERR_FILE } = require('./modules/logger');

const probeRoutes = require('./modules/routes/probe');
const downloadRoutes = require('./modules/routes/download');
const queueRoutes = require('./modules/routes/queue');
const historyRoutes = require('./modules/routes/history');
const settingsRoutes = require('./modules/routes/settings');
const slideRoutes = require('./modules/routes/slide');
const cookiesRoutes = require('./modules/routes/cookies');
const logsRoutes    = require('./modules/routes/logs');

const PORT = 7272;

async function main() {
  log.info('main', 'GrabIt server starting v3.0');
  log.info('main', `Log files`, { main: LOG_FILE, errors: ERR_FILE });

  // Init persistent storage
  await initDB();
  log.ok('main', 'Database initialised');

  // Extract cookies from browser at startup (best-effort)
  await startupCookieExtract();
  log.ok('main', 'Cookie extraction done');

  // Init download queue manager
  initQueue();
  log.ok('main', 'Queue initialised');

  const app = express();
  app.use(cors({ origin: '*' }));
  app.use(express.json({ limit: '10mb' }));

  // ── Request logger middleware ──────────────────────────────────────────────
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => {
      const level = res.statusCode >= 500 ? 'error'
                  : res.statusCode >= 400 ? 'warn'
                  : 'debug';
      log[level]('HTTP', `${req.method} ${req.path} → ${res.statusCode} (${Date.now() - t0}ms)`, {
        status: res.statusCode,
        query:  JSON.stringify(req.query).slice(0, 200),
        body:   req.method !== 'GET' ? JSON.stringify(req.body || {}).slice(0, 300) : undefined
      });
    });
    next();
  });

  // Health check (extension pings this on open)
  app.get('/health', (req, res) => res.json({ ok: true, version: '3.0.0', logFile: LOG_FILE }));

  // Mount route modules
  app.use('/probe',    probeRoutes);
  app.use('/download', downloadRoutes);
  app.use('/queue',    queueRoutes);
  app.use('/history',  historyRoutes);
  app.use('/settings', settingsRoutes);
  app.use('/slide',    slideRoutes);
  app.use('/cookies',  cookiesRoutes);
  app.use('/logs',     logsRoutes);

  // ── Global error handler ──────────────────────────────────────────────────
  app.use((err, req, res, next) => {
    log.error('express', `Unhandled route error: ${err.message}`, {
      path: req.path, stack: err.stack?.split('\n').slice(0,4).join(' | ')
    });
    res.status(500).json({ error: err.message });
  });

  const httpServer = createServer(app);
  initWebSocket(httpServer);

  httpServer.listen(PORT, '127.0.0.1', () => {
    log.ok('main', `Server ready`, { http: `http://127.0.0.1:${PORT}`, ws: `ws://127.0.0.1:${PORT}` });
    log.ok('main', `Logs writing to ${LOG_FILE}`);
    console.log(`\n[GrabIt] Server ready — http://127.0.0.1:${PORT}`);
    console.log(`[GrabIt] Live logs: tail -f "${LOG_FILE}"`);
    console.log(`[GrabIt] Errors only: tail -f "${ERR_FILE}"\n`);
  });

  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', err.message, err);
    console.error('[GrabIt] Uncaught exception:', err.message);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    log.error('unhandledRejection', msg, reason instanceof Error ? reason : { reason: msg });
  });
}

main();
