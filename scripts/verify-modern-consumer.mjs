import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
const packageIdentity = `${sourceManifest.name}@${sourceManifest.version}`;
const peerBypassEnvironment = new Set(['npm_config_force', 'npm_config_legacy_peer_deps']);
const falseValues = new Set(['', '0', 'false', 'no', 'off']);

for (const [name, value] of Object.entries(process.env)) {
  const normalizedName = name.toLowerCase().replaceAll('-', '_');
  if (
    peerBypassEnvironment.has(normalizedName) &&
    value !== undefined &&
    !falseValues.has(value.trim().toLowerCase())
  ) {
    throw new Error(`${name}=${value} would bypass strict peer dependency verification`);
  }
}

const strictPeerEnvironment = {
  ...process.env,
  npm_config_force: 'false',
  NPM_CONFIG_FORCE: 'false',
  npm_config_legacy_peer_deps: 'false',
  NPM_CONFIG_LEGACY_PEER_DEPS: 'false',
  npm_config_strict_peer_deps: 'true',
  NPM_CONFIG_STRICT_PEER_DEPS: 'true',
};
const consumerRoot = mkdtempSync(join(tmpdir(), 'webhook-modern-consumer-'));

const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: strictPeerEnvironment,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

try {
  const packResult = JSON.parse(
    run(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', consumerRoot],
      repositoryRoot,
    ),
  );
  const packedArtifact = packResult[0];
  const tarball = join(consumerRoot, packedArtifact.filename);
  const computedIntegrity = `sha512-${createHash('sha512')
    .update(readFileSync(tarball))
    .digest('base64')}`;

  if (packedArtifact.id !== packageIdentity || !packedArtifact.integrity) {
    throw new Error('npm pack did not produce the expected versioned artifact identity');
  }
  if (packedArtifact.integrity !== computedIntegrity) {
    throw new Error('npm pack integrity does not match the independently hashed tarball bytes');
  }

  const packedFiles = new Set(packedArtifact.files.map(({ path }) => path));
  for (const required of [
    'README.md', 'CHANGELOG.md', 'SECURITY.md', 'LICENSE', 'docs/usage.md', 'llms.txt',
    'examples/quick-start/README.md', 'examples/quick-start/package.json',
    'src/sql/create-webhook-tables.sql', 'src/sql/migrations/v0.9.0.sql',
    'src/sql/migrations/v0.12.0.sql', 'src/sql/migrations/v0.13.0.sql', 'dist/index.d.ts',
  ]) {
    if (!packedFiles.has(required)) throw new Error(`Packed consumer documentation/file missing: ${required}`);
  }
  if ([...packedFiles].some((path) => /^examples\/quick-start\/(node_modules|dist|generated)\//.test(path))) {
    throw new Error('Packed example must not include installed dependencies or generated output');
  }

  writeFileSync(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'webhook-modern-consumer',
        private: true,
        version: '0.0.0',
        dependencies: {
          '@nestarc/webhook': `file:${tarball}`,
          '@nestjs/common': '11.2.1',
          '@nestjs/core': '11.2.1',
          '@nestjs/schedule': '5.0.1',
          '@prisma/adapter-pg': '7.10.0',
          '@prisma/client': '7.10.0',
          '@types/node': '25.6.0',
          pg: '8.23.0',
          'reflect-metadata': '0.2.2',
          rxjs: '7.8.2',
          typescript: '5.9.3',
        },
      },
      null,
      2,
    )}\n`,
  );

  run(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--strict-peer-deps=true',
      '--force=false',
      '--legacy-peer-deps=false',
    ],
    consumerRoot,
  );
  run(
    'npm',
    [
      'ci',
      '--ignore-scripts',
      '--strict-peer-deps=true',
      '--force=false',
      '--legacy-peer-deps=false',
    ],
    consumerRoot,
  );

  writeFileSync(
    join(consumerRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
          strict: true,
          target: 'ES2022',
          skipLibCheck: false,
        },
        files: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(consumerRoot, 'consumer.ts'),
    `import { PrismaPg } from '@prisma/adapter-pg';
import { WebhookModule, WebhookModuleOptions, WebhookService } from '@nestarc/webhook';

const adapter = new PrismaPg({ connectionString: 'postgresql://consumer:consumer@localhost/consumer' });
const options: WebhookModuleOptions = {
  prisma: { $queryRaw: async () => [] },
  polling: { enabled: false },
};
const definition = WebhookModule.forRoot(options);
const serviceType: typeof WebhookService = WebhookService;
void definition;
void serviceType;
void adapter;
`,
  );
  run(join(consumerRoot, 'node_modules/.bin/tsc'), ['--noEmit'], consumerRoot);

  writeFileSync(
    join(consumerRoot, 'runtime.cjs'),
    `const assert = require('node:assert/strict');
const webhook = require('@nestarc/webhook');
const { DEFAULT_USER_AGENT } = require('@nestarc/webhook/dist/webhook.constants');
const definition = webhook.WebhookModule.forRoot({ prisma: {}, polling: { enabled: false } });
assert.equal(definition.module, webhook.WebhookModule);
assert.equal(DEFAULT_USER_AGENT, ${JSON.stringify(`${sourceManifest.name}/${sourceManifest.version}`)});
assert.equal(typeof webhook.WebhookService, 'function');
`,
  );
  run(process.execPath, ['runtime.cjs'], consumerRoot);

  writeFileSync(
    join(consumerRoot, 'provisioning-secret.cjs'),
    readFileSync(join(repositoryRoot, 'scripts/fixtures/provisioning-secret.cjs'), 'utf8'),
  );
  run(process.execPath, ['provisioning-secret.cjs'], consumerRoot);

  const tree = JSON.parse(run('npm', ['ls', '--depth=0', '--json'], consumerRoot));
  const expected = {
    '@nestarc/webhook': sourceManifest.version,
    '@nestjs/common': '11.2.1',
    '@nestjs/core': '11.2.1',
    '@nestjs/schedule': '5.0.1',
    '@prisma/adapter-pg': '7.10.0',
    '@prisma/client': '7.10.0',
    pg: '8.23.0',
  };

  for (const [name, version] of Object.entries(expected)) {
    const installed = tree.dependencies?.[name]?.version;
    if (installed !== version) {
      throw new Error(`Expected ${name}@${version}, found ${installed ?? 'missing'}`);
    }
  }

  const packedManifest = JSON.parse(
    readFileSync(join(consumerRoot, 'node_modules/@nestarc/webhook/package.json'), 'utf8'),
  );
  if (
    packedManifest.name !== '@nestarc/webhook' ||
    packedManifest.version !== sourceManifest.version ||
    packedManifest.repository?.url !== 'https://github.com/nestarc/webhook.git'
  ) {
    throw new Error('Installed webhook artifact identity/repository metadata does not match this repository');
  }
  if (packedManifest.peerDependencies?.['@prisma/client'] !== '^5.0.0 || ^6.0.0 || ^7.0.0') {
    throw new Error('Packed webhook artifact does not declare the Prisma 7 peer range');
  }

  const consumerLock = JSON.parse(
    readFileSync(join(consumerRoot, 'package-lock.json'), 'utf8'),
  );
  const lockedWebhook = consumerLock.packages?.['node_modules/@nestarc/webhook'];
  if (
    lockedWebhook?.version !== sourceManifest.version ||
    !lockedWebhook.resolved?.startsWith('file:') ||
    lockedWebhook.integrity !== packedArtifact.integrity
  ) {
    throw new Error('Consumer lock does not preserve the packed webhook artifact integrity');
  }

  for (const [name, version] of Object.entries(expected)) {
    if (name === '@nestarc/webhook') continue;
    const lockedDependency = consumerLock.packages?.[`node_modules/${name}`];
    if (
      lockedDependency?.version !== version ||
      !lockedDependency.resolved?.startsWith('https://registry.npmjs.org/') ||
      !lockedDependency.integrity?.startsWith('sha512-')
    ) {
      throw new Error(`Consumer lock does not preserve registry origin/integrity for ${name}@${version}`);
    }
  }

  process.stdout.write(
    `Strict modern consumer passed: ${packageIdentity} + NestJS 11.2.1 + Prisma 7.10.0; independently verified integrity ${computedIntegrity}; packaged documentation, public types and runtime load verified.\n`,
  );
} finally {
  rmSync(consumerRoot, { recursive: true, force: true });
}
