const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

/**
 * Monorepo: o app importa código compartilhado do repo (../lib/sync-core,
 * ../lib/db-schema) — arquivos fora da raiz do mobile precisam entrar no
 * watchFolders do Metro pra serem empacotados e recarregados.
 */
const config = getDefaultConfig(__dirname);
const repoRoot = path.resolve(__dirname, "..");

config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(repoRoot, "node_modules"),
];

module.exports = config;
