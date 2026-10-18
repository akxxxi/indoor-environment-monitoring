import express from 'express';
import { InputError, parseSeries, validateThresholds } from './validation.js';

export function createHttp(service, events, mqtt, config, logger = console) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.headers.origin === config.corsOrigin) {
      res.set('Access-Control-Allow-Origin', config.corsOrigin);
      res.vary('Origin');
      res.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '16kb', strict: true }));
  const healthy = () => ({
    status: 'ok', mqtt: mqtt.server.listening && !mqtt.broker.closed && !service.closing,
    database: service.store.healthy() && service.databaseWritable && !service.closing,
  });
  app.get('/api/v1/health', (_req, res) => {
    const data = healthy();
    const ready = data.mqtt && data.database;
    if (!ready) return res.status(503).json({ error: {
      code: 'DEPENDENCY_UNAVAILABLE',
      message: `MQTT ${data.mqtt ? 'ready' : 'unavailable'}; database ${data.database ? 'ready' : 'unavailable'}`,
    } });
    res.json({ data });
  });
  app.use('/api/v1', (_req, _res, next) => {
    if (!service.store.healthy() || service.closing) return next(new InputError('DEPENDENCY_UNAVAILABLE', 'Database is not ready', 503));
    next();
  });
  const base = '/api/v1/devices/:deviceId';
  app.get(`${base}/latest`, (req, res) => res.json({ data: service.latest(req.params.deviceId) }));
  app.get(`${base}/series`, (req, res) => {
    service.device(req.params.deviceId);
    res.json(service.store.series(req.params.deviceId, parseSeries(req.query)));
  });
  app.get(`${base}/thresholds`, (req, res) => res.json({ data: service.thresholds(req.params.deviceId) }));
  app.put(`${base}/thresholds`, (req, res) => {
    service.device(req.params.deviceId);
    if (!req.is('application/json')) throw new InputError('INVALID_PAYLOAD', 'Content-Type must be application/json');
    res.json({ data: service.saveThresholds(req.params.deviceId, validateThresholds(req.body)) });
  });
  app.get('/api/v1/events', (req, res) => {
    if (typeof req.query.device_id !== 'string') throw new InputError('INVALID_QUERY', 'device_id is required');
    service.device(req.query.device_id);
    events.subscribe(req.query.device_id, req, res);
  });
  app.use((_req, _res, next) => next(new InputError('NOT_FOUND', 'Endpoint does not exist', 404)));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    if (error instanceof InputError) return res.status(error.status).json({ error: { code: error.code, message: error.message } });
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return res.status(400).json({ error: { code: 'INVALID_PAYLOAD', message: 'Invalid JSON or body exceeds 16 KiB' } });
    }
    logger.error('HTTP dependency error:', error.message);
    return res.status(503).json({ error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Database or service is unavailable' } });
  });
  return app;
}
