# Step 7.3 — PostgreSQL authentication backend

## Scoped task

Starting from merged step 7.2 (`3246d1e`), implement register, login, refresh, logout
and `/me` against PostgreSQL, with secure password/token handling and real database
tests. Replace the old auth routes; retain legacy organization code for its later
migration. No FE or role-capability implementation in this step.

Implement only the scope described. Do not redesign unrelated modules, introduce
speculative abstractions, or migrate additional prototype functionality unless
explicitly requested.

## Design and acceptance criteria

- Native scrypt, random salt, bounded verification parameters, constant-time hash
  comparison, and no password truncation. Passwordless users cannot password-login.
- Case-insensitive email lookup and transactional registration plus session creation.
  Duplicate email returns 409. Wrong/unknown/passwordless logins share a 401 response.
- Random opaque access/refresh tokens; store hashes only. DB lookup on each access
  makes logout and revocation immediate, without relying on the legacy JWT secret.
- Short-lived access token returned in JSON; refresh token only in an HttpOnly,
  Strict cookie with Secure and __Host prefix in production. Absolute session expiry.
- Atomic refresh rotation with row locks; consumed refresh reuse revokes the session.
  Concurrent duplicate refresh is considered replay; FE must serialize refresh.
- Custom CSRF header on POST, exact Origin checks, credentialed CORS to configured
  FE only, request throttling, safe errors and no-store auth responses.
- Migration up/down preserves users; rollback of auth tables invalidates all sessions.
- Unit tests cover boundaries/passwords. PostgreSQL CI tests verify persisted account
  creation, credential failures, replay and concurrency, expiry, logout, independent
  sessions, production cookie flags and safe response fields.

## Review and handoff

Review the actual diff in a separate local pass, resolve findings, then prepare one
BE PR. Server validation is pending access, as authorized by the owner. Do not mark
the deployed authenticated milestone complete until FE integration and server tests
pass. Operators must inspect existing schema, back up, apply pending migrations,
configure NODE_ENV/WEB_ORIGIN/HTTPS, and verify proxy-aware throttling before sharing.

Legacy organization routes still use Mongo/JWT and do not accept the new tokens.
Existing FE is a navigation mockup with no backend calls, so it needs no changes in
this PR. Account recovery, verification and MFA are separate work; users must not
treat mockup admin/creator screens as backend-authorized capabilities.
