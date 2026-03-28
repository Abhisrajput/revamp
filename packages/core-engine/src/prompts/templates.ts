/**
 * Prompt templates for each pipeline stage
 */

import { PipelineStageName } from '@revamp/shared-types/pipeline';

export interface PromptTemplate {
  stageId: string;
  template: string;
  variables: string[];
  description: string;
  examples?: string[];
}

export const promptTemplates: Record<PipelineStageName, PromptTemplate> = {
  [PipelineStageName.SCAN]: {
    stageId: PipelineStageName.SCAN,
    description:
      'Inventory the codebase — catalog files, technologies, architecture, and key risks',
    variables: [
      'codebaseDescription',
      'repositoryUrl',
      'deploymentInfo',
      'teamSize',
      'mainTechnologies',
    ],
    template: `You are performing Stage 1 (SCAN) of an 8-stage modernization pipeline. Your job is to INVENTORY what exists — not to plan fixes or propose modernization strategies.

**Codebase Description:**
{{codebaseDescription}}

**Repository:** {{repositoryUrl}}
**Deployment:** {{deploymentInfo}}
**Team Size:** {{teamSize}}
**Main Technologies:** {{mainTechnologies}}

Produce a clean, readable analysis document with these sections:

## Executive Summary
3-5 sentences: what this system is, its current state, and the top concerns.

## Codebase Overview
Summary table: total files, LOC, languages, active vs. inactive status.

## Architecture
- System type (monolith, client-server, etc.)
- Component inventory table (name, path, type, LOC, status, description)
- ONE Mermaid diagram showing component relationships

## Technology Stack
- Languages table (language, version, LOC, %, status)
- Frameworks & libraries table
- Build/deployment tooling table
- Version risk summary (current vs. EOL)

## Security Posture
- Auth & session management summary
- Top security findings table (severity, location, category)
- Compliance flags table

## Key Risks & Blockers
Top 8-12 risks from the analysis, in a prioritized table.

## Readiness for Stage 2
Brief assessment of what the next stage (Intent Extraction) should focus on.

IMPORTANT — DO NOT include:
- Modernization plans, timelines, or cost estimates (that's Stage 5)
- Code refactoring suggestions (that's Stage 6)
- BDD/test scenarios (that's Stage 4)
- Business capability mapping (that's Stage 3)
- Remediation steps or "how to fix" instructions

Use TABLES instead of long prose. Target 2000-4000 words. Cite file paths for every finding.`,

    examples: [
      'Java-based e-commerce monolith with Spring Boot, deployed on AWS',
      'Legacy .NET application with tight coupling and manual deployment',
    ],
  },

  [PipelineStageName.DECODE]: {
    stageId: PipelineStageName.DECODE,
    description: 'Extract business intent, rules, and workflows from legacy code',
    variables: [
      'architecture',
      'businessDomains',
      'currentServices',
      'scalingPains',
    ],
    template: `Based on the current architecture, extract business intent:

**Current Architecture:**
{{architecture}}

**Business Domains:**
{{businessDomains}}

**Existing Services/Modules:**
{{currentServices}}

**Scaling Pain Points:**
{{scalingPains}}

For each identified capability, provide:
1. Capability name and description
2. Owned data entities
3. Key operations and workflows
4. Current location in codebase
5. Dependencies on other capabilities
6. Estimated complexity (Low/Medium/High)
7. Performance requirements
8. Scalability requirements
9. Security sensitivity
10. Priority for extraction

Organize by business domain and extraction priority.`,

    examples: [
      'User management: authentication, profiles, permissions',
      'Order processing: cart, checkout, fulfillment',
      'Inventory: stock levels, reservations, suppliers',
    ],
  },

  [PipelineStageName.BLUEPRINT]: {
    stageId: PipelineStageName.BLUEPRINT,
    description:
      'Map business capabilities to system components and define service boundaries',
    variables: [
      'capabilities',
      'dataModel',
      'communicationPatterns',
      'organizationStructure',
    ],
    template: `Design capability map and service boundaries:

**Capabilities to Extract:**
{{capabilities}}

**Current Data Model:**
{{dataModel}}

**Communication Patterns:**
{{communicationPatterns}}

**Organization Structure (Conway's Law):**
{{organizationStructure}}

For each proposed service, define:
1. Service name and purpose
2. Owned data entities and schemas
3. API operations (queries and commands)
4. Event types it publishes and subscribes to
5. External dependencies
6. Eventual consistency boundaries
7. Transactional guarantees needed
8. Suggested technology stack
9. Scaling considerations
10. Team ownership

Justify each boundary decision. Address:
- Cohesion within services
- Coupling between services
- Data consistency patterns
- Communication overhead
- Team autonomy`,

    examples: [
      'User service: authentication, profiles, permissions management',
      'Order service: order lifecycle, status tracking, notifications',
    ],
  },

  [PipelineStageName.SPEC_LOCK]: {
    stageId: PipelineStageName.SPEC_LOCK,
    description: 'Lock behavioral specs as BDD/Gherkin scenarios and acceptance criteria',
    variables: [
      'services',
      'currentInteractions',
      'qualityRequirements',
      'scalingRequirements',
    ],
    template: `Define behavioral contracts for these services:

**Services to Specify:**
{{services}}

**Current Interactions:**
{{currentInteractions}}

**Quality Requirements:**
{{qualityRequirements}}

**Scaling Requirements:**
{{scalingRequirements}}

For each service, specify:
1. OpenAPI/GraphQL schema with examples
2. Event schema (for published events)
3. Error responses and fault scenarios
4. Validation rules and constraints
5. Rate limiting and quota limits
6. SLA - availability, latency, throughput
7. Data retention policies
8. Backward compatibility strategy
9. Versioning approach
10. Testing requirements

For interactions between services:
1. Synchronous call patterns
2. Asynchronous event patterns
3. Data flow diagrams
4. Failure handling strategies
5. Retry and timeout policies

Make contracts precise enough for developers to implement independently.`,

    examples: [
      'User Service API: REST endpoints for auth, profile CRUD',
      'Order Service: async events for order state changes',
    ],
  },

  [PipelineStageName.ARCHITECT]: {
    stageId: PipelineStageName.ARCHITECT,
    description: 'Design modernization strategy, target architecture, and migration roadmap',
    variables: [
      'services',
      'technicalConstraints',
      'businessConstraints',
      'riskFactors',
    ],
    template: `Design modernization approach for these services:

**Services to Modernize:**
{{services}}

**Technical Constraints:**
{{technicalConstraints}}

**Business Constraints:**
{{businessConstraints}}

**Risk Factors:**
{{riskFactors}}

Develop a comprehensive strategy including:

1. Phasing and Milestones:
   - Phase breakdown (short, medium, long-term)
   - Dependencies between phases
   - Estimated timeline
   - Go/no-go decision points

2. Technology Choices:
   - Language and framework recommendations
   - Data store selections
   - Message queue technology
   - Containerization and orchestration
   - Observability stack

3. Platform and Infrastructure:
   - Cloud provider strategy
   - Network architecture
   - Service mesh options
   - CI/CD pipeline design
   - Deployment automation

4. Risk Management:
   - Identified risks and mitigation
   - Dependency risks
   - Integration risks
   - Performance risks
   - Cost overrun mitigation

5. Success Metrics:
   - KPIs to track
   - Technical metrics
   - Business metrics
   - Quality gates for each phase`,

    examples: [
      'Agile modernization: extract 2 services per quarter over 18 months',
      'Big bang: migrate entire platform in one major release',
    ],
  },

  [PipelineStageName.FORGE]: {
    stageId: PipelineStageName.FORGE,
    description: 'AI co-creation — generate production-ready code aligned to target architecture',
    variables: [
      'modernizationPlan',
      'stakeholderInput',
      'constraints',
      'budget',
    ],
    template: `Generate implementation code based on modernization plan:

**Current Modernization Plan:**
{{modernizationPlan}}

**Stakeholder Input and Concerns:**
{{stakeholderInput}}

**Updated Constraints:**
{{constraints}}

**Available Budget:**
{{budget}}

Create production-ready implementation including:
1. Source code files with proper error handling
2. Unit and integration tests
3. Configuration and environment setup
4. Database migration scripts
5. API endpoint implementations
6. Event handlers and message consumers

For each generated component:
1. Acceptance criteria and definition of done
2. Detailed task breakdown
3. Resource requirements
4. Risk mitigation steps
5. Success metrics
6. Rollback procedures

Ensure all code is:
- Production-grade with proper error handling
- Fully tested with unit and integration tests
- Aligned to Stage 4 target architecture
- Following best practices for the chosen tech stack`,

    examples: [
      'Address security concerns in extraction plan',
      'Adjust timeline based on team availability',
    ],
  },

  [PipelineStageName.SHADOW_RUN]: {
    stageId: PipelineStageName.SHADOW_RUN,
    description:
      'Run legacy and modern systems in parallel — validate behavioral equivalence',
    variables: [
      'serviceMigrationPlan',
      'currentSystemState',
      'validationStrategy',
      'cutoverPlan',
    ],
    template: `Plan parallel run validation:

**Service Migration Plan:**
{{serviceMigrationPlan}}

**Current System State:**
{{currentSystemState}}

**Validation Strategy:**
{{validationStrategy}}

**Cutover Plan:**
{{cutoverPlan}}

For the parallel run period, define:

1. Dual-Write Strategy:
   - How to keep both systems in sync
   - Conflict resolution approach
   - Eventual consistency handling
   - Data validation procedures

2. Traffic Routing:
   - Shadow traffic approach
   - Canary deployment steps
   - Rollback triggers
   - Monitoring and alerting

3. Validation Plan:
   - Functional equivalence tests
   - Performance comparisons
   - Data consistency checks
   - User acceptance testing
   - Security validation

4. Cutover Procedures:
   - Final data synchronization
   - Traffic cutover schedule
   - Rollback procedures
   - Communication timeline
   - Stakeholder notifications

5. Success Criteria:
   - System stability metrics
   - Performance metrics
   - Error rates
   - User satisfaction

Define clear go/no-go decision points at each stage.`,

    examples: [
      'Shadow all user transactions to validate new order service',
      'Gradual traffic shift: 10% -> 50% -> 100%',
    ],
  },

  [PipelineStageName.EVOLVE]: {
    stageId: PipelineStageName.EVOLVE,
    description:
      'Continuous modernization — KPI roadmap, operational plan, and ongoing evolution',
    variables: [
      'modernizedServices',
      'operationalMetrics',
      'teamCapacity',
      'futureRoadmap',
    ],
    template: `Plan continuous modernization and evolution:

**Modernized Services:**
{{modernizedServices}}

**Current Operational Metrics:**
{{operationalMetrics}}

**Team Capacity:**
{{teamCapacity}}

**Future Roadmap:**
{{futureRoadmap}}

Define a continuous evolution plan including:

1. Operational Excellence:
   - Monitoring and alerting setup
   - Incident response procedures
   - SLA tracking and reporting
   - Performance optimization backlog

2. Technical Debt Management:
   - Remaining debt inventory
   - Prioritized remediation plan
   - Automated quality gates
   - Dependency update strategy

3. Feature Evolution:
   - Feature roadmap alignment
   - A/B testing capabilities
   - Feature flag management
   - Gradual rollout strategies

4. Platform Maturity:
   - Infrastructure automation
   - Self-service capabilities
   - Developer experience improvements
   - Documentation and runbooks

5. KPIs and Metrics:
   - Business impact metrics
   - Technical health scores
   - Team velocity tracking
   - Cost optimization targets

Ensure the plan enables sustainable, continuous improvement.`,

    examples: [
      'Quarterly modernization sprints for remaining legacy components',
      'Automated dependency updates with canary testing',
    ],
  },
};

/**
 * Get template for a specific pipeline stage
 */
export function getPromptTemplate(stageName: PipelineStageName): PromptTemplate {
  return promptTemplates[stageName];
}

/**
 * Interpolate template variables
 */
export function interpolateTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;

  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{${key}}}`, 'g');
    result = result.replace(regex, value);
  });

  return result;
}

// Re-export scan subtask templates
export * from './scan-subtask-templates';

// Re-export decode subtask templates
export * from './decode-subtask-templates';

// Re-export anti-rationalization guards
export * from './rationalization-guards';

/**
 * Get all template variable placeholders in a template
 */
export function getTemplateVariables(template: string): string[] {
  const regex = /{{(\w+)}}/g;
  const matches: string[] = [];
  let match;

  while ((match = regex.exec(template)) !== null) {
    matches.push(match[1]);
  }

  return matches;
}
