export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retry<T>(fn: () => Promise<T>, retries = 2): Promise<T> {
  let attempt = 0;
  const baseDelay = process.env.NODE_ENV === 'test' ? 5 : 100;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      attempt++;
      const delay = Math.pow(2, attempt) * baseDelay;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export function truncateRaw(obj: any, max = 2000) {
  try {
    const s = JSON.stringify(obj);
    return s.length > max ? s.slice(0, max) + '...[truncated]' : s;
  } catch (e) {
    return String(obj).slice(0, max);
  }
}
