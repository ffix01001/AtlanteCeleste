import { defineConfig } from 'vite';

// In sviluppo (npm run dev) le chiamate /api vanno al server Python locale.
// Nella build i file hanno nomi fissi (senza codici casuali): aggiornando il
// programma si sovrascrivono invece di accumularsi. Il server li serve con
// "Cache-Control: no-cache", quindi il browser prende sempre l'ultima versione.
const output = {
  entryFileNames: 'assets/[name].js',
  chunkFileNames: 'assets/[name].js',
  // i caratteri tipografici non cambiano mai: tengono il loro codice (stabile, legato al contenuto)
  assetFileNames: (info: { names?: string[] }) =>
    /\.(woff2?|ttf|otf)$/i.test(info.names?.[0] ?? '') ? 'assets/[name]-[hash][extname]' : 'assets/[name][extname]',
};
// i worker hanno un prefisso proprio: i loro moduli interni non devono scontrarsi con quelli principali
const workerOutput = {
  entryFileNames: 'assets/worker-[name].js',
  chunkFileNames: 'assets/worker-[name].js',
  assetFileNames: 'assets/worker-[name][extname]',
};

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8765',
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rolldownOptions: { output },
  },
  worker: {
    format: 'es',
    rolldownOptions: { output: workerOutput },
  },
});
