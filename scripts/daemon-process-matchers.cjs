const path = require('path');

const MANAGED_PACKAGE_TOKEN = path.join('node_modules', 'fingerdaemon').replace(/\\/g, '/');

function normalizeCommand(value) {
  return String(value || '').replace(/\\/g, '/');
}

function includesAll(command, tokens) {
  const normalized = normalizeCommand(command);
  return tokens.every((token) => normalized.includes(normalizeCommand(token)));
}

function resolveManagedMatchers(root, relativePath) {
  return [
    [root, relativePath],
    [MANAGED_PACKAGE_TOKEN, relativePath],
  ];
}

function matchesManagedFingerProcess(command, root, relativePath) {
  return resolveManagedMatchers(root, relativePath).some((tokens) => includesAll(command, tokens));
}

module.exports = {
  MANAGED_PACKAGE_TOKEN,
  normalizeCommand,
  includesAll,
  resolveManagedMatchers,
  matchesManagedFingerProcess,
};
