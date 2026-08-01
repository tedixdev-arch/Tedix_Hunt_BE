export interface ApiEnvironment {
  nodeEnv: string;
  host: string;
  port: number;
  webOrigin?: string;
  version: string;
}

const DEFAULT_API_HOST = '127.0.0.1';
const DEFAULT_API_PORT = 3001;

const parseHost = (value: string | undefined): string => {
  const host = value?.trim() ?? '';

  if (!host) {
    return DEFAULT_API_HOST;
  }

  if (/\s/.test(host) || host.includes('/')) {
    throw new Error(
      'Invalid API_HOST. Provide a hostname or IP address without spaces or URL paths.',
    );
  }

  return host;
};

const parsePort = (value: string | undefined): number => {
  const rawPort = value?.trim() ?? String(DEFAULT_API_PORT);
  const parsed = Number(rawPort);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('Invalid API_PORT. Provide an integer from 1 to 65535.');
  }

  return parsed;
};

export const readEnvironment = (): ApiEnvironment => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: parseHost(process.env.API_HOST),
  port: parsePort(process.env.API_PORT),
  webOrigin: process.env.WEB_ORIGIN,
  version: process.env.npm_package_version ?? '0.1.0',
});

export const environment = readEnvironment();
