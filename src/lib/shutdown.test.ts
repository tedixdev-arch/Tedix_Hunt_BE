import { describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown } from './shutdown.js';

describe('graceful shutdown', () => {
  it('closes the HTTP server before the PostgreSQL pool', async () => {
    const events: string[] = [];
    const server = {
      close: vi.fn((callback: () => void) => {
        events.push('server');
        callback();
      }),
    };
    const closeDatabase = vi.fn(async () => {
      events.push('database');
    });

    await createGracefulShutdown(server, closeDatabase)();

    expect(events).toEqual(['server', 'database']);
    expect(server.close).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it('reuses an in-progress shutdown instead of closing twice', async () => {
    let finishServerClose: (() => void) | undefined;
    const server = {
      close: vi.fn((callback: () => void) => {
        finishServerClose = callback;
      }),
    };
    const closeDatabase = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown(server, closeDatabase);

    const first = shutdown();
    const second = shutdown();

    expect(second).toBe(first);
    expect(server.close).toHaveBeenCalledOnce();
    finishServerClose?.();
    await Promise.all([first, second]);
    expect(closeDatabase).toHaveBeenCalledOnce();

    await shutdown();
    expect(server.close).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
