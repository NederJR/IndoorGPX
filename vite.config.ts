import { defineConfig } from 'vite';

export default defineConfig({
  // No GitHub Pages o app fica em /<repositório>/; o workflow define BASE_PATH.
  base: process.env.BASE_PATH ?? '/',
  server: { host: true, port: 5173 },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        stravaCallback: 'strava-callback.html',
      },
    },
  },
});
