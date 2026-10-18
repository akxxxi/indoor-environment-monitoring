import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, getLatest, getSeries, getThresholds } from './api.js';
import { DEVICE_ID, WINDOW_MS, metricByKey } from './metrics.js';
import { addRecord, livePoints, newest, recordTime } from './model.js';

export function useMonitoring(metric) {
  const [latest, setLatest] = useState(null);
  const [device, setDevice] = useState(null);
  const [alarms, setAlarms] = useState(null);
  const [config, setConfigState] = useState(null);
  const [connection, setConnection] = useState('connecting');
  const [snapshotError, setSnapshotError] = useState('');
  const [configError, setConfigError] = useState('');
  const setConfig = useCallback((next) => {
    setConfigState((previous) => !previous || Number(next?.version) >= Number(previous.version) ? next : previous);
    setConfigError('');
  }, []);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [notice, setNotice] = useState(null);
  const [records, setRecords] = useState([]);
  const [series, setSeries] = useState({ points: [], end: 0, metric });
  const [seriesStatus, setSeriesStatus] = useState({ loading: true, error: '' });
  const [revision, setRevision] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const latestRef = useRef(null);
  const alarmsRef = useRef(null);
  const seriesBoundaryRef = useRef(0);
  const reconnectDelayRef = useRef(1000);

  useEffect(() => {
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      setRecords((items) => items.filter((item) => recordTime(item) >= time - WINDOW_MS));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true, busy = false, pending = false, alarmRevision = 0, deviceRevision = 0, configRevision = 0;
    let backfillTimer, reconnectTimer;
    const seen = new Set();
    const controller = new AbortController();
    setConnection('connecting');
    const applyAlarms = (next) => {
      if (!Array.isArray(next)) return;
      const restored = alarmsRef.current?.filter((old) => !next.some((alarm) => alarm.metric === old.metric && alarm.state === old.state));
      if (restored?.length) setNotice({ message: `${restored.map((alarm) => metricByKey(alarm.metric).name).join('、')}：后端已确认报警恢复。`, at: Date.now() });
      alarmsRef.current = next;
      setAlarms(next);
    };
    const loadSnapshot = async () => {
      if (busy) { pending = true; return; }
      busy = true;
      const a = alarmRevision, d = deviceRevision;
      try {
        const { data } = await getLatest(controller.signal);
        if (!active) return;
        const previous = latestRef.current;
        const merged = newest(previous, data);
        latestRef.current = merged;
        setLatest(merged);
        // A snapshot older than a just-arrived measurement cannot restore old status.
        if (data && merged === data) {
          if (d === deviceRevision) setDevice(data.device || null);
          if (a === alarmRevision) applyAlarms(data.alarms);
        }
        if (!data && !previous) { setDevice(null); applyAlarms([]); }
        setSnapshotError('');
      } catch (error) {
        if (active) setSnapshotError(error.message || '无法获取最新数据，请检查后端服务。');
      } finally {
        busy = false;
        if (active) {
          setSnapshotLoading(false);
          if (pending) { pending = false; void loadSnapshot(); }
        }
      }
    };
    const loadConfig = async () => {
      const c = configRevision;
      try {
        const { data } = await getThresholds(controller.signal);
        if (active && c === configRevision) { setConfig(data); setConfigError(''); }
      } catch (error) { if (active) setConfigError(error.message); }
    };
    // Subscribe first, then reconcile REST. Event revisions protect state arriving in flight.
    const stream = new EventSource(`${API_BASE}/events?${new URLSearchParams({ device_id: DEVICE_ID })}`);
    const listen = (name, handle) => stream.addEventListener(name, (event) => {
      if (!active) return;
      let data;
      try { data = JSON.parse(event.data); } catch { setSnapshotError('收到无法解析的实时事件，请重新同步。'); return; }
      if (data.device_id !== DEVICE_ID) return;
      handle(data);
    });
    stream.onopen = () => {
      if (!active) return;
      reconnectDelayRef.current = 1000;
      setConnection('open');
      void loadSnapshot();
      void loadConfig();
      setRevision((value) => value + 1);
    };
    stream.onerror = () => {
      if (!active) return;
      setConnection('reconnecting');
      // A proxy 500/502 or invalid MIME response can permanently close EventSource.
      // Native retry handles CONNECTING; CLOSED needs a fresh subscription.
      if (stream.readyState === 2 && !reconnectTimer) {
        stream.close();
        reconnectTimer = setTimeout(() => { if (active) setAttempt(value => value + 1); }, reconnectDelayRef.current);
        reconnectDelayRef.current = Math.min(15000, reconnectDelayRef.current * 2);
      }
    };
    listen('measurement.created', (data) => {
      if (data.id == null || seen.has(String(data.id))) return;
      seen.add(String(data.id));
      if (seen.size > 2400) seen.delete(seen.values().next().value);
      const previous = latestRef.current;
      const merged = newest(previous, data);
      latestRef.current = merged;
      setLatest(merged);
      setRecords((items) => addRecord(items, data, Date.now()));
      // A sample may commit after the REST query but carry a time inside its range.
      // Re-fetch that range so late samples are reconciled by server aggregation.
      if (data.time_quality === 'device' && recordTime(data) < seriesBoundaryRef.current && recordTime(data) >= Date.now() - WINDOW_MS && !backfillTimer) {
        backfillTimer = setTimeout(() => { backfillTimer = undefined; if (active) setRevision((value) => value + 1); }, 500);
      }
      void loadSnapshot();
    });
    listen('device.updated', (data) => { deviceRevision += 1; setDevice(data); });
    listen('alarm.changed', (data) => { alarmRevision += 1; applyAlarms(data.alarms); });
    listen('thresholds.updated', (data) => { configRevision += 1; setConfig(data.config); setConfigError(''); });
    void loadSnapshot();
    void loadConfig();
    return () => {
      active = false;
      stream.close();
      controller.abort();
      clearTimeout(backfillTimer);
      clearTimeout(reconnectTimer);
    };
  }, [attempt]);

  useEffect(() => {
    const controller = new AbortController();
    const end = Date.now();
    seriesBoundaryRef.current = end;
    setSeriesStatus({ loading: true, error: '' });
    getSeries(metric, end - WINDOW_MS, end, controller.signal).then(({ data, meta }) => {
      if (controller.signal.aborted) return;
      setSeries({ points: data, end, metric, meta });
      setSeriesStatus({ loading: false, error: '' });
    }).catch((error) => {
      if (!controller.signal.aborted) {
        setSeries({ points: [], end: 0, metric });
        setSeriesStatus({ loading: false, error: error.message });
      }
    });
    return () => controller.abort();
  }, [metric, revision, attempt]);

  const points = useMemo(() => livePoints(series.metric === metric ? series : { points: [], end: 0 }, records, metric, now), [series, records, metric, now]);
  return { latest, device, alarms, config, setConfig, configError, connection, snapshotError, snapshotLoading, notice, now, points, seriesStatus, retry: () => setAttempt((value) => value + 1), refreshSeries: () => setRevision((value) => value + 1) };
}
