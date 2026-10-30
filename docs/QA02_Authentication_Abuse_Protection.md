# QA-02 — bounded A4 authentication abuse repair

30 October 2026. Source implementation and disposable-environment evidence only.
**QA-02 remains open. Production configuration/enforcement and independent
production acceptance are unverified. Do not merge or deploy this Draft PR.**

## Authorization and prerequisites

The Product Owner's QA-02 request explicitly authorizes development, automated
verification and documentation under existing **A4 — Core Authentication**.
This supersedes the earlier QA report's proposed-only boundary for this bounded
repair. QA-02 is a finding identifier, not a new task. A4 remains a partial
foundation; preserve all 169 task IDs/order and the frozen reconciliation.
A6/B4/L1 provide related context, not expanded implementation authorization.

Bases inspected: BE merged main `a7df0f963feb8b431dfa83913eeca0facc43c116`, FE
merged main `4cc23dab1d7fbe6de5079934056792f168801777`. Read FE Master Execution
Plan (§A, A4, §H), cross-repository QA report including QA-02, current FE
`src/services/api/auth.ts`, BE authentication/routes/models, README,
`docs/A1-deployed-setup.md` and `.github/workflows/backend.yml`. FE recursive tree
was complete with no AGENTS.md; none exists in the local BE tree. Open PR search
across both repositories returned none before implementation. Shell Git transport
could not reach the configured proxy; GitHub connector reads verified immutable
bases. Publication uses that connector without touching main.

## Root cause and security boundaries

The backend had no request budget before public account creation, password hashing
or credential lookup. `/api/auth/guest` persists a new row on every call. Native
Participant registration also permits credentialless account creation; protecting
only `/guest` would leave that other creation path unbounded. No proxy trust was
configured, and historical deployment notes/workflows do not establish present
WAF limits, ingress chain, direct backend reachability or worker count. This is
source evidence, not proof that production has no perimeter protection.

Use one small dependency-free token bucket implementation: no service, schema,
cleanup job or package change. Node's monotonic clock drives refill; tests inject
time. A bucket starts full and replenishes continuously over its configured
window. Rejections do not consume additional tokens. Budgets count **all attempts**,
including successful authentication, to avoid success-based reset attacks.

Keys contain a category and process-random HMAC of the normalized account email
or Express-verified network identity. They contain no plaintext passwords, tokens,
IP addresses or emails; no limiter logging is added. Account normalization matches
`normalizeEmail` (trim/lowercase); malformed/oversized identifiers share a sentinel
bucket. No account lookup or account-existence signal is used by the limiter.
Existing registration conflict/error semantics remain unchanged.

IPv4-mapped IPv6 is canonicalized to IPv4; IPv6 suffixes within a /64 share a
network budget. Addresses beyond /64 can still be rotated by attackers with larger
allocations. IPs identify networks, never people. Client IDs, guest names, tokens
and forwarded headers from untrusted peers cannot establish independent budgets.

The network stage precedes JSON parsing, including invalid/oversized payloads.
The account stage follows parsing and rejects malformed body/value shapes before
model/bcrypt calls when enabled. With enforcement enabled, parser failures return generic 400/413
`invalid_input` without parser internals; disabled enforcement preserves the
existing parser/error-handler behavior.
Normal in-budget login/register/activation/guest/refresh responses remain unchanged.
No role, account status, token rotation/replay or logout logic is modified.

## Route coverage and provisional defaults

All values below are **development proposals, not approved production policy**.
Each network category is shared across the listed endpoints; switching endpoints,
case or an optional trailing slash does not reset a budget.

| Category | Capacity / full refill | Actual POST routes | Rationale |
| --- | --- | --- | --- |
| Login network | 120 / 60 s | `/api/auth/{participant,organizer,creator,admin}/login` | Allows a class of distinct logins/retries; bounds username spraying |
| Login account | 10 / 300 s | Same four routes, independent of network and role | Bounds targeted guesses across many source networks; one token per 30 s |
| Registration/application network | 60 / 60 s | `/api/auth/participant/register`, `/api/organizer-applications`, `/api/creator-applications` | Classroom-sized credentialless/native admission while bounding account/application growth |
| Guest network | 80 / 60 s | `/api/auth/guest` | Forty simultaneous joins plus forty retries/headroom |
| Activation network | 60 / 60 s | `/api/auth/admin/activate`, `/api/auth/organizer/activate-direct`, `/api/auth/creator/activate` | Class-sized onboarding; bounds hashing/activation attempts |
| Refresh network | 240 / 60 s | `/api/auth/refresh` | Forty participants with generous coordinated-refresh headroom |

Logout, password change, authenticated gameplay, administration, health, GETs and
preflight are outside these budgets. Approval/provisioning/review routes retain
existing authorization; retired application-activation endpoints are not revived.
The obsolete FE Creator registration helper has no corresponding backend route;
this repair adds no new endpoint.

All denials return HTTP 429, `{"error":"too_many_requests"}` and integer
`Retry-After` seconds rounded up to the next available token, at least one second.
For capacity exhaustion the header points to the earliest known entry expiry;
concurrent traffic can still require another retry. It promises no reservation.
CORS precedes the limiter, preserving existing allowed-origin handling of errors.

## Classroom evidence and anonymous-abuse limitation

At a frozen monotonic instant, forty actual `/guest` calls through the app and
PostgreSQL each returned 201 and persisted forty guests from one socket IP. With
a test capacity of forty, request 41 returned 429 with Retry-After 2 and persisted
no extra identity. Advancing time sixty seconds admitted the next guest. Separate
middleware tests admit the default eighty-call burst before returning 429. No
load requests were sent to a deployed service.

There is no trusted discriminator between a classroom and a script behind the
same IP under these constraints. A script can spend the classroom allowance
first, and distributed sources can each obtain an allowance. An already depleted
bucket or exhausted store cannot guarantee admission for a later classroom.
The scenario proves admission from an initially available budget, not complete
anonymous abuse prevention or guaranteed classroom availability under attack.
Aggregate guest creation is bounded per verified network/process, with no CAPTCHA,
extra screen or arbitrary client identity. Multiple classes on the same network
need operator capacity planning; NAT capacity is not a per-human guarantee.
Account limits can also be deliberately exhausted to temporarily deny a known
email; this availability tradeoff requires threshold approval and monitoring.

## Bounded memory and overload

One map contains at most `AUTH_ABUSE_MAX_ENTRIES` entries (20,000 default, accepted
range 1–100,000). Keys have fixed length. Entries expire after a full configured window without activity; continuous token
refill is independent of this conservative idle TTL. Even an empty bucket has
replenished fully before it can be removed. A one-second unref'ed sweep reclaims
idle entries, with lazy reclamation on access.
`app.locals.stopAbuseProtection()` releases the timer for application disposal.
An indexed min-heap holds exactly one expiry record per map entry; updating a
deadline adjusts that record in O(log N), and nextExpiry always reads the exact
root deadline. Sweeps remove only expired roots in O(K log N) for K removals;
no live-entry scans or stale queued deadlines accumulate. Repeated capacity
denials with no expired entries do O(1) expiry work. Each removal is chargeable to
an earlier insertion, and a single operation removes at most the configured cap. No live entry is evicted to
admit another key, which would let cycling identities reset budgets.

When full, requests needing a new entry fail closed with the same generic 429.
Existing entries retain their budgets. The network budget is spent before the
account budget, including account-limit denials. A shared store lets identity
flooding affect other protected endpoint categories until entries expire; this
bounded, documented availability tradeoff avoids an unbounded allocation or silent
fail-open. Restarting resets buckets. This is **per process**, not a global limit:
N independent workers/instances can allow approximately N times the configured
capacity. Sticky routing does not establish global enforcement. No Redis or
new database limiter is authorized here.

## Deployment configuration and activation gate

`.env.example` lists every supported `AUTH_ABUSE_*` setting and refill unit.
`AUTH_ABUSE_ENABLED` is **false by default in all environments**, including
production. Only literal `true` enables it; invalid booleans/positive integer
settings fail startup. Capacity values are capped at 1,000,000 and windows at
86,400,000 ms. No environment defaults silently activate production enforcement.

`AUTH_TRUSTED_PROXIES` is an optional comma-separated list of literal IPs/CIDRs.
Omit it to trust no proxies (the TCP peer determines the network). Empty values,
hop counts, broad named aliases, Boolean values and /0 networks are rejected;
invalid addresses/prefixes fail startup. It configures Express trust explicitly,
never `trust proxy: true`. Example documentation addresses are not actual topology:

```dotenv
AUTH_ABUSE_ENABLED=false
# Set only after validating real ingress; do not copy these example addresses.
# AUTH_TRUSTED_PROXIES=192.0.2.10/32,2001:db8::10/128
```

After **separate** operator/PO approval, environment configuration can enable the
reviewed values without modifying source. The existing workflow preserves server
`.env`; this PR does not edit deployment secrets, server settings or workflow jobs.
Before any activation the operator must record:

1. Actual ingress/proxy chain and whether every trusted proxy overwrites/sanitizes
   incoming forwarding headers, including variable-length paths.
2. Exact trusted addresses/CIDRs and direct-backend reachability/firewall behavior.
   Restrict access to verified ingress where applicable; never trust end-user ranges.
3. Instance and worker counts, restart behavior and the per-process budget effect.
4. Existing WAF/reverse-proxy limits and their combined effect on requests/bodies.
5. Shared-NAT classroom sizes, simultaneous classes and refresh traffic.
6. Approved production capacities/windows, memory cap, overload response and rollback.

The nearest untrusted hop determines req.ip. Tests cover untrusted sockets and
leftmost forwarding injection behind a trusted loopback proxy. Those tests verify
Express behavior, not a real proxy's header sanitation. Trusting an overly broad
network that includes clients remains unsafe. No production addresses/hop count
are assumed or configured in this PR. Record deployment configuration separately
from enablement and independent acceptance.

## Guest retention assessment only

Inspected `003_core_hunt_records`, later migrations, `User.deleteControlled`,
`UserDeletion.integration.test.ts`, HuntParticipant and Team models. Guest identity
is persisted in `users.is_guest`; enrollment is `hunt_participants.user_id` with
ON DELETE CASCADE, and team membership references the enrollment through composite
foreign keys, also cascading. Removing a user can therefore erase membership even
if a simple users delete succeeds. Hunts can be draft, published, active, paused,
cancelled or finished. Existing controlled Admin deletion retires/anonymizes a user
when durable dependencies exist, revokes credentials and preserves provenance;
it is not an automatic retention policy. Its dependency check is not a promise
that every future result/audit relationship has been covered.

Current migrations have no complete participant progress/results or generalized
gameplay audit model. Review/approval history and template authorship reference
users; future progress/results/audit domains must join the retention inventory
before cleanup can be approved. Access-token expiry (one hour for guests) is not
a safe deletion age: an active/paused Hunt or historical enrollment can outlive it.
Credentialless non-guest Participants are a separate policy category and must not
be swept as guests.

Future proposal, requiring separate retention/privacy authorization: define age,
activity and legal/history requirements; inventory every FK and logical user
reference (including cascading and external audit references); exclude all active
and paused Hunt memberships and any undecided lifecycle states; prefer approved
anonymization/retirement for history-bearing identities. Produce a read-only,
aggregate dry-run with candidate/exclusion counts and sampled reference validation,
without logging PII/tokens. Verify database backup/restore and privacy impact.
Any future mutation must recheck eligibility and references transactionally under
appropriate user/Hunt locks or equivalent serialization with concurrent enrollment,
fail closed on unknown dependencies, run in bounded batches and compare postconditions.
Document race handling, rollback limits and irreversible privacy erasure separately.
Do not simply schedule `deleteControlled` without analyzing enrollment races.
**No retention implementation, participant deletion or cleanup is included.**

## Verification and completion dimensions

Validation results and immutable PR/CI references are recorded below after execution.
The new unit suite uses an injected clock, no sleeps. Existing auth route regressions
run with enforcement both disabled and enabled. New PostgreSQL scenarios exercise
the real Express routes/models and persisted counts; existing PostgreSQL auth and
reference-safety regressions are also run. CI uses existing PostgreSQL 17 service.
No additional infrastructure, workflow deployment or live database is used.

| Dimension | Status |
| --- | --- |
| Implemented in source | Bounded A4 middleware/config/tests/documentation, Draft review pending |
| Tested locally / CI | See executed results below; CI is separate evidence |
| Configured for deployment | Examples only; actual operator configuration unverified |
| Enabled in production | No activation performed; defaults disabled |
| Independently verified in production | Unverified; requires separately authorized acceptance |

The exact FE evidence/plan follow-up is staged in
[QA02_FE_Documentation_Followup.md](QA02_FE_Documentation_Followup.md).
It is not published to FE: this task opens exactly one BE Draft PR.

### Executed local validation

- Focused limiter/auth routes/auth middleware/RefreshToken suites: **188 passed**.
- Focused PostgreSQL QA-02, Tedix authentication and controlled-deletion reference
  suites: **34 passed** against disposable PostgreSQL 17.
- Full `TEST_DATABASE_URL=<disposable-local-database> npm test`: **1,360 tests /
  62 files passed**, zero failures/skips, including all PostgreSQL suites.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- No lint/format script or corresponding configuration exists; no lint pass claimed.
- Initial unprivileged Supertest execution failed because local listening sockets
  were denied (EPERM); it was rerun successfully with local execution permission.
- Existing PostgreSQL test output includes a pg@9 future deprecation warning about
  concurrent queries on a client; no failure. No production load or E2E test run.
- CI: **not run at Draft preparation**. Opening the PR triggers the existing test
  workflow. Per the requested stop boundary, CI results must be reviewed separately;
  a CI pass, if obtained, will not establish deployment or QA-02 closure.

The FE follow-up patch was checked to retain all 169 ordered task anchors and
leave the historical QA report intact. Only the BE Draft is published.

Final source validation includes two additional enabled/disabled malformed-JSON
compatibility cases in the full 1,360-test run. The earlier focused 188-test run
preceded those additions; no final focused rerun is claimed.

### PR #91 re-review — refill, idle expiration and capacity accounting

30 October 2026. Rework of existing Draft #91, reviewed source
`e6e09f9ef5368fedc74dce8ab3652162b22a8231`. The user's explicit correction request
stays within the existing bounded A4 authorization; no second PR, task, dependency,
configuration/default change, production activation, merge or deployment.

**Finding assessment:** a deficit-based expiry is mathematically valid when its
refill accounting is exact: capacity 10 / 10 seconds, one token spent, becomes
full after one second. Removing that fully replenished bucket does not by itself
grant extra tokens. No excess-admission reproduction solely from that formula is
claimed. The reviewed implementation did cache nextExpiry using only `Math.min`:
when an entry's deadline moved later, the cache could remain earlier than every
actual deadline, permitting unnecessary whole-map reclamation scans under capacity
pressure. Prior tests covered frozen bursts and capacity-one expiry but did not
adequately prove spaced-request bounds, idle retention or expiry-index invariants.

**Correction:** cleanup now uses an explicit, conservative full-window idle TTL:
`expiresAt = now + windowMs` after each attempt on an existing/admitted bucket.
Refill still uses elapsed time and the configured token rate; rejection spends no
additional token. A full idle window is sufficient to restore even an empty
bucket, so cleanup cannot remove a partially replenished entry. Requests before
idle expiry use the retained balance; repeated denials do not postpone token
replenishment. Idle retention can be longer than the previous deficit-based TTL,
keeping more identities resident and potentially causing capacity denials sooner;
this bounded availability tradeoff is documented without increasing the memory cap.

**Expiry index:** a min-heap holds one mutable record per map entry, indexed by the
entry's heap position. Rescheduling adjusts that existing record; it never appends
stale expiry tickets. nextExpiry is derived from the root, not an independently
cached lower bound. Removing expired roots updates both map and heap, including
the empty state (Infinity), while preserving live entries. New identities at
capacity fail closed; no live entry is evicted and no capacity denial refreshes a
victim's state. Cleanup visits expired roots only. Updates cost O(log N), a denial
without expirations costs O(1) expiry work, and K removals cost O(K log N), bounded
by the configured entry cap and amortized against earlier insertions.

**Deterministic coverage:** nine new injected-clock regressions (23 limiter tests
total) cover one-token consumption and retained idle lifetime, partially depleted
refill, 101 spaced bursts with exact admitted-token bounds, automatic idle expiry,
exact nextExpiry after updates/rejections/removals, selective reclamation under
capacity pressure, repeated capacity floods without live scans, HTTP Retry-After
through repeated denials and a 2,000-step mixed-budget reference model. The model
checks admitted/denied outcomes, map size, exact earliest deadline and one expiry
record per map entry after every step. Existing forty-student shared-NAT tests
remain in the middleware, auth route and real PostgreSQL suites.

**Other middleware review:** route/category matching, independent account/network
keys, proxy identity canonicalization, JSON-stage ordering, generic 429 responses,
disabled enforcement and bypassed logout/gameplay routes were reviewed. No further
confirmed bypass was found in this source review. Existing protections and their
NAT, account-denial, per-process and deployment limitations remain as documented.
Budgets are immutable for the lifetime of an application instance; deployment
configuration is not hot-reloaded into existing buckets.

**Executed rework validation:** focused limiter suite **23 passed**; combined
focused limiter/auth/refresh/authorization and relevant PostgreSQL suites **233
passed across 7 files**. Final full suite with disposable local PostgreSQL 17:
**1,369 tests across 62 files passed**, zero failures/skips. Typecheck, build and
whitespace checks passed. The full suite additionally verifies the bounded expiry
index assertion added after the focused run. No lint/format configuration exists.
The disposable database container was removed after validation. Rework CI is not
yet observed at evidence preparation; no corrective CI pass is claimed.

**Completion dimensions:** corrected source/local tests only, awaiting ChatGPT
re-review in the same Draft #91. Actual deployment configuration, production
enablement and independent production acceptance remain unverified. Enforcement
defaults remain disabled; QA-02 and A4's full verification remain open. The FE
follow-up patch includes this correction status without changing its 169 ordered
task anchors or the frozen reconciliation. No merge or deployment.
