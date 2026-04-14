// @revamp/core — Frontend business logic package
//
// This package follows the Multica pattern:
//   - Zero react-dom imports
//   - Zero next/* imports
//   - Zero direct browser API usage (localStorage, window)
//   - Platform-specific code injected via providers
//
// Boundary rules:
//   ✓ React hooks (useQuery, useState, etc.)
//   ✓ @tanstack/react-query
//   ✓ zustand
//   ✓ @revamp/shared-types
//   ✗ next/*
//   ✗ react-dom
//   ✗ localStorage / sessionStorage / window directly
//   ✗ process.env

// API
export { setApiClient, getApiClient } from './api/types';
export type { ApiClient, ApiResponse, RequestConfig } from './api/types';

// Query Keys
export { pipelineKeys, projectKeys, agentKeys } from './hooks/pipeline-keys';

// Types
export type {
  PipelineStatus,
  StageProgressEntry,
  ApprovalGate,
  SubtaskEntry,
  ValidationResult,
} from './types/pipeline';
