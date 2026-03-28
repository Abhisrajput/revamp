/**
 * Project Blueprints — reusable modernization configurations.
 *
 * Extends the existing preset-templates pattern (prompt-only) into full
 * pipeline configuration blueprints that include:
 *   - Prompt templates per stage
 *   - Agent roster overrides (which specialists to prefer)
 *   - Validation thresholds (per-stage confidence floors)
 *   - Budget defaults
 *   - Stage skip/enable configuration
 *   - Target stack recommendations
 *
 * Blueprints can be:
 *   1. Built-in (shipped with the platform)
 *   2. User-created (saved from a successful pipeline run)
 *   3. Organization-shared (published to the org's blueprint library)
 *
 * Inspired by Paperclip's project template system and OpenViking's
 * reusable configuration patterns.
 */

import { db } from "@/db/index.js";
import { projects } from "@/db/schema.js";
import { eq } from "drizzle-orm";

// ─── TYPES ──────────────────────────────────────────────────────

export interface BlueprintStageConfig {
  /** Custom prompt override for this stage */
  prompt?: string;
  /** Validation prompt override */
  validationPrompt?: string;
  /** Minimum confidence score to auto-pass (0-1) */
  confidenceThreshold?: number;
  /** Maximum refinement passes */
  maxRefinements?: number;
  /** Preferred agent persona ID */
  preferredAgent?: string;
  /** Model override for this stage */
  model?: string;
  /** Whether to skip this stage entirely */
  skip?: boolean;
}

export interface ProjectBlueprint {
  id: string;
  name: string;
  description: string;
  category: BlueprintCategory;
  /** Source language families this blueprint is designed for */
  sourceLanguages: string[];
  /** Recommended target stacks */
  targetStacks: string[];
  /** Per-stage configuration */
  stages: Partial<Record<string, BlueprintStageConfig>>;
  /** Default budget in cents (0 = unlimited) */
  defaultBudgetCents: number;
  /** Tags for search/filtering */
  tags: string[];
  /** Whether this is a built-in blueprint */
  builtIn: boolean;
  /** Organization ID (null for built-in) */
  orgId?: string;
  /** Author user ID (null for built-in) */
  authorId?: string;
  /** Creation timestamp */
  createdAt: string;
}

export type BlueprintCategory =
  | "legacy_mainframe"
  | "legacy_desktop"
  | "web_modernization"
  | "api_first"
  | "cloud_native"
  | "microservices"
  | "data_migration"
  | "custom";

// ─── BUILT-IN BLUEPRINTS ────────────────────────────────────────

const BUILT_IN_BLUEPRINTS: ProjectBlueprint[] = [
  {
    id: "bp-cobol-to-java",
    name: "COBOL to Java/Spring Boot",
    description:
      "Comprehensive mainframe COBOL modernization to Java Spring Boot microservices. " +
      "Emphasizes COPYBOOK parsing, CICS/JCL analysis, and data migration from DB2/VSAM.",
    category: "legacy_mainframe",
    sourceLanguages: ["COBOL", "JCL", "CICS"],
    targetStacks: ["Java/Spring Boot", "PostgreSQL", "Kubernetes"],
    stages: {
      SCAN: {
        confidenceThreshold: 0.7,
        maxRefinements: 2,
        preferredAgent: "legacy-analyzer",
        prompt:
          "Analyze this COBOL/mainframe codebase with special attention to: " +
          "COPYBOOK structures and data layouts, CICS transaction flows, " +
          "JCL job dependencies, DB2/VSAM data access patterns, " +
          "paragraph-level control flow, and PERFORM/CALL hierarchies.",
      },
      DECODE: {
        confidenceThreshold: 0.75,
        maxRefinements: 3,
        preferredAgent: "cobol-specialist",
        prompt:
          "Extract business intent from COBOL programs. Focus on: " +
          "business rules embedded in EVALUATE/IF chains, " +
          "data transformation logic in COMPUTE/MOVE statements, " +
          "file I/O patterns (sequential, VSAM, DB2 EXEC SQL), " +
          "inter-program communication (CALL, CICS LINK/XCTL).",
      },
      BLUEPRINT: {
        confidenceThreshold: 0.7,
        preferredAgent: "architect-lead",
      },
      SPEC_LOCK: {
        confidenceThreshold: 0.8,
        prompt:
          "Generate BDD specs that capture mainframe batch and online (CICS) behaviors. " +
          "Include: transaction boundaries, commit/rollback points, " +
          "file open/close sequences, and abend handling scenarios.",
      },
      ARCHITECT: {
        confidenceThreshold: 0.75,
        preferredAgent: "architect-lead",
        prompt:
          "Design Spring Boot microservices architecture replacing mainframe programs. " +
          "Map CICS transactions to REST endpoints, JCL jobs to Spring Batch, " +
          "COPYBOOKs to Java DTOs, DB2 to PostgreSQL with migration scripts.",
      },
      FORGE: {
        maxRefinements: 4,
        model: "sonnet",
      },
    },
    defaultBudgetCents: 5000,
    tags: ["cobol", "mainframe", "java", "spring-boot", "db2", "cics"],
    builtIn: true,
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "bp-vb6-to-react",
    name: "VB6 to React + .NET API",
    description:
      "Visual Basic 6 desktop application modernization to React frontend with .NET API backend. " +
      "Handles COM/ActiveX dependencies, form-based UI, and Access/SQL Server migration.",
    category: "legacy_desktop",
    sourceLanguages: ["VB6", "VBA", "VBScript"],
    targetStacks: ["React", ".NET 8", "SQL Server", "Azure"],
    stages: {
      SCAN: {
        confidenceThreshold: 0.7,
        preferredAgent: "legacy-analyzer",
        prompt:
          "Analyze this VB6 codebase with focus on: form layouts and event handlers, " +
          "COM/ActiveX component usage, ADO/DAO data access, " +
          "API declares and Win32 calls, class modules and their interfaces.",
      },
      DECODE: {
        confidenceThreshold: 0.7,
        preferredAgent: "vb6-specialist",
        prompt:
          "Extract business intent from VB6 modules. Focus on: " +
          "form event workflows, data validation in form controls, " +
          "business logic in class modules vs code-behind, " +
          "report generation (Crystal Reports, DataReport), " +
          "COM component interfaces that must be preserved.",
      },
      ARCHITECT: {
        preferredAgent: "architect-lead",
        prompt:
          "Design React + .NET 8 architecture replacing VB6 desktop app. " +
          "Map VB6 forms to React components, class modules to .NET services, " +
          "ADO data access to Entity Framework, Crystal Reports to reporting API.",
      },
    },
    defaultBudgetCents: 4000,
    tags: ["vb6", "visual-basic", "react", "dotnet", "desktop"],
    builtIn: true,
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "bp-delphi-to-web",
    name: "Delphi to Web Application",
    description:
      "Delphi/Object Pascal desktop application modernization to modern web stack. " +
      "Handles VCL components, BDE/ADO database layers, and DLL dependencies.",
    category: "legacy_desktop",
    sourceLanguages: ["Delphi", "Object Pascal"],
    targetStacks: ["TypeScript/Next.js", "Node.js/Fastify", "PostgreSQL"],
    stages: {
      SCAN: {
        confidenceThreshold: 0.7,
        prompt:
          "Analyze this Delphi codebase with focus on: VCL form inheritance trees, " +
          "unit dependencies (uses clauses), BDE/ADO connection patterns, " +
          "DLL imports and COM interfaces, custom component registrations.",
      },
      DECODE: {
        confidenceThreshold: 0.7,
        prompt:
          "Extract business intent from Delphi units. Focus on: " +
          "form OnCreate/OnDestroy lifecycles, dataset open/close patterns, " +
          "business logic in data modules vs form units, " +
          "report builders (FastReport, QuickReport), " +
          "thread usage for background processing.",
      },
    },
    defaultBudgetCents: 4000,
    tags: ["delphi", "pascal", "web", "typescript", "next.js"],
    builtIn: true,
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "bp-fortran-to-python",
    name: "Fortran to Python Scientific Stack",
    description:
      "Fortran scientific/engineering code modernization to Python with NumPy/SciPy. " +
      "Preserves numerical precision, parallelism patterns, and legacy file formats.",
    category: "legacy_mainframe",
    sourceLanguages: ["Fortran", "Fortran 77", "Fortran 90"],
    targetStacks: ["Python", "NumPy/SciPy", "FastAPI"],
    stages: {
      SCAN: {
        confidenceThreshold: 0.65,
        prompt:
          "Analyze this Fortran codebase with focus on: COMMON block shared state, " +
          "subroutine/function call graphs, INCLUDE file dependencies, " +
          "numerical algorithms and precision requirements, " +
          "I/O formats (formatted/unformatted, direct/sequential access).",
      },
      DECODE: {
        confidenceThreshold: 0.7,
        prompt:
          "Extract computational intent from Fortran routines. Focus on: " +
          "array operation patterns mappable to NumPy, " +
          "DO loop structures and their parallelization potential, " +
          "EQUIVALENCE/COMMON state sharing that needs refactoring, " +
          "FORMAT statements and data file layouts.",
      },
      ARCHITECT: {
        prompt:
          "Design Python architecture replacing Fortran code. " +
          "Map DO loops to NumPy vectorized ops, COMMON blocks to module state, " +
          "subroutines to Python functions/classes, " +
          "identify hot loops that need Cython/ctypes wrappers for performance.",
      },
    },
    defaultBudgetCents: 3000,
    tags: ["fortran", "python", "scientific", "numpy", "scipy"],
    builtIn: true,
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "bp-monolith-to-microservices",
    name: "Monolith to Microservices",
    description:
      "Break a monolithic application into independently deployable microservices. " +
      "Framework-agnostic — works with Java, .NET, Python, Node.js monoliths.",
    category: "microservices",
    sourceLanguages: [],
    targetStacks: ["Kubernetes", "Docker", "API Gateway"],
    stages: {
      SCAN: { confidenceThreshold: 0.7 },
      DECODE: {
        confidenceThreshold: 0.75,
        prompt:
          "Extract business domains and bounded contexts from this monolithic codebase. " +
          "Identify: shared database tables, cross-cutting concerns, " +
          "transactional boundaries, event-worthy state changes, " +
          "and candidate service boundaries based on cohesion/coupling analysis.",
      },
      BLUEPRINT: {
        confidenceThreshold: 0.75,
        prompt:
          "Map business capabilities to candidate microservices. " +
          "For each service: define data ownership, API surface area, " +
          "event contracts, and inter-service dependencies. " +
          "Produce a dependency graph showing migration wave order.",
      },
      ARCHITECT: {
        confidenceThreshold: 0.8,
        prompt:
          "Design microservices architecture with: service mesh (Istio/Linkerd), " +
          "API gateway, event bus (Kafka/NATS), per-service databases, " +
          "circuit breakers, distributed tracing, and CI/CD per service. " +
          "Include strangler-fig migration strategy.",
      },
    },
    defaultBudgetCents: 5000,
    tags: ["monolith", "microservices", "kubernetes", "decomposition"],
    builtIn: true,
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    id: "bp-cloud-migration",
    name: "Cloud-Native Migration (AWS)",
    description:
      "Migrate on-premise applications to AWS cloud-native services. " +
      "Maps existing components to AWS equivalents with IaC.",
    category: "cloud_native",
    sourceLanguages: [],
    targetStacks: ["AWS Lambda", "ECS/Fargate", "RDS", "DynamoDB", "S3"],
    stages: {
      SCAN: { confidenceThreshold: 0.7 },
      DECODE: {
        prompt:
          "Extract infrastructure and deployment intent. Identify: " +
          "compute requirements (CPU, memory, GPU), storage patterns, " +
          "networking dependencies, security/compliance constraints, " +
          "stateful vs stateless components, and scaling characteristics.",
      },
      ARCHITECT: {
        confidenceThreshold: 0.75,
        prompt:
          "Design AWS cloud-native architecture. Map: " +
          "web servers → ECS/Fargate or Lambda, " +
          "databases → RDS/Aurora or DynamoDB, " +
          "file storage → S3, queues → SQS/SNS, " +
          "cron jobs → EventBridge + Lambda. " +
          "Include Terraform IaC, VPC design, IAM policies, and cost estimate.",
      },
    },
    defaultBudgetCents: 4000,
    tags: ["cloud", "aws", "terraform", "serverless", "containers"],
    builtIn: true,
    createdAt: "2024-01-01T00:00:00Z",
  },
];

// ─── BLUEPRINT OPERATIONS ───────────────────────────────────────

/**
 * Get all built-in blueprints.
 */
export function getBuiltInBlueprints(): ProjectBlueprint[] {
  return BUILT_IN_BLUEPRINTS;
}

/**
 * Get a blueprint by ID (built-in only for now).
 */
export function getBlueprintById(id: string): ProjectBlueprint | undefined {
  return BUILT_IN_BLUEPRINTS.find((bp) => bp.id === id);
}

/**
 * Get blueprints matching source languages.
 */
export function getBlueprintsForLanguages(languages: string[]): ProjectBlueprint[] {
  const lowerLangs = languages.map((l) => l.toLowerCase());
  return BUILT_IN_BLUEPRINTS.filter((bp) => {
    // Blueprints with empty sourceLanguages are universal
    if (bp.sourceLanguages.length === 0) return true;
    return bp.sourceLanguages.some((sl) =>
      lowerLangs.some((l) => sl.toLowerCase().includes(l) || l.includes(sl.toLowerCase())),
    );
  });
}

/**
 * Get blueprints by category.
 */
export function getBlueprintsByCategory(category: BlueprintCategory): ProjectBlueprint[] {
  return BUILT_IN_BLUEPRINTS.filter((bp) => bp.category === category);
}

/**
 * Apply a blueprint to a project — merges blueprint stage configs
 * into the project's settings without overwriting user customizations.
 */
export async function applyBlueprintToProject(
  projectId: string,
  blueprintId: string,
): Promise<{ applied: boolean; stagesConfigured: string[] }> {
  const blueprint = getBlueprintById(blueprintId);
  if (!blueprint) {
    return { applied: false, stagesConfigured: [] };
  }

  // Build the stage configuration from blueprint
  const stagePrompts: Record<string, string> = {};
  const stageValidationPrompts: Record<string, string> = {};
  const disabledStages: Record<string, boolean> = {};
  const stageModels: Record<string, string> = {};
  const stagesConfigured: string[] = [];

  for (const [stageName, config] of Object.entries(blueprint.stages)) {
    if (!config) continue;
    stagesConfigured.push(stageName);

    if (config.prompt) stagePrompts[stageName] = config.prompt;
    if (config.validationPrompt) stageValidationPrompts[stageName] = config.validationPrompt;
    if (config.skip) disabledStages[stageName] = true;
    if (config.model) stageModels[stageName] = config.model;
  }

  // Merge into project settings
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    return { applied: false, stagesConfigured: [] };
  }

  const existingConfig = (project as any).config as Record<string, unknown> || {};
  const mergedConfig = {
    ...existingConfig,
    blueprint_id: blueprintId,
    blueprint_name: blueprint.name,
    disabled_stages: { ...(existingConfig.disabled_stages as Record<string, boolean> || {}), ...disabledStages },
    stage_models: { ...(existingConfig.stage_models as Record<string, string> || {}), ...stageModels },
    validation_thresholds: Object.fromEntries(
      Object.entries(blueprint.stages)
        .filter(([, cfg]) => cfg?.confidenceThreshold)
        .map(([stage, cfg]) => [stage, cfg!.confidenceThreshold]),
    ),
    preferred_agents: Object.fromEntries(
      Object.entries(blueprint.stages)
        .filter(([, cfg]) => cfg?.preferredAgent)
        .map(([stage, cfg]) => [stage, cfg!.preferredAgent]),
    ),
  };

  await db
    .update(projects)
    .set({
      stage_prompts: stagePrompts,
      config: mergedConfig,
      updated_at: new Date(),
    } as any)
    .where(eq(projects.id, projectId));

  return { applied: true, stagesConfigured };
}

/**
 * Create a blueprint from a successful pipeline run.
 * Captures the configuration that led to a good outcome for reuse.
 */
export function createBlueprintFromRun(params: {
  name: string;
  description: string;
  category: BlueprintCategory;
  sourceLanguages: string[];
  targetStacks: string[];
  stageConfigs: Record<string, BlueprintStageConfig>;
  tags: string[];
  orgId?: string;
  authorId?: string;
}): ProjectBlueprint {
  return {
    id: `bp-custom-${Date.now().toString(36)}`,
    name: params.name,
    description: params.description,
    category: params.category,
    sourceLanguages: params.sourceLanguages,
    targetStacks: params.targetStacks,
    stages: params.stageConfigs,
    defaultBudgetCents: 0,
    tags: params.tags,
    builtIn: false,
    orgId: params.orgId,
    authorId: params.authorId,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Recommend blueprints based on detected codebase characteristics.
 * Used after file analysis to suggest the best-fit blueprint.
 */
export function recommendBlueprints(analysis: {
  languages: string[];
  frameworks?: string[];
  fileCount?: number;
}): Array<{ blueprint: ProjectBlueprint; matchScore: number; reason: string }> {
  const results: Array<{ blueprint: ProjectBlueprint; matchScore: number; reason: string }> = [];

  for (const bp of BUILT_IN_BLUEPRINTS) {
    let score = 0;
    const reasons: string[] = [];

    // Language match
    if (bp.sourceLanguages.length === 0) {
      // Universal blueprint — lower base score
      score += 0.3;
      reasons.push("Universal blueprint");
    } else {
      const langMatch = bp.sourceLanguages.filter((sl) =>
        analysis.languages.some(
          (al) => al.toLowerCase().includes(sl.toLowerCase()) || sl.toLowerCase().includes(al.toLowerCase()),
        ),
      );
      if (langMatch.length > 0) {
        score += 0.5 + 0.1 * langMatch.length;
        reasons.push(`Language match: ${langMatch.join(", ")}`);
      }
    }

    // Skip if no language relevance at all
    if (score === 0) continue;

    // Category bonus for legacy stacks
    const hasLegacy = analysis.languages.some((l) =>
      /cobol|vb6|delphi|fortran|powerbuilder|rpg/i.test(l),
    );
    if (hasLegacy && (bp.category === "legacy_mainframe" || bp.category === "legacy_desktop")) {
      score += 0.2;
      reasons.push("Legacy-specialized blueprint");
    }

    results.push({
      blueprint: bp,
      matchScore: Math.min(score, 1),
      reason: reasons.join("; "),
    });
  }

  return results.sort((a, b) => b.matchScore - a.matchScore);
}
