export type RatesResult = {
  // Breaking change: top-level keys are fiat bases (e.g., 'EUR', 'USD'), each mapping to symbol -> value
  [base: string]: {
    [symbol: string]: number;
  };
};
