# Development Pool binding diagnostic (G4c-3)

This proposed diagnostic avoids Linux process inspection. It executes one fixed,
parameterized SELECT through the **running backend's existing singleton Pool**.
It does not instantiate a Pool, read DATABASE_URL, expose environment values,
run the importer, migrate, grant permissions, deploy or restart anything.
Production does not register the route. Both the captured environment and explicit
`NODE_ENV=development` must agree; the implicit development default is insufficient.

## Review and availability

This PR is for review only. Do not deploy, restart or invoke a workflow as part of
G4c-3. An already running older build cannot acquire this diagnostic without a
separately authorized future rollout. Until the reviewed code is running normally
in development, verification remains BLOCKED. Never start a second backend or a
standalone Pool as substitute evidence about the running service.

## Exact safe invocation, after a separately authorized rollout

1. An authorized administrator obtains the existing repository variables
   `DEV_PG_SYSTEM_IDENTIFIER`, `DEV_PG_SERVER_ADDR`, `DEV_PG_SERVER_PORT` from the
   administrator-designated `tedixhunt_dev` record. Preserve these independently
   recorded values; never derive them from the backend under test, DATABASE_URL,
   the importer's configuration or this diagnostic. Expected database and role
   remain the reviewed constants `tedix_hunt` and `tedix_app` (including session role).
   Address must be a literal IP and port a decimal string. IPv6 equivalence is
   evaluated by PostgreSQL's inet type. Unix socket/null endpoints block.
2. Use an existing active, non-guest Admin account's short-lived access token
   issued by the normal development authentication flow. Do not create an account,
   bootstrap an administrator, mint a JWT manually or use a refresh token.
3. Confirm the development reverse proxy denies
   `/api/admin/diagnostics/database-binding` (and trailing slash) from public
   ingress. The route additionally requires a loopback transport peer, rejects
   Forwarded and all X-Forwarded-* headers, and checks authoritative current
   account status and Admin capabilities. A local proxy that strips forwarding
   headers is indistinguishable from local callers; the ingress deny is mandatory.
   Do not expose a new listener, change bind addresses or weaken proxy rules.
4. From an authorized workstation, open an SSH tunnel using the existing approved
   development SSH target and host-key verification. Substitute the actual existing
   backend port for `BACKEND_PORT` and configured target for `DEV_SSH_TARGET`:

   ```sh
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:13001:127.0.0.1:BACKEND_PORT DEV_SSH_TARGET
   ```

5. In a second workstation terminal use Bash with tracing disabled. This prompts
   for independent expected values and the token without putting the token in
   command arguments, shell history or a temporary file. Python builds the request
   privately; response errors are sanitized locally as well. Do not run under
   `set -x`, HTTP tracing, traffic recording or a logging proxy. This requires
   only Python 3 and makes exactly one diagnostic request, without login writes.

   ```sh
   set +x
   python3 - <<'PY'
   import getpass, json, urllib.request, urllib.error
   expected = {k: getpass.getpass(k + ': ') for k in (
       'DEV_PG_SYSTEM_IDENTIFIER', 'DEV_PG_SERVER_ADDR', 'DEV_PG_SERVER_PORT')}
   token = getpass.getpass('Development Admin access token: ')
   opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
   req = urllib.request.Request(
       'http://127.0.0.1:13001/api/admin/diagnostics/database-binding',
       data=json.dumps(expected).encode(), method='POST',
       headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
   try:
       try:
           response = opener.open(req, timeout=10)
       except urllib.error.HTTPError as exc:
           response = exc
       body = json.loads(response.read(4096))
       valid_checks = {'database_match', 'role_match', 'cluster_match', 'endpoint_match'}
       codes = {'AUTHORIZATION_REQUIRED', 'DEVELOPMENT_ONLY', 'DIRECT_LOOPBACK_REQUIRED',
                'INDEPENDENT_CONFIGURATION_REQUIRED', 'IDENTITY_UNAVAILABLE',
                'PERMISSION_PG_METADATA', 'INVALID_REQUEST', 'METHOD_NOT_ALLOWED'}
       if (isinstance(body, dict) and set(body) == {'status', 'checks'}
           and body['status'] in ('PASS', 'FAIL') and isinstance(body['checks'], dict)
           and set(body['checks']) == valid_checks
           and all(v in ('PASS', 'FAIL') for v in body['checks'].values())):
           print(json.dumps(body))
       elif (isinstance(body, dict) and set(body) == {'status', 'code'}
             and body['status'] == 'BLOCKED' and body['code'] in codes):
           print(json.dumps(body))
       else:
           print('BLOCKED: UNRECOGNIZED_RESPONSE')
   except Exception:
       print('BLOCKED: REQUEST_UNAVAILABLE')
   PY
   ```

6. Close the SSH tunnel. Record only the sanitized diagnostic, reviewed running
   build identity obtained through existing approved deployment records, and time.
   Do not record the request, token, independent values or database error text.

The request carries the three independent values rather than adding runtime
configuration or using raw backend environment variables. It cannot prove that an
operator supplied trustworthy values; their independent provenance is mandatory.
No automated workflow is added and the previous /proc verifier is unchanged.

## Results and limits

- PASS: database, current/session role, cluster identifier, and server address/port
  all match on one checked-out connection from the live Pool.
- FAIL: at least one definite mismatch; only PASS/FAIL per check is returned.
- BLOCKED: missing/invalid configuration, authentication/authorization, unsupported
  transport, unavailable/null identity, query error or timeout. SQLSTATE 42501 maps
  to `PERMISSION_PG_METADATA`; never grant `pg_control_system()` access as part of
  this task. Existing permission is still required and may keep this check blocked.

No raw SQL errors are logged or returned, including JSON parser failures. Responses
are no-store. Query timeout is five seconds on the client; this is not a server-side
statement timeout. SQL reads only built-in identity functions and no application
rows. Normal authentication additionally performs the existing read-only user/role
lookup. PASS proves the sampled Pool connection at invocation time, not all future
connections, replicas, importer equivalence, migration/catalog state or GeoNames
readiness. No import is authorized by PASS.

Validation: `npm run build` and
`npx vitest run src/routes/developmentDatabaseBinding.test.ts`.
