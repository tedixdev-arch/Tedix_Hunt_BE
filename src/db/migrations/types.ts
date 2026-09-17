import type { PoolClient } from 'pg';

export interface Migration {
  id: string;
  up: (client: PoolClient) => Promise<void>;
}
