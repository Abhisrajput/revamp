/**
 * Seed script — populates the 16 default agent personas from core-engine templates.
 *
 * Usage: npx tsx apps/api/src/scripts/seed-agents.ts
 *
 * Idempotent: uses ON CONFLICT DO UPDATE on slug.
 */

import "../env.js";
import { db } from "../db/index.js";
import { agentPersonas, budgetPolicies } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { PERSONA_TEMPLATES } from "@revamp/core-engine";

async function seed() {
  console.log("Seeding agent personas...");

  // First pass: insert all personas (without reports_to since we need IDs first)
  for (const template of PERSONA_TEMPLATES) {
    await db.execute(sql`
      INSERT INTO agent_personas (
        name, slug, role, department, status,
        system_prompt, skills, tech_stack, legacy_expertise, modern_expertise,
        tool_permissions, stage_permissions,
        preferred_provider, preferred_model, evaluator_model,
        max_concurrent_tasks, can_delegate,
        monthly_budget_cents, lifetime_budget_cents, hard_stop_enabled, warning_threshold,
        session_compaction_threshold, memory_strategy
      ) VALUES (
        ${template.name}, ${template.slug}, ${template.role}, ${template.department}, 'idle',
        ${template.systemPrompt},
        ${JSON.stringify(template.skills)}::jsonb,
        ${JSON.stringify(template.techStack)}::jsonb,
        ${JSON.stringify(template.legacyExpertise)}::jsonb,
        ${JSON.stringify(template.modernExpertise)}::jsonb,
        ${JSON.stringify(template.toolPermissions)}::jsonb,
        ${JSON.stringify(template.stagePermissions)}::jsonb,
        ${template.preferredProvider}, ${template.preferredModel}, ${template.evaluatorModel ?? null},
        ${template.maxConcurrentTasks}, ${template.canDelegate},
        ${template.monthlyBudgetCents}, ${template.lifetimeBudgetCents ?? null},
        ${template.hardStopEnabled}, ${template.warningThreshold.toString()},
        ${template.sessionCompactionThreshold}, ${template.memoryStrategy}
      )
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name,
        role = EXCLUDED.role,
        department = EXCLUDED.department,
        system_prompt = EXCLUDED.system_prompt,
        skills = EXCLUDED.skills,
        tech_stack = EXCLUDED.tech_stack,
        legacy_expertise = EXCLUDED.legacy_expertise,
        modern_expertise = EXCLUDED.modern_expertise,
        tool_permissions = EXCLUDED.tool_permissions,
        stage_permissions = EXCLUDED.stage_permissions,
        preferred_provider = EXCLUDED.preferred_provider,
        preferred_model = EXCLUDED.preferred_model,
        evaluator_model = EXCLUDED.evaluator_model,
        max_concurrent_tasks = EXCLUDED.max_concurrent_tasks,
        can_delegate = EXCLUDED.can_delegate,
        monthly_budget_cents = EXCLUDED.monthly_budget_cents,
        lifetime_budget_cents = EXCLUDED.lifetime_budget_cents,
        hard_stop_enabled = EXCLUDED.hard_stop_enabled,
        warning_threshold = EXCLUDED.warning_threshold,
        session_compaction_threshold = EXCLUDED.session_compaction_threshold,
        memory_strategy = EXCLUDED.memory_strategy,
        updated_at = NOW()
    `);
    console.log(`  ✓ ${template.name} (${template.slug})`);
  }

  // Second pass: set reports_to references
  for (const template of PERSONA_TEMPLATES) {
    if (template.reportsToSlug) {
      await db.execute(sql`
        UPDATE agent_personas
        SET reports_to = (SELECT id FROM agent_personas WHERE slug = ${template.reportsToSlug}),
            escalation_target = (SELECT id FROM agent_personas WHERE slug = ${template.reportsToSlug})
        WHERE slug = ${template.slug}
      `);
    }
  }

  console.log("\nSetting up default budget policies...");

  // Default budget policies per department
  const departments = [
    { name: "discovery", limitCents: 200000 },
    { name: "execution", limitCents: 300000 },
    { name: "qa", limitCents: 100000 },
    { name: "pm", limitCents: 50000 },
  ];

  // Use deterministic UUIDs keyed on department name for idempotent re-runs
  // Format: 00000000-0000-0000-0000-00000000000N (N=index+1)
  for (let i = 0; i < departments.length; i++) {
    const dept = departments[i];
    const scopeId = `00000000-0000-0000-0000-00000000000${i + 1}`;

    const existing = await db.execute(sql`
      SELECT id FROM budget_policies
      WHERE scope_type = 'organization'
        AND scope_id = ${scopeId}
      LIMIT 1
    `);

    if ((existing.rows as any[]).length === 0) {
      await db.insert(budgetPolicies).values({
        scope_type: "organization",
        scope_id: scopeId,
        metric: "billed_cents",
        window: "monthly",
        limit_cents: dept.limitCents,
        warn_percent: "0.80",
        hard_stop: true,
        notify_enabled: true,
        active: true,
      });
    } else {
      await db.execute(sql`
        UPDATE budget_policies
        SET limit_cents = ${dept.limitCents}, updated_at = NOW()
        WHERE scope_type = 'organization' AND scope_id = ${scopeId}
      `);
    }
    console.log(`  ✓ Budget policy: ${dept.name} department — $${dept.limitCents / 100}/month`);
  }

  console.log("\nSeed complete!");
  console.log(`  ${PERSONA_TEMPLATES.length} agent personas`);
  console.log(`  ${departments.length} budget policies`);

  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
