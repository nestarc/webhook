import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const nestMajor = process.env.COMPAT_NESTJS;
const prismaMajor = process.env.COMPAT_PRISMA;

const nestVersions = {
  '10': {
    '@nestjs/common': '10.4.20',
    '@nestjs/core': '10.4.20',
    '@nestjs/platform-express': '10.4.20',
    '@nestjs/schedule': '4.1.2',
    '@nestjs/testing': '10.4.20',
  },
  '11': {
    '@nestjs/common': '11.2.1',
    '@nestjs/core': '11.2.1',
    '@nestjs/platform-express': '11.2.1',
    '@nestjs/schedule': '5.0.1',
    '@nestjs/testing': '11.2.1',
  },
};

const prismaVersions = {
  '6': {
    '@prisma/adapter-pg': '6.19.3',
    '@prisma/client': '6.19.3',
    prisma: '6.19.3',
  },
  '7': {
    '@prisma/adapter-pg': '7.10.0',
    '@prisma/client': '7.10.0',
    prisma: '7.10.0',
  },
};

if (!nestVersions[nestMajor] || !prismaVersions[prismaMajor]) {
  throw new Error(`Unsupported compatibility tuple NestJS ${nestMajor} / Prisma ${prismaMajor}`);
}

const expected = {
  ...nestVersions[nestMajor],
  ...prismaVersions[prismaMajor],
  pg: '8.23.0',
};

for (const [name, version] of Object.entries(expected)) {
  const manifestPath = join(repositoryRoot, 'node_modules', ...name.split('/'), 'package.json');
  const installed = JSON.parse(readFileSync(manifestPath, 'utf8')).version;
  if (installed !== version) {
    throw new Error(`Expected ${name}@${version}, found ${installed}`);
  }
}

process.stdout.write(
  `Resolved compatibility tuple verified: NestJS ${nestMajor} / Prisma ${prismaMajor}.\n`,
);
