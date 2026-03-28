/**
 * Common API types and response envelopes
 */

export type SortOrder = 'asc' | 'desc';

export interface PaginationParams {
  page?: number; // 1-indexed
  pageSize?: number;
  sortBy?: string;
  sortOrder?: SortOrder;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
  links?: {
    self: string;
    first: string;
    last: string;
    next?: string;
    previous?: string;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: Record<string, unknown>;
  timestamp: string;
}

export enum ApiErrorCode {
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  RATE_LIMITED = 'RATE_LIMITED',
  TIMEOUT = 'TIMEOUT',
}

export interface FieldError {
  field: string;
  message: string;
  code?: string;
  value?: unknown;
}

export interface ApiError {
  code: ApiErrorCode | string;
  message: string;
  details?: string;
  statusCode: number;
  requestId?: string;
  fieldErrors?: FieldError[];
  timestamp: string;
}

export interface ValidationError {
  field: string;
  message: string;
  type: 'required' | 'invalid' | 'unique' | 'format' | 'range' | 'custom';
  value?: unknown;
}

export interface BatchRequest<T> {
  requests: Array<{
    id: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    body?: T;
  }>;
}

export interface BatchResponse<T> {
  responses: Array<{
    id: string;
    statusCode: number;
    body?: T;
    error?: ApiError;
  }>;
}

export interface HealthCheckResponse {
  status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
  version: string;
  timestamp: string;
  uptime: number; // seconds
  checks: Record<string, {
    status: 'PASS' | 'WARN' | 'FAIL';
    message?: string;
    responseTime?: number;
  }>;
}

export interface WebhookPayload {
  id: string;
  event: string;
  timestamp: string;
  version: string;
  data: Record<string, unknown>;
  attempt: number;
}

export interface WebhookConfig {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  secret?: string;
  retryPolicy?: {
    maxAttempts: number;
    backoffMultiplier: number;
    initialDelayMs: number;
  };
  headers?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface PaginatedRequest<TFilters = Record<string, unknown>> {
  pagination?: PaginationParams;
  filters?: TFilters;
  search?: string;
}

export interface ListResponse<T> extends PaginatedResponse<T> {
  count: number;
}

export interface ErrorResponse {
  error: ApiError;
}

export type ApiEndpointResponse<T> = ApiResponse<T> | ErrorResponse;
