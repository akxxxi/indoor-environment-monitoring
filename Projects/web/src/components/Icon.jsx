const paths = {
  leaf: <><path d="M5 16C5 6 12 3 21 3c0 9-3 16-12 16"/><path d="m6 19 10-10"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  history: <><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7"/><path d="M12 7v5l3 2"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/></>,
  temperature: <><path d="M9 14V5a3 3 0 0 1 6 0v9a5 5 0 1 1-6 0Z"/><path d="M12 8v9"/><circle cx="12" cy="18" r="1"/></>,
  humidity: <><path d="M12 3s-7 8-7 12a7 7 0 0 0 14 0c0-4-7-12-7-12Z"/><path d="M9 16a3 3 0 0 0 3 3"/></>,
  air: <><path d="M3 8h12a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h5a3 3 0 1 1-3 3"/></>,
  dust: <><circle cx="7" cy="6" r="2"/><circle cx="17" cy="10" r="3"/><circle cx="7" cy="17" r="3"/><path d="M18 18h.01M12 3h.01M3 11h.01"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
  refresh: <><path d="M20 7a9 9 0 0 0-15-2L3 8m0-5v5h5M4 17a9 9 0 0 0 15 2l2-3m0 5v-5h-5"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  warning: <><path d="m10 4-8 14a2 2 0 0 0 2 3h16a2 2 0 0 0 2-3L14 4a2.3 2.3 0 0 0-4 0Z"/><path d="M12 9v4m0 4h.01"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  signal: <><path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r=".5"/></>,
  room: <><path d="M3 21V5l9-3v19M12 7h8v14M1 21h22M6 7v1m3-2v1m-3 4v1m3-2v1m-3 4v1m3-2v1m6-6v1m3-1v1m-3 3v1m3-1v1"/></>,
  chart: <><path d="M3 3v18h18M6 15l4-5 4 3 6-8"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
};
export default function Icon({ name, size = 20, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.chart}</svg>;
}
