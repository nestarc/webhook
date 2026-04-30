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

/** Internal record that includes the signing secret. Only used for endpoint creation response and delivery enrichment. */
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
  /** Keep the previous secret valid until this timestamp so queued receivers can overlap during rotation. */
  previousSecretExpiresAt: Date;
}
