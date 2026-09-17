import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown } from './shutdown.js';

describe('graceful shutdown', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes the HTTP server before the PostgreSQL pool', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
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
    expect(clearTimeoutSpy).toHaveBeenCalledOnce();
  });

  it('fails when graceful shutdown does not finish before the timeout', async () => {
    vi.useFakeTimers();
    const server = { close: vi.fn((_callback: () => void) => undefined) };
    const closeDatabase = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown(server, closeDatabase, 5_000);

    const result = expect(shutdown()).rejects.toThrow(
      'Graceful shutdown timed out after 5000ms.',
    );
    await vi.advanceTimersByTimeAsync(5_000);

    await result;
    expect(server.close).toHaveBeenCalledOnce();
    expect(closeDatabase).not.toHaveBeenCalled();
  });

  it('reuses an in-progress shutdown instead of creating duplicate operations', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
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
    expect(setTimeoutSpy).toHaveBeenCalledOnce();
    finishServerClose?.();
    await Promise.all([first, second]);
    expect(closeDatabase).toHaveBeenCalledOnce();

    await shutdown();
    expect(server.close).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});
