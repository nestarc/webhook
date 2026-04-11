import { WebhookSecretVault } from '../ports/webhook-secret-vault';

/**
 * Default no-op vault — secrets are stored and retrieved as-is.
 * Replace with a real implementation (e.g. AES-256-GCM) for production.
 */
export class PlaintextSecretVault implements WebhookSecretVault {
  async encrypt(secret: string): Promise<string> {
    return secret;
  }

  async decrypt(secret: string): Promise<string> {
    return secret;
  }
}
