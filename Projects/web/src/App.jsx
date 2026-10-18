import { useEffect, useRef, useState } from 'react';
import { DEVICE_ID, METRICS, WINDOW_MS, formatTime, formatValue, metricByKey } from './metrics.js';
import { freshness } from './model.js';
import { useMonitoring } from './useMonitoring.js';
import Icon from './components/Icon.jsx';
import TrendChart from './components/TrendChart.jsx';
import HistoryView from './components/HistoryView.jsx';
import ThresholdDialog from './components/ThresholdDialog.jsx';

function AnimatedNumber({ value, digits, animate }) {
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    let frame;
    const before = previous.current;
    previous.current = value;
    if (typeof value !== 'number' || typeof before !== 'number' || !animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { setDisplay(value); return; }
    const start = performance.now();
    const step = (time) => {
      const progress = Math.min(1, (time - start) / 480);
      setDisplay(before + (value - before) * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, animate]);
  return <>{formatValue(display, digits)}</>;
}

function thresholdText(rule) {
  if (!rule) return '阈值尚未同步';
  if (!rule.enabled) return '提醒已关闭';
  if (rule.lower != null && rule.upper != null) return `演示范围 ${rule.lower}–${rule.upper}`;
  if (rule.upper != null) return `演示上限 ${rule.upper}`;
  if (rule.lower != null) return `演示下限 ${rule.lower}`;
  return '未设置边界';
}

export default function App() {
  const [tab, setTab] = useState('live');
  const [metric, setMetric] = useState('co2_ppm');
  const [thresholdOpen, setThresholdOpen] = useState(false);
  const data = useMonitoring(metric);
  const quality = freshness(data.latest, data.device, data.now);
  const selected = metricByKey(metric);
  const connected = data.connection === 'open';
  const connectionLabel = connected ? '实时连接已建立' : data.connection === 'connecting' ? '正在连接实时服务' : '连接失败 · 自动重试';
  const qualityLabel = { empty: '等待采样', unknown: '采样时间未知', stale: '数据已过期', fresh: '数据新鲜' }[quality];
  const activeAlarms = data.alarms || [];
  function tabKeys(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'live' : event.key === 'End' ? 'history' : tab === 'live' ? 'history' : 'live';
    setTab(next); document.getElementById(`tab-${next}`)?.focus();
  }
  return <>
    <a className="skip-link" href="#main-content">跳至主要内容</a>
    <header className="site-header"><div className="header-inner"><a className="brand" href="/" aria-label="知境首页"><span className="brand-symbol"><Icon name="leaf" size={26} /></span><span className="brand-name">知境<span>教室环境监测</span></span></a><div className="header-right"><span className="header-caption">让环境被看见，让学习更舒适</span><span className={`connection-pill ${connected ? 'online' : 'pending'}`} role="status"><i className="status-dot" />{connectionLabel}</span></div></div></header>
    <main className="main-shell" id="main-content">
      <div className="workspace-bar"><div className="tab-list" role="tablist" aria-label="监测视图" onKeyDown={tabKeys}>{[['live', '实时看板', 'grid'], ['history', '历史查询', 'history']].map(([key, label, icon]) => <button id={`tab-${key}`} key={key} role="tab" aria-selected={tab === key} aria-controls={`panel-${key}`} tabIndex={tab === key ? 0 : -1} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}><Icon name={icon} size={17} />{label}</button>)}</div><button className="button secondary threshold-trigger" onClick={() => setThresholdOpen(true)}><Icon name="settings" size={17} />阈值设置</button></div>
      {tab === 'live' ? <section className="view-enter" id="panel-live" role="tabpanel" aria-labelledby="tab-live">
        <div className="view-intro"><div><p className="eyebrow">A BETTER SPACE TO LEARN</p><h1>教室里的舒适，一目了然<span className="title-dot">.</span></h1><p>在每一次呼吸、每一束光里，感知学习空间的变化。</p></div><div className="room-label"><span className="room-icon"><Icon name="room" size={24} /></span><div><strong>教室 001</strong><span>环境监测节点 001</span></div></div></div>
        <div className="overview-line"><div className="overview-tags"><span className="source-tag">{data.latest?.source === 'hardware' ? '硬件数据' : data.latest?.source === 'simulator' ? '虚拟数据 · 模拟节点' : '虚拟节点 · 等待数据源确认'}</span><span className={`quality-tag ${quality}`}><i className="status-dot" />{qualityLabel}</span></div><span className="last-update"><Icon name="clock" size={14} /> 最近采样 {formatTime(data.latest?.sampled_at)}</span></div>
        {data.snapshotError && <div className="connection-banner" role="alert"><Icon name="signal" size={18} /><span><strong>暂时无法同步最新快照</strong><span>{data.snapshotError}</span></span><button onClick={data.retry}>重新连接 <Icon name="refresh" size={14} /></button></div>}
        {quality === 'stale' && <div className="stale-banner" role="status"><Icon name="clock" size={16} /> 最新有效采样已超过 10 秒，当前保留最后读数，等待新鲜数据。</div>}
        {quality === 'unknown' && <div className="stale-banner" role="status"><Icon name="clock" size={16} /> 设备未提供有效采样时间，以下为最近接收读数，不作为新鲜采样或采样时间曲线。</div>}
        <div className="metric-grid" aria-label="最新环境指标">{METRICS.map((item) => {
          const value = data.latest?.metrics?.[item.key];
          const alarm = activeAlarms.find((entry) => entry.metric === item.key);
          return <button className={`metric-card ${metric === item.key ? 'selected' : ''} ${alarm ? 'has-alarm' : ''}`} key={item.key} aria-pressed={metric === item.key} onClick={() => setMetric(item.key)}>
            <div className="metric-card-top"><span className="metric-icon"><Icon name={item.icon} size={21} /></span><span className="metric-state">{value == null ? '缺测' : alarm ? `${alarm.state === 'high' ? '高于' : '低于'}阈值` : quality === 'fresh' ? '最新读数' : qualityLabel}</span></div>
            <h2>{item.name}</h2><div className="metric-reading" data-testid={`value-${item.key}`}><span><AnimatedNumber value={value} digits={item.digits} animate={quality === 'fresh'} /></span><small>{item.unit}</small></div>
            <div className="metric-card-bottom"><span>{value == null ? data.latest ? '此项暂无有效采样' : '等待设备采样' : thresholdText(data.config?.rules?.[item.key])}</span><Icon name="arrow" size={15} /></div>
          </button>;
        })}</div>
        <div className="dashboard-grid"><section className="panel live-chart"><div className="panel-heading"><div><p className="eyebrow">LIVE TREND</p><h2>环境变化趋势</h2></div><span className="soft-tag"><Icon name="clock" size={13} /> 最近 10 分钟</span></div><div className="chart-toolbar"><div className="metric-switch" aria-label="趋势指标">{METRICS.map((item) => <button key={item.key} aria-pressed={metric === item.key} className={metric === item.key ? 'active' : ''} onClick={() => setMetric(item.key)}>{item.name}</button>)}</div></div>
          <TrendChart points={data.points} metric={selected} start={data.now - WINDOW_MS} end={data.now} loading={data.seriesStatus.loading} error={data.seriesStatus.error} onRetry={data.refreshSeries} />
          <div className="chart-footer"><span><i className="legend-dot" /> {selected.name}<span className="footer-unit">{selected.unit}</span></span><span>按采样时间 · 缺测留空</span></div>
        </section><aside className="status-column"><section className="panel status-panel"><div className="small-panel-heading"><h2>监测状态</h2><Icon name="signal" size={18} /></div><div className="device-heading"><span className={`device-orb ${data.device?.online ? 'online' : ''}`}><Icon name="room" size={25} /></span><div><strong>教室环境节点</strong><span><i className={`status-dot ${data.device?.online ? 'green' : ''}`} />{data.device ? data.device.online ? '设备在线' : '设备离线' : '设备状态待同步'}</span></div></div><dl className="device-details"><div><dt>设备标识</dt><dd className="device-id">{DEVICE_ID}</dd></div><div><dt>最近接收</dt><dd>{formatTime(data.device?.last_seen_at || data.latest?.received_at)}</dd></div><div><dt>有效采样</dt><dd>{formatTime(data.latest?.time_quality === 'device' ? data.latest.sampled_at : null)}</dd></div><div><dt>时间质量</dt><dd>{!data.latest ? '暂无数据' : data.latest.time_quality === 'device' ? '设备采样时间' : '仅接收时间'}</dd></div><div><dt>阈值配置</dt><dd>{data.config ? `v${data.config.version} · 已同步` : '尚未同步'}</dd></div></dl>{data.configError && <p className="config-warning">阈值同步失败，可在设置中重试。</p>}</section>
          <section className={`panel alarm-panel ${activeAlarms.length ? 'warning' : ''}`} aria-live="polite"><div className="small-panel-heading"><h2>当前环境提醒</h2><span className="count-badge">{activeAlarms.length || '—'}</span></div><span className="alarm-symbol"><Icon name={activeAlarms.length ? 'warning' : data.alarms === null ? 'clock' : 'check'} size={22} /></span><strong>{data.alarms === null ? '等待报警状态同步' : activeAlarms.length ? `${activeAlarms.length} 项指标需要留意` : '暂无活动报警'}</strong>{activeAlarms.length ? <ul className="alarm-list">{activeAlarms.map((alarm) => <li key={`${alarm.metric}-${alarm.state}`}><span>{metricByKey(alarm.metric).name}</span><b>{alarm.state === 'high' ? '高于上限' : '低于下限'}</b><small>触发于 {formatTime(alarm.triggered_at)}</small></li>)}</ul> : <p>{quality === 'fresh' && connected ? '后端将持续判断超限与恢复。' : '等待新鲜采样与后端确认。'}</p>}{(!connected || quality !== 'fresh') && activeAlarms.length > 0 && <p>显示最近同步状态，等待新鲜采样确认。</p>}<button className="text-button" onClick={() => setThresholdOpen(true)}>查看演示阈值 <Icon name="arrow" size={14} /></button></section>
        </aside></div><p className="page-note"><Icon name="leaf" size={15} /> 以数据了解环境，让每一间教室更适合学习。<span>粉尘读数为传感器浓度估算值。</span></p>
      </section> : <HistoryView />}
      <footer className="site-footer"><span>知境 <i /> 教室环境监测</span><span>毕业设计 · 基础演示</span></footer>
    </main>
    {data.notice && data.now - data.notice.at < 12000 && <div className="toast" role="status"><Icon name="check" size={18} />{data.notice.message}</div>}
    {thresholdOpen && <ThresholdDialog config={data.config} onClose={() => setThresholdOpen(false)} onSaved={data.setConfig} />}
  </>;
}
