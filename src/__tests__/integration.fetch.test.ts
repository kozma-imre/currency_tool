import axios from 'axios';

const runIntegration = String(process.env.RUN_INTEGRATION_TESTS || '').toLowerCase() === 'true';

if (!runIntegration) {
  // Skip the integration test by default to avoid network calls in CI.
  test.skip('integration: fetch real data from CoinPaprika (skipped unless RUN_INTEGRATION_TESTS=true)', () => {});
} else {
  test('integration: fetch real data from CoinPaprika', async () => {
    const res = await axios.get('https://api.coinpaprika.com/v1/tickers/btc-bitcoin', { timeout: 15000 });
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
    expect(res.data.quotes).toBeDefined();
    const usd = res.data.quotes && res.data.quotes.USD && res.data.quotes.USD.price;
    expect(typeof usd).toBe('number');
    expect(usd).toBeGreaterThan(0);
  }, 20000);
}
