import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import { readDatabaseConfig } from '../config/database.js';

const migrate = async () => {
  const direction = process.argv[2];
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('Expected up or down.');
  }
  await runner({
    databaseUrl: readDatabaseConfig(),
    dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
    direction,
    ...(direction === 'down' ? { count: 1 } : {}),
    migrationsTable: 'pgmigrations',
    checkOrder: true,
    singleTransaction: true,
    // Runner errors can contain SQL/connection details; keep operator output safe.
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  console.log(`PostgreSQL migration ${direction} completed.`);
};

migrate().catch(() => {
  console.error('Migration failed. Check DATABASE_URL, database permissions and migration order.');
  process.exitCode = 1;
});
