/**
 * Skill Catalog — centralized skill definitions for the Agent Department.
 *
 * Each skill has a category, keywords (used for task matching), and a weight
 * that influences scoring during agent-to-task assignment.
 */

import type { Skill, SkillCategory } from '@revamp/shared-types/agent';

// ─── SKILL DEFINITIONS ──────────────────────────────────────────

export const SKILL_CATALOG: Skill[] = [
  // Legacy Analysis
  { name: 'cobol-analysis', category: 'legacy-analysis', proficiency: 'expert', keywords: ['cobol', 'mainframe', 'jcl', 'copybook', 'cics', 'vsam', 'db2'], weight: 90 },
  { name: 'vb6-analysis', category: 'legacy-analysis', proficiency: 'expert', keywords: ['vb6', 'visual basic', 'com', 'activex', 'msaccess', 'vba'], weight: 85 },
  { name: 'delphi-analysis', category: 'legacy-analysis', proficiency: 'expert', keywords: ['delphi', 'pascal', 'object pascal', 'borland', 'vcl'], weight: 80 },
  { name: 'fortran-analysis', category: 'legacy-analysis', proficiency: 'advanced', keywords: ['fortran', 'f77', 'f90', 'f95', 'scientific', 'numerical'], weight: 75 },
  { name: 'powerbuilder-analysis', category: 'legacy-analysis', proficiency: 'advanced', keywords: ['powerbuilder', 'datawindow', 'powerscript', 'sybase'], weight: 75 },
  { name: 'business-rule-extraction', category: 'legacy-analysis', proficiency: 'expert', keywords: ['business rules', 'domain logic', 'workflow', 'business process'], weight: 85 },

  // Architecture
  { name: 'system-decomposition', category: 'architecture', proficiency: 'expert', keywords: ['microservices', 'bounded context', 'domain-driven', 'ddd', 'decomposition', 'api design'], weight: 95 },
  { name: 'data-modeling', category: 'architecture', proficiency: 'expert', keywords: ['schema', 'erd', 'normalization', 'migration', 'postgresql', 'database'], weight: 90 },
  { name: 'cloud-architecture', category: 'architecture', proficiency: 'advanced', keywords: ['aws', 'gcp', 'azure', 'kubernetes', 'terraform', 'cloud-native'], weight: 85 },
  { name: 'api-design', category: 'architecture', proficiency: 'expert', keywords: ['rest', 'graphql', 'grpc', 'openapi', 'swagger', 'api gateway'], weight: 85 },

  // Code Transformation
  { name: 'java-spring-dev', category: 'code-transformation', proficiency: 'expert', keywords: ['java', 'spring boot', 'spring', 'maven', 'gradle', 'hibernate', 'jpa'], weight: 90 },
  { name: 'python-fastapi-dev', category: 'code-transformation', proficiency: 'expert', keywords: ['python', 'fastapi', 'django', 'flask', 'sqlalchemy', 'pydantic'], weight: 90 },
  { name: 'go-dev', category: 'code-transformation', proficiency: 'expert', keywords: ['go', 'golang', 'chi', 'gin', 'goroutine', 'concurrency'], weight: 85 },
  { name: 'frontend-dev', category: 'code-transformation', proficiency: 'expert', keywords: ['react', 'typescript', 'nextjs', 'tailwind', 'angular', 'vue'], weight: 85 },
  { name: 'dotnet-dev', category: 'code-transformation', proficiency: 'advanced', keywords: ['.net', 'c#', 'aspnet', 'entity framework', 'blazor'], weight: 80 },

  // Testing
  { name: 'bdd-testing', category: 'testing', proficiency: 'expert', keywords: ['bdd', 'gherkin', 'cucumber', 'behavior-driven', 'acceptance test', 'spec'], weight: 90 },
  { name: 'integration-testing', category: 'testing', proficiency: 'advanced', keywords: ['integration', 'e2e', 'api test', 'contract test', 'testcontainers'], weight: 80 },
  { name: 'performance-testing', category: 'testing', proficiency: 'advanced', keywords: ['performance', 'load test', 'benchmark', 'jmeter', 'k6', 'gatling'], weight: 75 },

  // Data Migration
  { name: 'schema-migration', category: 'data-migration', proficiency: 'expert', keywords: ['schema', 'migration', 'flyway', 'liquibase', 'drizzle', 'alembic'], weight: 85 },
  { name: 'data-transformation', category: 'data-migration', proficiency: 'advanced', keywords: ['etl', 'data pipeline', 'data mapping', 'transformation', 'cleansing'], weight: 80 },

  // DevOps
  { name: 'ci-cd', category: 'devops', proficiency: 'expert', keywords: ['ci/cd', 'github actions', 'jenkins', 'gitlab ci', 'pipeline', 'deploy'], weight: 85 },
  { name: 'containerization', category: 'devops', proficiency: 'expert', keywords: ['docker', 'kubernetes', 'helm', 'container', 'k8s', 'pod'], weight: 85 },
  { name: 'infrastructure', category: 'devops', proficiency: 'advanced', keywords: ['terraform', 'pulumi', 'cloudformation', 'iac', 'infrastructure'], weight: 80 },

  // Documentation
  { name: 'technical-docs', category: 'documentation', proficiency: 'expert', keywords: ['documentation', 'api docs', 'readme', 'architecture decision', 'adr'], weight: 80 },
  { name: 'runbook-creation', category: 'documentation', proficiency: 'advanced', keywords: ['runbook', 'playbook', 'sop', 'operations', 'incident'], weight: 75 },

  // Project Management
  { name: 'task-decomposition', category: 'project-management', proficiency: 'expert', keywords: ['decomposition', 'work breakdown', 'estimation', 'planning', 'sprint'], weight: 85 },
  { name: 'stakeholder-comms', category: 'project-management', proficiency: 'advanced', keywords: ['stakeholder', 'status report', 'progress', 'communication'], weight: 75 },

  // Security
  { name: 'security-audit', category: 'security', proficiency: 'expert', keywords: ['security', 'vulnerability', 'owasp', 'penetration', 'cve', 'sast', 'dast'], weight: 90 },
  { name: 'compliance-review', category: 'security', proficiency: 'advanced', keywords: ['compliance', 'gdpr', 'hipaa', 'sox', 'pci-dss', 'audit'], weight: 80 },
];

/**
 * Get skills by category.
 */
export function getSkillsByCategory(category: SkillCategory): Skill[] {
  return SKILL_CATALOG.filter((s) => s.category === category);
}

/**
 * Find a skill by name.
 */
export function getSkillByName(name: string): Skill | undefined {
  return SKILL_CATALOG.find((s) => s.name === name);
}

/**
 * Search skills by keyword overlap.
 */
export function searchSkills(keywords: string[]): Skill[] {
  const lower = keywords.map((k) => k.toLowerCase());
  return SKILL_CATALOG.filter((skill) =>
    skill.keywords.some((kw) => lower.some((q) => kw.includes(q) || q.includes(kw)))
  ).sort((a, b) => b.weight - a.weight);
}
