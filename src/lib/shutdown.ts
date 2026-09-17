export interface ClosableServer {
  close: (callback: () => void) => unknown;
}

export const createGracefulShutdown = (
  server: ClosableServer,
  closeDatabase: () => Promise<void>,
) => {
  let shutdownPromise: Promise<void> | undefined;

  return (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      // Stop accepting HTTP work before releasing shared database connections.
      await new Promise<void>((resolve, reject) => {
        try {
          server.close(resolve);
        } catch (error) {
          reject(error);
        }
      });
      await closeDatabase();
    })();

    return shutdownPromise;
  };
};
