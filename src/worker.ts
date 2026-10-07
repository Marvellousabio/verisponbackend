import { config } from './config.js';
import { pool, requirePool } from './db/pool.js';
import { runWorkers } from './services/outbox-worker.js';

if (!config.ENABLE_WORKERS) {
  throw new Error('ENABLE_WORKERS=true is required to start the worker process');
}

await runWorkers(requirePool());

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await pool?.end();
    process.exit(0);
  });
}