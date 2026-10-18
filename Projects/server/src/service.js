import { AlarmState } from './alarms.js';
import { InputError, validateTelemetry } from './validation.js';

export class TelemetryService {
  constructor(store, config, events) {
    this.store = store;
    this.config = config;
    this.events = events;
    this.devices = new Map(store.devices().map(device => [device.id, {
      ...device,
      latest: store.latest(device.id),
      clients: new Set(), lastSeenAt: store.lastReceived(device.id),
      alarms: new AlarmState(store.thresholds(device.id), config.staleAfterMs),
      previousState: null,
    }]));
    this.databaseWritable = true;
    this.closing = false;
    for (const id of this.devices.keys()) this.publishState(id);
    this.timer = setInterval(() => {
      for (const id of this.devices.keys()) this.publishState(id);
    }, Math.min(1000, config.staleAfterMs));
    this.timer.unref();
  }

  device(id) {
    const device = this.devices.get(id);
    if (!device) throw new InputError('DEVICE_NOT_FOUND', 'Device is not registered', 404);
    return device;
  }
  state(id, now = Date.now()) {
    const device = this.device(id);
    const latest = device.latest;
    return {
      device_id: id, online: device.clients.size > 0,
      stale: !latest || latest.time_quality !== 'device' || now - Date.parse(latest.sampled_at) > this.config.staleAfterMs,
      last_seen_at: device.lastSeenAt,
    };
  }
  publishState(id) {
    const device = this.device(id);
    const state = this.state(id);
    const serialized = JSON.stringify(state);
    if (device.previousState !== serialized && !this.closing) {
      device.previousState = serialized;
      this.events.send('device.updated', state);
    }
  }
  seen(id, client, online = true) {
    const device = this.device(id);
    if (client) {
      if (online) device.clients.add(client);
      else device.clients.delete(client);
    }
    device.lastSeenAt = new Date().toISOString();
    this.publishState(id);
  }
  disconnected(client) {
    for (const [id, device] of this.devices) {
      if (device.clients.delete(client)) this.publishState(id);
    }
  }
  ingest(value, topicDevice, client, now = Date.now()) {
    const device = this.devices.get(topicDevice);
    validateTelemetry(value, topicDevice, device, now);
    let result;
    try {
      result = this.store.store(value, new Date(now).toISOString());
      this.databaseWritable = true;
    } catch (error) {
      if (!(error instanceof InputError)) this.databaseWritable = false;
      throw error;
    }
    // All notifications and success ACKs follow a completed transaction.
    const record = result.record;
    if (result.status === 'stored') {
      const newer = !device.latest || Date.parse(record.effective_at) > Date.parse(device.latest.effective_at);
      if (newer || record.effective_at === device.latest?.effective_at) device.latest = record;
      this.events.send('measurement.created', record);
      if (newer && device.alarms.sample(record, now)) {
        this.events.send('alarm.changed', { device_id: topicDevice, alarms: device.alarms.alarms() });
      }
    }
    this.seen(topicDevice, client);
    return {
      schema_version: 1, device_id: value.device_id, boot_id: value.boot_id, seq: value.seq,
      status: result.status, stored_at: record.stored_at,
    };
  }
  latest(id) {
    const device = this.device(id);
    if (!device.latest) return null;
    const { device_id, ...state } = this.state(id);
    return { ...device.latest, device: state, alarms: device.alarms.alarms() };
  }
  thresholds(id) {
    this.device(id);
    return this.store.thresholds(id);
  }
  saveThresholds(id, config) {
    const device = this.device(id);
    let next;
    try {
      next = this.store.saveThresholds(id, config);
      this.databaseWritable = true;
    } catch (error) {
      this.databaseWritable = false;
      throw error;
    }
    device.alarms.configure(next);
    this.events.send('thresholds.updated', { device_id: id, config: next });
    return next;
  }
  close() {
    this.closing = true;
    clearInterval(this.timer);
  }
}
