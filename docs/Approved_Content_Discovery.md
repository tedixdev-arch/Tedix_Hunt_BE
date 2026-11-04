# Approved Content discovery (C2d-01)

## FE integration contract

Both routes require an authenticated, active, non-guest account with the existing Creator capability. They can read another Creator's approved exercise. Existing owner-only draft/revision writes and Admin review permissions are unchanged.

| Method and route | Response |
| --- | --- |
| `GET /api/creator/content/approved` | `{items,nextAfter}`; lightweight metadata, default 50, maximum 100 items. |
| `GET /api/creator/content/approved/:contentId/revisions/:revisionId` | Exact approved revision metadata plus complete canonical `exercise`. No fallback to another revision. |

Metadata: `contentId`, `revisionId`, `version`, `status` (`approved`), `classification` (`personal` or `team`), `type` (canonical mechanic), `title`, `category`, `curriculum`, and `geography`. Owner identities, review actors, contact data, answers and instructions are omitted from list results. Detail adds the unchanged complete exercise, preserving answers, interaction/validation data, hints, feedback, solution, whitespace, Unicode and LaTeX. Render exercise strings with the existing canonical renderer.

Every query parameter is optional:

| Parameter | Meaning |
| --- | --- |
| `classification` | `personal` or `team`. |
| `type` | One of the existing 15 Personal or seven Team mechanic identifiers; must agree with classification if supplied. |
| `category` | `Mathematics`, `History`, `Science`, `Mixed`. |
| `grade` | `5`–`12` matches an explicitly stored grade on Mathematics content. `unspecified` matches absent grade. Omit for all grades. No automatic inclusion of unspecified grades in a specific grade search. |
| `q` | Trimmed, case-insensitive literal substring in title or instructions, 1–200 characters. `%`, `_` and backslash have literal meanings. |
| `countryCode` | Uppercase two-letter canonical country code. |
| `admin1Code` | Canonical region identifier; requires countryCode. |
| `geographicId` | GeoNames city ID as a decimal string; requires countryCode. Cannot be combined with admin1Code. |
| `limit`, `after` | Limit 1–100, default 50; opaque `nextAfter` from the previous page. |

Example for Cluj-Napoca:

```http
GET /api/creator/content/approved?countryCode=RO&geographicId=681290&category=Mathematics&grade=5&limit=20
Authorization: Bearer <access-token>
```

A country search includes Universal and that Country. A region search also includes that exact canonical Region. A city search includes Universal, Country, its resolved Region and that exact City, excluding neighboring cities, other regions and other countries. Catalog identifiers establish hierarchy; labels and coordinates are never used to infer it. A city from another country or an unknown city falls back to Universal and the explicitly requested Country. A known city without a resolvable region includes its exact City but no unrelated Region. An unknown region includes Universal and Country only. Without geographic parameters, browsing includes all applicability scopes; a local Hunt or future allocation caller must supply its canonical location to use inclusive local eligibility.

Default listing selects the highest approved **version** per Content ID, then applies filters. It never substitutes an older matching version when the newest approved version does not match. A newer draft/submission/changes request does not hide existing approval. Exact detail keeps older approved revisions accessible. Status alone is insufficient: both endpoints require a matching immutable `approved` review event bound to the same Content and revision. Unsupported stored classification/mechanics are excluded. Starter/Template examples are not queried or treated as approval evidence.

Ordering is Content UUID ascending. On page one the server captures PostgreSQL transaction visibility; signed cursors preserve that horizon and the exact filter set for a 15-minute chain. Repeat the same filters on subsequent pages; limit may change. This excludes new approvals, including transactions already in progress on page one that commit later, and freezes the selected approved revision. Start a fresh search to see new approvals. Cursors are opaque and cannot authenticate requests. A malformed, tampered, expired or filter-mismatched cursor returns 400. Canonical catalog changes are not versioned by this cursor; it freezes approval visibility, not a geography catalog snapshot. Future approval revocation/archival must continue to fail closed.

Errors: 400 invalid query/identifiers/cursor, 401 missing/invalid/blocked/retired identity, 403 absent Creator capability or guest, 404 absent/mismatched/nonapproved/unsupported exact revision. Unknown query parameters are rejected. No curriculum Main/Unit/Lesson identifiers are introduced. Existing optional `subject: math` and grade metadata are preserved; grade-only Mathematics metadata is supported.

## Implementation report

The read-only router is mounted before the owner `/:id` route so `approved` is not interpreted as a Content UUID. It reuses existing bearer authentication, capability middleware, Content tables, immutable revision lifecycle and canonical mechanic definitions. There is no alternate storage model or workflow mutation. Shared projections deliberately exclude Creator and review actor identities.

SQL selects each identity's latest approval-backed revision with a lateral indexed lookup, applies metadata/text/geography filters in PostgreSQL and limits results before aggregation. Full exercise payloads are returned only by exact detail. The reusable `ApprovedContent.list` model owns the inclusive geography predicate for future selection callers; it implements no allocation or assignment. Snapshot filtering uses append-only approval events' MVCC insertion transaction, expanded into the snapshot's transaction epoch, rather than event timestamps that can precede a delayed commit. Cursors use the existing JWT signing infrastructure with a dedicated non-access token type and fixed chain expiry.

Non-destructive migration `044_approved_content_discovery` adds one partial `(content_id, version DESC)` index for approved revisions. Existing unique event-decision and catalog indexes support evidence/hierarchy lookups; no text-search infrastructure or new extension is needed. The fresh schema includes the same index. Migration tests preserve C2a rows, fail closed on unsupported legacy promotions, verify repeat migration safety and compare fresh/upgrade indexes and protections.

No Template/Hunt snapshots, exercise schemas, owner draft semantics, Admin decisions, FE interfaces, assignment, random allocation, copying, gameplay or scoring are changed.

## Verification

All database checks used a disposable PostgreSQL 17 container, with `TEST_DATABASE_URL` pointing to its dedicated local `tedix_test` database and file suites run sequentially.

- Full backend suite: **83 files, 1,789 tests passed**, no skips.
- Final focused discovery, migration and OpenAPI contract checks: **39 tests passed**, including 31 authenticated discovery integration cases.
- Typecheck and production build: passed.
- Migration upgrade, rerun safety, data preservation, fresh-schema parity and index parity: passed.
- Content API OpenAPI 3.0 validation, including all Content routes and their referenced schemas: passed.
- Full-document OpenAPI validation: **355 pre-existing diagnostics**, identical to untouched `main` (`a56ae64`), with **zero new diagnostics**. Unrelated legacy schemas/responses are unchanged.
- `git diff --check`: passed.

The initial full-run connection used `/postgres`; the seed suite correctly refused it because it requires the dedicated local `/tedix_test` database. The disposable cluster was configured accordingly, with no test/guard changes. The new integrity fixture also exercised the existing Template ownership guard; it now uses the canonical allocator to create valid persisted instances. Final runs pass all checks except the explicitly identified pre-existing full-document OpenAPI diagnostics.

STOP for ChatGPT review. Draft PR only; do not merge or deploy.
