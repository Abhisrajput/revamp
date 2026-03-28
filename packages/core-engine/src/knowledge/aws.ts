/**
 * AWS Service Knowledge Base for REVAMP
 *
 * Comprehensive mapping of AWS services, modernization patterns,
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

export interface AWSServiceInfo {
  /** Stable identifier used in architecture specs and lookups */
  id: string;
  name: string;
  shortName: string;
  category: CloudServiceCategory;
  description: string;
  /** Hex color for icon backgrounds in architecture diagrams */
  iconColor: string;
  useCases: readonly string[];
  /** Alternative AWS services for the same use-case */
  alternatives: readonly string[];
  /** Operational considerations when adopting this service */
  considerations: readonly string[];
  pricingModel: string;
  /** Equivalent services on other clouds: { gcp: string; azure: string } */
  crossCloudEquivalents?: { gcp?: string; azure?: string };
  /** Hard limits worth knowing during migration planning */
  limits?: Record<string, string>;
}

export interface AWSModernizationPattern {
  legacyPattern: string;
  /** Service IDs from the catalog */
  awsServices: readonly string[];
  description: string;
  benefits: readonly string[];
  /** Specific cost tips for this migration path */
  costTips?: readonly string[];
}

export interface AWSArchitecturePattern {
  name: string;
  description: string;
  components: readonly string[];
  considerations: readonly string[];
}

// Architecture diagram node/edge/group types for rendering
export interface AWSArchNode {
  id: string;
  /** AWS service ID from the catalog */
  service: string;
  label: string;
  group?: string;
  x?: number;
  y?: number;
}

export interface AWSArchEdge {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dashed';
}

export interface AWSArchGroup {
  id: string;
  label: string;
  type: 'region' | 'vpc' | 'subnet' | 'az' | 'account' | 'generic';
  color?: string;
}

export interface AWSArchitectureSpec {
  title: string;
  nodes: AWSArchNode[];
  edges: AWSArchEdge[];
  groups: AWSArchGroup[];
}

// ---------------------------------------------------------------------------
// Category colors (for diagram rendering)
// ---------------------------------------------------------------------------

export const AWS_CATEGORY_COLORS: Record<CloudServiceCategory, string> = {
  compute: '#ED7100',
  containers: '#ED7100',
  database: '#3B48CC',
  storage: '#3F8624',
  networking: '#8C4FFF',
  messaging: '#E7157B',
  security: '#DD344C',
  monitoring: '#E7157B',
  'ai-ml': '#01A88D',
  cicd: '#3B48CC',
  analytics: '#8C4FFF',
  integration: '#E7157B',
  management: '#E7157B',
};

// ---------------------------------------------------------------------------
// Service catalog
// ---------------------------------------------------------------------------

export const AWS_SERVICES: AWSServiceInfo[] = [
  // ── Compute ─────────────────────────────────────────────────────────
  {
    id: 'lambda',
    name: 'AWS Lambda',
    shortName: 'Lambda',
    category: 'compute',
    iconColor: '#ED7100',
    description: 'Serverless compute — run code without provisioning servers',
    useCases: ['Event-driven processing', 'API backends', 'Scheduled tasks', 'Stream processing', 'Real-time file processing', 'IoT backends'],
    alternatives: ['ecs', 'ec2', 'app-runner', 'fargate'],
    considerations: ['Cold start latency', 'Timeout limits (15 minutes max)', 'Memory constraints (128 MB-10 GB)', 'State management', 'VPC networking overhead'],
    pricingModel: 'Pay per invocation and execution duration',
    crossCloudEquivalents: { gcp: 'Cloud Functions', azure: 'Azure Functions' },
    limits: { maxTimeout: '15 minutes', maxMemory: '10 GB', maxPayload: '6 MB sync / 256 KB async' },
  },
  {
    id: 'ec2',
    name: 'Amazon EC2',
    shortName: 'EC2',
    category: 'compute',
    iconColor: '#ED7100',
    description: 'Virtual servers in the cloud',
    useCases: ['Legacy app hosting', 'Custom runtimes', 'GPU workloads', 'High-performance computing'],
    alternatives: ['fargate', 'lambda', 'elastic-beanstalk'],
    considerations: ['Instance type selection', 'Spot vs On-Demand vs Reserved', 'AMI management', 'Auto Scaling Groups', 'EBS volume sizing'],
    pricingModel: 'Hourly or per-second billing; Spot/Reserved discounts available',
    crossCloudEquivalents: { gcp: 'Compute Engine', azure: 'Azure Virtual Machines' },
  },
  {
    id: 'fargate',
    name: 'AWS Fargate',
    shortName: 'Fargate',
    category: 'containers',
    iconColor: '#ED7100',
    description: 'Serverless compute for containers',
    useCases: ['Container workloads without managing servers', 'Microservices', 'Batch processing'],
    alternatives: ['ecs', 'eks', 'lambda'],
    considerations: ['No SSH to host', 'Task sizing (vCPU + memory)', 'Cost vs EC2 launch type', 'Ephemeral storage limit'],
    pricingModel: 'Pay per vCPU and memory per second',
    crossCloudEquivalents: { gcp: 'Cloud Run', azure: 'Azure Container Apps' },
  },
  {
    id: 'ecs',
    name: 'Amazon ECS',
    shortName: 'ECS',
    category: 'containers',
    iconColor: '#ED7100',
    description: 'Container orchestration service',
    useCases: ['Docker container management', 'Microservice architectures', 'Batch workloads', 'Long-running services'],
    alternatives: ['eks', 'fargate', 'app-runner'],
    considerations: ['Cluster management complexity', 'Task placement strategies', 'Load balancing setup', 'EC2 vs Fargate launch type', 'Cost optimization'],
    pricingModel: 'Pay for underlying EC2 or Fargate resources',
    crossCloudEquivalents: { gcp: 'Cloud Run / GKE', azure: 'Azure Container Apps' },
  },
  {
    id: 'eks',
    name: 'Amazon EKS',
    shortName: 'EKS',
    category: 'containers',
    iconColor: '#ED7100',
    description: 'Managed Kubernetes service',
    useCases: ['Kubernetes workloads', 'Multi-cloud portability', 'Complex microservice orchestration', 'Hybrid deployments'],
    alternatives: ['ecs', 'fargate', 'app-runner'],
    considerations: ['Kubernetes complexity', 'Management overhead', 'Node scaling strategy (Karpenter)', 'Networking configuration', 'Cost implications'],
    pricingModel: 'Cluster fee ($0.10/hr) + compute resource costs',
    crossCloudEquivalents: { gcp: 'GKE', azure: 'AKS' },
  },
  {
    id: 'app-runner',
    name: 'AWS App Runner',
    shortName: 'App Runner',
    category: 'containers',
    iconColor: '#ED7100',
    description: 'Build and run containerized web apps at scale',
    useCases: ['Simple web apps', 'API services', 'Quick container deployment'],
    alternatives: ['ecs', 'fargate', 'elastic-beanstalk'],
    considerations: ['Limited configuration options', 'Auto-scaling built in', 'Source or image deployment'],
    pricingModel: 'Pay per vCPU and memory per second; provisioned instances available',
    crossCloudEquivalents: { gcp: 'Cloud Run', azure: 'Azure Container Apps' },
  },
  {
    id: 'elastic-beanstalk',
    name: 'AWS Elastic Beanstalk',
    shortName: 'Beanstalk',
    category: 'compute',
    iconColor: '#ED7100',
    description: 'Easy-to-use service for deploying web apps',
    useCases: ['Web applications', 'Legacy app lift-and-shift', 'Auto-scaling apps'],
    alternatives: ['app-runner', 'ecs', 'ec2'],
    considerations: ['Platform version management', 'Environment configuration', 'Deployment policies', 'Customization limits'],
    pricingModel: 'No additional charge; pay for underlying resources',
    crossCloudEquivalents: { gcp: 'App Engine', azure: 'Azure App Service' },
  },

  // ── Database ────────────────────────────────────────────────────────
  {
    id: 'rds',
    name: 'Amazon RDS',
    shortName: 'RDS',
    category: 'database',
    iconColor: '#3B48CC',
    description: 'Managed relational database (PostgreSQL, MySQL, Oracle, SQL Server)',
    useCases: ['Relational data', 'SQL workloads', 'Legacy DB migration', 'OLTP applications', 'Multi-AZ reliability'],
    alternatives: ['aurora', 'dynamodb', 'documentdb'],
    considerations: ['Instance type selection', 'Backup and recovery', 'Read replicas', 'Scaling limitations', 'License costs for commercial engines'],
    pricingModel: 'Hourly instance cost + storage + backup',
    crossCloudEquivalents: { gcp: 'Cloud SQL', azure: 'Azure SQL Database' },
  },
  {
    id: 'aurora',
    name: 'Amazon Aurora',
    shortName: 'Aurora',
    category: 'database',
    iconColor: '#3B48CC',
    description: 'MySQL/PostgreSQL-compatible relational DB with 5x performance',
    useCases: ['High-performance relational', 'Global databases', 'Serverless DB'],
    alternatives: ['rds', 'dynamodb'],
    considerations: ['Aurora Serverless v2 for variable load', 'Global Database for cross-region', 'I/O-Optimized vs Standard pricing', 'Storage auto-scaling'],
    pricingModel: 'Instance hours + I/O + storage; Serverless v2 ACU-based',
    crossCloudEquivalents: { gcp: 'AlloyDB / Cloud Spanner', azure: 'Azure SQL Hyperscale' },
  },
  {
    id: 'dynamodb',
    name: 'Amazon DynamoDB',
    shortName: 'DynamoDB',
    category: 'database',
    iconColor: '#3B48CC',
    description: 'Serverless NoSQL key-value and document database',
    useCases: ['High-scale NoSQL', 'Session stores', 'IoT data', 'Gaming leaderboards', 'Real-time applications'],
    alternatives: ['rds', 'documentdb', 'elasticache'],
    considerations: ['Partition key design', 'Eventual vs strong consistency', 'Query limitations (single-table design)', 'On-demand vs provisioned capacity', 'Cost at scale'],
    pricingModel: 'Provisioned or on-demand capacity units + storage',
    crossCloudEquivalents: { gcp: 'Firestore / Bigtable', azure: 'Cosmos DB' },
  },
  {
    id: 'elasticache',
    name: 'Amazon ElastiCache',
    shortName: 'ElastiCache',
    category: 'database',
    iconColor: '#3B48CC',
    description: 'In-memory caching (Redis, Memcached)',
    useCases: ['Session caching', 'Real-time analytics', 'Message queues', 'Leaderboards'],
    alternatives: ['dynamodb', 'memorydb'],
    considerations: ['Redis vs Memcached', 'Cluster mode', 'Failover behavior', 'Data persistence'],
    pricingModel: 'Node hours based on instance type',
    crossCloudEquivalents: { gcp: 'Memorystore', azure: 'Azure Cache for Redis' },
  },
  {
    id: 'documentdb',
    name: 'Amazon DocumentDB',
    shortName: 'DocumentDB',
    category: 'database',
    iconColor: '#3B48CC',
    description: 'MongoDB-compatible document database',
    useCases: ['Document storage', 'Content management', 'User profiles'],
    alternatives: ['dynamodb', 'rds'],
    considerations: ['MongoDB compatibility level', 'Instance-based pricing', 'Cluster scaling'],
    pricingModel: 'Instance hours + storage + I/O',
    crossCloudEquivalents: { gcp: 'Firestore', azure: 'Cosmos DB (MongoDB API)' },
  },
  {
    id: 'neptune',
    name: 'Amazon Neptune',
    shortName: 'Neptune',
    category: 'database',
    iconColor: '#3B48CC',
    description: 'Graph database for connected data',
    useCases: ['Social networks', 'Knowledge graphs', 'Fraud detection'],
    alternatives: ['dynamodb', 'rds'],
    considerations: ['Gremlin vs SPARQL', 'Instance sizing', 'Read replicas'],
    pricingModel: 'Instance hours + storage + I/O',
    crossCloudEquivalents: { azure: 'Cosmos DB (Gremlin API)' },
  },
  {
    id: 'redshift',
    name: 'Amazon Redshift',
    shortName: 'Redshift',
    category: 'analytics',
    iconColor: '#8C4FFF',
    description: 'Cloud data warehouse',
    useCases: ['Data warehousing', 'BI analytics', 'Large-scale reporting'],
    alternatives: ['athena', 's3'],
    considerations: ['Cluster sizing', 'Distribution keys', 'Concurrency scaling', 'RA3 vs DC2 nodes', 'Redshift Serverless option'],
    pricingModel: 'Node hours + storage; Serverless: per RPU-hour',
    crossCloudEquivalents: { gcp: 'BigQuery', azure: 'Azure Synapse Analytics' },
  },

  // ── Storage ─────────────────────────────────────────────────────────
  {
    id: 's3',
    name: 'Amazon S3',
    shortName: 'S3',
    category: 'storage',
    iconColor: '#3F8624',
    description: 'Object storage with 99.999999999% durability',
    useCases: ['Static assets', 'Data lakes', 'Backups', 'Log storage', 'Static website hosting'],
    alternatives: ['efs', 'ebs', 'glacier'],
    considerations: ['Storage class selection (Standard/IA/Glacier)', 'Lifecycle policies', 'Versioning and replication', 'Access control (bucket policies, ACLs)', 'Cost optimization'],
    pricingModel: 'Storage per GB + requests + data transfer',
    crossCloudEquivalents: { gcp: 'Cloud Storage', azure: 'Azure Blob Storage' },
  },
  {
    id: 'efs',
    name: 'Amazon EFS',
    shortName: 'EFS',
    category: 'storage',
    iconColor: '#3F8624',
    description: 'Elastic file system for Linux workloads',
    useCases: ['Shared file storage', 'CMS content', 'Container storage'],
    alternatives: ['s3', 'ebs', 'fsx'],
    considerations: ['Performance mode (General Purpose vs Max I/O)', 'Throughput mode', 'Cost vs EBS for single-instance use'],
    pricingModel: 'Per GB-month; Infrequent Access tier available',
    crossCloudEquivalents: { gcp: 'Filestore', azure: 'Azure Files' },
  },
  {
    id: 'ebs',
    name: 'Amazon EBS',
    shortName: 'EBS',
    category: 'storage',
    iconColor: '#3F8624',
    description: 'Block storage for EC2 instances',
    useCases: ['Database storage', 'Boot volumes', 'High-IOPS workloads'],
    alternatives: ['efs', 's3'],
    considerations: ['Volume type (gp3, io2, st1, sc1)', 'Snapshot management', 'IOPS provisioning', 'Multi-attach'],
    pricingModel: 'Per GB-month + provisioned IOPS',
    crossCloudEquivalents: { gcp: 'Persistent Disk', azure: 'Azure Managed Disks' },
  },

  // ── Networking ──────────────────────────────────────────────────────
  {
    id: 'vpc',
    name: 'Amazon VPC',
    shortName: 'VPC',
    category: 'networking',
    iconColor: '#8C4FFF',
    description: 'Isolated cloud networking',
    useCases: ['Network isolation', 'Subnets', 'Security groups', 'VPN'],
    alternatives: [],
    considerations: ['CIDR planning', 'Public vs private subnets', 'NAT Gateway costs', 'VPC peering vs Transit Gateway'],
    pricingModel: 'No charge for VPC; NAT Gateway/VPN charged separately',
    crossCloudEquivalents: { gcp: 'VPC', azure: 'Azure VNet' },
  },
  {
    id: 'alb',
    name: 'Elastic Load Balancer',
    shortName: 'ALB',
    category: 'networking',
    iconColor: '#8C4FFF',
    description: 'Application and network load balancing',
    useCases: ['Traffic distribution', 'SSL termination', 'Path-based routing', 'Host-based routing', 'WebSocket support'],
    alternatives: ['nlb', 'cloudfront'],
    considerations: ['Target group configuration', 'Health checks', 'SSL/TLS certificates', 'Sticky sessions', 'LCU pricing'],
    pricingModel: 'Hourly charge + LCU pricing',
    crossCloudEquivalents: { gcp: 'Cloud Load Balancing', azure: 'Azure Application Gateway' },
  },
  {
    id: 'cloudfront',
    name: 'Amazon CloudFront',
    shortName: 'CloudFront',
    category: 'networking',
    iconColor: '#8C4FFF',
    description: 'Global CDN for low-latency content delivery',
    useCases: ['Static assets', 'API acceleration', 'Video streaming', 'DDoS protection'],
    alternatives: ['alb'],
    considerations: ['Cache control', 'Invalidation strategy', 'Origin setup (S3, ALB, custom)', 'WAF integration', 'Cost optimization'],
    pricingModel: 'Data transfer out + requests; free tier available',
    crossCloudEquivalents: { gcp: 'Cloud CDN', azure: 'Azure Front Door' },
  },
  {
    id: 'route53',
    name: 'Amazon Route 53',
    shortName: 'Route 53',
    category: 'networking',
    iconColor: '#8C4FFF',
    description: 'Scalable DNS and domain management',
    useCases: ['DNS routing', 'Health checks', 'Failover', 'Domain registration'],
    alternatives: [],
    considerations: ['Routing policies (weighted, latency, geolocation)', 'Health check interval', 'Alias records for AWS resources'],
    pricingModel: 'Per hosted zone + per million queries',
    crossCloudEquivalents: { gcp: 'Cloud DNS', azure: 'Azure DNS' },
  },
  {
    id: 'api-gateway',
    name: 'Amazon API Gateway',
    shortName: 'API Gateway',
    category: 'networking',
    iconColor: '#8C4FFF',
    description: 'Managed REST, HTTP, and WebSocket APIs',
    useCases: ['API management', 'Rate limiting', 'Auth integration', 'Request transformation'],
    alternatives: ['alb'],
    considerations: ['REST vs HTTP API (cost difference)', 'Throttling and quota', 'Custom authorizers', 'Integration timeout (29 s)'],
    pricingModel: 'Per million API calls + data transfer',
    crossCloudEquivalents: { gcp: 'Apigee / Cloud Endpoints', azure: 'Azure API Management' },
    limits: { integrationTimeout: '29 seconds', maxPayload: '10 MB' },
  },

  // ── Messaging & Integration ─────────────────────────────────────────
  {
    id: 'sqs',
    name: 'Amazon SQS',
    shortName: 'SQS',
    category: 'messaging',
    iconColor: '#E7157B',
    description: 'Fully managed message queuing',
    useCases: ['Decoupling microservices', 'Task queues', 'Buffer writes', 'Event processing', 'Work distribution'],
    alternatives: ['sns', 'kinesis', 'eventbridge', 'mq'],
    considerations: ['FIFO vs Standard', 'Message retention (up to 14 days)', 'Visibility timeout tuning', 'Dead letter queues', 'Scaling characteristics'],
    pricingModel: 'Pay per million requests',
    crossCloudEquivalents: { gcp: 'Cloud Tasks', azure: 'Azure Queue Storage / Service Bus' },
  },
  {
    id: 'sns',
    name: 'Amazon SNS',
    shortName: 'SNS',
    category: 'messaging',
    iconColor: '#E7157B',
    description: 'Pub/sub messaging and mobile notifications',
    useCases: ['Fan-out patterns', 'Push notifications', 'Email/SMS alerts', 'Multi-destination notifications'],
    alternatives: ['sqs', 'eventbridge'],
    considerations: ['Topic management', 'Subscription filtering', 'Message ordering', 'Delivery guarantees', 'Retry policies'],
    pricingModel: 'Per million requests + delivery costs (SMS, email)',
    crossCloudEquivalents: { gcp: 'Pub/Sub', azure: 'Azure Service Bus Topics' },
  },
  {
    id: 'eventbridge',
    name: 'Amazon EventBridge',
    shortName: 'EventBridge',
    category: 'messaging',
    iconColor: '#E7157B',
    description: 'Serverless event bus for application integration',
    useCases: ['Event-driven architecture', 'SaaS integration', 'CQRS event bus', 'Cross-service communication', 'Scheduled rules'],
    alternatives: ['sns', 'sqs'],
    considerations: ['Event schema registry', 'Content-based filtering', 'Archive and replay', 'Cross-account routing'],
    pricingModel: 'Per million events published',
    crossCloudEquivalents: { gcp: 'Eventarc', azure: 'Azure Event Grid' },
  },
  {
    id: 'kinesis',
    name: 'Amazon Kinesis',
    shortName: 'Kinesis',
    category: 'messaging',
    iconColor: '#E7157B',
    description: 'Real-time data streaming',
    useCases: ['Log streaming', 'Click streams', 'IoT telemetry', 'Real-time analytics'],
    alternatives: ['sqs', 'eventbridge'],
    considerations: ['Shard capacity planning', 'Enhanced fan-out', 'Retention period (up to 365 days)', 'Kinesis Data Firehose for delivery'],
    pricingModel: 'Per shard hour + per PUT payload unit',
    crossCloudEquivalents: { gcp: 'Pub/Sub', azure: 'Azure Event Hubs' },
  },
  {
    id: 'mq',
    name: 'Amazon MQ',
    shortName: 'Amazon MQ',
    category: 'messaging',
    iconColor: '#E7157B',
    description: 'Managed message broker (ActiveMQ, RabbitMQ)',
    useCases: ['Legacy JMS migration', 'AMQP workloads', 'MQTT IoT'],
    alternatives: ['sqs', 'sns'],
    considerations: ['ActiveMQ vs RabbitMQ engine', 'Instance sizing', 'Network connectivity', 'Protocol compatibility'],
    pricingModel: 'Instance hours + storage',
    crossCloudEquivalents: { azure: 'Azure Service Bus' },
  },
  {
    id: 'step-functions',
    name: 'AWS Step Functions',
    shortName: 'Step Functions',
    category: 'integration',
    iconColor: '#E7157B',
    description: 'Visual workflow orchestration',
    useCases: ['Saga patterns', 'ETL pipelines', 'Order processing', 'Approval workflows'],
    alternatives: ['lambda', 'eventbridge'],
    considerations: ['Standard vs Express workflows', 'State payload limits (256 KB)', 'Error handling strategies', 'Cost at high volume (Express cheaper)'],
    pricingModel: 'Per state transition (Standard) or per request + duration (Express)',
    crossCloudEquivalents: { gcp: 'Workflows', azure: 'Durable Functions / Logic Apps' },
  },

  // ── Security ────────────────────────────────────────────────────────
  {
    id: 'iam',
    name: 'AWS IAM',
    shortName: 'IAM',
    category: 'security',
    iconColor: '#DD344C',
    description: 'Identity and access management',
    useCases: ['Access control', 'Role-based permissions', 'Service-to-service auth'],
    alternatives: [],
    considerations: ['Least privilege principle', 'Policy evaluation logic', 'Service control policies (SCPs)', 'IAM Identity Center for SSO'],
    pricingModel: 'Free',
    crossCloudEquivalents: { gcp: 'Cloud IAM', azure: 'Microsoft Entra ID' },
  },
  {
    id: 'cognito',
    name: 'Amazon Cognito',
    shortName: 'Cognito',
    category: 'security',
    iconColor: '#DD344C',
    description: 'User authentication and authorization',
    useCases: ['User sign-up/sign-in', 'Social login', 'MFA', 'OAuth/OIDC'],
    alternatives: ['iam'],
    considerations: ['User pools vs Identity pools', 'Custom auth flows', 'Lambda triggers for customization', 'Pricing tiers'],
    pricingModel: 'Per monthly active user',
    crossCloudEquivalents: { gcp: 'Identity Platform', azure: 'Microsoft Entra ID B2C' },
  },
  {
    id: 'kms',
    name: 'AWS KMS',
    shortName: 'KMS',
    category: 'security',
    iconColor: '#DD344C',
    description: 'Key management and encryption',
    useCases: ['Data encryption', 'Key rotation', 'Envelope encryption', 'Compliance requirements'],
    alternatives: ['secrets-manager'],
    considerations: ['Key policies', 'Automatic key rotation (annual)', 'Audit logging via CloudTrail', 'Performance overhead', 'Cost per API call'],
    pricingModel: 'Monthly key cost ($1/key) + API call charges',
    crossCloudEquivalents: { gcp: 'Cloud KMS', azure: 'Azure Key Vault' },
  },
  {
    id: 'secrets-manager',
    name: 'AWS Secrets Manager',
    shortName: 'Secrets Mgr',
    category: 'security',
    iconColor: '#DD344C',
    description: 'Secrets rotation and management',
    useCases: ['DB credentials', 'API keys', 'Certificate management', 'Automatic rotation'],
    alternatives: ['kms', 'ssm'],
    considerations: ['Rotation strategy', 'Access policies', 'Encryption with KMS', 'Cost per secret ($0.40/mo)', 'SSM Parameter Store as cheaper alternative'],
    pricingModel: 'Per-secret monthly cost + API calls',
    crossCloudEquivalents: { gcp: 'Secret Manager', azure: 'Azure Key Vault' },
  },
  {
    id: 'waf',
    name: 'AWS WAF',
    shortName: 'WAF',
    category: 'security',
    iconColor: '#DD344C',
    description: 'Web application firewall',
    useCases: ['SQL injection protection', 'XSS prevention', 'Rate limiting', 'Bot control'],
    alternatives: [],
    considerations: ['Managed rule groups', 'Custom rules', 'Integration with CloudFront/ALB/API Gateway', 'Logging to S3/CloudWatch'],
    pricingModel: 'Per web ACL + per rule + per million requests',
    crossCloudEquivalents: { gcp: 'Cloud Armor', azure: 'Azure WAF' },
  },
  {
    id: 'acm',
    name: 'AWS Certificate Manager',
    shortName: 'ACM',
    category: 'security',
    iconColor: '#DD344C',
    description: 'SSL/TLS certificate provisioning',
    useCases: ['HTTPS endpoints', 'Certificate auto-renewal'],
    alternatives: [],
    considerations: ['DNS vs email validation', 'Regional certificates for ALB, global for CloudFront', 'No charge for public certificates'],
    pricingModel: 'Free for public certificates; private CA charged',
    crossCloudEquivalents: { gcp: 'Certificate Manager', azure: 'Azure App Service Certificates' },
  },

  // ── Monitoring & Observability ──────────────────────────────────────
  {
    id: 'cloudwatch',
    name: 'Amazon CloudWatch',
    shortName: 'CloudWatch',
    category: 'monitoring',
    iconColor: '#E7157B',
    description: 'Monitoring, logging, and alerting',
    useCases: ['Metrics collection', 'Log aggregation', 'Alarms', 'Dashboards', 'Log analysis'],
    alternatives: ['xray'],
    considerations: ['Retention policies', 'Metric resolution (standard 1 min, high-res 1 s)', 'Log ingestion costs', 'Insights query costs', 'Embedded Metric Format'],
    pricingModel: 'Per metric, per GB ingested, per alarm, per query GB scanned',
    crossCloudEquivalents: { gcp: 'Cloud Monitoring + Cloud Logging', azure: 'Azure Monitor + Log Analytics' },
  },
  {
    id: 'xray',
    name: 'AWS X-Ray',
    shortName: 'X-Ray',
    category: 'monitoring',
    iconColor: '#E7157B',
    description: 'Distributed tracing for microservices',
    useCases: ['Request tracing', 'Latency analysis', 'Error debugging', 'Service map visualization'],
    alternatives: ['cloudwatch'],
    considerations: ['SDK integration effort', 'Sampling strategies', 'Trace retention (30 days)', 'Integration with CloudWatch ServiceLens'],
    pricingModel: 'Per million traced requests + per million traces scanned',
    crossCloudEquivalents: { gcp: 'Cloud Trace', azure: 'Application Insights' },
  },
  {
    id: 'cloudtrail',
    name: 'AWS CloudTrail',
    shortName: 'CloudTrail',
    category: 'monitoring',
    iconColor: '#E7157B',
    description: 'API activity logging and auditing',
    useCases: ['Compliance auditing', 'Security analysis', 'Change tracking'],
    alternatives: [],
    considerations: ['Management vs data events', 'Multi-region trails', 'S3 delivery costs', 'Integration with Athena for querying'],
    pricingModel: 'First trail free; additional trails per 100K events',
    crossCloudEquivalents: { gcp: 'Cloud Audit Logs', azure: 'Azure Activity Log' },
  },

  // ── CI/CD ───────────────────────────────────────────────────────────
  {
    id: 'codepipeline',
    name: 'AWS CodePipeline',
    shortName: 'CodePipeline',
    category: 'cicd',
    iconColor: '#3B48CC',
    description: 'Continuous delivery pipeline',
    useCases: ['Build-test-deploy automation', 'Multi-stage pipelines'],
    alternatives: ['codebuild'],
    considerations: ['Pipeline structure design', 'Approval actions', 'Cross-region deployments', 'Integration with GitHub/Bitbucket'],
    pricingModel: 'Per active pipeline per month',
    crossCloudEquivalents: { gcp: 'Cloud Build + Cloud Deploy', azure: 'Azure DevOps Pipelines' },
  },
  {
    id: 'codebuild',
    name: 'AWS CodeBuild',
    shortName: 'CodeBuild',
    category: 'cicd',
    iconColor: '#3B48CC',
    description: 'Fully managed build service',
    useCases: ['Docker builds', 'Unit/integration testing', 'Artifact generation'],
    alternatives: ['codepipeline'],
    considerations: ['Build environment selection', 'Caching strategy', 'Buildspec.yml configuration', 'Concurrency limits'],
    pricingModel: 'Per build minute based on compute type',
    crossCloudEquivalents: { gcp: 'Cloud Build', azure: 'Azure DevOps Pipelines' },
  },
  {
    id: 'codedeploy',
    name: 'AWS CodeDeploy',
    shortName: 'CodeDeploy',
    category: 'cicd',
    iconColor: '#3B48CC',
    description: 'Automated deployment service',
    useCases: ['Blue/green deployments', 'Canary releases', 'Rolling updates'],
    alternatives: ['codepipeline'],
    considerations: ['Deployment group configuration', 'Rollback policies', 'Traffic shifting strategies', 'AppSpec file'],
    pricingModel: 'Free for EC2/Lambda deployments',
    crossCloudEquivalents: { gcp: 'Cloud Deploy', azure: 'Azure DevOps Release' },
  },
  {
    id: 'ecr',
    name: 'Amazon ECR',
    shortName: 'ECR',
    category: 'containers',
    iconColor: '#ED7100',
    description: 'Docker container registry',
    useCases: ['Container image storage', 'Image scanning', 'Cross-region replication'],
    alternatives: [],
    considerations: ['Lifecycle policies for cleanup', 'Image scanning on push', 'Private vs public repos', 'Cross-account access'],
    pricingModel: 'Per GB storage + data transfer',
    crossCloudEquivalents: { gcp: 'Artifact Registry', azure: 'Azure Container Registry' },
  },

  // ── AI/ML ───────────────────────────────────────────────────────────
  {
    id: 'bedrock',
    name: 'Amazon Bedrock',
    shortName: 'Bedrock',
    category: 'ai-ml',
    iconColor: '#01A88D',
    description: 'Foundation models as a service',
    useCases: ['Generative AI', 'Text generation', 'Code assistance', 'RAG applications'],
    alternatives: ['sagemaker'],
    considerations: ['Model selection (Claude, Llama, Titan)', 'Provisioned throughput', 'Knowledge bases integration', 'Guardrails configuration'],
    pricingModel: 'Per 1K input/output tokens; provisioned throughput available',
    crossCloudEquivalents: { gcp: 'Vertex AI / Gemini API', azure: 'Azure OpenAI Service' },
  },
  {
    id: 'sagemaker',
    name: 'Amazon SageMaker',
    shortName: 'SageMaker',
    category: 'ai-ml',
    iconColor: '#01A88D',
    description: 'ML model training and deployment',
    useCases: ['Model training', 'ML inference', 'MLOps pipelines'],
    alternatives: ['bedrock'],
    considerations: ['Instance selection for training', 'Endpoint auto-scaling', 'SageMaker Studio notebooks', 'Feature Store'],
    pricingModel: 'Instance hours for training and hosting',
    crossCloudEquivalents: { gcp: 'Vertex AI', azure: 'Azure Machine Learning' },
  },

  // ── Analytics ─────────────────────────────────────────────────────
  // Redshift listed above under database/analytics

  // ── Management ──────────────────────────────────────────────────────
  {
    id: 'cloudformation',
    name: 'AWS CloudFormation',
    shortName: 'CloudFormation',
    category: 'management',
    iconColor: '#E7157B',
    description: 'Infrastructure as Code',
    useCases: ['IaC templates', 'Stack management', 'Drift detection'],
    alternatives: ['cdk', 'terraform'],
    considerations: ['Template size limits', 'Stack update strategies', 'Rollback behavior', 'StackSets for multi-account'],
    pricingModel: 'Free; pay for resources provisioned',
    crossCloudEquivalents: { gcp: 'Deployment Manager', azure: 'ARM Templates' },
  },
  {
    id: 'cdk',
    name: 'AWS CDK',
    shortName: 'CDK',
    category: 'management',
    iconColor: '#E7157B',
    description: 'Define cloud infrastructure using programming languages',
    useCases: ['TypeScript IaC', 'Python IaC', 'Reusable constructs'],
    alternatives: ['cloudformation', 'terraform'],
    considerations: ['Construct library maturity', 'Synthesize to CloudFormation', 'L1 vs L2 vs L3 constructs', 'Testing with assertions'],
    pricingModel: 'Free; pay for resources provisioned',
    crossCloudEquivalents: { gcp: 'Pulumi / Terraform', azure: 'Bicep / Pulumi' },
  },
  {
    id: 'ssm',
    name: 'AWS Systems Manager',
    shortName: 'SSM',
    category: 'management',
    iconColor: '#E7157B',
    description: 'Operational management for AWS resources',
    useCases: ['Parameter store', 'Patch management', 'Session manager', 'Run command'],
    alternatives: ['secrets-manager'],
    considerations: ['Parameter Store free tier (standard)', 'Session Manager as SSH replacement', 'Automation runbooks'],
    pricingModel: 'Free for most features; advanced Parameter Store $0.05/param/mo',
    crossCloudEquivalents: { azure: 'Azure Automation' },
  },
];

// ---------------------------------------------------------------------------
// Quick lookups
// ---------------------------------------------------------------------------

/** Map from service ID to full service info */
export const AWS_SERVICE_MAP = new Map(AWS_SERVICES.map((s) => [s.id, s]));

/** Get AWS service info by service ID */
export function getAWSService(serviceId: string): AWSServiceInfo | null {
  return AWS_SERVICE_MAP.get(serviceId) ?? null;
}

/** Get all AWS services in a category */
export function getAWSServicesByCategory(category: CloudServiceCategory): AWSServiceInfo[] {
  return AWS_SERVICES.filter((s) => s.category === category);
}

/** Find AWS services whose use cases match a search term */
export function findAWSServicesForUseCase(useCase: string): AWSServiceInfo[] {
  const lc = useCase.toLowerCase();
  return AWS_SERVICES.filter((s) =>
    s.useCases.some((uc) => uc.toLowerCase().includes(lc)),
  );
}

// ---------------------------------------------------------------------------
// Legacy -> AWS modernization patterns
// ---------------------------------------------------------------------------

export const AWS_MODERNIZATION_PATTERNS: AWSModernizationPattern[] = [
  {
    legacyPattern: 'On-premises relational database (Oracle, SQL Server, MySQL)',
    awsServices: ['rds', 'aurora'],
    description: 'Migrate to Amazon RDS or Aurora for managed relational databases with automated backups, patching, and Multi-AZ failover.',
    benefits: ['No server management', 'Automated backups', 'Multi-AZ high availability', '5x performance with Aurora'],
    costTips: ['Use Reserved Instances for predictable workloads (up to 69% savings)', 'Aurora Serverless v2 for variable traffic', 'Right-size instances with Performance Insights'],
  },
  {
    legacyPattern: 'Monolithic application server (WebSphere, JBoss, Tomcat)',
    awsServices: ['ecs', 'fargate', 'alb'],
    description: 'Containerize the monolith and deploy on ECS/Fargate behind an ALB. Use strangler fig pattern to extract microservices incrementally.',
    benefits: ['No server management with Fargate', 'Auto-scaling', 'Rolling deployments', 'Path-based routing via ALB'],
    costTips: ['Start with Fargate Spot for non-critical workloads', 'Use ECS Capacity Providers for mixed Spot/On-Demand', 'Right-size task definitions'],
  },
  {
    legacyPattern: 'Batch processing / Cron jobs',
    awsServices: ['lambda', 'step-functions', 'eventbridge'],
    description: 'Replace cron-based batch jobs with EventBridge scheduled rules triggering Lambda functions or Step Functions workflows.',
    benefits: ['Pay-per-execution', 'Built-in retry/error handling', 'Visual workflow monitoring', 'No idle compute costs'],
    costTips: ['Use Step Functions Express for high-volume short workflows', 'Arm64 Lambda for 20% cost reduction', 'Optimize memory to find cost sweet spot'],
  },
  {
    legacyPattern: 'Message queue (IBM MQ, RabbitMQ, ActiveMQ)',
    awsServices: ['sqs', 'sns', 'mq'],
    description: 'For JMS/AMQP compatibility use Amazon MQ. For new designs, use SQS (point-to-point) + SNS (pub/sub) for fully managed messaging.',
    benefits: ['Unlimited throughput with SQS', 'No broker management', 'Dead letter queues', 'Fan-out with SNS'],
    costTips: ['SQS long polling reduces empty receives', 'Batch send/receive for throughput and cost', 'SNS message filtering to reduce downstream costs'],
  },
  {
    legacyPattern: 'File server / NAS / shared storage',
    awsServices: ['s3', 'efs'],
    description: 'Migrate file shares to S3 for object storage or EFS for POSIX-compatible shared filesystems.',
    benefits: ['99.999999999% durability', 'Automatic scaling', 'Lifecycle policies', 'Versioning'],
    costTips: ['S3 Intelligent-Tiering for unknown access patterns', 'EFS Infrequent Access for cold data', 'Lifecycle rules to move to Glacier after 90 days'],
  },
  {
    legacyPattern: 'Monolithic frontend (JSP, ASP.NET, PHP templates)',
    awsServices: ['cloudfront', 's3', 'api-gateway'],
    description: 'Rebuild as a SPA (React/Vue/Angular) hosted on S3 + CloudFront CDN with API Gateway for backend APIs.',
    benefits: ['Global CDN distribution', 'Instant scaling', 'Cache at edge', 'API management'],
    costTips: ['CloudFront free tier includes 1 TB transfer', 'Use HTTP API instead of REST API for 71% savings', 'Enable compression for reduced transfer costs'],
  },
  {
    legacyPattern: 'In-memory cache (local, Memcached, Redis)',
    awsServices: ['elasticache'],
    description: 'Migrate to Amazon ElastiCache for managed Redis or Memcached with automatic failover and scaling.',
    benefits: ['Sub-millisecond latency', 'Auto-failover', 'Cluster mode', 'Backup/restore'],
    costTips: ['Use Reserved Nodes for 30-55% savings', 'Right-size with CloudWatch metrics', 'Consider Graviton (r7g) nodes for better price-performance'],
  },
  {
    legacyPattern: 'Custom authentication / LDAP / Active Directory',
    awsServices: ['cognito', 'iam'],
    description: 'Replace custom auth with Amazon Cognito for user pools with built-in MFA, social login, and OIDC/SAML federation.',
    benefits: ['Built-in MFA', 'Social login', 'Standards-based (OAuth2/OIDC)', 'Adaptive authentication'],
    costTips: ['First 50K MAU free', 'Use Cognito groups instead of per-user attribute lookups'],
  },
  {
    legacyPattern: 'SOAP / XML web services',
    awsServices: ['api-gateway', 'lambda'],
    description: 'Wrap legacy SOAP services behind API Gateway with Lambda transformers converting XML to JSON. Gradually replace with REST/GraphQL.',
    benefits: ['Protocol translation', 'Rate limiting', 'API versioning', 'Usage analytics'],
    costTips: ['HTTP API for simple proxy (lower cost than REST API)', 'Cache responses at API Gateway to reduce Lambda invocations'],
  },
  {
    legacyPattern: 'ETL pipelines / Data warehouse',
    awsServices: ['step-functions', 'lambda', 'redshift', 's3'],
    description: 'Replace legacy ETL with Step Functions orchestrating Lambda for transformation, S3 as data lake, and Redshift for analytics.',
    benefits: ['Serverless ETL', 'Visual pipeline monitoring', 'Petabyte-scale analytics', 'Separation of storage and compute'],
    costTips: ['Redshift Serverless for intermittent analytics', 'S3 as staging area to decouple ingest from analysis', 'Use Redshift Spectrum to query S3 directly'],
  },
  {
    legacyPattern: 'VM-based deployment / manual ops',
    awsServices: ['codepipeline', 'codebuild', 'codedeploy', 'ecr'],
    description: 'Implement CI/CD pipeline with CodePipeline, CodeBuild, ECR, and CodeDeploy with blue/green deployment strategy.',
    benefits: ['Automated deployments', 'Blue/green with rollback', 'Build caching', 'Deployment approval gates'],
    costTips: ['CodePipeline V2 for pay-per-action pricing', 'CodeBuild caching to reduce build minutes', 'ECR lifecycle policies to prune old images'],
  },
  {
    legacyPattern: 'Mainframe / COBOL / AS/400',
    awsServices: ['lambda', 'api-gateway', 'dynamodb', 'step-functions', 'sqs'],
    description: 'Decompose mainframe transactions into microservices using API Gateway + Lambda. Use DynamoDB for high-throughput data and Step Functions for transaction orchestration.',
    benefits: ['Incremental migration', 'Pay-per-transaction', 'Horizontal scaling', 'Modern API surface'],
    costTips: ['DynamoDB on-demand mode during migration (switch to provisioned later)', 'Lambda Provisioned Concurrency only for latency-critical paths'],
  },
  {
    legacyPattern: 'Monitoring / logging (Nagios, ELK, Splunk)',
    awsServices: ['cloudwatch', 'xray', 'cloudtrail'],
    description: 'Consolidate monitoring on CloudWatch (metrics + logs + alarms), X-Ray for distributed tracing, and CloudTrail for audit logging.',
    benefits: ['Unified observability', 'Automatic log collection', 'Distributed tracing', 'Compliance auditing'],
    costTips: ['Use CloudWatch Logs Insights instead of streaming to ElasticSearch', 'Set log retention to reduce storage costs', 'X-Ray sampling to control trace volume'],
  },
  {
    legacyPattern: 'Event-driven architecture / ESB',
    awsServices: ['eventbridge', 'sns', 'sqs', 'step-functions'],
    description: 'Replace enterprise service bus with EventBridge as the central event router, SNS for pub/sub, SQS for buffering, and Step Functions for orchestration.',
    benefits: ['Schema registry', 'Event replay', 'Cross-account routing', 'SaaS integration'],
    costTips: ['EventBridge archive selectively (not all events)', 'SQS long polling', 'Step Functions Express for high-volume workflows'],
  },
  {
    legacyPattern: 'Static infrastructure / manual provisioning',
    awsServices: ['cloudformation', 'cdk'],
    description: 'Define all infrastructure as code using CloudFormation templates or AWS CDK for type-safe infrastructure definitions.',
    benefits: ['Repeatable deployments', 'Version-controlled infra', 'Drift detection', 'Multi-environment consistency'],
    costTips: ['No cost for IaC tools themselves', 'Use CDK aspects to enforce tagging/compliance', 'StackSets for multi-account governance'],
  },
];

// ---------------------------------------------------------------------------
// Architecture patterns (high-level blueprints)
// ---------------------------------------------------------------------------

export const AWS_ARCHITECTURE_PATTERNS: AWSArchitecturePattern[] = [
  {
    name: 'Microservices on AWS',
    description: 'Deploy microservices using ECS, EKS, or Lambda behind ALB/API Gateway',
    components: ['ecs', 'eks', 'alb', 'api-gateway', 'rds', 'dynamodb', 'sqs', 'sns'],
    considerations: ['Service discovery (Cloud Map)', 'API Gateway for external-facing APIs', 'Inter-service communication (sync vs async)', 'Shared data patterns', 'Deployment automation with CodePipeline'],
  },
  {
    name: 'Serverless Applications',
    description: 'Event-driven serverless architecture with zero server management',
    components: ['lambda', 'api-gateway', 'dynamodb', 's3', 'sns', 'sqs', 'step-functions'],
    considerations: ['Cold start mitigation', 'Duration limits (15 min)', 'State management via DynamoDB/Step Functions', 'Scaling characteristics', 'Cost monitoring at scale'],
  },
  {
    name: 'Data Lake on AWS',
    description: 'Store and analyze large-scale data with separation of storage and compute',
    components: ['s3', 'redshift', 'kinesis', 'lambda', 'cloudwatch'],
    considerations: ['Data partitioning (Hive-style)', 'Metadata catalog (Glue)', 'Access controls (Lake Formation)', 'Cost optimization (storage classes)', 'Query performance (columnar formats)'],
  },
  {
    name: 'Event-Driven Architecture',
    description: 'Loosely coupled event-driven systems using managed messaging',
    components: ['eventbridge', 'sqs', 'sns', 'kinesis', 'lambda', 'step-functions'],
    considerations: ['Event schema design', 'Retry and dead-letter strategies', 'Event ordering guarantees', 'Consumer scaling patterns', 'Observability across event flows'],
  },
];

// ---------------------------------------------------------------------------
// Cost optimization tips (general AWS)
// ---------------------------------------------------------------------------

export const AWS_COST_OPTIMIZATION_TIPS: string[] = [
  'Use Savings Plans or Reserved Instances for predictable workloads (up to 72% savings)',
  'Enable S3 Intelligent-Tiering for objects with unknown access patterns',
  'Right-size EC2 instances using AWS Compute Optimizer',
  'Use Spot Instances for fault-tolerant workloads (up to 90% savings)',
  'Delete unused EBS volumes, snapshots, and Elastic IPs',
  'Set CloudWatch Logs retention policies (default is forever)',
  'Use Graviton (Arm64) instances for 20-40% better price-performance',
  'Enable DynamoDB auto-scaling or on-demand mode to avoid over-provisioning',
  'Use NAT Gateway endpoints for S3/DynamoDB to avoid data transfer charges',
  'Consolidate accounts under AWS Organizations for volume discounts',
];

// ---------------------------------------------------------------------------
// Prompt context builder — inject into modernization stages
// ---------------------------------------------------------------------------

export function buildAWSKnowledgeContext(): string {
  const byCategory = new Map<string, string[]>();
  for (const s of AWS_SERVICES) {
    const list = byCategory.get(s.category) || [];
    list.push(`${s.id} (${s.shortName})`);
    byCategory.set(s.category, list);
  }
  const serviceCatalog = Array.from(byCategory.entries())
    .map(([cat, svcs]) => `- **${cat}**: ${svcs.join(', ')}`)
    .join('\n');

  const patterns = AWS_MODERNIZATION_PATTERNS.map(
    (p) => `- ${p.legacyPattern} -> ${p.awsServices.join(', ')}`,
  ).join('\n');

  return [
    '## AWS Service IDs (use these in awsArchSpec nodes)',
    serviceCatalog,
    '',
    '## Legacy -> AWS Patterns',
    patterns,
    '',
    'Return `awsArchSpec` JSON: {"title":"string","nodes":[{"id":"string","service":"<service-id>","label":"string","group":"group-id"}],"edges":[{"from":"id","to":"id","label":"string"}],"groups":[{"id":"string","label":"string","type":"vpc|subnet|az|region|generic"}]}',
    'Valid service IDs: ' + AWS_SERVICES.map((s) => s.id).join(', '),
  ].join('\n');
}
