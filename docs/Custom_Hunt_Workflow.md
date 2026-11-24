# Custom Hunt workflow

An Organizer asks for a Hunt that the approved Local templates cannot provide. The finished Hunt is an
ordinary Local template that only the requesting organization can see and use.

## Flow

| Step | Who | API | Request status |
| --- | --- | --- | --- |
| 1. Submit request (linked to the Organizer's organization) | Organizer | `POST /api/custom-hunt-requests` (`organizationId` optional; auto when the account has exactly one organization) | `new` |
| 2. Review | Admin | `PATCH /api/admin/custom-hunt-requests/:id` `{ status: 'in_review' }` | `in_review` |
| 3. Assign to a Creator (first assignment emails the Organizer "in work") | Admin | `POST /api/admin/custom-hunt-requests/:id/assign` `{ creatorUserId }` | `assigned` |
| 4. Build: create a Local template, then link it | Creator | `GET /api/creator/custom-requests`, `PUT /api/creator/custom-requests/:id/template` `{ key }` | `in_progress` |
| 5. Submit template for review | Creator | existing `POST /api/creator/templates/:key/submit` | `in_progress` |
| 6. Approve template (completes request, emails "ready") | Admin | existing `POST /api/admin/templates/review/:key/approve` | `completed` |
| 7. Schedule, publish and manage | Organizer | existing Local Hunt setup; the template is listed only for the requesting organization (`exclusive: true`) | — |

Admin can reject an open request at any time with a note for the Organizer
(`POST /api/admin/custom-hunt-requests/:id/reject` `{ organizerNote }`); the Organizer is emailed.
Rejecting or closing releases a linked template that has not been approved yet.

Organizers track their requests with `GET /api/custom-hunt-requests/mine`: `progress` is
`in_work` (new, in review, assigned, in progress), `done`, `rejected` or `closed` (legacy), plus `note`.

## Rules

- Only requests linked to an organization can be assigned (`409 organization_required`), because exclusivity needs an owner.
- A template can serve one request and a request has at most one template (`hunt_templates.custom_request_id UNIQUE`).
  Only the assigned Creator's own, not-yet-approved Local templates can be linked.
- Exclusivity is enforced in Local template discovery (organization membership) and in Hunt selection
  (`hunts.organization_id` must equal the request's organization). Custom templates do not count towards a
  city's public "has approved Local Hunt" flag.
- Creators see the brief (organization, city, date, participants, details), never the contact email or internal notes.

## Email

Emails are written to `email_outbox` in the same transaction as the status change and delivered after commit
(and retried every minute, up to 5 attempts). Configure `SMTP_URL` and `MAIL_FROM`; without `SMTP_URL`
messages are written to the server log and marked `logged`.
