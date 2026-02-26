import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type OutputBundle } from 'rollup';
import { type Plugin, defineConfig, loadEnv } from 'vite';

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version?: string };
const APP_VERSION = process.env.APP_VERSION || packageJson.version || '0.0.0';

const noCacheHeaders = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

const versionManifestPlugin: Plugin = {
  name: 'bridge-version-manifest',
  generateBundle(_options, bundle: OutputBundle) {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify(
        {
          version: APP_VERSION,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    });

  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiBaseUrl = env.VITE_API_BASE_URL?.trim();
  const hasApiBaseUrl = Boolean(apiBaseUrl);

  if (mode === 'development' && !hasApiBaseUrl) {
    console.warn(
      '[vite] VITE_API_BASE_URL is not set. Dev server will start without /api proxy. ' +
      'Set VITE_API_BASE_URL in .env.local to enable backend proxying.',
    );
  }

  return {
    plugins: [react(), versionManifestPlugin],
    publicDir: 'public',
    // Keep Vite dependency cache version-scoped to avoid stale chunk references
    // leaking between different app versions/branches.
    cacheDir: `node_modules/.vite/bridge-${APP_VERSION}`,
    define: {
      'process.env': {},
      global: 'window',
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    server: {
      port: 3000,
      headers: noCacheHeaders,
      proxy: hasApiBaseUrl
        ? {
            '/api': {
              target: apiBaseUrl,
              changeOrigin: true,
              secure: false,
            },
          }
        : undefined,
    },
    preview: {
      headers: noCacheHeaders,
    },
    // Avoid unstable Vite prebundling for capacitor/xmpp dependencies during local development.
    optimizeDeps: {
      // Force a fresh prebundle each startup so Windows clients don't hold stale
      // references to removed `.vite/deps/chunk-*.js` files after dependency changes.
      force: true,
      exclude: [
        // Native/cordova-capacitor packages regularly break Vite's prebundle cache.
        '@capacitor/secure-storage',
        'capacitor-secure-storage-plugin',
        '@aparajita/capacitor-biometric-auth',
        'cordova-plugin-fingerprint-aio',
        // strophe ships mixed module formats that can produce unstable dep chunks on Windows.
        'strophe.js',
        // strophe's XML parser dependency also appears in dep chunk traces for XMPP/media payload flow.
        '@xmldom/xmldom',
        // `abab` can be pulled by strophe and has CJS/ESM interop quirks.
        'abab',
      ],
    },

    build: {
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/services/xmppService') || id.includes('/services/e2eeService') || id.includes('/services/mediaCrypto')) {
              return 'messaging-core';
            }

            if (id.includes('/translations')) {
              return 'i18n-core';
            }

            if (!id.includes('node_modules')) return undefined;

            if (id.includes('react') || id.includes('scheduler')) {
              return 'react-vendor';
            }

            if (id.includes('react-router')) {
              return 'router-vendor';
            }

            if (id.includes('strophe.js') || id.includes('xmldom')) {
              return 'xmpp-vendor';
            }

            if (id.includes('lucide-react')) {
              return 'icons-vendor';
            }

            return 'vendor';
          },
        },
      },
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        // strophe.js imports named { atob, btoa } from `abab`, but modern `abab`
        // only ships default-style CJS exports in some environments.
        abab: fileURLToPath(new URL('./shims/abab.ts', import.meta.url)),
      },
    },
  };
});
