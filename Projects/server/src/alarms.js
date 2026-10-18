import { METRICS } from './config.js';

export class AlarmState {
  constructor(config, staleAfterMs) {
    this.config = config;
    this.staleAfterMs = staleAfterMs;
    this.states = new Map(METRICS.map(metric => [metric, { active: null, candidate: null, count: 0, recovery: 0 }]));
    this.lastSampleMs = null;
  }
  resetCounts() {
    for (const state of this.states.values()) {
      state.candidate = null;
      state.count = 0;
      state.recovery = 0;
    }
  }
  configure(config) {
    this.config = config;
    this.resetCounts();
  }
  alarms() {
    return [...this.states.entries()].filter(([, state]) => state.active).map(([metric, state]) => ({ metric, ...state.active }));
  }
  sample(record, now) {
    const ms = Date.parse(record.sampled_at);
    if (record.time_quality !== 'device' || !Number.isFinite(ms) || now - ms > this.staleAfterMs ||
        ms > now + 5000 || (this.lastSampleMs !== null && ms <= this.lastSampleMs)) return false;
    if (this.lastSampleMs !== null && ms - this.lastSampleMs > this.staleAfterMs) this.resetCounts();
    this.lastSampleMs = ms;
    const before = JSON.stringify(this.alarms());
    for (const metric of METRICS) {
      const rule = this.config.rules[metric];
      const state = this.states.get(metric);
      const value = record.metrics[metric];
      // A missing measurement is neither a normal reading nor a recovery sample.
      if (value === null) {
        state.count = 0;
        state.candidate = null;
        state.recovery = 0;
        continue;
      }
      const side = rule.enabled ? (rule.upper !== null && value > rule.upper ? 'high' :
        rule.lower !== null && value < rule.lower ? 'low' : null) : null;
      if (state.active) {
        const recovered = !rule.enabled || (
          (rule.lower === null || value >= rule.lower + (state.active.state === 'low' ? rule.hysteresis : 0)) &&
          (rule.upper === null || value <= rule.upper - (state.active.state === 'high' ? rule.hysteresis : 0))
        );
        state.recovery = recovered ? state.recovery + 1 : 0;
        if (state.recovery >= this.config.consecutive_samples) {
          state.active = null;
          state.recovery = 0;
          state.count = 0;
          state.candidate = null;
        }
      } else {
        state.count = side === null ? 0 : (side === state.candidate ? state.count + 1 : 1);
        state.candidate = side;
        if (state.count >= this.config.consecutive_samples) {
          state.active = { state: side, triggered_at: record.effective_at };
          state.count = 0;
          state.candidate = null;
        }
      }
    }
    return before !== JSON.stringify(this.alarms());
  }
}
