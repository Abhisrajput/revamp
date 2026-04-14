/**
 * Azure Service Knowledge Base for REVAMP
 *
 * Comprehensive mapping of Azure services, modernization patterns,
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

export interface AzureServiceInfo {
  /** Stable identifier used in architecture specs and lookups */
  id: string;
  name: string;
  shortName: string;
  category: CloudServiceCategory;
  description: string;
  /** Hex color for icon backgrounds in architecture diagrams */
  iconColor: string;
  useCases: readonly string[];
  /** Alternative Azure services for the same use-case */
  alternatives: readonly string[];
  /** Operational considerations when adopting this service */
  considerations: readonly string[];
  pricingModel: string;
  /** Equivalent services on other clouds */
  crossCloudEquivalents?: { aws?: string; gcp?: string };
  /** Hard limits worth knowing during migration planning */
  limits?: Record<string, string>;
}

// Architecture diagram node/edge/group types for rendering
export interface AzureArchNode {
  id: string;
  /** Azure service ID from the catalog */
  service: string;
  label: string;
  group?: string;
  x?: number;
  y?: number;
}

export interface AzureArchEdge {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dashed';
}

export interface AzureArchGroup {
  id: string;
  label: string;
  type: 'subscription' | 'resource-group' | 'vnet' | 'subnet' | 'region' | 'generic';
  color?: string;
}

export interface AzureArchitectureSpec {
  title: string;
  nodes: AzureArchNode[];
  edges: AzureArchEdge[];
  groups: AzureArchGroup[];
}

// ---------------------------------------------------------------------------
// Service catalog
// ---------------------------------------------------------------------------

export const AZURE_SERVICES: AzureServiceInfo[] = [
  // ── Compute ─────────────────────────────────────────────────────────
  {
    id: 'azure-functions',
    name: 'Azure Functions',
    shortName: 'Functions',
    category: 'compute',
    iconColor: '#0078D4',
    description: 'Serverless compute — event-driven functions',
    useCases: ['Event-driven processing', 'API backends', 'Scheduled tasks', 'Stream processing', 'Microservices'],
    alternatives: ['app-service', 'container-apps', 'logic-apps'],
    considerations: ['Runtime support (.NET, Node, Python, Java)', 'Trigger types (HTTP, timer, queue, blob)', 'Consumption vs Premium vs Dedicated plan', 'Cold start on Consumption plan', 'State management with Durable Functions'],
    pricingModel: 'Consumption: per execution + GB-s; Premium/Dedicated: plan-based',
    crossCloudEquivalents: { aws: 'AWS Lambda', gcp: 'Cloud Functions' },
    limits: { maxTimeoutConsumption: '10 minutes', maxTimeoutPremium: 'unlimited', maxMemory: '1.5 GB (Consumption)' },
  },
  {
    id: 'azure-vm',
    name: 'Azure Virtual Machines',
    shortName: 'VMs',
    category: 'compute',
    iconColor: '#0078D4',
    description: 'Virtual machines in the cloud',
    useCases: ['Legacy app hosting', 'Custom runtimes', 'GPU workloads', 'High-performance computing'],
    alternatives: ['app-service', 'container-apps', 'aks'],
    considerations: ['VM series selection (B, D, E, F, N)', 'Spot VMs for savings', 'Reserved Instances', 'Availability Sets/Zones', 'Azure Hybrid Benefit for Windows/SQL'],
    pricingModel: 'Per-second billing; Reserved/Spot discounts available',
    crossCloudEquivalents: { aws: 'Amazon EC2', gcp: 'Compute Engine' },
  },
  {
    id: 'app-service',
    name: 'Azure App Service',
    shortName: 'App Service',
    category: 'compute',
    iconColor: '#0078D4',
    description: 'Managed platform for web apps and APIs',
    useCases: ['Web applications', 'REST APIs', 'Mobile backends', 'Auto-scaling apps', 'WebSocket applications'],
    alternatives: ['container-apps', 'azure-functions', 'azure-vm'],
    considerations: ['App Service Plan sizing (Free/Basic/Standard/Premium)', 'Deployment slots for staging', 'Auto-scaling rules', 'SSL/TLS certificates', 'Easy Auth integration'],
    pricingModel: 'App Service Plan hourly cost; Free and Shared tiers available',
    crossCloudEquivalents: { aws: 'AWS Elastic Beanstalk', gcp: 'App Engine' },
  },
  {
    id: 'aks',
    name: 'Azure Kubernetes Service',
    shortName: 'AKS',
    category: 'containers',
    iconColor: '#0078D4',
    description: 'Managed Kubernetes service',
    useCases: ['Kubernetes workloads', 'Microservice orchestration', 'Multi-cloud portability', 'Stateful services', 'Hybrid deployments'],
    alternatives: ['container-apps', 'app-service', 'container-instances'],
    considerations: ['Node pool management', 'Network policies (Azure CNI vs Kubenet)', 'Storage integration (Azure Disk, Files)', 'KEDA for event-driven scaling', 'Cost optimization with Spot node pools'],
    pricingModel: 'Free control plane; pay for node VMs and resources',
    crossCloudEquivalents: { aws: 'Amazon EKS', gcp: 'GKE' },
  },
  {
    id: 'container-instances',
    name: 'Azure Container Instances',
    shortName: 'ACI',
    category: 'containers',
    iconColor: '#0078D4',
    description: 'Run containers without managing servers',
    useCases: ['Simple container workloads', 'Burst capacity', 'CI/CD tasks', 'Development and testing'],
    alternatives: ['container-apps', 'aks', 'azure-functions'],
    considerations: ['CPU and memory options', 'Public/private networking', 'Container image management', 'No built-in scaling (use AKS virtual nodes for scaling)'],
    pricingModel: 'Per-second billing for vCPU and memory',
    crossCloudEquivalents: { aws: 'AWS Fargate (standalone)', gcp: 'Cloud Run Jobs' },
  },
  {
    id: 'container-apps',
    name: 'Azure Container Apps',
    shortName: 'Container Apps',
    category: 'containers',
    iconColor: '#0078D4',
    description: 'Serverless containers with scale-to-zero',
    useCases: ['Microservices', 'Event processing', 'API endpoints', 'Background tasks'],
    alternatives: ['aks', 'container-instances', 'app-service'],
    considerations: ['Dapr integration for microservices', 'KEDA-based scaling', 'Revision management', 'Environment-level networking', 'Managed identity support'],
    pricingModel: 'Consumption: per vCPU-s and GiB-s; Dedicated: workload profile pricing',
    crossCloudEquivalents: { aws: 'AWS Fargate / App Runner', gcp: 'Cloud Run' },
  },
  {
    id: 'spring-apps',
    name: 'Azure Spring Apps',
    shortName: 'Spring Apps',
    category: 'compute',
    iconColor: '#0078D4',
    description: 'Managed Spring Boot service',
    useCases: ['Java/Spring microservices', 'Spring Cloud apps'],
    alternatives: ['aks', 'app-service'],
    considerations: ['Enterprise vs Standard tier', 'Spring Cloud Config integration', 'Tanzu Build Service', 'Service registry built-in'],
    pricingModel: 'Per app instance-hour + vCPU and memory',
    crossCloudEquivalents: { aws: 'AWS App Runner' },
  },

  // ── Database ────────────────────────────────────────────────────────
  {
    id: 'azure-sql',
    name: 'Azure SQL Database',
    shortName: 'Azure SQL',
    category: 'database',
    iconColor: '#0078D4',
    description: 'Managed SQL Server database',
    useCases: ['Relational data', 'SQL Server migration', 'OLTP workloads', 'Business applications'],
    alternatives: ['azure-sql-mi', 'cosmos-db', 'azure-postgresql'],
    considerations: ['DTU vs vCore pricing model', 'Service tier selection (General Purpose, Business Critical, Hyperscale)', 'Geo-replication', 'Backup strategy (PITR)', 'Intelligent Performance tuning'],
    pricingModel: 'DTU or vCore pricing; Serverless auto-pause option',
    crossCloudEquivalents: { aws: 'Amazon RDS (SQL Server) / Aurora', gcp: 'Cloud SQL' },
  },
  {
    id: 'azure-sql-mi',
    name: 'Azure SQL Managed Instance',
    shortName: 'SQL MI',
    category: 'database',
    iconColor: '#0078D4',
    description: 'Near 100% SQL Server compatibility in the cloud',
    useCases: ['SQL Server lift-and-shift', 'Agent jobs', 'Cross-DB queries', 'Linked servers'],
    alternatives: ['azure-sql', 'azure-vm'],
    considerations: ['VNet deployment required', 'Instance pool for cost sharing', 'Link feature for near-real-time replication', 'SQL Agent jobs supported'],
    pricingModel: 'vCore-based pricing; Reserved capacity discounts',
    crossCloudEquivalents: { aws: 'Amazon RDS Custom (SQL Server)' },
  },
  {
    id: 'cosmos-db',
    name: 'Azure Cosmos DB',
    shortName: 'Cosmos DB',
    category: 'database',
    iconColor: '#0078D4',
    description: 'Multi-model globally distributed database',
    useCases: ['Global distribution', 'Multi-model (document, graph, key-value)', 'Low-latency at scale', 'Real-time applications'],
    alternatives: ['azure-sql', 'azure-redis'],
    considerations: ['Consistency models (5 levels)', 'Partition key design (critical)', 'Cost at scale (RU-based)', 'API selection (NoSQL, MongoDB, Cassandra, Gremlin, Table)', 'Serverless vs provisioned throughput'],
    pricingModel: 'RU/s throughput pricing or serverless per-request',
    crossCloudEquivalents: { aws: 'Amazon DynamoDB', gcp: 'Firestore / Cloud Spanner' },
  },
  {
    id: 'azure-redis',
    name: 'Azure Cache for Redis',
    shortName: 'Redis Cache',
    category: 'database',
    iconColor: '#0078D4',
    description: 'Managed Redis cache',
    useCases: ['Session caching', 'Real-time analytics', 'Message broker'],
    alternatives: ['cosmos-db'],
    considerations: ['Tier selection (Basic, Standard, Premium, Enterprise)', 'Clustering for scale', 'Data persistence', 'Geo-replication (Premium+)', 'Redis modules (Enterprise)'],
    pricingModel: 'Per instance-hour based on tier and size',
    crossCloudEquivalents: { aws: 'Amazon ElastiCache', gcp: 'Memorystore' },
  },
  {
    id: 'azure-postgresql',
    name: 'Azure Database for PostgreSQL',
    shortName: 'PostgreSQL',
    category: 'database',
    iconColor: '#0078D4',
    description: 'Managed PostgreSQL database',
    useCases: ['PostgreSQL workloads', 'Open-source migration', 'Flexible server'],
    alternatives: ['azure-sql', 'cosmos-db'],
    considerations: ['Flexible Server (recommended) vs Single Server (deprecated)', 'Burstable vs General Purpose vs Memory Optimized', 'HA with zone-redundant deployments', 'PgBouncer built-in'],
    pricingModel: 'vCore pricing + storage + backup',
    crossCloudEquivalents: { aws: 'Amazon RDS PostgreSQL / Aurora', gcp: 'Cloud SQL PostgreSQL / AlloyDB' },
  },
  {
    id: 'azure-mysql',
    name: 'Azure Database for MySQL',
    shortName: 'MySQL',
    category: 'database',
    iconColor: '#0078D4',
    description: 'Managed MySQL database',
    useCases: ['MySQL workloads', 'WordPress/CMS backends', 'Web app data'],
    alternatives: ['azure-sql', 'azure-postgresql'],
    considerations: ['Flexible Server deployment', 'Same-zone or zone-redundant HA', 'Read replicas', 'Data-in encryption'],
    pricingModel: 'vCore pricing + storage + backup',
    crossCloudEquivalents: { aws: 'Amazon RDS MySQL / Aurora MySQL', gcp: 'Cloud SQL MySQL' },
  },

  // ── Storage ─────────────────────────────────────────────────────────
  {
    id: 'blob-storage',
    name: 'Azure Blob Storage',
    shortName: 'Blob Storage',
    category: 'storage',
    iconColor: '#0078D4',
    description: 'Object storage for unstructured data',
    useCases: ['Static assets', 'Data lakes', 'Backups', 'Log storage', 'Media delivery'],
    alternatives: ['azure-files', 'data-lake', 'azure-disk'],
    considerations: ['Access tiers (Hot/Cool/Cold/Archive)', 'Lifecycle management policies', 'Versioning and soft delete', 'Access control (RBAC, SAS tokens, access keys)', 'Immutability policies'],
    pricingModel: 'Storage per GB + transactions + data transfer (varies by tier)',
    crossCloudEquivalents: { aws: 'Amazon S3', gcp: 'Cloud Storage' },
  },
  {
    id: 'azure-files',
    name: 'Azure Files',
    shortName: 'Azure Files',
    category: 'storage',
    iconColor: '#0078D4',
    description: 'Managed file shares (SMB/NFS)',
    useCases: ['Shared file storage', 'Lift-and-shift file shares', 'Container storage'],
    alternatives: ['blob-storage', 'azure-disk'],
    considerations: ['SMB vs NFS protocol', 'Standard vs Premium tier', 'Azure File Sync for hybrid', 'Snapshot support', 'AD integration for access control'],
    pricingModel: 'Per GiB used (Standard) or provisioned (Premium)',
    crossCloudEquivalents: { aws: 'Amazon EFS', gcp: 'Filestore' },
  },
  {
    id: 'azure-disk',
    name: 'Azure Managed Disks',
    shortName: 'Managed Disks',
    category: 'storage',
    iconColor: '#0078D4',
    description: 'Block storage for VMs',
    useCases: ['VM disks', 'Database storage', 'High-IOPS workloads'],
    alternatives: ['blob-storage', 'azure-files'],
    considerations: ['Disk type (Standard HDD, Standard SSD, Premium SSD, Ultra)', 'Disk bursting', 'Shared disks for clustering', 'Snapshot and image management'],
    pricingModel: 'Per disk per month based on size and type',
    crossCloudEquivalents: { aws: 'Amazon EBS', gcp: 'Persistent Disk' },
  },
  {
    id: 'data-lake',
    name: 'Azure Data Lake Storage',
    shortName: 'Data Lake',
    category: 'storage',
    iconColor: '#0078D4',
    description: 'Hierarchical namespace on Blob Storage for analytics',
    useCases: ['Big data analytics', 'Data lakes', 'ML training data'],
    alternatives: ['blob-storage'],
    considerations: ['Hierarchical namespace (HNS) enabled', 'ACL-based access control', 'Integration with Synapse/Databricks', 'Same pricing as Blob Storage'],
    pricingModel: 'Same as Blob Storage (per GB + transactions)',
    crossCloudEquivalents: { aws: 'Amazon S3 (with Lake Formation)', gcp: 'Cloud Storage' },
  },

  // ── Networking ──────────────────────────────────────────────────────
  {
    id: 'vnet',
    name: 'Azure Virtual Network',
    shortName: 'VNet',
    category: 'networking',
    iconColor: '#7FBA00',
    description: 'Isolated cloud networking',
    useCases: ['Network isolation', 'Subnets', 'Network security groups', 'VPN'],
    alternatives: [],
    considerations: ['Address space planning', 'NSG vs ASG', 'VNet peering (regional/global)', 'Service Endpoints vs Private Endpoints', 'NAT Gateway for outbound'],
    pricingModel: 'No charge for VNet; peering, VPN, NAT Gateway charged separately',
    crossCloudEquivalents: { aws: 'Amazon VPC', gcp: 'VPC' },
  },
  {
    id: 'app-gateway',
    name: 'Azure Application Gateway',
    shortName: 'App Gateway',
    category: 'networking',
    iconColor: '#7FBA00',
    description: 'L7 load balancer with WAF',
    useCases: ['Web app load balancing', 'SSL termination', 'URL-based routing', 'WAF'],
    alternatives: ['front-door', 'load-balancer'],
    considerations: ['v2 SKU (recommended)', 'WAF v2 with custom rules', 'Backend pool configuration', 'Health probes', 'Auto-scaling'],
    pricingModel: 'Fixed hourly + capacity unit pricing',
    crossCloudEquivalents: { aws: 'Elastic Load Balancer (ALB)', gcp: 'Cloud Load Balancing' },
  },
  {
    id: 'front-door',
    name: 'Azure Front Door',
    shortName: 'Front Door',
    category: 'networking',
    iconColor: '#7FBA00',
    description: 'Global CDN and L7 load balancer',
    useCases: ['Global traffic management', 'CDN', 'SSL offload', 'WAF at edge'],
    alternatives: ['app-gateway', 'traffic-manager'],
    considerations: ['Standard vs Premium tier', 'Rule engine for routing', 'WAF at edge', 'Private Link origins', 'Caching configuration'],
    pricingModel: 'Per routing rule + data transfer + WAF requests',
    crossCloudEquivalents: { aws: 'Amazon CloudFront', gcp: 'Cloud CDN + Cloud Load Balancing' },
  },
  {
    id: 'traffic-manager',
    name: 'Azure Traffic Manager',
    shortName: 'Traffic Mgr',
    category: 'networking',
    iconColor: '#7FBA00',
    description: 'DNS-based traffic load balancer',
    useCases: ['Geographic routing', 'Failover', 'Weighted routing'],
    alternatives: ['front-door'],
    considerations: ['DNS-based (no inline proxy)', 'Routing methods (Priority, Weighted, Performance, Geographic)', 'Nested profiles', 'Health monitoring'],
    pricingModel: 'Per million DNS queries + health checks',
    crossCloudEquivalents: { aws: 'Amazon Route 53 (routing policies)', gcp: 'Cloud DNS (routing policies)' },
  },
  {
    id: 'apim',
    name: 'Azure API Management',
    shortName: 'API Mgmt',
    category: 'networking',
    iconColor: '#7FBA00',
    description: 'Full lifecycle API management',
    useCases: ['API gateway', 'Rate limiting', 'Developer portal', 'API versioning'],
    alternatives: ['app-gateway'],
    considerations: ['Tier selection (Consumption, Developer, Standard, Premium)', 'Policy expressions', 'VNet integration (Premium)', 'Self-hosted gateway for hybrid'],
    pricingModel: 'Tier-based; Consumption plan per million calls',
    crossCloudEquivalents: { aws: 'Amazon API Gateway', gcp: 'Apigee' },
  },
  {
    id: 'azure-dns',
    name: 'Azure DNS',
    shortName: 'Azure DNS',
    category: 'networking',
    iconColor: '#7FBA00',
    description: 'DNS hosting service',
    useCases: ['Domain management', 'DNS records', 'Private DNS zones'],
    alternatives: [],
    considerations: ['Alias record sets', 'Private DNS zones for VNet', 'DNS zone delegation', 'Integration with Traffic Manager'],
    pricingModel: 'Per hosted zone + per million queries',
    crossCloudEquivalents: { aws: 'Amazon Route 53', gcp: 'Cloud DNS' },
  },
  {
    id: 'load-balancer',
    name: 'Azure Load Balancer',
    shortName: 'Load Balancer',
    category: 'networking',
    iconColor: '#7FBA00',
    description: 'L4 load balancer',
    useCases: ['TCP/UDP load balancing', 'HA ports', 'Internal load balancing'],
    alternatives: ['app-gateway', 'front-door'],
    considerations: ['Standard vs Basic SKU', 'Zone-redundant frontend', 'Outbound rules', 'Health probes'],
    pricingModel: 'Per rule + per GB data processed (Standard)',
    crossCloudEquivalents: { aws: 'Network Load Balancer', gcp: 'Cloud Load Balancing (TCP/UDP)' },
  },

  // ── Messaging & Integration ─────────────────────────────────────────
  {
    id: 'service-bus',
    name: 'Azure Service Bus',
    shortName: 'Service Bus',
    category: 'messaging',
    iconColor: '#FF8C00',
    description: 'Enterprise messaging with queues and topics',
    useCases: ['Decoupling microservices', 'Message queues', 'Pub/sub topics', 'Transaction support', 'Order processing'],
    alternatives: ['storage-queues', 'event-hubs', 'event-grid'],
    considerations: ['Queue vs Topic (pub/sub)', 'Message sessions for ordering', 'Dead-letter handling', 'Duplicate detection', 'Tier selection (Basic, Standard, Premium)'],
    pricingModel: 'Per million operations (Standard) or messaging units (Premium)',
    crossCloudEquivalents: { aws: 'Amazon SQS + SNS', gcp: 'Pub/Sub' },
  },
  {
    id: 'event-hubs',
    name: 'Azure Event Hubs',
    shortName: 'Event Hubs',
    category: 'messaging',
    iconColor: '#FF8C00',
    description: 'Big data streaming platform',
    useCases: ['Event streaming', 'Telemetry ingestion', 'Log streaming', 'Kafka-compatible'],
    alternatives: ['service-bus', 'event-grid'],
    considerations: ['Throughput units (Standard) vs Processing units (Premium)', 'Partition count', 'Retention period (up to 90 days)', 'Consumer groups', 'Kafka protocol support'],
    pricingModel: 'Throughput/Processing units; Dedicated for enterprise',
    crossCloudEquivalents: { aws: 'Amazon Kinesis', gcp: 'Pub/Sub' },
  },
  {
    id: 'event-grid',
    name: 'Azure Event Grid',
    shortName: 'Event Grid',
    category: 'messaging',
    iconColor: '#FF8C00',
    description: 'Event routing service',
    useCases: ['Event-driven architecture', 'Reactive programming', 'Serverless triggers', 'Azure resource events'],
    alternatives: ['service-bus', 'event-hubs'],
    considerations: ['System vs custom topics', 'Event domains for multi-tenant', 'Dead-letter and retry policies', 'CloudEvents schema support', 'Push-based delivery'],
    pricingModel: 'Per million operations (first 100K/month free)',
    crossCloudEquivalents: { aws: 'Amazon EventBridge', gcp: 'Eventarc' },
  },
  {
    id: 'logic-apps',
    name: 'Azure Logic Apps',
    shortName: 'Logic Apps',
    category: 'integration',
    iconColor: '#FF8C00',
    description: 'Workflow automation and integration',
    useCases: ['B2B integration', 'SaaS connectors', 'Approval workflows', 'ETL pipelines'],
    alternatives: ['durable-functions', 'azure-functions'],
    considerations: ['Consumption vs Standard plan', '1000+ connectors', 'Visual designer', 'Enterprise Integration Pack for B2B', 'ISE for VNet isolation'],
    pricingModel: 'Per action execution (Consumption) or plan-based (Standard)',
    crossCloudEquivalents: { aws: 'AWS Step Functions', gcp: 'Workflows' },
  },
  {
    id: 'storage-queues',
    name: 'Azure Queue Storage',
    shortName: 'Queue Storage',
    category: 'messaging',
    iconColor: '#FF8C00',
    description: 'Simple HTTP-based message queuing',
    useCases: ['Simple task queues', 'Asynchronous processing', 'Decoupling'],
    alternatives: ['service-bus', 'event-grid'],
    considerations: ['Simple HTTP API', 'Part of Storage Account', 'No pub/sub support', 'Up to 64 KB messages', 'Up to 7-day retention'],
    pricingModel: 'Included with Storage Account; per transaction',
    crossCloudEquivalents: { aws: 'Amazon SQS', gcp: 'Cloud Tasks' },
  },
  {
    id: 'durable-functions',
    name: 'Durable Functions',
    shortName: 'Durable Func',
    category: 'integration',
    iconColor: '#FF8C00',
    description: 'Stateful serverless workflows',
    useCases: ['Saga patterns', 'Fan-out/fan-in', 'Chaining', 'Human interaction flows'],
    alternatives: ['logic-apps', 'azure-functions'],
    considerations: ['Orchestrator function constraints (deterministic)', 'Entity functions for stateful actors', 'Monitoring via Azure Portal', 'Durable Task Hub storage backend'],
    pricingModel: 'Same as Azure Functions (per execution or plan-based)',
    crossCloudEquivalents: { aws: 'AWS Step Functions', gcp: 'Workflows' },
  },

  // ── Security ────────────────────────────────────────────────────────
  {
    id: 'entra-id',
    name: 'Microsoft Entra ID',
    shortName: 'Entra ID',
    category: 'security',
    iconColor: '#DD5900',
    description: 'Identity and access management (Azure AD)',
    useCases: ['User authentication', 'SSO', 'MFA', 'Conditional access'],
    alternatives: [],
    considerations: ['Free vs P1 vs P2 licensing', 'Conditional Access policies', 'Privileged Identity Management (P2)', 'App registrations for OAuth', 'B2B and B2C scenarios'],
    pricingModel: 'Free tier + Premium P1/P2 per user per month',
    crossCloudEquivalents: { aws: 'AWS IAM + Cognito', gcp: 'Cloud IAM + Identity Platform' },
  },
  {
    id: 'key-vault',
    name: 'Azure Key Vault',
    shortName: 'Key Vault',
    category: 'security',
    iconColor: '#DD5900',
    description: 'Secrets, keys, and certificate management',
    useCases: ['Secret storage', 'Key management', 'Certificate management', 'HSM'],
    alternatives: ['defender'],
    considerations: ['Standard vs Premium tier (HSM-backed)', 'Access policies vs RBAC', 'Soft-delete and purge protection', 'Certificate auto-renewal', 'Key rotation'],
    pricingModel: 'Per 10K operations + per key/secret/certificate',
    crossCloudEquivalents: { aws: 'AWS KMS + Secrets Manager', gcp: 'Cloud KMS + Secret Manager' },
  },
  {
    id: 'azure-waf',
    name: 'Azure WAF',
    shortName: 'WAF',
    category: 'security',
    iconColor: '#DD5900',
    description: 'Web application firewall',
    useCases: ['OWASP protection', 'Bot protection', 'Custom rules'],
    alternatives: ['ddos-protection'],
    considerations: ['WAF on Front Door vs App Gateway', 'Custom rules vs managed rule sets', 'DRS (Default Rule Set) versions', 'Rate limiting rules'],
    pricingModel: 'Per WAF policy + per rule + per million requests',
    crossCloudEquivalents: { aws: 'AWS WAF', gcp: 'Cloud Armor' },
  },
  {
    id: 'ddos-protection',
    name: 'Azure DDoS Protection',
    shortName: 'DDoS Protect',
    category: 'security',
    iconColor: '#DD5900',
    description: 'DDoS mitigation',
    useCases: ['DDoS protection', 'Attack analytics', 'Cost protection'],
    alternatives: ['azure-waf'],
    considerations: ['Network vs IP Protection tiers', 'Cost protection guarantee', 'Rapid Response team access (Network tier)', 'Integration with Azure Monitor'],
    pricingModel: 'Network tier: monthly fixed + per resource; IP tier: per protected IP',
    crossCloudEquivalents: { aws: 'AWS Shield', gcp: 'Cloud Armor' },
  },
  {
    id: 'defender',
    name: 'Microsoft Defender for Cloud',
    shortName: 'Defender',
    category: 'security',
    iconColor: '#DD5900',
    description: 'Cloud security posture management',
    useCases: ['Threat detection', 'Security recommendations', 'Compliance'],
    alternatives: [],
    considerations: ['CSPM free vs Defender plans (paid)', 'Multi-cloud support (AWS, GCP)', 'Regulatory compliance dashboard', 'Just-in-time VM access'],
    pricingModel: 'Free basic CSPM; per-resource Defender plan pricing',
    crossCloudEquivalents: { aws: 'AWS Security Hub + GuardDuty', gcp: 'Security Command Center' },
  },

  // ── Monitoring & Observability ──────────────────────────────────────
  {
    id: 'azure-monitor',
    name: 'Azure Monitor',
    shortName: 'Monitor',
    category: 'monitoring',
    iconColor: '#50E6FF',
    description: 'Full-stack monitoring and alerting',
    useCases: ['Metrics collection', 'Alerting', 'Dashboards', 'Autoscale'],
    alternatives: ['app-insights', 'log-analytics'],
    considerations: ['Platform metrics (free) vs custom metrics', 'Alert rule types (metric, log, activity log)', 'Action groups for notification', 'Workbooks for visualization'],
    pricingModel: 'Platform metrics free; custom metrics, alerts, and data charged',
    crossCloudEquivalents: { aws: 'Amazon CloudWatch', gcp: 'Cloud Monitoring' },
  },
  {
    id: 'app-insights',
    name: 'Application Insights',
    shortName: 'App Insights',
    category: 'monitoring',
    iconColor: '#50E6FF',
    description: 'APM and distributed tracing',
    useCases: ['Request tracing', 'Performance monitoring', 'Error diagnostics', 'Live metrics'],
    alternatives: ['azure-monitor'],
    considerations: ['Auto-instrumentation vs SDK', 'Sampling configuration (to reduce cost)', 'Smart detection', 'Application Map for dependency visualization', 'Availability tests'],
    pricingModel: 'Per GB ingested (first 5 GB/month free)',
    crossCloudEquivalents: { aws: 'AWS X-Ray', gcp: 'Cloud Trace' },
  },
  {
    id: 'log-analytics',
    name: 'Log Analytics',
    shortName: 'Log Analytics',
    category: 'monitoring',
    iconColor: '#50E6FF',
    description: 'Log aggregation and KQL queries',
    useCases: ['Log management', 'KQL queries', 'Workbooks', 'Sentinel integration'],
    alternatives: ['azure-monitor'],
    considerations: ['Workspace architecture (centralized vs distributed)', 'Data retention (up to 730 days)', 'Basic vs Analytics logs (cost optimization)', 'Ingestion-time transformation'],
    pricingModel: 'Per GB ingested; commitment tiers for discounts',
    crossCloudEquivalents: { aws: 'Amazon CloudWatch Logs', gcp: 'Cloud Logging' },
  },

  // ── CI/CD ───────────────────────────────────────────────────────────
  {
    id: 'azure-devops',
    name: 'Azure DevOps',
    shortName: 'DevOps',
    category: 'cicd',
    iconColor: '#0078D4',
    description: 'CI/CD pipelines, repos, boards, artifacts',
    useCases: ['Build pipelines', 'Release pipelines', 'Test plans', 'Artifact management'],
    alternatives: [],
    considerations: ['YAML vs Classic pipelines', 'Self-hosted vs Microsoft-hosted agents', 'Artifact feeds for packages', 'Integration with GitHub', 'Board work tracking'],
    pricingModel: 'First 5 users free; parallel job pricing',
    crossCloudEquivalents: { aws: 'AWS CodePipeline + CodeBuild', gcp: 'Cloud Build + Cloud Deploy' },
  },
  {
    id: 'acr',
    name: 'Azure Container Registry',
    shortName: 'ACR',
    category: 'containers',
    iconColor: '#0078D4',
    description: 'Docker container registry',
    useCases: ['Container image storage', 'Image scanning', 'Geo-replication'],
    alternatives: [],
    considerations: ['Tier selection (Basic, Standard, Premium)', 'Geo-replication (Premium)', 'Tasks for automated builds', 'Content trust for image signing', 'Retention policies'],
    pricingModel: 'Per registry per day + storage + network',
    crossCloudEquivalents: { aws: 'Amazon ECR', gcp: 'Artifact Registry' },
  },

  // ── AI/ML ───────────────────────────────────────────────────────────
  {
    id: 'azure-openai',
    name: 'Azure OpenAI Service',
    shortName: 'Azure OpenAI',
    category: 'ai-ml',
    iconColor: '#773ADC',
    description: 'OpenAI models with Azure enterprise features',
    useCases: ['Generative AI', 'Text generation', 'Code assistance', 'RAG applications'],
    alternatives: ['azure-ml', 'ai-services'],
    considerations: ['Model availability by region', 'Provisioned Throughput Units (PTU)', 'Content filtering', 'Data privacy (data not used for training)', 'Rate limits and quotas'],
    pricingModel: 'Per 1K tokens (input/output); PTU for provisioned throughput',
    crossCloudEquivalents: { aws: 'Amazon Bedrock', gcp: 'Gemini API / Vertex AI' },
  },
  {
    id: 'azure-ml',
    name: 'Azure Machine Learning',
    shortName: 'Azure ML',
    category: 'ai-ml',
    iconColor: '#773ADC',
    description: 'End-to-end ML lifecycle management',
    useCases: ['Model training', 'MLOps', 'AutoML', 'Managed endpoints'],
    alternatives: ['azure-openai'],
    considerations: ['Compute instance selection', 'Pipeline orchestration', 'Model Registry', 'Managed online/batch endpoints', 'Responsible AI dashboard'],
    pricingModel: 'No surcharge; pay for underlying compute and storage',
    crossCloudEquivalents: { aws: 'Amazon SageMaker', gcp: 'Vertex AI' },
  },
  {
    id: 'ai-services',
    name: 'Azure AI Services',
    shortName: 'AI Services',
    category: 'ai-ml',
    iconColor: '#773ADC',
    description: 'Pre-built AI APIs (vision, speech, language)',
    useCases: ['Document intelligence', 'Speech services', 'Language understanding', 'Computer vision'],
    alternatives: ['azure-openai', 'azure-ml'],
    considerations: ['Service-specific SDKs', 'Container deployment for edge', 'Custom model training', 'Pricing per transaction'],
    pricingModel: 'Per API transaction; free tiers available',
    crossCloudEquivalents: { aws: 'Amazon Rekognition / Comprehend / Polly', gcp: 'Cloud Vision / Natural Language / Speech-to-Text' },
  },

  // ── Analytics ─────────────────────────────────────────────────────
  {
    id: 'synapse',
    name: 'Azure Synapse Analytics',
    shortName: 'Synapse',
    category: 'analytics',
    iconColor: '#773ADC',
    description: 'Unified analytics and data warehouse',
    useCases: ['Data warehousing', 'Big data analytics', 'Data integration', 'Spark pools'],
    alternatives: ['data-factory'],
    considerations: ['Dedicated vs serverless SQL pools', 'Spark pools for big data', 'Data integration (similar to Data Factory)', 'Synapse Link for HTAP', 'Workspace security model'],
    pricingModel: 'DWU-based (dedicated) or per TB scanned (serverless)',
    crossCloudEquivalents: { aws: 'Amazon Redshift', gcp: 'BigQuery' },
  },
  {
    id: 'data-factory',
    name: 'Azure Data Factory',
    shortName: 'Data Factory',
    category: 'analytics',
    iconColor: '#773ADC',
    description: 'Cloud ETL and data integration',
    useCases: ['ETL pipelines', 'Data movement', 'Orchestration', 'Data flows'],
    alternatives: ['synapse'],
    considerations: ['Pipeline authoring (visual)', '100+ connectors', 'Integration Runtime (Azure, Self-hosted, SSIS)', 'Mapping Data Flows for transformations', 'Cost optimization with pipeline concurrency'],
    pricingModel: 'Per activity run + data movement + data flow compute',
    crossCloudEquivalents: { aws: 'AWS Glue / Step Functions', gcp: 'Dataflow / Dataproc' },
  },

  // ── Management ──────────────────────────────────────────────────────
  {
    id: 'arm-templates',
    name: 'ARM Templates',
    shortName: 'ARM',
    category: 'management',
    iconColor: '#50E6FF',
    description: 'Infrastructure as Code for Azure',
    useCases: ['IaC templates', 'Resource deployment', 'Policy enforcement'],
    alternatives: ['bicep', 'terraform'],
    considerations: ['JSON-based (verbose)', 'Template specs for sharing', 'What-if deployment preview', 'Nested templates for modularity'],
    pricingModel: 'Free; pay for resources provisioned',
    crossCloudEquivalents: { aws: 'AWS CloudFormation', gcp: 'Deployment Manager' },
  },
  {
    id: 'bicep',
    name: 'Azure Bicep',
    shortName: 'Bicep',
    category: 'management',
    iconColor: '#50E6FF',
    description: 'Declarative IaC language for Azure',
    useCases: ['Type-safe IaC', 'Modular templates', 'ARM abstraction'],
    alternatives: ['arm-templates', 'terraform'],
    considerations: ['Transpiles to ARM (first-class Azure support)', 'VS Code extension with IntelliSense', 'Module registry', 'What-if deployments'],
    pricingModel: 'Free; pay for resources provisioned',
    crossCloudEquivalents: { aws: 'AWS CDK', gcp: 'Terraform / Pulumi' },
  },
  {
    id: 'azure-policy',
    name: 'Azure Policy',
    shortName: 'Policy',
    category: 'management',
    iconColor: '#50E6FF',
    description: 'Governance and compliance policies',
    useCases: ['Compliance enforcement', 'Resource tagging', 'Allowed regions'],
    alternatives: [],
    considerations: ['Built-in vs custom policies', 'Initiative (policy set) grouping', 'Remediation tasks', 'Exemptions for exceptions', 'Integration with Defender for Cloud'],
    pricingModel: 'Free for Azure resources; per-resource pricing for Arc',
    crossCloudEquivalents: { aws: 'AWS Service Control Policies / Config Rules', gcp: 'Organization Policies' },
  },
];

// ---------------------------------------------------------------------------
// Quick lookups
// ---------------------------------------------------------------------------

/** Get Azure service info by service ID */
export function getAzureService(serviceId: string): AzureServiceInfo | null {
  return AZURE_SERVICES.find((s) => s.id === serviceId) ?? null;
}

/** Get all Azure services in a category */
export function getAzureServicesByCategory(category: CloudServiceCategory): AzureServiceInfo[] {
  return AZURE_SERVICES.filter((s) => s.category === category);
}

/** Find Azure services whose use cases match a search term */
export function findAzureServicesForUseCase(useCase: string): AzureServiceInfo[] {
  const lc = useCase.toLowerCase();
  return AZURE_SERVICES.filter((s) =>
    s.useCases.some((uc) => uc.toLowerCase().includes(lc)),
  );
}

