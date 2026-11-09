/** Human-readable device label from a User-Agent (no dependency; good enough for a device list). */
export function deviceNameFromUA(ua: string | undefined, clientHint?: string): string {
  if (clientHint) return clientHint.slice(0, 100);
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /YaBrowser/.test(ua)
        ? 'Yandex Browser'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : /Safari\//.test(ua)
              ? 'Safari'
              : /MaxCloud/.test(ua)
                ? 'MaxCloud app'
                : 'Browser';
  return `${browser} on ${os}`;
}
