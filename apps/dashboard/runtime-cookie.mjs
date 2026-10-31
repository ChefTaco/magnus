/** Parse a Cookie header without allowing malformed percent encoding to crash auth. */
export function parseCookieHeader(header = '') {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(part.slice(idx + 1).trim()));
    } catch {
      // Ignore only the malformed pair; valid cookies in the header remain usable.
    }
  }
  return cookies;
}
