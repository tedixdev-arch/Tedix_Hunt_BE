'use strict';
// Sent over SSH stdin. Built-ins only: never imports backend code, dotenv or pg.
const net = require('node:net');
const fs = require('node:fs');
const [id, addr, port] = process.argv.slice(2);
const directory = `/tmp/tedixhunt-dev-db-binding-${process.getuid()}`;
const socketPath = `${directory}/binding.sock`;
let finished = false;
const finish = (body) => {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify(body) + '\n');
};
const blocked = code => ({ status: 'BLOCKED', code });
function safeResponse(body) {
  const keys = ['database_match', 'role_match', 'cluster_match', 'endpoint_match'];
  const codes = ['INVALID_REQUEST', 'INDEPENDENT_CONFIGURATION_REQUIRED', 'IDENTITY_UNAVAILABLE', 'PERMISSION_PG_METADATA', 'BUSY'];
  if (body && Object.keys(body).sort().join(',') === 'code,status' && body.status === 'BLOCKED' && codes.includes(body.code)) return body;
  if (body && Object.keys(body).sort().join(',') === 'checks,status' && ['PASS','FAIL'].includes(body.status)
    && body.checks && Object.keys(body.checks).sort().join(',') === keys.sort().join(',')
    && keys.every(k => ['PASS','FAIL'].includes(body.checks[k]))
    && body.status === (keys.every(k => body.checks[k] === 'PASS') ? 'PASS' : 'FAIL')) return body;
  return blocked('INVALID_RESPONSE');
}
async function main() {
  if (!/^[1-9][0-9]{0,19}$/.test(id || '') || !net.isIP(addr || '')
    || !/^[1-9][0-9]{0,4}$/.test(port || '') || Number(port) > 65535) {
    finish(blocked('INDEPENDENT_CONFIGURATION_REQUIRED')); return;
  }
  try {
    const dir = fs.lstatSync(directory), sock = fs.lstatSync(socketPath);
    if (!dir.isDirectory() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700
      || !sock.isSocket() || sock.uid !== process.getuid() || (sock.mode & 0o777) !== 0o600) throw new Error();
  } catch { finish(blocked('PRIVATE_DIAGNOSTIC_UNAVAILABLE')); return; }
  const socket = net.createConnection(socketPath);
  let data = '';
  const timer = setTimeout(() => { finish(blocked('PRIVATE_DIAGNOSTIC_UNAVAILABLE')); socket.destroy(); }, 10000);
  socket.on('connect', () => socket.write(JSON.stringify({ DEV_PG_SYSTEM_IDENTIFIER: id, DEV_PG_SERVER_ADDR: addr, DEV_PG_SERVER_PORT: port }) + '\n'));
  socket.on('data', chunk => {
    data += chunk.toString('utf8');
    if (Buffer.byteLength(data) > 2048) { finish(blocked('INVALID_RESPONSE')); socket.destroy(); }
  });
  socket.on('error', () => finish(blocked('PRIVATE_DIAGNOSTIC_UNAVAILABLE')));
  socket.on('close', () => {
    clearTimeout(timer);
    try { finish(safeResponse(JSON.parse(data))); } catch { finish(blocked('INVALID_RESPONSE')); }
  });
}
if (require.main === module) main().catch(() => finish(blocked('PRIVATE_DIAGNOSTIC_UNAVAILABLE')));
module.exports = { safeResponse };
