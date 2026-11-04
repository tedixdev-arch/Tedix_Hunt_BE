import type { RequestHandler } from 'express';
import type { AuthRequest } from './auth.js';
import { Audit, type AuditCategory } from '../models/Audit.js';

/**
 * L6/L1.6: records successful privileged actions after the response is sent. Rules match the
 * method and path; only allowlisted body fields are kept, so passwords and tokens never reach the log.
 * Settings changes are recorded in their own transaction (PlatformSettings.update) with before/after values.
 */
interface Rule {
  method: string; path: RegExp; action: string; category: AuditCategory; targetType: string;
  summary: (m: string[], body: Record<string, any>) => string; keep?: readonly string[];
}
const id = '([0-9a-fA-F-]{36})';
const key = '([a-z0-9][a-z0-9-]{0,199})';
const rules: Rule[] = [
  { method: 'POST', path: /^\/api\/admin\/users\/professional$/, action: 'user.provisioned', category: 'users', targetType: 'user',
    summary: (_m, b) => `Provisioned ${b.role ?? 'professional'} ${b.email ?? ''}`.trim(), keep: ['email', 'name', 'role', 'organizationName'] },
  { method: 'POST', path: /^\/api\/admin\/users\/admin$/, action: 'admin.provisioned', category: 'users', targetType: 'user',
    summary: (_m, b) => `Provisioned Admin ${b.email ?? ''}`.trim(), keep: ['email', 'name'] },
  { method: 'PATCH', path: new RegExp(`^/api/admin/users/${id}$`), action: 'user.updated', category: 'users', targetType: 'user',
    summary: () => 'Edited user profile', keep: ['email', 'name'] },
  { method: 'DELETE', path: new RegExp(`^/api/admin/users/${id}$`), action: 'user.removed', category: 'users', targetType: 'user', summary: () => 'Removed user account' },
  { method: 'PUT', path: new RegExp(`^/api/admin/users/${id}/password$`), action: 'user.password_replaced', category: 'users', targetType: 'user', summary: () => 'Replaced user password' },
  { method: 'POST', path: new RegExp(`^/api/admin/users/${id}/block$`), action: 'user.blocked', category: 'users', targetType: 'user', summary: () => 'Blocked user' },
  { method: 'POST', path: new RegExp(`^/api/admin/users/${id}/unblock$`), action: 'user.unblocked', category: 'users', targetType: 'user', summary: () => 'Unblocked user' },
  { method: 'POST', path: new RegExp(`^/api/admin/users/${id}/roles/([a-z]+)$`), action: 'user.role_granted', category: 'users', targetType: 'user', summary: m => `Granted ${m[2]} role` },
  { method: 'DELETE', path: new RegExp(`^/api/admin/users/${id}/roles/([a-z]+)$`), action: 'user.role_removed', category: 'users', targetType: 'user', summary: m => `Removed ${m[2]} role` },
  { method: 'POST', path: new RegExp(`^/api/organizer-applications/${id}/approve$`), action: 'organizer_application.approved', category: 'applications', targetType: 'organizer_application', summary: () => 'Approved Organizer application' },
  { method: 'POST', path: new RegExp(`^/api/organizer-applications/${id}/reject$`), action: 'organizer_application.rejected', category: 'applications', targetType: 'organizer_application', summary: () => 'Rejected Organizer application', keep: ['reason'] },
  { method: 'POST', path: new RegExp(`^/api/creator-applications/${id}/approve$`), action: 'creator_application.approved', category: 'applications', targetType: 'creator_application', summary: () => 'Approved Creator application' },
  { method: 'POST', path: new RegExp(`^/api/creator-applications/${id}/reject$`), action: 'creator_application.rejected', category: 'applications', targetType: 'creator_application', summary: () => 'Rejected Creator application', keep: ['reason'] },
  { method: 'POST', path: new RegExp(`^/api/admin/templates/review/${key}/approve$`), action: 'template.approved', category: 'templates', targetType: 'template', summary: (m, b) => `Approved Template ${m[1]}${b.version ? ` v${b.version}` : ''}`, keep: ['version'] },
  { method: 'POST', path: new RegExp(`^/api/admin/templates/review/${key}/request-changes$`), action: 'template.changes_requested', category: 'templates', targetType: 'template', summary: m => `Requested changes to Template ${m[1]}`, keep: ['version', 'reason', 'notes'] },
  { method: 'PATCH', path: new RegExp(`^/api/admin/templates/review/${key}/checkpoint-radii$`), action: 'template.radii_changed', category: 'templates', targetType: 'template', summary: m => `Changed detection radii of Template ${m[1]}`, keep: ['checkpointPositions', 'finishPoint'] },
  { method: 'POST', path: new RegExp(`^/api/admin/templates/${key}/suspend$`), action: 'template.suspended', category: 'templates', targetType: 'template', summary: (m, b) => `Suspended Template ${m[1]}${b.version ? ` v${b.version}` : ''}`, keep: ['version', 'reason'] },
  { method: 'POST', path: new RegExp(`^/api/admin/locality-proposals/${id}/decision$`), action: 'locality_proposal.decided', category: 'templates', targetType: 'locality_proposal', summary: (_m, b) => `Decided locality proposal${b.decision ? `: ${b.decision}` : ''}`, keep: ['decision', 'reason'] },
  { method: 'POST', path: new RegExp(`^/api/geography/cities/(\\d+)/registration$`), action: 'city.registered', category: 'templates', targetType: 'city', summary: m => `Registered catalog city ${m[1]}` },
  { method: 'POST', path: new RegExp(`^/api/hunts/${id}/(publish|start|pause|resume|cancel|finish)$`), action: 'hunt.lifecycle', category: 'hunts', targetType: 'hunt', summary: m => `Hunt ${({ publish: 'published', start: 'started', pause: 'paused', resume: 'resumed', cancel: 'cancelled', finish: 'finished' } as Record<string, string>)[m[2]]}` },
  { method: 'PATCH', path: new RegExp(`^/api/hunts/${id}/checkpoint-radii$`), action: 'hunt.radii_changed', category: 'hunts', targetType: 'hunt', summary: () => 'Changed Hunt detection radii', keep: ['checkpointPositions', 'finishPoint'] },
  { method: 'POST', path: new RegExp(`^/api/hunts/${id}/participants/${id}/checkpoints/${id}/check-in$`), action: 'safety.arrival_confirmed', category: 'safety', targetType: 'hunt', summary: () => 'Organizer confirmed participant arrival (GPS fallback)' },
  { method: 'POST', path: new RegExp(`^/api/hunts/${id}/help-requests/${id}/resolve$`), action: 'safety.help_resolved', category: 'safety', targetType: 'hunt', summary: () => 'Resolved participant help request' },
  { method: 'PATCH', path: new RegExp(`^/api/admin/custom-hunt-requests/${id}$`), action: 'custom_request.updated', category: 'requests', targetType: 'custom_hunt_request', summary: (_m, b) => b.status ? `Custom Hunt request set to ${b.status}` : 'Updated custom Hunt request note', keep: ['status'] },
  { method: 'POST', path: /^\/api\/auth\/change-password$/, action: 'account.password_changed', category: 'account', targetType: 'user', summary: () => 'Changed own password' },
];

const extraDetails = (rule: Rule, m: string[]): Record<string, string> =>
  rule.action === 'safety.arrival_confirmed' ? { participantId: m[2], checkpointId: m[3] }
    : rule.action === 'safety.help_resolved' ? { helpRequestId: m[2] }
    : rule.action === 'hunt.lifecycle' ? { transition: m[2] } : {};

// Unit tests mock individual queries; opt in explicitly (AUDIT_TRAIL=on) where a test covers auditing.
const enabled = () => process.env.NODE_ENV !== 'test' || process.env.AUDIT_TRAIL === 'on';

export const auditTrail: RequestHandler = (req: AuthRequest, res, next) => {
  const path = req.originalUrl.split('?')[0];
  const rule = enabled() ? rules.find(r => r.method === req.method && r.path.test(path)) : undefined;
  if (!rule) { next(); return; }
  // Only the created identity's id is read from the response; tokens in it are never stored.
  let createdId: string | undefined;
  const json = res.json.bind(res);
  res.json = (payload: any) => { if (typeof payload?.user?.id === 'string') createdId = payload.user.id; return json(payload); };
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300 || !req.user) return;
    const match = rule.path.exec(path)!;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, any> : {};
    const kept = Object.fromEntries((rule.keep ?? []).filter(k => body[k] !== undefined).map(k => [k, body[k]]));
    const targetId = rule.action === 'user.provisioned' || rule.action === 'admin.provisioned' ? createdId : match[1];
    Audit.record({ actor: req.user, action: rule.action, category: rule.category, targetType: rule.targetType, targetId,
      summary: rule.summary(match, body), details: { ...kept, ...extraDetails(rule, match) } })
      .catch(error => console.error('Audit event could not be recorded', rule.action, error instanceof Error ? error.message : error));
  });
  next();
};
