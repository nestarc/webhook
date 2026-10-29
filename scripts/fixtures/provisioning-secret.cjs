const assert = require('node:assert/strict');
const {
  PrismaEndpointRepository,
  WebhookEndpointAdminService,
  WebhookSigner,
} = require(process.argv[2] || '@nestarc/webhook');

async function verifyProvisioning(secret) {
  let stored;
  const encryptedInputs = [];
  const vault = {
    async encrypt(value) {
      encryptedInputs.push(value);
      return `encrypted:${value}`;
    },
    async decrypt() {
      throw new Error('Provisioning and endpoint reads must not require vault decryption');
    },
  };
  const publicRecord = () => {
    const { secret: _secret, previousSecret: _previous, ...record } = stored;
    return record;
  };
  const prisma = {
    async $queryRawUnsafe(query, ...values) {
      if (query.trim().startsWith('INSERT INTO webhook_endpoints')) {
        stored = Object.freeze({
          id: 'endpoint-1', url: values[0], secret: values[1], events: values[2],
          description: values[3], metadata: values[4], tenantId: values[5],
          active: true, consecutiveFailures: 0, disabledAt: null, disabledReason: null,
          previousSecretExpiresAt: null, createdAt: new Date(), updatedAt: new Date(),
        });
        return [stored];
      }
      if (query.trim().startsWith('UPDATE webhook_endpoints')) {
        assert.match(query, /previous_secret = secret/);
        assert.equal(values[2], stored.id);
        stored = Object.freeze({
          ...stored, previousSecret: stored.secret, secret: values[0],
          previousSecretExpiresAt: values[1],
        });
        assert.doesNotMatch(query.split('RETURNING')[1], /\b(?:secret|previous_secret)\b/);
        return [publicRecord()];
      }
      assert.match(query, /SELECT/);
      assert.doesNotMatch(query.split('FROM')[0], /\b(?:secret|previous_secret)\b/);
      return [publicRecord()];
    },
  };
  const repository = new PrismaEndpointRepository(prisma, vault);
  const admin = new WebhookEndpointAdminService(
    repository, {}, {}, new WebhookSigner(), { allowPrivateUrls: true },
  );
  const endpoint = await admin.createEndpoint({
    url: 'https://receiver.example/hook', events: ['order.created'], tenantId: 'tenant-a', secret,
  });
  const originalSecret = encryptedInputs[0];
  assert.equal(endpoint.secret, originalSecret);
  assert.equal(Buffer.from(originalSecret, 'base64').length, 32);
  if (secret && secret !== 'auto') assert.equal(endpoint.secret, secret);
  assert.equal(stored.secret, `encrypted:${originalSecret}`);
  assert.equal(stored.tenantId, 'tenant-a');
  assert.notEqual(endpoint, stored);

  const found = await admin.getEndpoint(endpoint.id);
  const listed = await admin.listEndpoints('tenant-a');
  assert.equal(Object.hasOwn(found, 'secret'), false);
  assert.equal(Object.hasOwn(listed[0], 'secret'), false);

  const replacement = Buffer.alloc(32, 2).toString('base64');
  const rotated = await admin.rotateSecret(endpoint.id, {
    secret: replacement, previousSecretExpiresAt: new Date(Date.now() + 60_000),
  });
  assert.equal(rotated.secret, replacement);
  assert.equal(stored.secret, `encrypted:${replacement}`);
  assert.equal(stored.previousSecret, `encrypted:${originalSecret}`);
  const afterRotation = await admin.getEndpoint(endpoint.id);
  assert.equal(Object.hasOwn(afterRotation, 'secret'), false);
  assert.equal(Object.hasOwn(afterRotation, 'previousSecret'), false);
}

(async () => {
  for (const secret of [undefined, 'auto', Buffer.alloc(32, 1).toString('base64')]) {
    await verifyProvisioning(secret);
  }
  console.log('Packed provisioning regression passed: generated/explicit keys, ciphertext storage, read redaction and rotation.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
