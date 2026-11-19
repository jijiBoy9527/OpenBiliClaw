import { root } from './environment.mjs';
import { serve } from '@hono/node-server';
// Use the official app directly so this deployment binds to loopback only.
import app from 'dailyhot-api/dist/app.js';

const server = serve({
  fetch: request => new URL(request.url).pathname === '/__workspace'
    ? Response.json({ root, pid: process.pid, service: 'dailyhot-api', version: '2.0.8' })
    : app.fetch(request),
  hostname: '127.0.0.1', port: 6688,
}, info => {
  console.log(`DailyHotApi ready: http://127.0.0.1:${info.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
