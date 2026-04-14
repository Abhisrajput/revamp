/**
 * Prometheus metrics plugin for the REVAMP API Gateway.
 *
 * Exposes /metrics endpoint in Prometheus text format.
 * Tracks pipeline execution, validation, approval gates, and HTTP requests.
 *
 * Lightweight implementation — no prom-client dependency required.
 * Counters and histograms are stored in-memory and formatted on scrape.
 *
 * To use prom-client instead, install it and replace the Counter/Histogram
 * classes with prom-client equivalents. The metric names and labels stay the same.
 */
import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";

// ─── Lightweight Counter ───────────────────────────────────────

class Counter {
  private name: string;
  private help: string;
  private labels: string[];
  private values = new Map<string, number>();

  constructor(opts: { name: string; help: string; labels: string[] }) {
    this.name = opts.name;
    this.help = opts.help;
    this.labels = opts.labels;
  }

  inc(labelValues: Record<string, string>, value = 1) {
    const key = this.labels.map((l) => labelValues[l] || "").join(",");
    this.values.set(key, (this.values.get(key) || 0) + value);
  }

  format(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, val] of this.values) {
      const parts = key.split(",");
      const labelStr = this.labels.map((l, i) => `${l}="${parts[i]}"`).join(",");
      lines.push(`${this.name}{${labelStr}} ${val}`);
    }
    return lines.join("\n");
  }
}

// ─── Lightweight Histogram ─────────────────────────────────────

class Histogram {
  private name: string;
  private help: string;
  private labels: string[];
  private buckets: number[];
  private data = new Map<string, { buckets: number[]; sum: number; count: number }>();

  constructor(opts: { name: string; help: string; labels: string[]; buckets: number[] }) {
    this.name = opts.name;
    this.help = opts.help;
    this.labels = opts.labels;
    this.buckets = opts.buckets;
  }

  observe(labelValues: Record<string, string>, value: number) {
    const key = this.labels.map((l) => labelValues[l] || "").join(",");
    if (!this.data.has(key)) {
      this.data.set(key, { buckets: new Array(this.buckets.length).fill(0), sum: 0, count: 0 });
    }
    const d = this.data.get(key)!;
    d.sum += value;
    d.count++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) d.buckets[i]++;
    }
  }

  format(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, d] of this.data) {
      const parts = key.split(",");
      const labelStr = this.labels.map((l, i) => `${l}="${parts[i]}"`).join(",");
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket{${labelStr},le="${this.buckets[i]}"} ${d.buckets[i]}`);
      }
      lines.push(`${this.name}_bucket{${labelStr},le="+Inf"} ${d.count}`);
      lines.push(`${this.name}_sum{${labelStr}} ${d.sum}`);
      lines.push(`${this.name}_count{${labelStr}} ${d.count}`);
    }
    return lines.join("\n");
  }
}

// ─── Metric Definitions ────────────────────────────────────────

const httpRequestsTotal = new Counter({
  name: "revamp_http_requests_total",
  help: "Total HTTP requests",
  labels: ["method", "route", "status"],
});

const httpRequestDuration = new Histogram({
  name: "revamp_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labels: ["method", "route"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});

const pipelineStageExecutions = new Counter({
  name: "revamp_pipeline_stage_executions_total",
  help: "Pipeline stage executions",
  labels: ["stage", "status"],
});

const pipelineStageDuration = new Histogram({
  name: "revamp_pipeline_stage_duration_seconds",
  help: "Pipeline stage execution duration in seconds",
  labels: ["stage"],
  buckets: [10, 30, 60, 120, 300, 600, 1200, 1800],
});

const validationScores = new Histogram({
  name: "revamp_validation_confidence_score",
  help: "Validation confidence scores (0-100)",
  labels: ["stage"],
  buckets: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
});

const approvalGateActions = new Counter({
  name: "revamp_approval_gate_actions_total",
  help: "Approval gate actions",
  labels: ["stage", "action"],
});

const llmCallsTotal = new Counter({
  name: "revamp_llm_calls_total",
  help: "Total LLM API calls from Node API",
  labels: ["model", "status"],
});

const activeConnections = { value: 0 };

// ─── Public API for recording metrics ──────────────────────────

export const apiMetrics = {
  recordStageExecution(stage: string, status: "completed" | "failed" | "aborted") {
    pipelineStageExecutions.inc({ stage, status });
  },
  recordStageDuration(stage: string, durationMs: number) {
    pipelineStageDuration.observe({ stage }, durationMs / 1000);
  },
  recordValidationScore(stage: string, score: number) {
    validationScores.observe({ stage }, score);
  },
  recordApprovalAction(stage: string, action: "approved" | "rejected") {
    approvalGateActions.inc({ stage, action });
  },
  recordLlmCall(model: string, status: "success" | "error") {
    llmCallsTotal.inc({ model, status });
  },
};

// ─── Plugin ────────────────────────────────────────────────────

async function metricsPlugin(fastify: FastifyInstance) {
  // Track HTTP requests
  fastify.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url || request.url;
    const method = request.method;
    const status = String(reply.statusCode);
    httpRequestsTotal.inc({ method, route, status });

    const duration = reply.elapsedTime / 1000; // ms to seconds
    httpRequestDuration.observe({ method, route }, duration);
  });

  // Expose /metrics endpoint
  fastify.get("/metrics", async (_request, reply) => {
    const sections = [
      httpRequestsTotal.format(),
      httpRequestDuration.format(),
      pipelineStageExecutions.format(),
      pipelineStageDuration.format(),
      validationScores.format(),
      approvalGateActions.format(),
      llmCallsTotal.format(),
      `# HELP revamp_active_connections Current active HTTP connections`,
      `# TYPE revamp_active_connections gauge`,
      `revamp_active_connections ${activeConnections.value}`,
      `# HELP revamp_uptime_seconds Server uptime in seconds`,
      `# TYPE revamp_uptime_seconds gauge`,
      `revamp_uptime_seconds ${process.uptime()}`,
      `# HELP revamp_memory_usage_bytes Process memory usage`,
      `# TYPE revamp_memory_usage_bytes gauge`,
      `revamp_memory_usage_bytes{type="rss"} ${process.memoryUsage().rss}`,
      `revamp_memory_usage_bytes{type="heapUsed"} ${process.memoryUsage().heapUsed}`,
      `revamp_memory_usage_bytes{type="heapTotal"} ${process.memoryUsage().heapTotal}`,
    ];

    reply
      .header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
      .send(sections.filter(Boolean).join("\n\n") + "\n");
  });

  // Track active connections
  fastify.addHook("onRequest", async () => { activeConnections.value++; });
  fastify.addHook("onResponse", async () => { activeConnections.value--; });
}

export default fp(metricsPlugin, {
  name: "metrics",
});
