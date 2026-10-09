export type A2AListenOptions = {
  readonly host: string;
  readonly port: number;
};

/** Parse CLI listener flags without exposing an A2A endpoint beyond loopback by default. */
export function parseA2AListenOptions(args: Readonly<Record<string, string>>): A2AListenOptions {
  const host = args.host?.trim() || '127.0.0.1';
  if (host.includes('://') || /[/?#\s]/.test(host)) {
    throw new Error('host must be a hostname or IP address without a URL scheme');
  }
  const suppliedPort = args.port?.trim();
  const port = suppliedPort === undefined || suppliedPort === '' ? 0 : Number.parseInt(suppliedPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (suppliedPort !== undefined && suppliedPort !== '' && String(port) !== suppliedPort)) {
    throw new Error('port must be an integer between 0 and 65535');
  }
  return { host, port };
}
