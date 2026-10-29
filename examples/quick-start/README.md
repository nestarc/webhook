# Runnable NestJS webhook example

This example starts a NestJS application context and a receiver on an ephemeral
loopback port, registers an endpoint, publishes a tenant event, and lets the normal
scheduled worker deliver it. It verifies the raw request signature, rejects a
tampered body, acknowledges a duplicate without processing it again, and checks
the persisted `SENT` delivery and its attempt log.

## Run

This example targets `@nestarc/webhook@0.13.3`. For repository development,
verify local changes with the [packed-source verification](#verify-the-repository-build) below.

Use Node.js **20.19+, 22.12+, or 24+** (the supported Prisma 7 release lines) and
PostgreSQL **14+**. The database user needs permission to create schemas. Use a
local test database; each run creates a random schema and drops only that schema
when it finishes. Existing webhook tables are not used.

From this directory:

```bash
export DATABASE_URL='postgresql://webhook_test:webhook_test@localhost:5433/webhook_test'
npm install --strict-peer-deps
npm start
```

For example, start a disposable PostgreSQL database with Docker first:

```bash
docker run --rm --name webhook-quick-start-db \
  -e POSTGRES_USER=webhook_test \
  -e POSTGRES_PASSWORD=webhook_test \
  -e POSTGRES_DB=webhook_test \
  -p 127.0.0.1:5433:5432 postgres:16-alpine
```

Wait for PostgreSQL to report that it is ready to accept connections, then run the
example in a second terminal. Stop the Docker command when finished.

Expected output:

```text
Verified webhook: type=order.created tenant=tenant_example delivery=SENT attempts=1
Verified receiver: tampered=401 duplicate=200 processed=1
Quick start passed; temporary schema removed and connections closed.
```

`npm start` generates the Prisma 7 client, compiles the CommonJS application, and
runs it. The package uses raw SQL, so the Prisma schema needs no webhook models.
The example applies the SQL shipped with the installed package to its temporary
schema; it skips the `pgcrypto` extension because PostgreSQL 14+ already supplies
`gen_random_uuid()`.

## Use the pattern in your application

- Register an endpoint and provide its secret to the receiver **before** publishing.
  `sendToTenant()` limits matching destinations to that tenant. `send()` broadcasts
  to matching endpoints across tenants.
- Verify the untouched request body before parsing JSON. A successful
  `verifyWithTolerance()` check accepts repeated valid requests within the window;
  deduplicate by `webhook-id` separately.
- The in-memory `Set` here lasts for one process. In production, store the event ID
  durably with a unique constraint and commit it atomically with the business
  change. Concurrent requests, restarts, and retries must not repeat that change.
- `allowPrivateUrls: true` permits this loopback destination. Omit it for production
  public destinations, use HTTPS, and store signing secrets securely.
- Replace the temporary-schema setup with your normal versioned migrations, and
  keep your application's existing Prisma client and Nest lifecycle. This finite
  example closes Nest before disconnecting the database.

## Verify the repository build

From the repository root, with `DATABASE_URL` set, run:

```bash
npm run test:consumer:quick-start
```

The verifier packs the current build, copies this example into a temporary
consumer directory, installs the tarball with strict peer dependency resolution,
and runs the same `npm start` command. Application imports use only the package's
public root exports; SQL comes from the installed package. No repository source
imports or mocked database/HTTP adapters are used.
