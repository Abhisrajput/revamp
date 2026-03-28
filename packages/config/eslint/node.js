module.exports = {
  extends: ['./base.js'],
  env: {
    node: true,
  },
  rules: {
    'no-process-exit': 'warn',
    'no-process-env': 'off',
  },
};
