export type RatesResult = {
  [symbol: string]: {
    [currency: string]: number;
  };
};
