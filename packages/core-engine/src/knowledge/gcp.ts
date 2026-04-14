/**
 * GCP Service Knowledge Base for REVAMP
 *
 * Comprehensive mapping of Google Cloud services, modernization patterns,
 * cost optimization tips, and cross-cloud equivalencies.
 * Ported from legacy-bridge with additional operational guidance.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CloudServiceCategory =
  | 'compute'
  | 'containers'
  | 'database'
  | 'storage'
  | 'networking'
  | 'messaging'
  | 'security'
  | 'monitoring'
  | 'ai-ml'
  | 'cicd'
  | 'analytics'
  | 'integration'
  | 'management';

export interface GCPServiceInfo {
  /** Stable identifier used in architecture specs and lookups */
  id: string;
  name: string;
  shortName: string;
  category: CloudServiceCategory;
  description: string;
  /** Hex color for icon backgrounds in architecture diagrams */
  iconColor: string;
  useCases: readonly string[];
  /** Alternative GCP services for the same use-case */
  alternatives: readonly string[];
  /** Operational considerations when adopting this service */
  considerations: readonly string[];
  pricingModel: string;
  /** Equivalent services on other clouds */
  crossCloudEquivalents?: { aws?: string; azure?: string };
  /** Hard limits worth knowing during migration planning */
  limits?: Record<string, string>;
}

// Architecture diagram node/edge/group types for rendering
export interface GCPArchNode {
  id: string;
  /** GCP service ID from the catalog */
  service: string;
  label: string;
  group?: string;
  x?: number;
  y?: number;
}

export interface GCPArchEdge {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dashed';
}

export interface GCPArchGroup {
  id: string;
  label: string;
  type: 'project' | 'vpc' | 'subnet' | 'region' | 'zone' | 'generic';
  color?: string;
}

export interface GCPArchitectureSpec {
  title: string;
  nodes: GCPArchNode[];
  edges: GCPArchEdge[];
  groups: GCPArchGroup[];
}

// ---------------------------------------------------------------------------
// Service catalog
// ---------------------------------------------------------------------------

export const GCP_SERVICES: GCPServiceInfo[] = [
  // ── Compute ─────────────────────────────────────────────────────────
  {
    id: 'cloud-functions',
    name: 'Cloud Functions',
    shortName: 'Functions',
    category: 'compute',
    iconColor: '#4285F4',
    description: 'Event-driven serverless functions',
    useCases: ['Event-driven processing', 'Webhooks', 'Lightweight APIs', 'Stream processing'],
    alternatives: ['cloud-run', 'compute-engine', 'app-engine'],
    considerations: ['Cold start performance', 'Timeout limits (v2: 60 min)', 'Concurrency settings (v2)', 'VPC connector for private access'],
    pricingModel: 'Pay per invocation + compute time (100 ms granularity)',
    crossCloudEquivalents: { aws: 'AWS Lambda', azure: 'Azure Functions' },
    limits: { maxTimeoutV1: '9 minutes', maxTimeoutV2: '60 minutes', maxMemory: '32 GB (v2)' },
  },
  {
    id: 'compute-engine',
    name: 'Compute Engine',
    shortName: 'GCE',
    category: 'compute',
    iconColor: '#4285F4',
    description: 'Virtual machines on Google infrastructure',
    useCases: ['Legacy app hosting', 'Custom workloads', 'GPU/TPU workloads', 'High-performance computing'],
    alternatives: ['cloud-run', 'gke', 'app-engine'],
    considerations: ['Machine family selection (N2, C3, E2)', 'Preemptible/Spot VMs for savings', 'Custom machine types', 'Live migration', 'Sole-tenant nodes'],
    pricingModel: 'Per-second billing; Committed Use Discounts (CUDs) available',
    crossCloudEquivalents: { aws: 'Amazon EC2', azure: 'Azure Virtual Machines' },
  },
  {
    id: 'cloud-run',
    name: 'Cloud Run',
    shortName: 'Cloud Run',
    category: 'containers',
    iconColor: '#4285F4',
    description: 'Serverless containers with scale-to-zero',
    useCases: ['Container workloads', 'Microservices', 'API endpoints', 'Web apps'],
    alternatives: ['gke', 'app-engine', 'cloud-functions'],
    considerations: ['Cold start performance', 'Concurrency limits (up to 1000)', 'Memory and CPU constraints', 'Container image requirements', 'Traffic splitting for canary deploys'],
    pricingModel: 'Pay per request + compute time; always-on instances available',
    crossCloudEquivalents: { aws: 'AWS Fargate / App Runner', azure: 'Azure Container Apps' },
    limits: { maxTimeout: '60 minutes', maxMemory: '32 GB', maxConcurrency: '1000 per instance' },
  },
  {
    id: 'gke',
    name: 'Google Kubernetes Engine',
    shortName: 'GKE',
    category: 'containers',
    iconColor: '#4285F4',
    description: 'Managed Kubernetes with Autopilot mode',
    useCases: ['Kubernetes workloads', 'Microservice orchestration', 'Multi-cloud portability', 'Stateful services', 'Hybrid deployments'],
    alternatives: ['cloud-run', 'app-engine'],
    considerations: ['Autopilot vs Standard mode', 'Node pool management', 'Network policies (Dataplane V2)', 'Workload distribution', 'Cost optimization with Spot pods'],
    pricingModel: 'Autopilot: per pod; Standard: cluster fee + node costs',
    crossCloudEquivalents: { aws: 'Amazon EKS', azure: 'Azure AKS' },
  },
  {
    id: 'app-engine',
    name: 'App Engine',
    shortName: 'App Engine',
    category: 'compute',
    iconColor: '#4285F4',
    description: 'Fully managed PaaS for web applications',
    useCases: ['Web applications', 'Mobile backends', 'Auto-scaling apps', 'Rapid prototyping'],
    alternatives: ['cloud-run', 'gke', 'compute-engine'],
    considerations: ['Standard vs Flexible environment', 'Language support', 'Automatic scaling', 'Deployment process', 'Vendor lock-in considerations'],
    pricingModel: 'Instance hours + App Engine API calls',
    crossCloudEquivalents: { aws: 'AWS Elastic Beanstalk', azure: 'Azure App Service' },
  },
  {
    id: 'cloud-run-jobs',
    name: 'Cloud Run Jobs',
    shortName: 'Run Jobs',
    category: 'containers',
    iconColor: '#4285F4',
    description: 'Run containers to completion for batch work',
    useCases: ['Batch processing', 'Data migration', 'Scheduled tasks'],
    alternatives: ['cloud-functions', 'gke'],
    considerations: ['Task parallelism', 'Retry configuration', 'Timeout limits', 'Scheduled execution via Cloud Scheduler'],
    pricingModel: 'Pay per vCPU and memory per second while running',
    crossCloudEquivalents: { aws: 'AWS Batch / Step Functions', azure: 'Azure Container Instances' },
  },

  // ── Database ────────────────────────────────────────────────────────
  {
    id: 'cloud-sql',
    name: 'Cloud SQL',
    shortName: 'Cloud SQL',
    category: 'database',
    iconColor: '#4285F4',
    description: 'Managed MySQL, PostgreSQL, and SQL Server',
    useCases: ['Relational data', 'SQL workloads', 'Legacy DB migration', 'OLTP applications'],
    alternatives: ['alloydb', 'cloud-spanner', 'firestore'],
    considerations: ['Instance sizing', 'Replication options', 'Backup strategy', 'Scaling approach', 'Network access (authorized networks, Cloud SQL Proxy)'],
    pricingModel: 'Instance costs + storage + backup + network',
    crossCloudEquivalents: { aws: 'Amazon RDS', azure: 'Azure SQL Database' },
  },
  {
    id: 'alloydb',
    name: 'AlloyDB',
    shortName: 'AlloyDB',
    category: 'database',
    iconColor: '#4285F4',
    description: 'PostgreSQL-compatible with 4x performance',
    useCases: ['High-performance PostgreSQL', 'Enterprise workloads', 'Analytics on OLTP data'],
    alternatives: ['cloud-sql', 'cloud-spanner'],
    considerations: ['PostgreSQL compatibility', 'Columnar engine for analytics', 'Adaptive autovacuum', 'Cross-region replication'],
    pricingModel: 'Instance hours + storage; no I/O charges',
    crossCloudEquivalents: { aws: 'Amazon Aurora' },
  },
  {
    id: 'cloud-spanner',
    name: 'Cloud Spanner',
    shortName: 'Spanner',
    category: 'database',
    iconColor: '#4285F4',
    description: 'Globally distributed relational database',
    useCases: ['Global transactions', 'Financial systems', 'Unlimited scale relational'],
    alternatives: ['cloud-sql', 'alloydb'],
    considerations: ['High cost (minimum 1 node)', 'Schema design (interleaving)', 'PostgreSQL interface available', 'Multi-region configurations'],
    pricingModel: 'Per node-hour + storage + network',
    crossCloudEquivalents: { aws: 'Amazon Aurora Global / DynamoDB Global Tables', azure: 'Azure Cosmos DB' },
  },
  {
    id: 'firestore',
    name: 'Firestore',
    shortName: 'Firestore',
    category: 'database',
    iconColor: '#4285F4',
    description: 'Serverless NoSQL document database',
    useCases: ['Mobile/web apps', 'Real-time sync', 'User profiles', 'Game state', 'Offline sync'],
    alternatives: ['bigtable', 'cloud-sql'],
    considerations: ['Data modeling (collections/documents)', 'Eventual vs strong consistency', 'Query limitations (no inequality on multiple fields)', 'Indexing strategy', 'Pricing at scale'],
    pricingModel: 'Reads + writes + deletes + storage',
    crossCloudEquivalents: { aws: 'Amazon DynamoDB', azure: 'Azure Cosmos DB' },
  },
  {
    id: 'bigtable',
    name: 'Cloud Bigtable',
    shortName: 'Bigtable',
    category: 'database',
    iconColor: '#4285F4',
    description: 'Wide-column NoSQL for large analytical and operational workloads',
    useCases: ['IoT data', 'Time-series', 'Ad-tech', 'Financial data', 'Massive scale'],
    alternatives: ['firestore', 'cloud-sql'],
    considerations: ['Row key design (critical for performance)', 'Cluster sizing (minimum 3 nodes)', 'Replication for HA', 'Compaction behavior', 'HBase API compatibility'],
    pricingModel: 'Hourly cluster cost + storage + network',
    crossCloudEquivalents: { aws: 'Amazon DynamoDB', azure: 'Azure Cosmos DB (Cassandra API)' },
  },
  {
    id: 'memorystore',
    name: 'Memorystore',
    shortName: 'Memorystore',
    category: 'database',
    iconColor: '#4285F4',
    description: 'Managed Redis and Memcached',
    useCases: ['Session caching', 'Real-time analytics', 'Game leaderboards'],
    alternatives: ['firestore', 'bigtable'],
    considerations: ['Redis vs Memcached', 'Instance tier selection', 'HA configuration', 'Import/export capabilities'],
    pricingModel: 'Per GB of provisioned capacity per hour',
    crossCloudEquivalents: { aws: 'Amazon ElastiCache', azure: 'Azure Cache for Redis' },
  },

  // ── Storage ─────────────────────────────────────────────────────────
  {
    id: 'cloud-storage',
    name: 'Cloud Storage',
    shortName: 'GCS',
    category: 'storage',
    iconColor: '#4285F4',
    description: 'Object storage with global edge caching',
    useCases: ['Static assets', 'Data lakes', 'Backups', 'ML training data', 'Archive storage'],
    alternatives: ['persistent-disk', 'filestore'],
    considerations: ['Storage classes (Standard/Nearline/Coldline/Archive)', 'Access control (uniform vs fine-grained)', 'Versioning', 'Lifecycle policies', 'Regional vs multi-regional redundancy'],
    pricingModel: 'Storage per GB + network egress + operations',
    crossCloudEquivalents: { aws: 'Amazon S3', azure: 'Azure Blob Storage' },
  },
  {
    id: 'persistent-disk',
    name: 'Persistent Disk',
    shortName: 'PD',
    category: 'storage',
    iconColor: '#4285F4',
    description: 'Block storage for VMs and containers',
    useCases: ['VM disks', 'Database storage', 'Boot volumes'],
    alternatives: ['cloud-storage', 'filestore'],
    considerations: ['pd-standard vs pd-ssd vs pd-balanced', 'Snapshot scheduling', 'Regional PD for HA', 'Resize without downtime'],
    pricingModel: 'Per GB-month; varies by disk type',
    crossCloudEquivalents: { aws: 'Amazon EBS', azure: 'Azure Managed Disks' },
  },
  {
    id: 'filestore',
    name: 'Filestore',
    shortName: 'Filestore',
    category: 'storage',
    iconColor: '#4285F4',
    description: 'Managed NFS file storage',
    useCases: ['Shared file storage', 'CMS content', 'GKE persistent volumes'],
    alternatives: ['cloud-storage', 'persistent-disk'],
    considerations: ['Tier selection (Basic/High Scale/Enterprise)', 'NFS protocol support', 'Backup configuration', 'Scaling up only (no shrink)'],
    pricingModel: 'Per GB-month based on tier',
    crossCloudEquivalents: { aws: 'Amazon EFS', azure: 'Azure Files' },
  },

  // ── Networking ──────────────────────────────────────────────────────
  {
    id: 'vpc',
    name: 'Virtual Private Cloud',
    shortName: 'VPC',
    category: 'networking',
    iconColor: '#34A853',
    description: 'Global virtual network',
    useCases: ['Network isolation', 'Subnets', 'Firewall rules', 'VPN/Interconnect'],
    alternatives: [],
    considerations: ['Global VPC (spans all regions)', 'Shared VPC for multi-project', 'VPC peering vs VPN', 'Private Google Access'],
    pricingModel: 'No charge for VPC; egress, VPN, Interconnect charged separately',
    crossCloudEquivalents: { aws: 'Amazon VPC', azure: 'Azure VNet' },
  },
  {
    id: 'cloud-load-balancing',
    name: 'Cloud Load Balancing',
    shortName: 'Load Balancer',
    category: 'networking',
    iconColor: '#34A853',
    description: 'Global and regional load balancing',
    useCases: ['HTTP(S) load balancing', 'TCP/UDP proxy', 'SSL termination', 'CDN integration'],
    alternatives: [],
    considerations: ['Global vs regional', 'Backend services configuration', 'Health checks', 'Session affinity', 'DDoS protection built-in'],
    pricingModel: 'Per forwarding rule + ingress data processed',
    crossCloudEquivalents: { aws: 'Elastic Load Balancer', azure: 'Azure Application Gateway / Load Balancer' },
  },
  {
    id: 'cloud-cdn',
    name: 'Cloud CDN',
    shortName: 'Cloud CDN',
    category: 'networking',
    iconColor: '#34A853',
    description: 'Content delivery network',
    useCases: ['Static asset caching', 'API acceleration', 'Media delivery', 'DDoS mitigation'],
    alternatives: [],
    considerations: ['Cache modes (USE_ORIGIN_HEADERS, CACHE_ALL_STATIC)', 'Invalidation costs', 'Origin setup', 'Signed URLs/cookies'],
    pricingModel: 'Data transfer + cache fill + requests',
    crossCloudEquivalents: { aws: 'Amazon CloudFront', azure: 'Azure Front Door / CDN' },
  },
  {
    id: 'cloud-dns',
    name: 'Cloud DNS',
    shortName: 'Cloud DNS',
    category: 'networking',
    iconColor: '#34A853',
    description: 'Managed authoritative DNS',
    useCases: ['DNS hosting', 'Private zones', 'DNSSEC'],
    alternatives: [],
    considerations: ['Zone management', 'DNSSEC support', 'Private DNS for VPC', 'Routing policies'],
    pricingModel: 'Per managed zone + per million queries',
    crossCloudEquivalents: { aws: 'Amazon Route 53', azure: 'Azure DNS' },
  },
  {
    id: 'apigee',
    name: 'Apigee API Management',
    shortName: 'Apigee',
    category: 'networking',
    iconColor: '#34A853',
    description: 'Full lifecycle API management platform',
    useCases: ['API gateway', 'Developer portal', 'Rate limiting', 'API monetization'],
    alternatives: ['cloud-endpoints'],
    considerations: ['Apigee X vs hybrid', 'Policy-based mediation', 'Analytics and monitoring', 'Cost (enterprise-grade pricing)'],
    pricingModel: 'Per API call; subscription tiers available',
    crossCloudEquivalents: { aws: 'Amazon API Gateway', azure: 'Azure API Management' },
  },
  {
    id: 'cloud-armor',
    name: 'Cloud Armor',
    shortName: 'Cloud Armor',
    category: 'networking',
    iconColor: '#34A853',
    description: 'DDoS protection and WAF',
    useCases: ['DDoS protection', 'WAF rules', 'Adaptive protection', 'Bot management'],
    alternatives: [],
    considerations: ['Security policies', 'Pre-configured WAF rules', 'Rate limiting', 'Geo-based access control'],
    pricingModel: 'Per policy + per rule + per million requests',
    crossCloudEquivalents: { aws: 'AWS WAF + AWS Shield', azure: 'Azure WAF + DDoS Protection' },
  },

  // ── Messaging & Integration ─────────────────────────────────────────
  {
    id: 'pub-sub',
    name: 'Pub/Sub',
    shortName: 'Pub/Sub',
    category: 'messaging',
    iconColor: '#EA4335',
    description: 'Global real-time messaging',
    useCases: ['Event streaming', 'Decoupling microservices', 'Log ingestion', 'IoT telemetry', 'Order processing'],
    alternatives: ['cloud-tasks', 'eventarc'],
    considerations: ['Topic design', 'Subscription management', 'Message ordering (ordering keys)', 'Exactly-once delivery', 'Retention policies (up to 31 days)', 'Dead-letter topics'],
    pricingModel: 'Per GB ingested + egress + storage for retained messages',
    crossCloudEquivalents: { aws: 'Amazon SNS + SQS / Kinesis', azure: 'Azure Service Bus / Event Hubs' },
  },
  {
    id: 'cloud-tasks',
    name: 'Cloud Tasks',
    shortName: 'Cloud Tasks',
    category: 'messaging',
    iconColor: '#EA4335',
    description: 'Managed task queue',
    useCases: ['Asynchronous task execution', 'Rate-controlled dispatch', 'Retry with backoff'],
    alternatives: ['pub-sub'],
    considerations: ['Queue configuration', 'Rate limiting', 'Retry policies', 'HTTP vs App Engine targets'],
    pricingModel: 'Per million operations',
    crossCloudEquivalents: { aws: 'Amazon SQS', azure: 'Azure Queue Storage' },
  },
  {
    id: 'workflows',
    name: 'Workflows',
    shortName: 'Workflows',
    category: 'integration',
    iconColor: '#EA4335',
    description: 'Serverless workflow orchestration',
    useCases: ['Service orchestration', 'API chaining', 'Saga patterns', 'Approval flows'],
    alternatives: ['cloud-functions', 'pub-sub'],
    considerations: ['YAML-based definition', 'Connector library', 'Error handling and retries', 'Execution history'],
    pricingModel: 'Per step executed (first 5K steps/mo free)',
    crossCloudEquivalents: { aws: 'AWS Step Functions', azure: 'Azure Logic Apps / Durable Functions' },
  },
  {
    id: 'eventarc',
    name: 'Eventarc',
    shortName: 'Eventarc',
    category: 'messaging',
    iconColor: '#EA4335',
    description: 'Event-driven triggers for Cloud Run',
    useCases: ['Event routing', 'Audit log triggers', 'Pub/Sub to Cloud Run', 'Cross-service events'],
    alternatives: ['pub-sub', 'workflows'],
    considerations: ['Event source support (90+ sources)', 'Destination types (Cloud Run, Workflows, Functions)', 'Filtering by event attributes', 'Channel-based event delivery'],
    pricingModel: 'No additional charge (underlying Pub/Sub charges apply)',
    crossCloudEquivalents: { aws: 'Amazon EventBridge', azure: 'Azure Event Grid' },
  },

  // ── Security ────────────────────────────────────────────────────────
  {
    id: 'cloud-iam',
    name: 'Cloud IAM',
    shortName: 'IAM',
    category: 'security',
    iconColor: '#EA4335',
    description: 'Identity and access management',
    useCases: ['Access control', 'Service accounts', 'Workload identity', 'Organization policies'],
    alternatives: [],
    considerations: ['Resource hierarchy (org/folder/project)', 'Predefined vs custom roles', 'Service account key management', 'Workload Identity Federation'],
    pricingModel: 'Free',
    crossCloudEquivalents: { aws: 'AWS IAM', azure: 'Microsoft Entra ID' },
  },
  {
    id: 'secret-manager',
    name: 'Secret Manager',
    shortName: 'Secret Mgr',
    category: 'security',
    iconColor: '#EA4335',
    description: 'Secret storage and management',
    useCases: ['API keys', 'Database credentials', 'Certificate storage', 'Automatic rotation'],
    alternatives: ['cloud-kms'],
    considerations: ['Versioning', 'Access control (IAM)', 'Rotation via Cloud Functions', 'Audit logging', 'Regional vs replication policy'],
    pricingModel: 'Per active secret version + per 10K access operations',
    crossCloudEquivalents: { aws: 'AWS Secrets Manager', azure: 'Azure Key Vault' },
  },
  {
    id: 'cloud-kms',
    name: 'Cloud KMS',
    shortName: 'Cloud KMS',
    category: 'security',
    iconColor: '#EA4335',
    description: 'Key management and encryption',
    useCases: ['Encryption key management', 'HSM', 'Envelope encryption', 'Digital signing'],
    alternatives: ['secret-manager'],
    considerations: ['Key rings and key hierarchy', 'Rotation strategy', 'Protection level (software, HSM, external)', 'Audit trail via Cloud Audit Logs'],
    pricingModel: 'Per key version + per 10K cryptographic operations',
    crossCloudEquivalents: { aws: 'AWS KMS', azure: 'Azure Key Vault' },
  },
  {
    id: 'identity-platform',
    name: 'Identity Platform',
    shortName: 'Identity',
    category: 'security',
    iconColor: '#EA4335',
    description: 'Customer identity and access management',
    useCases: ['User authentication', 'Multi-tenancy', 'MFA', 'Social login'],
    alternatives: ['cloud-iam'],
    considerations: ['Firebase Auth compatibility', 'Multi-tenancy support', 'Blocking functions for custom logic', 'SAML/OIDC federation'],
    pricingModel: 'Per monthly active user; free tier available',
    crossCloudEquivalents: { aws: 'Amazon Cognito', azure: 'Microsoft Entra ID B2C' },
  },

  // ── Monitoring & Observability ──────────────────────────────────────
  {
    id: 'cloud-monitoring',
    name: 'Cloud Monitoring',
    shortName: 'Monitoring',
    category: 'monitoring',
    iconColor: '#FBBC04',
    description: 'Infrastructure and application monitoring',
    useCases: ['Metrics collection', 'Alerting', 'Dashboards', 'Uptime checks', 'SLO tracking'],
    alternatives: [],
    considerations: ['Metric collection (auto for GCP services)', 'Custom metrics', 'Alert policies', 'Notification channels', 'Integration with PagerDuty/Slack'],
    pricingModel: 'Per metric per month (GCP metrics free, custom metrics charged)',
    crossCloudEquivalents: { aws: 'Amazon CloudWatch', azure: 'Azure Monitor' },
  },
  {
    id: 'cloud-logging',
    name: 'Cloud Logging',
    shortName: 'Logging',
    category: 'monitoring',
    iconColor: '#FBBC04',
    description: 'Log management and analysis',
    useCases: ['Log aggregation', 'Log-based metrics', 'Log Router', 'Audit logs'],
    alternatives: [],
    considerations: ['Log routing (sinks to GCS, BigQuery, Pub/Sub)', 'Retention (30 days default, configurable)', 'Exclusion filters to reduce cost', 'Log-based alerting'],
    pricingModel: 'Per GB ingested (first 50 GB/project/month free)',
    crossCloudEquivalents: { aws: 'Amazon CloudWatch Logs', azure: 'Azure Log Analytics' },
  },
  {
    id: 'cloud-trace',
    name: 'Cloud Trace',
    shortName: 'Trace',
    category: 'monitoring',
    iconColor: '#FBBC04',
    description: 'Distributed tracing',
    useCases: ['Request tracing', 'Latency analysis', 'Performance debugging'],
    alternatives: [],
    considerations: ['OpenTelemetry integration', 'Automatic instrumentation for GCP services', 'Sampling configuration', 'Trace retention'],
    pricingModel: 'Per million traces ingested',
    crossCloudEquivalents: { aws: 'AWS X-Ray', azure: 'Application Insights' },
  },

  // ── CI/CD ───────────────────────────────────────────────────────────
  {
    id: 'cloud-build',
    name: 'Cloud Build',
    shortName: 'Cloud Build',
    category: 'cicd',
    iconColor: '#4285F4',
    description: 'Serverless CI/CD platform',
    useCases: ['Container builds', 'CI pipelines', 'Artifact generation'],
    alternatives: ['cloud-deploy'],
    considerations: ['Build config (cloudbuild.yaml)', 'Build triggers (push, PR, manual)', 'Worker pools for private builds', 'Caching with kaniko'],
    pricingModel: 'Per build-minute (first 120 min/day free)',
    crossCloudEquivalents: { aws: 'AWS CodeBuild', azure: 'Azure DevOps Pipelines' },
  },
  {
    id: 'artifact-registry',
    name: 'Artifact Registry',
    shortName: 'Artifact Reg',
    category: 'cicd',
    iconColor: '#4285F4',
    description: 'Universal package and container registry',
    useCases: ['Container images', 'npm/Maven/pip packages', 'Vulnerability scanning'],
    alternatives: [],
    considerations: ['Cleanup policies', 'Vulnerability scanning (on push)', 'Remote and virtual repositories', 'Cross-region replication'],
    pricingModel: 'Per GB storage + network egress',
    crossCloudEquivalents: { aws: 'Amazon ECR', azure: 'Azure Container Registry' },
  },
  {
    id: 'cloud-deploy',
    name: 'Cloud Deploy',
    shortName: 'Cloud Deploy',
    category: 'cicd',
    iconColor: '#4285F4',
    description: 'Managed continuous delivery to GKE/Cloud Run',
    useCases: ['Canary deployments', 'Progressive rollouts', 'Approval gates'],
    alternatives: ['cloud-build'],
    considerations: ['Delivery pipeline definition', 'Target configuration', 'Verification steps', 'Rollback strategy'],
    pricingModel: 'Per delivery pipeline per month + per target per month',
    crossCloudEquivalents: { aws: 'AWS CodeDeploy', azure: 'Azure DevOps Release' },
  },

  // ── AI/ML ───────────────────────────────────────────────────────────
  {
    id: 'vertex-ai',
    name: 'Vertex AI',
    shortName: 'Vertex AI',
    category: 'ai-ml',
    iconColor: '#9334E6',
    description: 'Unified ML platform for training and serving',
    useCases: ['Model training', 'ML pipelines', 'Feature store', 'Model monitoring'],
    alternatives: ['gemini-api'],
    considerations: ['Training compute selection', 'Endpoint auto-scaling', 'Feature Store for feature sharing', 'Model Registry', 'Experiment tracking'],
    pricingModel: 'Instance hours for training and prediction',
    crossCloudEquivalents: { aws: 'Amazon SageMaker', azure: 'Azure Machine Learning' },
  },
  {
    id: 'gemini-api',
    name: 'Gemini API',
    shortName: 'Gemini',
    category: 'ai-ml',
    iconColor: '#9334E6',
    description: 'Google multimodal AI models',
    useCases: ['Generative AI', 'Multimodal understanding', 'Code generation', 'RAG applications'],
    alternatives: ['vertex-ai'],
    considerations: ['Model selection (Gemini Pro, Ultra, Flash)', 'Context window sizes', 'Grounding with Google Search', 'Safety settings'],
    pricingModel: 'Per 1K input/output tokens; free tier available',
    crossCloudEquivalents: { aws: 'Amazon Bedrock', azure: 'Azure OpenAI Service' },
  },

  // ── Analytics ─────────────────────────────────────────────────────
  {
    id: 'bigquery',
    name: 'BigQuery',
    shortName: 'BigQuery',
    category: 'analytics',
    iconColor: '#9334E6',
    description: 'Serverless data warehouse',
    useCases: ['Data warehousing', 'BI analytics', 'ML with SQL (BigQuery ML)', 'Real-time analytics'],
    alternatives: ['dataflow', 'dataproc'],
    considerations: ['Partitioning and clustering', 'Slot-based vs on-demand pricing', 'Materialized views', 'Streaming inserts vs batch loads', 'BI Engine for fast dashboards'],
    pricingModel: 'On-demand: per TB scanned; Editions: per slot-hour',
    crossCloudEquivalents: { aws: 'Amazon Redshift', azure: 'Azure Synapse Analytics' },
  },
  {
    id: 'dataflow',
    name: 'Dataflow',
    shortName: 'Dataflow',
    category: 'analytics',
    iconColor: '#9334E6',
    description: 'Managed Apache Beam pipelines',
    useCases: ['Stream processing', 'Batch ETL', 'Real-time analytics'],
    alternatives: ['dataproc', 'bigquery'],
    considerations: ['Apache Beam programming model', 'Autoscaling behavior', 'Template-based deployments', 'Streaming vs batch mode'],
    pricingModel: 'Per vCPU-hour + per GB-hour of memory + per GB of shuffle',
    crossCloudEquivalents: { aws: 'Amazon Kinesis Data Analytics', azure: 'Azure Stream Analytics' },
  },
  {
    id: 'dataproc',
    name: 'Dataproc',
    shortName: 'Dataproc',
    category: 'analytics',
    iconColor: '#9334E6',
    description: 'Managed Spark and Hadoop',
    useCases: ['Spark workloads', 'Hadoop migration', 'Batch processing'],
    alternatives: ['dataflow', 'bigquery'],
    considerations: ['Cluster vs Serverless Spark', 'Autoscaling policies', 'Component gateway for web UIs', 'GCS as HDFS replacement'],
    pricingModel: 'Per-second per VM + Dataproc premium',
    crossCloudEquivalents: { aws: 'Amazon EMR', azure: 'Azure HDInsight / Synapse Spark' },
  },

  // ── Management ──────────────────────────────────────────────────────
  {
    id: 'deployment-manager',
    name: 'Deployment Manager',
    shortName: 'Deploy Mgr',
    category: 'management',
    iconColor: '#FBBC04',
    description: 'Infrastructure as Code for GCP',
    useCases: ['IaC templates', 'Resource deployment'],
    alternatives: ['terraform-gcp'],
    considerations: ['YAML/Jinja/Python templates', 'Limited community support', 'Consider Terraform instead for new projects'],
    pricingModel: 'Free; pay for resources provisioned',
    crossCloudEquivalents: { aws: 'AWS CloudFormation', azure: 'ARM Templates' },
  },
  {
    id: 'terraform-gcp',
    name: 'Terraform for GCP',
    shortName: 'Terraform',
    category: 'management',
    iconColor: '#FBBC04',
    description: 'HashiCorp Terraform with GCP provider',
    useCases: ['Multi-cloud IaC', 'State management', 'Modular infrastructure'],
    alternatives: ['deployment-manager'],
    considerations: ['State backend (GCS recommended)', 'Module registry', 'Plan/apply workflow', 'Provider version management'],
    pricingModel: 'Free (open source); Terraform Cloud available',
    crossCloudEquivalents: { aws: 'AWS CDK / Terraform', azure: 'Bicep / Terraform' },
  },
];

// ---------------------------------------------------------------------------
// Quick lookups
// ---------------------------------------------------------------------------

/** Get GCP service info by service ID */
export function getGCPService(serviceId: string): GCPServiceInfo | null {
  return GCP_SERVICES.find((s) => s.id === serviceId) ?? null;
}

/** Get all GCP services in a category */
export function getGCPServicesByCategory(category: CloudServiceCategory): GCPServiceInfo[] {
  return GCP_SERVICES.filter((s) => s.category === category);
}

/** Find GCP services whose use cases match a search term */
export function findGCPServicesForUseCase(useCase: string): GCPServiceInfo[] {
  const lc = useCase.toLowerCase();
  return GCP_SERVICES.filter((s) =>
    s.useCases.some((uc) => uc.toLowerCase().includes(lc)),
  );
}

