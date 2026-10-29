export interface EndpointRecord {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  description: string | null;
  metadata: Record<string, unknown> | null;
  tenantId: string | null;
  consecutiveFailures: number;
  disabledAt: Date | null;
  disabledReason: string | null;
  previousSecretExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Provisioning response with the new plaintext signing secret, even with an encryption vault. Read APIs omit it. */
export interface EndpointRecordWithSecret extends EndpointRecord {
  secret: string;
}

export interface CreateEndpointDto {
  url: string;
  events: string[];
  /** Pass `'auto'` or omit the field to generate a secure base64 signing secret. */
  secret?: string;
  description?: string;
  /** JSON-serializable metadata stored as jsonb. Dates become strings; BigInt is not supported. */
  metadata?: Record<string, unknown>;
  tenantId?: string;
}

export interface UpdateEndpointDto {
  url?: string;
  events?: string[];
  description?: string;
  /** JSON-serializable metadata stored as jsonb. Dates become strings; BigInt is not supported. */
  metadata?: Record<string, unknown>;
  active?: boolean;
}

export interface RotateEndpointSecretDto {
  /** Pass `'auto'` or omit the field to generate a secure base64 signing secret. */
  secret?: string;
  /** Include the previous secret in deliveries queued before this future timestamp. Existing queued snapshots are not expired or rewritten. */
  previousSecretExpiresAt: Date;
}
