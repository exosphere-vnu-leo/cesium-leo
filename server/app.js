import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { SimulationEngine } from './simulationEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(engine = new SimulationEngine(config.data)) {
  const app = express();
  app.locals.engine = engine;
  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/manifest', (_req, res) => {
    res.json(engine.manifest());
  });

  app.get('/api/frame', (req, res) => {
    res.json(engine.frame(req.query.t));
  });

  app.get('/api/nodes/:id/frame', (req, res, next) => {
    try {
      res.json(engine.nodeFrame(req.params.id, req.query.t));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/handovers', (req, res) => {
    res.json({
      events: engine.getHandovers({
        from: req.query.from,
        to: req.query.to,
        nodeId: req.query.nodeId,
        includeStay: req.query.includeStay === 'true'
      })
    });
  });

  const distDir = path.resolve(__dirname, '..', 'dist');
  app.use(express.static(distDir));
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distDir, 'index.html'), (error) => {
      if (error) next();
    });
  });

  app.use((error, _req, res, _next) => {
    const status = error.statusCode ?? 500;
    res.status(status).json({
      error: error.message ?? 'Internal server error'
    });
  });

  return app;
}
