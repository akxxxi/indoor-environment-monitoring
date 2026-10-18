import { Generator } from './generator.js';
import { sameIdentity, validAck } from './contract.js';

export class SimulatorNode {
  constructor({ config, outbox, connect, log = console.log, onSettled = () => {} }) {
    Object.assign(this, { config, outbox, connect, log, onSettled });
    this.generator = new Generator(config);
    this.baseTopic = `envmon/v1/devices/${config.deviceId}`;
    this.ready = false;
    this.stopping = false;
    this.full = false;
  }
  status(state) {
    return JSON.stringify({ schema_version: 1, device_id: this.config.deviceId, boot_id: this.generator.bootId, state });
  }
  start() {
    this.outbox.assertIdentity(this.config.deviceId, this.config.roomId);
    this.log(`启动 boot_id=${this.generator.bootId} scenario=${this.config.scenario} seed=${this.config.seed} interval=${this.config.intervalMs}ms queue=${this.outbox.count()}`);
    this.sample();
    this.sampler = setInterval(() => this.sample(), this.config.intervalMs);
    this.openConnection();
  }
  sample() {
    if (this.stopping) return;
    if (this.outbox.count() >= this.config.maxPending) {
      if (!this.full) this.log(`队列已满 capacity=${this.config.maxPending}：停止接纳新采样，保留全部旧记录；确认出队后自动恢复`);
      this.full = true;
      return;
    }
    if (this.full) this.log('队列已有空间，恢复采样');
    this.full = false;
    const oldPhase = this.generator.phase;
    const message = this.generator.next();
    if (oldPhase !== this.generator.phase) this.log(`情景 scenario=${this.config.scenario} phase=${this.generator.phase}`);
    if (!this.outbox.enqueue(message)) throw new Error('队列容量发生意外变化');
    this.log(`采样 boot_id=${message.boot_id} seq=${message.seq} queue=${this.outbox.count()}`);
    this.pump();
  }
  openConnection() {
    if (this.stopping) return;
    this.log('连接 MQTT（MQTT 3.1.1 / QoS 1）');
    // A fresh MQTT client for each connection leaves all replay to the SQLite
    // outbox. MQTT.js must not replay an old QoS packet before SUBACK.
    const client = this.connect(this.config.mqttUrl, {
      protocolVersion: 4, clean: true, reconnectPeriod: 0, resubscribe: false,
      connectTimeout: 5000, keepalive: 15, queueQoSZero: false,
      clientId: `sim-${this.generator.bootId}`,
      will: { topic: `${this.baseTopic}/status`, payload: this.status('offline'), qos: 1, retain: true },
    });
    this.client = client;
    client.on('error', error => { if (!this.stopping) this.log(`MQTT 错误：${error.message}`); });
    client.on('connect', () => {
      if (this.stopping || client !== this.client) return;
      this.log('MQTT 已连接，等待 ACK 主题订阅确认');
      client.subscribe(`${this.baseTopic}/ack`, { qos: 1 }, (error, granted) => {
        if (this.stopping || client !== this.client || !client.connected) return;
        if (error || !granted?.some(item => item.topic === `${this.baseTopic}/ack` && item.qos === 1)) {
          this.log(`ACK 订阅失败：${error?.message ?? '未授予 QoS 1'}，重新连接`);
          client.end(true);
          return;
        }
        this.ready = true;
        this.log('ACK 订阅成功，开始有序发送');
        client.publish(`${this.baseTopic}/status`, this.status('online'), { qos: 1, retain: true });
        this.pump();
      });
    });
    client.on('message', (topic, payload, packet) => {
      if (client !== this.client || this.stopping || !this.ready || topic !== `${this.baseTopic}/ack`) return;
      if (packet?.retain) { this.log('忽略 retained ACK'); return; }
      let ack;
      try { ack = JSON.parse(payload.toString()); } catch { this.log('忽略无法解析的 ACK'); return; }
      this.onAck(ack);
    });
    client.on('close', () => {
      if (client !== this.client) return;
      this.ready = false;
      clearTimeout(this.deliveryTimer);
      this.flight = null;
      // Discard MQTT's volatile outgoing store; original messages remain in SQLite.
      client.end(true);
      if (this.stopping) return;
      this.log(`MQTT 已断线，继续本地采样；${this.config.reconnectMs}ms 后重连 queue=${this.outbox.count()}`);
      this.reconnectTimer = setTimeout(() => this.openConnection(), this.config.reconnectMs);
    });
  }
  pump() {
    if (this.stopping || !this.ready || !this.client?.connected || this.flight) return;
    const row = this.outbox.head();
    if (!row) return;
    this.flight = row;
    this.send(row);
  }
  send(row) {
    if (this.stopping || !this.ready || !this.client?.connected || this.flight !== row) return;
    this.outbox.attempted(row.id);
    row.attempts++;
    this.log(`发送 boot_id=${row.boot_id} seq=${row.seq} attempt=${row.attempts} queue=${this.outbox.count()}`);
    this.deliveryTimer = setTimeout(() => this.retry(row, '应用 ACK 超时'), this.config.ackTimeoutMs);
    this.client.publish(`envmon/v1/devices/${row.device_id}/telemetry`, row.payload, { qos: 1, retain: false }, error => {
      // PUBACK intentionally does not remove anything from the outbox.
      if (error && this.flight === row && !this.stopping && this.ready) this.retry(row, `发布错误：${error.message}`);
    });
  }
  retry(row, reason) {
    if (this.flight !== row || !this.ready || this.stopping) return;
    clearTimeout(this.deliveryTimer);
    const delay = Math.min(30000, this.config.retryBaseMs * 2 ** Math.min(row.attempts - 1, 15));
    this.log(`${reason} boot_id=${row.boot_id} seq=${row.seq}，${delay}ms 后重试（保留原始消息）`);
    this.deliveryTimer = setTimeout(() => this.send(row), delay);
  }
  onAck(ack) {
    if (!validAck(ack)) { this.log('忽略格式不完整的 ACK'); return; }
    if (!this.flight || !sameIdentity(ack, this.flight)) { this.log(`忽略未匹配或重复 ACK seq=${ack.seq}`); return; }
    if (!this.outbox.settle(ack)) return;
    clearTimeout(this.deliveryTimer);
    this.flight = null;
    if (ack.status === 'rejected') this.log(`永久拒收 seq=${ack.seq} ${ack.error.code}: ${ack.error.message}（原因已保存） queue=${this.outbox.count()}`);
    else this.log(`入库确认 status=${ack.status} boot_id=${ack.boot_id} seq=${ack.seq} queue=${this.outbox.count()}`);
    this.onSettled(ack);
    // Drain backlog on each ACK without waiting for the next sampling interval.
    queueMicrotask(() => this.pump());
  }
  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    clearInterval(this.sampler);
    clearTimeout(this.deliveryTimer);
    clearTimeout(this.reconnectTimer);
    this.stopPromise = (async () => {
      const client = this.client;
      if (client) {
        await new Promise(resolve => {
          let ended = false;
          const finish = () => { if (!ended) { ended = true; clearTimeout(timeout); client.end(true, {}, resolve); } };
          const timeout = setTimeout(finish, 1000);
          if (client.connected) client.publish(`${this.baseTopic}/status`, this.status('offline'), { qos: 1, retain: true }, finish);
          else finish();
        });
      }
      this.log(`正常退出，待发队列保留 queue=${this.outbox.count()}`);
      this.outbox.close();
    })();
    return this.stopPromise;
  }
}
