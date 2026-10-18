import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxy = { '/api': { target: env.DEV_API_TARGET || 'http://127.0.0.1:3000', changeOrigin: true, timeout: 0, proxyTimeout: 0 } };
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            includeDependenciesRecursively: false,
            groups: [
              // Keep tslib out of the app entry to avoid a chart -> entry cycle.
              { name: 'chart-utils', test: /[\\/]node_modules[\\/]tslib[\\/]/ },
              { name: 'renderer', test: /[\\/]node_modules[\\/]zrender[\\/]/ },
              { name: 'charts', test: /[\\/]node_modules[\\/]echarts[\\/]/ },
            ],
          },
        },
      },
    },
  };
});
