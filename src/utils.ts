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
      // Add optional jitter to avoid thundering herd on retries in production
      const jitterFactor = process.env.NODE_ENV === 'test' ? 0 : Math.random() * 0.5; // up to +50%
      const delay = Math.pow(2, attempt) * baseDelay * (1 + jitterFactor);
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
