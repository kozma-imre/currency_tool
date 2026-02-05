export function isHost(url: any, host: string) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return h === host || h.endsWith(`.${host}`);
  } catch (e) {
    return false;
  }
}
