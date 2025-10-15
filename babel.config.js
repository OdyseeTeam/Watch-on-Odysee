module.exports = {
  // Do not transform Playwright E2E tests; Playwright handles TS itself.
  ignore: [
    'tests/e2e/**/*',
  ],
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    '@babel/preset-typescript',
  ],
}
