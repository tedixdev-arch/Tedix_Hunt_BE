import { createServer, type Socket } from 'node:net';
import { mkdir, chmod, rmdir, lstat } from 'node:fs/promises';
import { environment } from '../config/environment.js';
import { blocked, diagnoseDatabaseBinding } from './developmentDatabaseBinding.js';

export const diagnosticDirectory = () => `/tmp/tedixhunt-dev-db-binding-${process.getuid!()}`;
// Private OS identity authorization: directory owner only; no TCP listener or HTTP route.
// Never adopt/unlink an existing path (including stale sockets or symlinks).
export async function startDevelopmentDiagnostic(directory = diagnosticDirectory()): Promise<() => Promise<void>> {
  if (environment.nodeEnv !== 'development' || process.env.NODE_ENV !== 'development') return async () => {};
  let owned = false;
  let busy = false;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(8000, () => socket.destroy());
    let data = '';
    let replied = false;
    const reply = (body: unknown) => {
      if (replied) return;
      replied = true;
      socket.end(JSON.stringify(body) + '\n');
    };
    socket.on('data', chunk => {
      if (replied) return;
      data += chunk.toString('utf8');
      if (Buffer.byteLength(data) > 1024) { reply(blocked('INVALID_REQUEST')); return; }
      if (!data.includes('\n')) return;
      if (busy) { reply(blocked('BUSY')); return; }
      let expected: unknown;
      try { expected = JSON.parse(data.trim()); }
      catch { reply(blocked('INVALID_REQUEST')); return; }
      replied = true; // One request per connection, including while the query is pending.
      busy = true;
      void diagnoseDatabaseBinding(expected).then(body => {
        socket.end(JSON.stringify(body) + '\n');
      }).catch(() => socket.end(JSON.stringify(blocked('IDENTITY_UNAVAILABLE')) + '\n'))
        .finally(() => { busy = false; });
    });
  });
  try {
    await mkdir(directory, { mode: 0o700 });
    owned = true;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o700) throw new Error();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(`${directory}/binding.sock`, () => { server.removeListener('error', reject); resolve(); });
    });
    await chmod(`${directory}/binding.sock`, 0o600);
    server.on('error', () => {}); // No raw OS errors in application logs.
  } catch {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (owned) await rmdir(directory).catch(() => {});
    console.warn('BLOCKED: PRIVATE_DIAGNOSTIC_UNAVAILABLE');
    return async () => {};
  }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rmdir(directory).catch(() => {});
  };
}
