import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { AriaComponent, GridComponent, TooltipComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import { formatValue } from '../metrics.js';
import Icon from './Icon.jsx';

echarts.use([LineChart, GridComponent, TooltipComponent, AriaComponent, SVGRenderer]);

export default function TrendChart({ points, metric, start, end, loading, error, onRetry, history = false }) {
  const container = useRef(null), instance = useRef(null);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const validCount = points.filter((point) => typeof point.value === 'number' && Number.isFinite(point.value)).length;
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const listener = () => setReduced(media.matches);
    media.addEventListener('change', listener);
    const chart = echarts.init(container.current, null, { renderer: 'svg' });
    instance.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(container.current);
    return () => { observer.disconnect(); media.removeEventListener('change', listener); chart.dispose(); instance.current = null; };
  }, []);
  useEffect(() => {
    instance.current?.setOption({
      animation: !reduced, animationDuration: 350, animationDurationUpdate: 420,
      aria: { enabled: true, description: `${metric.name}时间趋势，单位${metric.unit}，共${validCount}个有效数据点。` },
      grid: { top: 28, right: 22, bottom: 36, left: 12, containLabel: true },
      tooltip: { trigger: 'axis', confine: true, backgroundColor: '#fff', borderColor: '#e4eae6', textStyle: { color: '#344840', fontSize: 12 }, valueFormatter: (value) => `${formatValue(value, metric.digits)} ${metric.unit}` },
      xAxis: { type: 'time', min: start, max: end, splitNumber: history ? 5 : 4, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#8a9590', fontSize: 11, hideOverlap: true, formatter: (value) => new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) }, splitLine: { show: false } },
      yAxis: { type: 'value', scale: true, name: metric.unit, nameTextStyle: { color: '#8a9590', align: 'left', padding: [0, 0, 0, 4] }, splitNumber: 4, axisLabel: { color: '#8a9590', fontSize: 11 }, splitLine: { lineStyle: { color: '#edf0ed', type: 'dashed' } } },
      series: [{ type: 'line', name: metric.name, data: points.map((point) => [Date.parse(point.time), point.value]), connectNulls: false, smooth: false, showSymbol: validCount === 1, symbolSize: 6, lineStyle: { width: 2.5, color: '#238a73' }, itemStyle: { color: '#238a73' }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(35,138,115,0.16)' }, { offset: 1, color: 'rgba(35,138,115,0.005)' }]) } }],
    }, { notMerge: true });
  }, [points, metric, start, end, reduced, validCount, history]);
  return <div className="chart-wrap" aria-busy={loading}>
    <div ref={container} className="chart-canvas" />
    {(loading || error || !validCount) && <div className="chart-overlay">
      <span className={`empty-icon ${loading ? 'spinning' : ''}`}><Icon name={loading ? 'refresh' : error ? 'signal' : 'chart'} size={25} /></span>
      <strong>{loading ? '正在获取曲线' : error ? '曲线暂时无法加载' : points.length ? '此范围内没有有效指标值' : history ? '这个时间段还没有数据' : '等待第一条环境数据'}</strong>
      <p>{loading ? '正在与监测服务同步' : error || (history ? '试试其他时间范围或指标。' : '设备开始采样后，趋势将在这里呈现。')}</p>
      {error && <button className="text-button" onClick={onRetry}>重新加载 <Icon name="arrow" size={14} /></button>}
    </div>}
  </div>;
}
