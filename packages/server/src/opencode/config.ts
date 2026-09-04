export function resolveOpenCodeBaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = typeof env.OPENCODE_BASE_URL === 'string' ? env.OPENCODE_BASE_URL.trim() : undefined;
  if (!raw) return undefined;

  const schemePrefixMatch = raw.match(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//);
  if (!schemePrefixMatch) {
    throw new Error('OPENCODE_BASE_URL must be a valid absolute URL');
  }

  const authorityAndSuffix = raw.slice(schemePrefixMatch[0].length);
  const authorityEndIndex = authorityAndSuffix.search(/[/?#]/);
  const rawAuthority = authorityEndIndex === -1
    ? authorityAndSuffix
    : authorityAndSuffix.slice(0, authorityEndIndex);
  const rawSuffix = authorityEndIndex === -1
    ? ''
    : authorityAndSuffix.slice(authorityEndIndex);
  const rawPath = rawSuffix.startsWith('/')
    ? rawSuffix.split(/[?#]/, 1)[0]
    : '';

  if (rawAuthority.includes('@')) {
    throw new Error('OPENCODE_BASE_URL must not include credentials or fragments');
  }

  const hasExplicitPort = (() => {
    if (!rawAuthority) return false;
    if (rawAuthority.startsWith('[')) {
      const ipv6End = rawAuthority.indexOf(']');
      if (ipv6End === -1) return false;
      return /^:\d+$/.test(rawAuthority.slice(ipv6End + 1));
    }
    const colonIndex = rawAuthority.lastIndexOf(':');
    if (colonIndex <= -1) return false;
    if (rawAuthority.includes(':', colonIndex + 1)) return false;
    return /^\d+$/.test(rawAuthority.slice(colonIndex + 1));
  })();

  if (rawPath !== '' && rawPath !== '/') {
    throw new Error('OPENCODE_BASE_URL must not include a path');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('OPENCODE_BASE_URL must be a valid absolute URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('OPENCODE_BASE_URL must use http or https');
  }

  const hostname = url.hostname.toLowerCase();
  const isLoopback =
    hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
  if (!isLoopback) {
    throw new Error('OPENCODE_BASE_URL must resolve to a loopback host');
  }

  if (!hasExplicitPort) {
    throw new Error('OPENCODE_BASE_URL must include an explicit port');
  }

  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('OPENCODE_BASE_URL must not include a path');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('OPENCODE_BASE_URL must not include credentials or fragments');
  }

  return `${url.protocol}//${url.host}`;
}
