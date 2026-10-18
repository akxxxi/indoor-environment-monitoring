import { useEffect, useRef, useState } from 'react';
import { getThresholds, putThresholds } from '../api.js';
import { METRICS } from '../metrics.js';
import Icon from './Icon.jsx';

export default function ThresholdDialog({ config, onClose, onSaved }) {
  const dialog = useRef(null), controller = useRef(null);
  const [draft, setDraft] = useState(config ? structuredClone(config) : null);
  const [loading, setLoading] = useState(!config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function load(signal) {
    setLoading(true); setError('');
    try { const { data } = await getThresholds(signal); if (!signal.aborted) setDraft(structuredClone(data)); }
    catch (err) { if (!signal.aborted) setError(err.message); }
    finally { if (!signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    const modal = dialog.current;
    const abort = new AbortController();
    controller.current = abort;
    modal.showModal();
    if (!config) void load(abort.signal);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { abort.abort(); modal.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  function update(key, field, value) {
    setSaved(false);
    setDraft((current) => ({ ...current, rules: { ...current.rules, [key]: { ...current.rules[key], [field]: value } } }));
  }
  async function save(event) {
    event.preventDefault();
    const rules = Object.fromEntries(METRICS.map(({ key }) => {
      const rule = draft.rules[key];
      return [key, { ...rule, lower: rule.lower === '' ? null : rule.lower, upper: rule.upper === '' ? null : rule.upper }];
    }));
    for (const { key, name } of METRICS) {
      const rule = rules[key];
      if (!rule.enabled) continue;
      if (rule.lower == null && rule.upper == null) { setError(`${name}至少需要一个有效边界。`); return; }
      if (rule.lower != null && rule.upper != null && rule.lower >= rule.upper) { setError(`${name}的下限必须小于上限。`); return; }
    }
    setSaving(true); setError('');
    try {
      // Preserve server-owned engineering parameters; only omit version as required.
      const { version, ...body } = draft;
      const { data } = await putThresholds({ ...body, rules }, controller.current.signal);
      if (!controller.current.signal.aborted) { setDraft(structuredClone(data)); setSaved(true); onSaved(data); }
    } catch (err) { if (!controller.current.signal.aborted) setError(err.message); }
    finally { if (!controller.current.signal.aborted) setSaving(false); }
  }
  return <dialog ref={dialog} className="threshold-dialog" aria-labelledby="threshold-title" onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }} onClick={(event) => { if (event.target === dialog.current && !saving) onClose(); }}>
    <div className="dialog-inner">
      <div className="dialog-heading"><span className="section-icon"><Icon name="settings" /></span><button className="icon-button" aria-label="关闭阈值设置" disabled={saving} onClick={onClose}><Icon name="close" /></button></div>
      <p className="eyebrow">DEMO THRESHOLDS</p><h2 id="threshold-title">给环境设一道提醒</h2>
      <p className="dialog-description">工程演示阈值，不代表国家标准。留空表示不设置该侧边界，报警与恢复均由后端判断。</p>
      {loading ? <p className="inline-status"><Icon name="refresh" className="spinning" /> 正在读取已保存的阈值…</p> : draft && <form onSubmit={save}>
        <div className="threshold-table"><div className="threshold-row table-label"><span>指标 / 启用</span><span>下限</span><span>上限</span></div>
          {METRICS.map((metric) => {
            const rule = draft.rules[metric.key];
            return <div className="threshold-row" key={metric.key}>
              <label className="rule-name"><input type="checkbox" checked={rule.enabled} onChange={(event) => update(metric.key, 'enabled', event.target.checked)} disabled={saving} /><span>{metric.name}<small>{metric.unit}</small></span></label>
              {['lower', 'upper'].map((field) => <input key={field} aria-label={`${metric.name}${field === 'lower' ? '下限' : '上限'}`} type="number" step="any" min={metric.key === 'temperature_c' ? undefined : 0} max={metric.key === 'humidity_rh' ? 100 : undefined} placeholder="不限" value={rule[field] ?? ''} disabled={saving || !rule.enabled} onChange={(event) => update(metric.key, field, event.target.value === '' ? null : Number(event.target.value))} />)}
            </div>;
          })}
        </div>
        <p className="config-note"><Icon name="clock" size={15} /> 连续 {draft.consecutive_samples} 条新鲜有效采样后确认超限，保留服务端恢复缓冲配置。</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {saved && <p className="save-success" role="status"><Icon name="check" size={16} /> 已保存到后端 · 配置版本 {draft.version}。后续新采样将按新规则判断。</p>}
        <div className="dialog-actions"><button type="button" className="button secondary" disabled={saving} onClick={onClose}>{saved ? '完成' : '取消'}</button><button className="button primary" disabled={saving || saved} type="submit">{saving ? '正在保存…' : saved ? '已保存' : '保存阈值'}<Icon name={saved ? 'check' : 'arrow'} size={16} /></button></div>
      </form>}
      {!loading && !draft && <div><p className="form-error" role="alert">{error || '尚未获取阈值配置。'}</p><button className="button secondary" onClick={() => load(controller.current.signal)}>重新读取</button></div>}
    </div>
  </dialog>;
}
