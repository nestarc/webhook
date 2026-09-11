import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL to a test PostgreSQL database before running this check');
}

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'webhook-quick-start-'));
const consumerRoot = join(temporaryRoot, 'consumer');
const environment = {
  ...process.env,
  npm_config_force: 'false',
  NPM_CONFIG_FORCE: 'false',
  npm_config_legacy_peer_deps: 'false',
  NPM_CONFIG_LEGACY_PEER_DEPS: 'false',
  npm_config_strict_peer_deps: 'true',
  NPM_CONFIG_STRICT_PEER_DEPS: 'true',
};

function run(args, cwd, capture = false) {
  return execFileSync('npm', args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
}

try {
  cpSync(join(repositoryRoot, 'examples/quick-start'), consumerRoot, {
    recursive: true,
    filter: (source) => !/(?:^|[/\\])(?:node_modules|dist|generated|package-lock\.json)(?:[/\\]|$)/.test(source),
  });
  const [artifact] = JSON.parse(run(
    ['pack', '--ignore-scripts', '--json', '--pack-destination', temporaryRoot],
    repositoryRoot,
    true,
  ));
  const tarball = join(temporaryRoot, artifact.filename);
  const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
  assert.equal(artifact.integrity, integrity, 'Packed artifact integrity must match its bytes');

  const manifestPath = join(consumerRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.dependencies['@nestarc/webhook'] = `file:${tarball}`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run(['install', '--strict-peer-deps=true', '--force=false', '--legacy-peer-deps=false'], consumerRoot);

  const lock = JSON.parse(readFileSync(join(consumerRoot, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@nestarc/webhook'].integrity, integrity);
  const installedManifest = JSON.parse(readFileSync(
    join(consumerRoot, 'node_modules/@nestarc/webhook/package.json'), 'utf8',
  ));
  assert.equal(artifact.id, `${installedManifest.name}@${installedManifest.version}`);

  run(['start'], consumerRoot);
  console.log(`Packed Quick Start passed: ${artifact.id}; real PostgreSQL, HTTP, and scheduled delivery.`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
