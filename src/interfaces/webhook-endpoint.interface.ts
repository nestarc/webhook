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
  secret?: string | 'auto';
  description?: string;
  metadata?: Record<string, unknown>;
  tenantId?: string;
}

export interface UpdateEndpointDto {
  url?: string;
  events?: string[];
  description?: string;
  metadata?: Record<string, unknown>;
  active?: boolean;
}
