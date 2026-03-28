/**
 * Project domain types for REVAMP 10X
 *
 * Extended from legacy-bridge project types with server-side storage,
 * type-safe enums, and full pipeline configuration support.
 */

import { PipelineStageName } from './pipeline';

// ─── Enums ─────────────────────────────────────────────────────────────────

export enum ProjectStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  IN_PROGRESS = 'IN_PROGRESS',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  ARCHIVED = 'ARCHIVED',
  FAILED = 'FAILED',
}

export type CloudProvider = 'aws' | 'azure' | 'gcp' | 'on-prem' | '';

export type Severity = 'critical' | 'warning' | 'info';

export type ApprovalAction = 'approved' | 'rejected' | 'rerun' | 'skipped' | 'prompt_edited' | 'failed';

export type ProjectMemberRole = 'OWNER' | 'LEAD' | 'CONTRIBUTOR' | 'REVIEWER';

export type ProjectRole = 'sme' | 'developer' | 'architect';

export type ApproverRole = 'sme' | 'architect';

// ─── Codebase Source ───────────────────────────────────────────────────────

export interface CodebaseSource {
  type: 'git' | 'upload' | 'local';
  url?: string;
  branch?: string;
  token?: string;
  path?: string;
  languages?: string[];
}

export interface DestinationRepo {
  url: string;
  branch?: string;
  token?: string;
}

// ─── File System Types ─────────────────────────────────────────────────────

export interface FolderNode {
  name: string;
  type: 'dir' | 'file';
  children?: FolderNode[];
  path?: string;
  size?: number;
  language?: string;
}

export interface CodeFile {
  path: string;
  name: string;
  language: string;
  content: string;
  size: number;
  lastModified?: string;
  isNew?: boolean;
  isModified?: boolean;
  isDeleted?: boolean;
}

export interface SupportingDocument {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  storageKey: string;
  uploadedBy: string;
  uploadedAt: string;
}

// ─── Validation Types ──────────────────────────────────────────────────────

export interface ValidationFinding {
  id: string;
  category: string;
  severity: Severity;
  message: string;
  codeLocation?: string;
  lineNumber?: number;
}

export interface ValidationDimensionScore {
  name: string;
  score: number;
  weight: number;
  details: string;
}

export interface ValidationResult {
  confidenceScore: number;
  findings: ValidationFinding[];
  dimensionScores?: ValidationDimensionScore[];
  timestamp: string;
}

export interface BddTestResult {
  name: string;
  status: 'pass' | 'fail';
  duration: number;
  error?: string;
}

// ─── Approval Types ────────────────────────────────────────────────────────

export interface ApprovalEntry {
  action: ApprovalAction;
  timestamp: string;
  user: string;
  comment: string;
  role?: ProjectRole;
  autoApproved?: boolean;
}

// ─── Project Settings ──────────────────────────────────────────────────────

export interface ProjectSettings {
  primaryAiModel: string;
  validationAiModel: string;
  bddFramework: string;
  testTimeout: number;
  confidenceThreshold: number;
  maxTokens: number;
  autoApprovalTimeoutHours: number;
  autoApprovalEnabled: boolean;
  cloudProvider: CloudProvider;
  deepAnalysis: Record<number, boolean>;
}

export interface ProjectLlmConfig {
  providerId: string;
  modelId: string;
  apiKey?: string;
  endpoint?: string;
}

// ─── Project Metrics ───────────────────────────────────────────────────────

export interface ProjectMetrics {
  filesProcessed: number;
  linesAnalyzed: number;
  tokensUsed: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost?: number;
}

// ─── Prompt History ────────────────────────────────────────────────────────

export interface PromptHistoryEntry {
  prompt: string;
  timestamp: string;
  changedBy: string;
}

// ─── System Log ────────────────────────────────────────────────────────────

export type SystemLogCategory = 'ai' | 'file' | 'git' | 'auth' | 'settings' | 'member' | 'template';

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  category: SystemLogCategory;
  action: string;
  user: string;
  details: string;
  metadata?: Record<string, unknown>;
}

// ─── Project Member ────────────────────────────────────────────────────────

export interface ProjectMember {
  id: string;
  userId: string;
  projectId: string;
  role: ProjectMemberRole;
  joinedAt: string;
  email?: string;
  name?: string;
  avatar?: string;
}

// ─── Project Metadata ──────────────────────────────────────────────────────

export interface ProjectMetadata {
  sourceLanguage?: string;
  sourceLanguages?: string[];
  targetArchitecture?: string;
  targetStack?: string;
  cloudProvider?: CloudProvider;
  estimatedServices?: number;
  estimatedComplexity?: 'Low' | 'Medium' | 'High' | 'Critical';
  codeRepository?: string;
  documentationUrl?: string;
  tags?: string[];
}

// ─── Stage Approver Map ────────────────────────────────────────────────────

export const STAGE_APPROVER: Record<number, ApproverRole> = {
  0: 'sme',
  1: 'sme',
  2: 'sme',
  3: 'architect',
  4: 'architect',
  5: 'architect',
  6: 'sme',
  7: 'architect',
};

// ─── Full Project ──────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus;
  organizationId: string;
  ownerId: string;
  metadata: ProjectMetadata;
  members: ProjectMember[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  archivedAt?: string;
  // 10X extensions
  codebaseSource?: CodebaseSource;
  destinationRepo?: DestinationRepo;
  supportingDocuments?: SupportingDocument[];
  settings?: ProjectSettings;
  metrics?: ProjectMetrics;
  folderStructure?: FolderNode[];
  stagePrompts?: Record<number, string>;
  validationPrompts?: Record<number, string>;
  promptHistory?: Record<number, PromptHistoryEntry[]>;
  appliedTemplateId?: string;
  currentStage?: number;
}

// ─── Request/Response Types ────────────────────────────────────────────────

export interface CreateProjectRequest {
  name: string;
  description: string;
  codebaseSource?: CodebaseSource;
  targetStack?: string;
  cloudProvider?: CloudProvider;
  promptTemplateId?: string;
  metadata?: Partial<ProjectMetadata>;
  members?: Array<{
    userId: string;
    role: ProjectMemberRole;
  }>;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  metadata?: Partial<ProjectMetadata>;
  codebaseSource?: CodebaseSource;
  settings?: Partial<ProjectSettings>;
  stagePrompts?: Record<number, string>;
  validationPrompts?: Record<number, string>;
}

export interface ProjectStats {
  projectId: string;
  totalPipelines: number;
  completedPipelines: number;
  activeRuns: number;
  totalApprovals: number;
  pendingApprovals: number;
  codeAnalyzed: number;
  servicesIdentified: number;
  estimatedProgress: number;
  totalTokensUsed?: number;
  estimatedCost?: number;
}

// ─── Default Constants ─────────────────────────────────────────────────────

export const DEFAULT_FOLDER_STRUCTURE: FolderNode[] = [
  { name: 'docs/', type: 'dir', children: [
    { name: 'requirements/', type: 'dir', children: [] },
    { name: 'architecture/', type: 'dir', children: [] },
    { name: 'bdd-specs/', type: 'dir', children: [] },
  ]},
  { name: 'legacy/', type: 'dir', children: [
    { name: 'source/', type: 'dir', children: [] },
    { name: 'analysis/', type: 'dir', children: [] },
  ]},
  { name: 'modernized/', type: 'dir', children: [
    { name: 'services/', type: 'dir', children: [] },
    { name: 'infrastructure/', type: 'dir', children: [] },
    { name: 'tests/', type: 'dir', children: [] },
  ]},
  { name: 'reports/', type: 'dir', children: [
    { name: 'validation/', type: 'dir', children: [] },
    { name: 'traceability/', type: 'dir', children: [] },
  ]},
];

export function createDefaultSettings(): ProjectSettings {
  return {
    primaryAiModel: '',
    validationAiModel: '',
    bddFramework: 'cucumber',
    testTimeout: 30,
    confidenceThreshold: 75,
    maxTokens: 16384,
    autoApprovalTimeoutHours: 3,
    autoApprovalEnabled: true,
    cloudProvider: '',
    deepAnalysis: {},
  };
}
