# Organizer invitation admission — Task 6.3

D7-A approval supplied by the Product Owner makes the existing random eight-character Hunt access code a transferable bearer invitation. A valid code authorizes the authenticated account/guest to join that exact Hunt; no individual Organizer approval is required. Public lookup remains read only. Migration 036 adds a durable enabled flag; existing codes become enabled invitations. Codes have no expiry or single-use restriction. Rotation invalidates the previous code for new admission; disabling retains the code for Organizer inspection and blocks public resolution/new admission. Retrieval never re-enables it.

Hunt-specific Organizer controls are `POST /api/hunts/{id}/access` (retrieve/create), `DELETE /api/hunts/{id}/access` (disable), and `POST /api/hunts/{id}/access/regenerate` (replace and enable). Supervisor reads redact the admission secret. No Supervisor/global-role authority is added.

`POST /api/hunts/{id}/participants/enroll` accepts only optional `accessCode`. First admission requires the enabled current code, published/active lifecycle, available configured Participant capacity and valid pinned access snapshot. Existing members may omit code and rejoin published/active/paused, retaining identity/progress regardless of disabled/rotated invitation or full capacity. GET context never creates membership. Unknown body fields cannot select user, participant, Team or roles.

The transaction locks the exact Hunt, then membership; first admission counts all existing Hunt participants and inserts once under the Hunt lock. Membership and checkpoint access initialization commit or roll back together. Controls and lifecycle updates serialize on that same Hunt row. Null capacity fails closed (`capacity_unconfigured`), consistent with the positive-capacity publication requirement. No Team roster, waiting list, seat reclamation or reservations are created. The old internal UUID-only compatibility method remains lookup-only and cannot bypass invitation checks.

Per-process bounded token buckets enforce 60 admission requests/minute per authenticated identity and 120 public lookups/minute per network identity. Multiple replicas need shared/edge rate enforcement for aggregate protection. Codes are not logged by this implementation and code-bearing responses use no-store.

Guest authentication still supplies a one-hour access token with no refresh token. Rejoin requires the original identity's valid credentials. Lost/expired guest-token recovery and account linking remain unavailable; creating a new guest never restores membership. FE must resolve the shared code, authenticate once, send the code to enrollment, navigate only on success, persist the session and reconnect using caller-scoped context. No FE changes are included.

Gameplay/GPS grants, Team formation, scoring and recovery policies remain outside this approval. Existing publication safeguards and Master Execution Plan are unchanged.
