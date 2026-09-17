import { pool } from './postgres.js';

// Readiness is deliberately read-only and uses the application's shared pool.
export const checkDatabaseReadiness = async (): Promise<void> => {
  await pool.query('SELECT 1');
};
