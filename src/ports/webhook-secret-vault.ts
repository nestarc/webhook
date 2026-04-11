/**
 * Port for encrypting/decrypting endpoint signing secrets at rest.
 * Implement this interface to provide custom encryption (e.g. AES-256-GCM).
 * The default PlaintextSecretVault passes values through unchanged.
 */
export interface WebhookSecretVault {
  encrypt(plainSecret: string): Promise<string>;
  decrypt(encryptedSecret: string): Promise<string>;
}
