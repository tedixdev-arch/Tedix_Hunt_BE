import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from './migrate.js';
import approval from './migrations/027_local_template_approval.js';
import type { Migration } from './migrations/types.js';

const testUrl = process.env.TEST_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const databaseName = `local_guards_${randomUUID().replaceAll('-', '')}`;

suite('Local approval authority adversarial SQL transactions', () => {
  const root = new Pool({ connectionString: testUrl });
  let db: Pool;
  let creator: string;
  let admin: string;
  let other: string;
  let formerAdmin: string;
  const history: Record<string, string> = {};

  const identity = async (client: Pool | PoolClient = db) => {
    const key = `guard-${randomUUID()}`;
    const id = (await client.query(`INSERT INTO hunt_templates
      (key,origin,category,created_by_user_id,status) VALUES ($1,'creator','local',$2,'draft') RETURNING id`,
    [key, creator])).rows[0].id;
    for (const version of [1, 2, 3]) await client.query(`INSERT INTO hunt_template_versions
      (template_id,version,content,origin,category,created_by_user_id)
      VALUES ($1,$2,$3,'creator','local',$4)`, [id, version, { key, version }, creator]);
    return id as string;
  };
  const evidence = (client: Pool | PoolClient, id: string, version: number, reviewer = admin) => client.query(
    `INSERT INTO hunt_template_reviews (template_id,version,reviewer_user_id,decision)
     VALUES ($1,$2,$3,'approved')`, [id, version, reviewer],
  );
  const promote = (client: PoolClient, id: string, version = 1) => client.query(
    `UPDATE hunt_templates SET status='approved',local_approved_version=$2 WHERE id=$1`, [id, version],
  );
  const submitted = async () => {
    const id = await identity();
    await db.query("UPDATE hunt_templates SET status='submitted',submitted_version=1 WHERE id=$1", [id]);
    return id;
  };
  const approved = async () => {
    const id = await submitted();
    const client = await db.connect();
    try {
      await client.query('BEGIN'); await promote(client, id); await evidence(client, id, 1); await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    return id;
  };
  const snapshot = async (id: string) => ({
    identity: (await db.query('SELECT * FROM hunt_templates WHERE id=$1', [id])).rows,
    versions: (await db.query('SELECT * FROM hunt_template_versions WHERE template_id=$1 ORDER BY version', [id])).rows,
    reviews: (await db.query('SELECT * FROM hunt_template_reviews WHERE template_id=$1 ORDER BY version', [id])).rows,
  });
  const transaction = async (action: (client: PoolClient) => Promise<void>) => {
    const client = await db.connect();
    try { await client.query('BEGIN'); await action(client); }
    finally { await client.query('ROLLBACK'); client.release(); }
  };

  beforeAll(async () => {
    await root.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(testUrl!); url.pathname = `/${databaseName}`;
    db = new Pool({ connectionString: url.toString() });
    const client = await db.connect();
    try {
      await client.query(await readFile(new URL('./pre_migration_baseline.sql', import.meta.url), 'utf8'));
      const directory = new URL('./migrations/', import.meta.url);
      const migrations: Migration[] = [];
      for (const file of (await readdir(directory)).filter(n => /^\d{3}_.*\.ts$/.test(n) && n < '027').sort()) {
        migrations.push((await import(new URL(file, directory).href)).default);
      }
      await runMigrations(client, migrations);
      creator = (await client.query("INSERT INTO users (role) VALUES ('creator') RETURNING id")).rows[0].id;
      other = (await client.query("INSERT INTO users (role) VALUES ('creator') RETURNING id")).rows[0].id;
      admin = (await client.query("INSERT INTO users (role) VALUES ('admin') RETURNING id")).rows[0].id;
      await client.query("INSERT INTO user_roles VALUES ($1,'admin')", [admin]);
      formerAdmin = (await client.query("INSERT INTO users (role) VALUES ('admin') RETURNING id")).rows[0].id;
      await client.query("INSERT INTO user_roles VALUES ($1,'admin')", [formerAdmin]);
      for (const kind of ['capture-pin-drift', 'fabricated-savepoint', 'fabricated-savepoint-commit', 'old-review', 'valid-capture', 'self', 'older-approved', 'capture-final-check']) {
        const id = await identity(client); history[kind] = id;
        if (kind !== 'old-review') await client.query("UPDATE hunt_templates SET status='approved',submitted_version=1 WHERE id=$1", [id]);
        if (!kind.startsWith('fabricated-savepoint')) await evidence(client, id, 1, kind === 'self' ? creator : kind === 'valid-capture' ? formerAdmin : admin);
        if (kind === 'older-approved') {
          await client.query('UPDATE hunt_templates SET submitted_version=2 WHERE id=$1', [id]);
          await evidence(client, id, 2);
        }
      }
      await runMigrations(client, [...migrations, approval]);
      await client.query("UPDATE users SET account_status='retired' WHERE id=$1", [formerAdmin]);
      await client.query("DELETE FROM user_roles WHERE user_id=$1", [formerAdmin]);
    } finally { client.release(); }
  }, 30_000);
  afterAll(async () => { await db?.end(); await root.query(`DROP DATABASE IF EXISTS "${databaseName}"`); await root.end(); });

  it('rejects a compatibility capture followed by approved candidate pin drift', async () => {
    const id = history['capture-pin-drift']; const before = await snapshot(id);
    await transaction(async client => {
      await client.query('UPDATE hunt_templates SET local_approved_version=submitted_version WHERE id=$1', [id]);
      await expect(client.query('UPDATE hunt_templates SET submitted_version=2 WHERE id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it('rechecks an established pointer when the approved pin changes without changing the pointer', async () => {
    const id = await approved(); const before = await snapshot(id);
    await transaction(async client => {
      await expect(client.query('UPDATE hunt_templates SET submitted_version=2 WHERE id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it('rejects fabricated same-transaction historical evidence inside a savepoint', async () => {
    const id = history['fabricated-savepoint']; const before = await snapshot(id);
    await transaction(async client => {
      await client.query('SAVEPOINT fabricated_evidence');
      await expect(evidence(client, id, 1, other)).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT fabricated_evidence');
      await expect(client.query('UPDATE hunt_templates SET local_approved_version=1 WHERE id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it('cannot commit an independent non-Admin review laundered through a subtransaction as historical evidence', async () => {
    const id = history['fabricated-savepoint-commit']; const before = await snapshot(id);
    await expect(transaction(async client => {
      await client.query('SAVEPOINT manufacture_history');
      await evidence(client, id, 1, other);
      await client.query('RELEASE SAVEPOINT manufacture_history');
      await client.query('UPDATE hunt_templates SET local_approved_version=1 WHERE id=$1', [id]);
      await client.query('COMMIT');
    })).rejects.toMatchObject({ code: '23514' });
    expect(await snapshot(id)).toEqual(before);
  });

  it.each(['draft', 'submitted'])('refuses old committed-review promotion after candidate changes to %s', async status => {
    const id = history['old-review']; const before = await snapshot(id);
    await transaction(async client => {
      if (status === 'submitted') await client.query("UPDATE hunt_templates SET status='submitted',submitted_version=1 WHERE id=$1", [id]);
      await expect(promote(client, id)).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it('refuses an older historical approval even after attempts to rewrite its compatibility pin', async () => {
    const id = history['older-approved']; const before = await snapshot(id);
    await transaction(async client => {
      await expect(client.query('UPDATE hunt_templates SET local_approved_version=1 WHERE id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    });
    await transaction(async client => {
      await expect(client.query('UPDATE hunt_templates SET submitted_version=1 WHERE id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it('refuses regression after a legitimate newer independent approval', async () => {
    const id = await approved();
    await transaction(async client => {
      await client.query("UPDATE hunt_templates SET status='submitted',submitted_version=2 WHERE id=$1", [id]);
      await promote(client, id, 2); await evidence(client, id, 2); await client.query('COMMIT');
    });
    const before = await snapshot(id);
    await transaction(async client => {
      await expect(client.query('UPDATE hunt_templates SET local_approved_version=1 WHERE id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it('refuses capture of self-reviewed historical evidence', async () => {
    const id = history.self; const before = await snapshot(id);
    await transaction(async client => {
      await expect(client.query('UPDATE hunt_templates SET local_approved_version=1 WHERE id=$1', [id])).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it.each(['self', 'nonadmin', 'missing-role', 'blocked', 'retired', 'guest', 'missing-review'])
  ('rejects %s new approval evidence at COMMIT after multiple identity updates', async kind => {
    const id = await submitted(); const before = await snapshot(id);
    const reviewer = kind === 'self' ? creator : kind === 'nonadmin' ? other
      : (await db.query("INSERT INTO users (role) VALUES ('admin') RETURNING id")).rows[0].id;
    if (!['self', 'nonadmin', 'missing-role'].includes(kind)) await db.query("INSERT INTO user_roles VALUES ($1,'admin')", [reviewer]);
    const actorBefore = (await db.query('SELECT * FROM users WHERE id=$1', [reviewer])).rows;
    await transaction(async client => {
      await promote(client, id);
      await client.query('UPDATE hunt_templates SET updated_at=clock_timestamp() WHERE id=$1', [id]);
      if (kind !== 'missing-review') await evidence(client, id, 1, reviewer);
      if (['blocked','retired'].includes(kind)) await client.query('UPDATE users SET account_status=$2 WHERE id=$1', [reviewer, kind]);
      if (kind === 'guest') await client.query('UPDATE users SET is_guest=true WHERE id=$1', [reviewer]);
      await client.query('UPDATE hunt_templates SET updated_at=clock_timestamp() WHERE id=$1', [id]);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
    expect((await db.query('SELECT * FROM users WHERE id=$1', [reviewer])).rows).toEqual(actorBefore);
  });
  it('rejects a nonexistent reviewer at its FK and rolls back the pending pointer', async () => {
    const id = await submitted(); const before = await snapshot(id);
    await transaction(async client => {
      await promote(client, id);
      await expect(evidence(client, id, 1, randomUUID())).rejects.toMatchObject({ code: '23503' });
      await client.query('COMMIT'); // PostgreSQL rolls back an aborted transaction.
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it('rechecks Admin membership removed after an initially valid review insertion', async () => {
    const id = await submitted(); const before = await snapshot(id);
    await transaction(async client => {
      await promote(client, id); await evidence(client, id, 1);
      await client.query("DELETE FROM user_roles WHERE user_id=$1 AND role='admin'", [admin]);
      await client.query('UPDATE hunt_templates SET updated_at=clock_timestamp() WHERE id=$1', [id]);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
    expect((await db.query("SELECT 1 FROM user_roles WHERE user_id=$1 AND role='admin'", [admin])).rowCount).toBe(1);
  });
  it.each(['draft', 'submitted', 'changes_requested'])('rejects an intermediate approval followed by final %s candidate at COMMIT', async status => {
    const id = await submitted(); const before = await snapshot(id);
    await transaction(async client => {
      await promote(client, id); await evidence(client, id, 1);
      await client.query('UPDATE hunt_templates SET status=$2,submitted_version=$3 WHERE id=$1', [id, status, status === 'draft' ? null : 2]);
      await client.query('UPDATE hunt_templates SET updated_at=clock_timestamp() WHERE id=$1', [id]);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it.each(['ordinary', 'savepoint'])('cannot insert historical evidence before promotion in a %s transaction', async scope => {
    const id = await submitted(); const before = await snapshot(id);
    await transaction(async client => {
      if (scope === 'savepoint') await client.query('SAVEPOINT insert_before_promotion');
      await expect(evidence(client, id, 1)).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it('rolls back at COMMIT when a review insertion was undone at a savepoint', async () => {
    const id = await submitted(); const before = await snapshot(id);
    await transaction(async client => {
      await promote(client, id);
      await client.query('SAVEPOINT evidence_write'); await evidence(client, id, 1);
      await client.query('ROLLBACK TO SAVEPOINT evidence_write'); await client.query('RELEASE SAVEPOINT evidence_write');
      await client.query('UPDATE hunt_templates SET updated_at=clock_timestamp() WHERE id=$1', [id]);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
  });
  it.each(['capture-final-check', 'established'])('independently validates final authority for %s even if the immediate guard fails', async kind => {
    const id = kind === 'established' ? await approved() : history[kind]; const before = await snapshot(id);
    const originalGuard = (await db.query("SELECT pg_get_functiondef('protect_local_template_authority()'::regprocedure) AS definition")).rows[0].definition;
    await transaction(async client => {
      if (kind === 'established') await client.query('UPDATE hunt_templates SET updated_at=clock_timestamp() WHERE id=$1', [id]);
      else await client.query('UPDATE hunt_templates SET local_approved_version=1 WHERE id=$1', [id]);
      // Disposable-test fault injection: isolate the deferred guard. Restore the
      // immediate function before COMMIT; the failed COMMIT rolls back all test DDL.
      // ALTER TABLE cannot disable triggers while deferred events are pending.
      await client.query('CREATE OR REPLACE FUNCTION protect_local_template_authority() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$');
      await client.query('UPDATE hunt_templates SET submitted_version=2 WHERE id=$1', [id]);
      await client.query(originalGuard);
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    });
    expect(await snapshot(id)).toEqual(before);
    expect((await db.query("SELECT pg_get_functiondef('protect_local_template_authority()'::regprocedure) AS definition")).rows[0].definition).toBe(originalGuard);
  });
  it('accepts real compatibility capture after prior metadata updates and with a retired historical reviewer', async () => {
    const id = history['valid-capture']; const before = await snapshot(id);
    await transaction(async client => {
      await client.query('UPDATE hunt_templates SET updated_at=clock_timestamp() WHERE id=$1', [id]);
      await client.query('SAVEPOINT compatibility_capture');
      await client.query('UPDATE hunt_templates SET local_approved_version=1 WHERE id=$1', [id]);
      await client.query("UPDATE hunt_templates SET status='draft',submitted_version=NULL WHERE id=$1", [id]);
      await client.query('RELEASE SAVEPOINT compatibility_capture'); await client.query('COMMIT');
    });
    const after = await snapshot(id);
    expect(after.identity[0]).toMatchObject({ local_approved_version: 1, status: 'draft', submitted_version: null });
    expect(after.reviews).toEqual(before.reviews); expect(after.versions).toEqual(before.versions);
  });
  it('accepts valid approval with savepoints and multiple identity writes when the final candidate is exact', async () => {
    const id = await submitted();
    await transaction(async client => {
      await client.query('SAVEPOINT approval_write'); await promote(client, id); await client.query('RELEASE SAVEPOINT approval_write');
      await evidence(client, id, 1);
      await client.query("UPDATE hunt_templates SET status='draft',submitted_version=NULL WHERE id=$1", [id]);
      await client.query("UPDATE hunt_templates SET status='approved',submitted_version=1 WHERE id=$1", [id]);
      await client.query('UPDATE hunt_templates SET updated_at=clock_timestamp() WHERE id=$1', [id]);
      await client.query('COMMIT');
    });
    const after = await snapshot(id);
    expect(after.identity[0]).toMatchObject({ local_approved_version: 1, status: 'approved', submitted_version: 1 });
    expect(after.reviews).toHaveLength(1); expect(after.reviews[0].reviewer_user_id).toBe(admin);
  });
  it('does not withdraw retained authority when its original Admin later loses capability', async () => {
    const reviewer = (await db.query("INSERT INTO users (role) VALUES ('admin') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO user_roles VALUES ($1,'admin')", [reviewer]);
    const id = await submitted();
    await transaction(async client => { await promote(client, id); await evidence(client, id, 1, reviewer); await client.query('COMMIT'); });
    const before = await snapshot(id);
    await db.query('DELETE FROM user_roles WHERE user_id=$1', [reviewer]);
    await db.query("UPDATE users SET account_status='retired' WHERE id=$1", [reviewer]);
    await db.query("UPDATE hunt_templates SET status='draft',submitted_version=NULL WHERE id=$1", [id]);
    const after = await snapshot(id);
    expect(after.identity[0].local_approved_version).toBe(1); expect(after.reviews).toEqual(before.reviews);
  });

});
