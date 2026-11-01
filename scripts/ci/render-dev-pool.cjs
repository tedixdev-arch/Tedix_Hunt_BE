'use strict';
const fs = require('node:fs');
const { safeResponse } = require('./invoke-dev-pool.cjs');
let body = { status: 'BLOCKED', code: 'SSH_OR_PROTOCOL_UNAVAILABLE' };
try {
  const raw = fs.readFileSync(process.argv[2], 'utf8');
  if (process.argv[4] === '0' && Buffer.byteLength(raw) <= 2048) {
    const parsed = JSON.parse(raw);
    if (parsed?.status === 'BLOCKED' && ['PRIVATE_DIAGNOSTIC_UNAVAILABLE','INVALID_RESPONSE'].includes(parsed.code)
      && Object.keys(parsed).sort().join(',') === 'code,status') body = parsed;
    else body = safeResponse(parsed);
  }
} catch {}
fs.writeFileSync(process.argv[3], JSON.stringify(body) + '\n');
process.stdout.write(JSON.stringify(body) + '\n');
process.exitCode = body.status === 'PASS' ? 0 : body.status === 'FAIL' ? 1 : 2;
