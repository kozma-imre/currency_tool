module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  plugins: ['import'],
  extends: ['eslint:recommended', 'plugin:import/recommended', 'prettier'],
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
