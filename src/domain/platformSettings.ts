/**
 * L5 Platform Settings: true global configuration only (never per-Hunt options).
 * Values resolve as: Admin-saved value → environment override → documented default.
 * Reads are synchronous from an in-memory cache so hot paths (GPS checks, Template writes) never query;
 * the server refreshes the cache at startup, every 30 s, and immediately after an Admin saves.
 */
type Kind = 'integer' | 'boolean' | 'text' | 'choice';
interface Definition {
  key: string; group: 'gps' | 'checkpoints' | 'scoring' | 'gameplay' | 'safety' | 'sessions';
  label: string; help: string; kind: Kind; unit?: string;
  min?: number; max?: number; maxLength?: number; choices?: readonly string[];
  /** Shown to participants in the play screen. */
  public?: boolean;
  fallback: () => unknown;
}

const envInteger = (name: string, fallback: number, scale = 1) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed / scale) : fallback;
};
const envHours = (name: string, fallback: number) => {
  const match = /^(\d+)h$/.exec(process.env[name] ?? '');
  return match ? Number(match[1]) : fallback;
};

export const settingDefinitions: readonly Definition[] = [
  { key: 'gps.maxAgeSeconds', group: 'gps', label: 'Maximum location reading age', unit: 's', kind: 'integer', min: 5, max: 300,
    help: 'A check-in is accepted only if the phone reading is at most this old.', fallback: () => envInteger('GAMEPLAY_PROXIMITY_MAX_AGE_MS', 30, 1000) },
  { key: 'gps.maxAccuracyMeters', group: 'gps', label: 'Maximum reported GPS inaccuracy', unit: 'm', kind: 'integer', min: 1, max: 200,
    help: 'Readings the phone reports as less precise than this are rejected.', fallback: () => envInteger('GAMEPLAY_PROXIMITY_MAX_ACCURACY_METERS', 20) },
  { key: 'gps.uncertaintyRule', group: 'gps', label: 'Inaccuracy rule', kind: 'choice', choices: ['center', 'contained'],
    help: 'center: the reading point must be inside the radius. contained: distance plus inaccuracy must fit inside the radius (stricter).',
    fallback: () => process.env.GAMEPLAY_PROXIMITY_UNCERTAINTY === 'contained' ? 'contained' : 'center' },
  { key: 'checkpoints.defaultRadiusMeters', group: 'checkpoints', label: 'Default detection radius', unit: 'm', kind: 'integer', min: 5, max: 500,
    help: 'Applied when a Creator saves a checkpoint or FinishPoint without its own radius. Saved Templates and Hunts never change.', fallback: () => 25 },
  { key: 'scoring.applyWrongAnswerPenalty', group: 'scoring', label: 'Apply authored wrong-answer penalty', kind: 'boolean',
    help: "When off, a Template's wrong-answer penalty is ignored. Other authored points are unchanged.", fallback: () => true },
  { key: 'scoring.defaultPersonalPoints', group: 'scoring', label: 'Default points: private challenge', kind: 'integer', min: 0, max: 1000,
    help: 'Used only for content that has no authored scoring rules.', fallback: () => 100 },
  { key: 'scoring.defaultTeamPoints', group: 'scoring', label: 'Default points: team challenge', kind: 'integer', min: 0, max: 1000,
    help: 'Used only for content that has no authored scoring rules.', fallback: () => 100 },
  { key: 'gameplay.organizerCheckInEnabled', group: 'gameplay', label: 'Organizers may confirm arrival', kind: 'boolean',
    help: 'GPS fallback: an assigned Organizer confirms a participant is at their current checkpoint. Every use is audited.', fallback: () => true },
  { key: 'gameplay.answerAttemptsPerMinute', group: 'gameplay', label: 'Answer attempts per minute', kind: 'integer', min: 5, max: 120,
    help: 'Per participant. Protects against guessing by brute force.', fallback: () => 30 },
  { key: 'safety.emergencyNumber', group: 'safety', label: 'Emergency phone number', kind: 'text', maxLength: 20, public: true,
    help: 'Shown to participants on the Help screen and after an emergency report.', fallback: () => '112' },
  { key: 'safety.participantNotice', group: 'safety', label: 'Participant safety notice', kind: 'text', maxLength: 500, public: true,
    help: 'Shown on the Help screen and before the first checkpoint. Leave empty to show none.',
    fallback: () => 'Stay with your group, follow traffic rules and never enter private property. Ask your Organizer if anything feels unsafe.' },
  { key: 'sessions.guestSessionHours', group: 'sessions', label: 'Guest session length', unit: 'h', kind: 'integer', min: 1, max: 24,
    help: 'Guests have no refresh token. Applies to guest sessions started after the change.', fallback: () => envHours('GUEST_TOKEN_EXPIRES_IN', 4) },
];
const byKey = new Map(settingDefinitions.map(d => [d.key, d]));

let saved = new Map<string, { value: unknown; updatedAt: Date; updatedBy: string | null }>();

export function setting<T = unknown>(key: string): T {
  const definition = byKey.get(key);
  if (!definition) throw new Error(`Unknown platform setting ${key}`);
  return (saved.has(key) ? saved.get(key)!.value : definition.fallback()) as T;
}

export const publicSettings = () => Object.fromEntries(settingDefinitions.filter(d => d.public).map(d => [d.key, setting(d.key)]));

/** Returns a normalized value or null when the input is not allowed for this setting. */
export function validateSetting(key: string, value: unknown): { ok: true; value: unknown } | { ok: false } {
  const d = byKey.get(key);
  if (!d) return { ok: false };
  switch (d.kind) {
    case 'integer': return Number.isInteger(value) && (value as number) >= d.min! && (value as number) <= d.max! ? { ok: true, value } : { ok: false };
    case 'boolean': return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
    case 'choice': return d.choices!.includes(value as string) ? { ok: true, value } : { ok: false };
    case 'text': {
      if (typeof value !== 'string') return { ok: false };
      const text = value.normalize('NFC').trim();
      if (text.length > d.maxLength!) return { ok: false };
      if (key === 'safety.emergencyNumber' && !/^\+?[0-9 ]{2,20}$/.test(text)) return { ok: false };
      return { ok: true, value: text };
    }
  }
}

export function applySavedSettings(rows: Array<{ key: string; value: unknown; updated_at: Date; updated_by_user_id: string | null }>) {
  saved = new Map(rows.filter(r => byKey.has(r.key) && validateSetting(r.key, r.value).ok)
    .map(r => [r.key, { value: r.value, updatedAt: r.updated_at, updatedBy: r.updated_by_user_id }]));
}

export const settingsView = () => settingDefinitions.map(({ fallback, ...d }) => ({
  ...d, value: setting(d.key), defaultValue: fallback(), customized: saved.has(d.key),
  updatedAt: saved.get(d.key)?.updatedAt ?? null, updatedByUserId: saved.get(d.key)?.updatedBy ?? null,
}));
