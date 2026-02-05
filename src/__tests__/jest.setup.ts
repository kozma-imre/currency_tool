// Jest setup: silence console during tests to avoid "Cannot log after tests are done" races
// Tests can still spy on console methods per-test when they need to

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
