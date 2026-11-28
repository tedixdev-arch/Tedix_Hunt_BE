/**
 * Participation rules a Creator sets on a Template (Template Details): the supported Hunt format, the participant
 * range and, for Team Hunters, the team size range. A Hunt built from the Template inherits the format and must keep
 * its capacity and team size inside these ranges. Values are stored as text ("16–40", "3–5" or "4").
 */
export type HuntFormat = 'solo' | 'team';
export interface Range { min: number; max: number }
export interface TemplateParticipation { format: HuntFormat | null; participants: Range | null; teamSize: Range | null }

/** Teams always have 2–10 members. */
export const TEAM_SIZE_LIMITS: Range = { min: 2, max: 10 };

const record = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads "12–16", "12-16" or "4"; anything else (including open "18+") is not a usable range. */
export function parseRange(value: unknown): Range | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return { min: value, max: value };
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^\d{1,6}$/.test(text)) return Number(text) >= 1 ? { min: Number(text), max: Number(text) } : null;
  const parts = text.split(/\s*[–—-]\s*/);
  if (parts.length !== 2 || !parts.every(part => /^\d{1,6}$/.test(part))) return null;
  const range = { min: Number(parts[0]), max: Number(parts[1]) };
  return range.min >= 1 && range.min <= range.max ? range : null;
}

/** Format, participant and team size ranges from a Template snapshot; missing or legacy values are null. */
export function templateParticipation(snapshot: unknown): TemplateParticipation {
  const configuration = record(snapshot) && record(snapshot.configuration) ? snapshot.configuration : {};
  // 'Single and Team Hunters' is a legacy value meaning "either"; it does not fix the format.
  const format = configuration.format === 'Single Hunters' ? 'solo' : configuration.format === 'Team Hunters' ? 'team' : null;
  const team = format === 'solo' ? null : parseRange(configuration.teamSize);
  return {
    format,
    participants: parseRange(configuration.participants),
    teamSize: team && team.min >= TEAM_SIZE_LIMITS.min && team.max <= TEAM_SIZE_LIMITS.max ? team : null,
  };
}

export const inRange = (value: number, range: Range) => value >= range.min && value <= range.max;
export const rangeText = (range: Range) => range.min === range.max ? String(range.min) : `${range.min}–${range.max}`;

/**
 * Format and team size a Hunt takes when this Template is selected. The current team size is kept when the Template
 * still allows it; otherwise the pilot size 4 when allowed, else the Template minimum. Solo Hunts have no team size.
 * Without a Template format the Hunt keeps its own, defaulting to Team Hunters.
 */
export function participationForSelection(snapshot: unknown, current: { format: HuntFormat | null; teamSize: number | null }) {
  const rules = templateParticipation(snapshot);
  // Templates without a fixed format keep the Hunt's format, defaulting to the pilot's Team Hunters with teams of 4.
  const format: HuntFormat = rules.format ?? current.format ?? 'team';
  if (format === 'solo') return { format, teamSize: null };
  if (!rules.teamSize) return { format, teamSize: current.teamSize ?? 4 };
  const teamSize = current.teamSize !== null && inRange(current.teamSize, rules.teamSize) ? current.teamSize
    : inRange(4, rules.teamSize) ? 4 : rules.teamSize.min;
  return { format, teamSize };
}

/** Why a capacity/format/team size breaks the Template rules; null when it is allowed. */
export function participationViolation(snapshot: unknown, values: { format?: HuntFormat | null; teamSize?: number | null; capacity?: number | null }) {
  const rules = templateParticipation(snapshot);
  if (rules.format && values.format && values.format !== rules.format)
    return { error: 'format_fixed_by_template', message: `This Hunt's template is for ${rules.format === 'solo' ? 'Single Hunters' : 'Team Hunters'}.` };
  if (rules.participants && typeof values.capacity === 'number' && !inRange(values.capacity, rules.participants))
    return { error: 'capacity_out_of_template_range', message: `Participants must be between ${rules.participants.min} and ${rules.participants.max} for this template.`, min: rules.participants.min, max: rules.participants.max };
  if (rules.teamSize && typeof values.teamSize === 'number' && !inRange(values.teamSize, rules.teamSize))
    return { error: 'team_size_out_of_template_range', message: `Team size must be between ${rules.teamSize.min} and ${rules.teamSize.max} for this template.`, min: rules.teamSize.min, max: rules.teamSize.max };
  return null;
}
