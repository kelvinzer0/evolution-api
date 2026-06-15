// Mirrors evolution-go/pkg/core/model.go
// Persisted as key/value rows in the RuntimeConfig table.

export const ConfigKey = {
  InstanceID: 'instance_id',
  APIKey: 'api_key',
  Tier: 'tier',
  CustomerID: 'customer_id',
} as const;

export type ConfigKey = (typeof ConfigKey)[keyof typeof ConfigKey];

export interface RuntimeData {
  apiKey: string;
  tier: string;
  customerId: number;
}

export interface LicenseStatusResponse {
  status: 'active' | 'inactive';
  instance_id: string;
  api_key?: string;
}

export interface RegisterInitResponse {
  register_url: string;
  token: string;
}

export interface RegisterExchangeResponse {
  api_key: string;
  tier: string;
  customer_id: number;
}

export interface RuntimeContextSnapshot {
  active: boolean;
  apiKey: string;
  instanceId: string;
  tier: string;
  version: string;
  registerUrl: string;
}
