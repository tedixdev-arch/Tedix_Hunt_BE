# Content Library review (C2c-01)

## FE integration contract

All routes use the existing bearer authentication and authoritative `user_roles` capabilities. Owners need Creator; reviewers need Admin. An account with both roles cannot review its own Content. Nothing in this change edits Template exercises, publishes a Template or changes a Hunt snapshot.

| Method and route | Contract |
| --- | --- |
| `GET /api/creator/content` | Existing own **draft-head-only** list, unchanged by default. |
| `GET /api/creator/content?view=all` | All own current heads, including submitted, approved and changes requested. Existing `limit` (1–100, default 50) and `after` Content UUID cursor apply. |
| `GET /api/creator/content/:id` | Own current revision in any lifecycle state. |
| `GET /api/creator/content/:id/revisions/:revisionId` | Own exact historical revision, including feedback. |
| `POST /api/creator/content/:id/revisions/:revisionId/submit` | Empty body (or `{}`). Submit only the exact current draft. Returns 200 with updated envelope, same revision ID and version. |
| `POST /api/creator/content/:id/revisions` | Existing `{baseRevisionId}` cloning, including approved/changes-requested heads, creates a new draft. Draft cloning remains compatible. Submitted and archived heads cannot advance. |
| `GET /api/admin/content/review` | Current submitted queue. `limit` 1–100 (default 50); `after` is a **revision UUID** cursor. Returns `{items,nextAfter}`. Classification, category, curriculum, geography identifiers and submission time; no contact details or answers. |
| `GET /api/admin/content/review/:id/revisions/:revisionId` | Complete exact current submitted envelope: canonical exercise, geography, version, owner UUID and events. |
| `POST /api/admin/content/review/:id/revisions/:revisionId/approve` | Empty body or optional `{comment}`. Returns updated exact envelope. No exercise or metadata fields accepted. |
| `POST /api/admin/content/review/:id/revisions/:revisionId/request-changes` | `{comment}` required. Returns updated exact envelope. |

Comments are trimmed, 3–1000 characters, and must contain a letter or digit. Render as plain text. Every Content envelope adds `reviewEvents`, ordered by decision time and event UUID, for **that exact revision**. Events contain `eventId`, `contentId`, `revisionId`, `actorUserId`, `decision` (`submitted`, `approved`, `changes_requested`), nullable `comment` and `decidedAt`. The actor is the submitting owner for submission events and the reviewer for decisions. Timestamps are server generated. `updatedAt` keeps C2a's revision-creation meaning; use event times for submission/review activity.

Errors: 400 invalid canonical data/metadata/comment/identifiers, 401 missing or inactive identity, 403 wrong capability or self-review, 404 absent/mismatched/not-owned revision (Admin detail also requires current submission), 409 stale head, invalid transition or duplicate review. Refetch after 409; never silently substitute another revision. Existing draft updates remain append-only with the existing `baseRevisionId` optimistic concurrency check.

Submission requires a supported category (`Mathematics`, `History`, `Science`, `Mixed`) and the complete existing canonical Personal/Team exercise validation, including answer relations, hints, feedback and solution rules. Category can remain null in drafts. Curriculum remains optional for every category: there are no invented Main/Unit/Lesson identifiers or additional mathematics requirements. Geography uses the unchanged scope structure and catalog foreign keys. Navigation remains unsupported.

## Implementation and security report

Migration `043_content_review` adds an append-only event table. Composite revision foreign keys bind Content/revision pairs. Unique partial indexes allow one submission and one final decision per revision. Event insertion locks Content then revision, checks head, lifecycle, active database role membership, owner identity and reviewer independence, stamps the decision time, and changes status through a nested trigger. The event and status update commit or roll back together. API transactions use the same lock order and revalidate the exact locked stored payload with the canonical validator before inserting events. There are no lifecycle setters or caller-controlled session/GUC bypass flags.

Direct status updates and initially non-draft inserts are rejected by revision triggers. Review events cannot be updated or deleted; nonempty audit tables cannot be truncated. The empty-table truncate case exists only to permit isolated test fixture resets without removing any history. Submitted/archived heads cannot advance; approved history survives new draft revisions and later review. Payloads remain immutable for all revisions. No automatic archive or arbitrary lifecycle change is exposed.

### Database authorization limits

The project uses one shared PostgreSQL application connection role, with user identity established by JWT authentication in Express. It has no per-user database login or database-verifiable user credential. Therefore the database can validate that a supplied actor UUID is an active authorized independent user, **but cannot prove that the SQL caller is that user**. Anyone with arbitrary SQL access and the application's table write privileges could insert a syntactically valid review event using a different active Admin UUID. Such a path bypasses the application's canonical validation too; PostgreSQL enforces structural/geography constraints, not a duplicate of the TypeScript canonical validator. The supported API supplies actor IDs exclusively from authenticated users and accepts neither reviewer IDs nor status/payload mutations in decision bodies.

These guards enforce transition shape, exact-revision binding, independence, atomicity and immutable evidence through ordinary DML. They are not isolation from a compromised shared connection or a table owner/superuser. A database owner can alter triggers, grant privileges or replace functions. Production should keep migration ownership separate from the ordinary runtime role, deny runtime schema/function/trigger DDL and TRUNCATE, and grant only required DML. This PR does not redesign global authentication or connection provisioning. Genuine database verification of end-user identity requires a separately scoped identity/connection design; it is not claimed here.

C2a has no supported review API. The migration fails closed if legacy non-draft rows exist rather than fabricating reviewer evidence or silently revoking approvals. Operators must reconcile such records with verified provenance before retrying; no fabricated backfill is supplied. Normal C2a drafts and revision identities migrate unchanged. Fresh `schema.sql` contains matching guards.

### Future reuse boundary

Future C2d/C2e discovery can query an exact revision with `status='approved'` and join its `library_content_review_events` decision of `approved`. Do not select only `head_version`: an older approved revision remains approved when a newer draft exists. This PR adds no shared discovery, geographic allocation, Template assignment, gameplay, scoring or FE changes.

### Verification

The PostgreSQL route suite covers all 18 requested scenarios, plus restricted non-owner SQL, forged actor capability, lifecycle bypass attempts, request body restrictions and cursor validation. A dedicated migration test checks failed legacy promotion upgrades, preservation of C2a draft data, repeat migration safety, and fresh/upgrade schema parity. Existing Template/Hunt rows are compared before and after review. OpenAPI contract tests cover the exact routes and compatible listing.

Verification results (disposable PostgreSQL 17):

- Full BE suite: **82 files, 1,757 tests passed**, with `TEST_DATABASE_URL` set and file suites run sequentially to avoid shared database fixtures racing.
- `npm run typecheck` and `npm run build`: passed.
- Content API OpenAPI 3.0 validation (`@apidevtools/swagger-parser`, including all Content routes and their referenced schemas): passed.
- Full OpenAPI validation: **remaining pre-existing errors**, verified against an untouched `origin/main` archive. Main produced 472 validator diagnostics; this branch produces 355, with **zero new diagnostics**. Existing failures include malformed response objects outside Content and empty required arrays in non-Library exercise documentation. The Library documentation projection now omits empty required arrays; canonical exercise schemas and validation are unchanged. Out-of-scope routes are not modified to conceal the remaining failures.
- `git diff --check`: passed.

Stop for ChatGPT review. This change is intended as a Draft PR only; do not merge or deploy.
