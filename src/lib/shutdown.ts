export interface ClosableServer {
  close: (callback: () => void) => unknown;
}

export const shutdownTimeoutMs = 5_000;

export const createGracefulShutdown = (
  server: ClosableServer,
  closeDatabase: () => Promise<void>,
  timeoutMs = shutdownTimeoutMs,
) => {
  let shutdownPromise: Promise<void> | undefined;

  return (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Graceful shutdown timed out after ${timeoutMs}ms.`));
      }, timeoutMs);

      void (async () => {
        // Stop accepting HTTP work before releasing shared database connections.
        await new Promise<void>((serverClosed, serverCloseFailed) => {
          try {
            server.close(serverClosed);
          } catch (error) {
            serverCloseFailed(error);
          }
        });
        await closeDatabase();
      })().then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });

    return shutdownPromise;
  };
};
