import { useEffect, useRef, useState } from 'react';
import { getSeries } from '../api.js';
import { METRICS, formatTime, metricByKey } from '../metrics.js';
import { validateRange } from '../model.js';
import TrendChart from './TrendChart.jsx';
import Icon from './Icon.jsx';

function localInput(time) {
  const date = new Date(time);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function HistoryView() {
  const [range, setRange] = useState('1');
  const [metric, setMetric] = useState('co2_ppm');
  const [start, setStart] = useState(() => localInput(Date.now() - 3600000));
  const [end, setEnd] = useState(() => localInput(Date.now()));
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [validation, setValidation] = useState('');
  const requestRef = useRef(null), queryRef = useRef(0);
  async function query(event, selectedMetric = metric) {
    event?.preventDefault();
    const to = range === 'custom' ? Date.parse(end) : Date.now();
    const from = range === 'custom' ? Date.parse(start) : to - Number(range) * 3600000;
    const message = validateRange(from, to);
    if (message) { setValidation(message); return; }
    setValidation(''); setError(''); setLoading(true); setResult(null);
    requestRef.current?.abort();
    const abort = new AbortController();
    requestRef.current = abort;
    const token = ++queryRef.current;
    try {
      const response = await getSeries(selectedMetric, from, to, abort.signal);
      if (!abort.signal.aborted && token === queryRef.current) setResult({ ...response, start: from, end: to, metric: selectedMetric });
    } catch (err) { if (!abort.signal.aborted) setError(err.message); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }
  useEffect(() => { void query(); return () => requestRef.current?.abort(); }, []);
  // Editing a filter invalidates the in-flight response and its previous chart.
  function changeFilter(update) {
    requestRef.current?.abort(); queryRef.current += 1;
    setLoading(false); setResult(null); setError(''); setValidation(''); update();
  }
  const selected = metricByKey(metric);
  const values = result?.data.filter((point) => typeof point.value === 'number').map((point) => point.value) || [];
  return <section className="view-enter" id="panel-history" role="tabpanel" aria-labelledby="tab-history">
    <div className="view-intro"><div><p className="eyebrow">LOOK BACK, SEE MORE</p><h1>回看环境的每一次变化<span className="title-dot">.</span></h1><p>选择一段时间，让数据告诉你教室里的故事。</p></div><span className="outline-tag"><Icon name="history" size={15} /> 最长查询 7 天</span></div>
    <section className="panel history-filter" aria-label="历史查询条件"><form onSubmit={query}>
      <div className="filter-top"><div><span className="field-caption">时间范围</span><div className="range-buttons">{[['1', '最近 1 小时'], ['6', '最近 6 小时'], ['24', '最近 24 小时'], ['custom', '自定义']].map(([key, text]) => <button key={key} type="button" className={range === key ? 'selected' : ''} aria-pressed={range === key} onClick={() => changeFilter(() => setRange(key))}>{text}</button>)}</div></div>
      <label className="metric-select">选择指标<select value={metric} onChange={(event) => changeFilter(() => setMetric(event.target.value))}>{METRICS.map((item) => <option key={item.key} value={item.key}>{item.name} · {item.unit}</option>)}</select></label>
      <button className="button primary query-button" type="submit" disabled={loading}>{loading ? '查询中…' : '查询趋势'}<Icon name={loading ? 'refresh' : 'arrow'} size={16} className={loading ? 'spinning' : ''} /></button></div>
      {range === 'custom' && <div className="custom-dates"><label>开始时间<input type="datetime-local" value={start} onChange={(event) => changeFilter(() => setStart(event.target.value))} required /></label><span>至</span><label>结束时间<input type="datetime-local" value={end} onChange={(event) => changeFilter(() => setEnd(event.target.value))} required /></label><small>使用当前浏览器的本地时间</small></div>}
      {validation && <p className="form-error" role="alert">{validation}</p>}
    </form></section>
    <section className="panel history-chart"><div className="panel-heading"><div><p className="eyebrow">HISTORICAL TREND</p><h2>{selected.name}<span className="unit-label">{selected.unit}</span></h2></div><span className="soft-tag">{result ? `${values.length} 个有效聚合点` : '按时间聚合'}</span></div>
      {!result && !loading && !error ? <div className="history-prompt"><Icon name="history" size={30} /><strong>查询条件已就绪</strong><p>点击“查询趋势”查看所选时间和指标。</p></div> : <TrendChart points={result?.data || []} metric={selected} start={result?.start} end={result?.end} loading={loading} error={error} onRetry={() => query()} history />}
      <div className="chart-footer"><span><i className="legend-dot" /> {selected.name}</span><span>{result ? `${formatTime(new Date(result.start).toISOString(), true)} — ${formatTime(new Date(result.end).toISOString(), true)} · ${result.meta?.bucket_seconds ?? '—'} 秒/桶` : '缺测保留为空，曲线不补零'}</span></div>
    </section><p className="page-note"><Icon name="clock" size={14} /> 查询基于有效采样时间，时间范围含起点、不含终点；采样时间未知的记录不计入曲线。</p>
  </section>;
}
