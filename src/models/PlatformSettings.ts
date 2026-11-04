import { pool } from '../lib/postgres.js';
import { applySavedSettings, setting, validateSetting, settingDefinitions } from '../domain/platformSettings.js';
import { Audit } from './Audit.js';
import type { IUser } from './User.js';

export class InvalidSettingError extends Error { constructor(public readonly key: string) { super('invalid_setting'); } }

export const PlatformSettings = {
  async refresh() {
    const { rows } = await pool.query('SELECT key, value, updated_at, updated_by_user_id FROM platform_settings');
    applySavedSettings(rows);
  },

  /** Validates every change first, then saves all of them and the audit event in one transaction. */
  async update(changes: Record<string, unknown>, actor: IUser) {
    const normalized = Object.entries(changes).map(([key, value]) => {
      const result = validateSetting(key, value);
      if (!result.ok) throw new InvalidSettingError(key);
      return [key, result.value] as const;
    });
    const changed = normalized.filter(([key, value]) => JSON.stringify(setting(key)) !== JSON.stringify(value))
      .map(([key, value]) => ({ key, from: setting(key), to: value }));
    if (!changed.length) return [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const { key, to } of changed) {
        await client.query(`INSERT INTO platform_settings(key,value,updated_at,updated_by_user_id) VALUES($1,$2::jsonb,now(),$3)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by_user_id=EXCLUDED.updated_by_user_id`,
          [key, JSON.stringify(to), actor.id]);
      }
      const labels = changed.map(c => settingDefinitions.find(d => d.key === c.key)!.label);
      await Audit.record({ actor, action: 'settings.updated', category: 'settings', targetType: 'platform_settings',
        summary: `Changed ${labels.join(', ')}`, details: { changes: changed } }, client);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await PlatformSettings.refresh();
    return changed;
  },
};
