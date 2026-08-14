/**
 * AI and machine learning services.
 *
 * These carry more configuration than most of the catalog because their cost and
 * latency are dominated by choices the user has to make explicitly: which model,
 * whether an endpoint stays warm, how many tokens a request is allowed. A
 * SageMaker endpoint on the wrong instance family is the difference between a
 * few dollars a month and a few thousand, and that is not something to leave to
 * a default nobody was shown.
 */
import type { AWSService } from '../aws-services';
import { bool, num, select, text } from './props';

const AI_COLOUR = '#01A88D';

export const aiServices: AWSService[] = [
  {
    id: 'bedrock',
    name: 'Bedrock',
    shortName: 'Bedrock',
    category: 'ai-ml',
    description: 'Managed foundation models via a single API',
    color: AI_COLOUR,
    icon: 'sparkles',
    allowedConnections: ['ecs', 'ec2', 'lambda', 'api-gateway', 'step-functions', 'sqs'],
    properties: [
      select(
        'modelId',
        'Model',
        [
          ['anthropic.claude-sonnet-4-20250514-v1:0', 'Claude Sonnet 4'],
          ['anthropic.claude-3-5-haiku-20241022-v1:0', 'Claude 3.5 Haiku'],
          ['amazon.nova-pro-v1:0', 'Amazon Nova Pro'],
          ['amazon.nova-lite-v1:0', 'Amazon Nova Lite'],
          ['meta.llama3-3-70b-instruct-v1:0', 'Llama 3.3 70B'],
          ['mistral.mistral-large-2407-v1:0', 'Mistral Large'],
          ['amazon.titan-embed-text-v2:0', 'Titan Text Embeddings v2'],
        ],
        'anthropic.claude-sonnet-4-20250514-v1:0'
      ),
      select('invocationMode', 'Invocation', [
        ['on-demand', 'On demand (per token)'],
        ['provisioned', 'Provisioned throughput'],
      ]),
      num('modelUnits', 'Provisioned Model Units', 0),
      num('maxTokens', 'Max Output Tokens', 4096),
      bool('guardrailsEnabled', 'Attach Guardrail', false),
      bool('invocationLogging', 'Log Invocations', true),
    ],
    iac: {
      terraformResource: 'aws_bedrock_provisioned_model_throughput',
      pulumiClass: 'aws.bedrock.ProvisionedModelThroughput',
      // Chosen in the interface to size the cost model; not arguments.
      overrides: { invocationMode: null, maxTokens: null, guardrailsEnabled: null },
    },
  },
  {
    id: 'bedrock-knowledge-base',
    name: 'Bedrock Knowledge Base',
    shortName: 'KB',
    category: 'ai-ml',
    description: 'Managed retrieval over your own documents',
    color: AI_COLOUR,
    icon: 'library',
    allowedConnections: ['bedrock', 'opensearch-vector', 's3', 'ecs', 'lambda'],
    properties: [
      text('knowledgeBaseName', 'Knowledge Base Name', 'my-knowledge-base', true),
      select('embeddingModel', 'Embedding Model', [
        ['amazon.titan-embed-text-v2:0', 'Titan Text Embeddings v2'],
        ['cohere.embed-english-v3', 'Cohere Embed English v3'],
        ['cohere.embed-multilingual-v3', 'Cohere Embed Multilingual v3'],
      ]),
      select('vectorStore', 'Vector Store', [
        ['opensearch-serverless', 'OpenSearch Serverless'],
        ['aurora', 'Aurora PostgreSQL with pgvector'],
        ['pinecone', 'Pinecone'],
      ]),
      num('chunkSize', 'Chunk Size (tokens)', 512),
      num('chunkOverlap', 'Chunk Overlap (tokens)', 64),
    ],
    iac: {
      terraformResource: 'aws_bedrockagent_knowledge_base',
      pulumiClass: 'aws.bedrock.AgentKnowledgeBase',
    },
  },
  {
    id: 'bedrock-agent',
    name: 'Bedrock Agent',
    shortName: 'Agent',
    category: 'ai-ml',
    description: 'Model that plans and calls tools',
    color: AI_COLOUR,
    icon: 'bot',
    allowedConnections: ['bedrock', 'bedrock-knowledge-base', 'lambda', 'api-gateway'],
    properties: [
      text('agentName', 'Agent Name', 'my-agent', true),
      select('foundationModel', 'Model', [
        ['anthropic.claude-sonnet-4-20250514-v1:0', 'Claude Sonnet 4'],
        ['anthropic.claude-3-5-haiku-20241022-v1:0', 'Claude 3.5 Haiku'],
        ['amazon.nova-pro-v1:0', 'Amazon Nova Pro'],
      ]),
      num('idleSessionTtl', 'Idle Session TTL (seconds)', 600),
      bool('memoryEnabled', 'Retain Session Memory', false),
    ],
    iac: { terraformResource: 'aws_bedrockagent_agent', pulumiClass: 'aws.bedrock.Agent' },
  },
  {
    id: 'bedrock-guardrail',
    name: 'Bedrock Guardrail',
    shortName: 'Guard',
    category: 'ai-ml',
    description: 'Content and topic filters applied to model calls',
    color: AI_COLOUR,
    icon: 'filter',
    allowedConnections: ['bedrock', 'bedrock-agent'],
    properties: [
      text('guardrailName', 'Guardrail Name', 'my-guardrail', true),
      select(
        'contentFilterStrength',
        'Content Filter Strength',
        ['none', 'low', 'medium', 'high'],
        'medium'
      ),
      bool('piiRedaction', 'Redact PII', true),
      bool('groundingCheck', 'Contextual Grounding Check', false),
    ],
    iac: { terraformResource: 'aws_bedrock_guardrail', pulumiClass: 'aws.bedrock.Guardrail' },
  },
  {
    id: 'sagemaker-endpoint',
    name: 'SageMaker Endpoint',
    shortName: 'SM',
    category: 'ai-ml',
    description: 'Hosted inference for your own model',
    color: AI_COLOUR,
    icon: 'brain',
    allowedConnections: ['ecs', 'lambda', 'api-gateway', 's3', 'ecr'],
    properties: [
      text('endpointName', 'Endpoint Name', 'my-endpoint', true),
      select(
        'instanceType',
        'Instance Type',
        [
          ['ml.t3.medium', 'ml.t3.medium (CPU, 2 vCPU 4GB)'],
          ['ml.m5.large', 'ml.m5.large (CPU, 2 vCPU 8GB)'],
          ['ml.c5.xlarge', 'ml.c5.xlarge (CPU optimised)'],
          ['ml.g5.xlarge', 'ml.g5.xlarge (1x A10G, 24GB)'],
          ['ml.g5.2xlarge', 'ml.g5.2xlarge (1x A10G, 24GB)'],
          ['ml.g6.xlarge', 'ml.g6.xlarge (1x L4, 24GB)'],
          ['ml.p4d.24xlarge', 'ml.p4d.24xlarge (8x A100, 320GB)'],
        ],
        'ml.g5.xlarge'
      ),
      num('instanceCount', 'Instance Count', 1),
      select('endpointMode', 'Endpoint Mode', [
        ['realtime', 'Real time (always warm)'],
        ['serverless', 'Serverless (scales to zero)'],
        ['async', 'Asynchronous (queued)'],
      ]),
      num('maxConcurrency', 'Max Concurrent Invocations', 10),
      bool('dataCaptureEnabled', 'Capture Requests', false),
    ],
    iac: {
      terraformResource: 'aws_sagemaker_endpoint',
      pulumiClass: 'aws.sagemaker.Endpoint',
      overrides: { endpointMode: null, maxConcurrency: null },
    },
  },
  {
    id: 'sagemaker-training',
    name: 'SageMaker Training',
    shortName: 'Train',
    category: 'ai-ml',
    description: 'Managed training and fine-tuning jobs',
    color: AI_COLOUR,
    icon: 'cpu',
    allowedConnections: ['s3', 'ecr', 'sagemaker-endpoint'],
    properties: [
      text('jobName', 'Job Name', 'my-training-job', true),
      select(
        'instanceType',
        'Instance Type',
        [
          ['ml.m5.xlarge', 'ml.m5.xlarge (CPU)'],
          ['ml.g5.2xlarge', 'ml.g5.2xlarge (1x A10G)'],
          ['ml.g5.12xlarge', 'ml.g5.12xlarge (4x A10G)'],
          ['ml.p4d.24xlarge', 'ml.p4d.24xlarge (8x A100)'],
        ],
        'ml.g5.2xlarge'
      ),
      num('instanceCount', 'Instance Count', 1),
      num('maxRuntimeSeconds', 'Max Runtime (seconds)', 86400),
      bool('spotTraining', 'Use Spot Capacity', true),
    ],
    iac: {
      terraformResource: 'aws_sagemaker_training_job',
      pulumiClass: 'aws.sagemaker.TrainingJob',
    },
  },
  {
    id: 'opensearch-vector',
    name: 'OpenSearch Serverless',
    shortName: 'Vectors',
    category: 'ai-ml',
    description: 'Serverless vector collection for embeddings',
    color: AI_COLOUR,
    icon: 'binary',
    allowedConnections: ['ecs', 'lambda', 'bedrock-knowledge-base', 'sagemaker-endpoint'],
    properties: [
      text('collectionName', 'Collection Name', 'my-vectors', true),
      num('dimensions', 'Vector Dimensions', 1024),
      select('distanceMetric', 'Distance Metric', ['cosine', 'l2', 'innerproduct'], 'cosine'),
      num('minCapacityOcu', 'Min Capacity (OCU)', 2),
      num('maxCapacityOcu', 'Max Capacity (OCU)', 8),
    ],
    iac: {
      terraformResource: 'aws_opensearchserverless_collection',
      pulumiClass: 'aws.opensearch.ServerlessCollection',
      overrides: { dimensions: null, distanceMetric: null },
    },
  },
  {
    id: 'kendra',
    name: 'Kendra',
    shortName: 'Kendra',
    category: 'ai-ml',
    description: 'Managed enterprise search with natural language',
    color: AI_COLOUR,
    icon: 'file-search',
    allowedConnections: ['s3', 'ecs', 'lambda', 'rds'],
    properties: [
      text('indexName', 'Index Name', 'my-index', true),
      select('edition', 'Edition', [
        ['DEVELOPER_EDITION', 'Developer'],
        ['ENTERPRISE_EDITION', 'Enterprise'],
      ]),
      num('storageCapacityUnits', 'Extra Storage Units', 0),
      num('queryCapacityUnits', 'Extra Query Units', 0),
    ],
    iac: { terraformResource: 'aws_kendra_index', pulumiClass: 'aws.kendra.Index' },
  },
  {
    id: 'textract',
    name: 'Textract',
    shortName: 'Textract',
    category: 'ai-ml',
    description: 'Text, form, and table extraction from documents',
    color: AI_COLOUR,
    icon: 'file-text',
    allowedConnections: ['s3', 'lambda', 'ecs', 'sqs', 'step-functions'],
    properties: [
      select('featureType', 'Analysis', [
        ['DETECTION', 'Text detection only'],
        ['FORMS', 'Forms'],
        ['TABLES', 'Tables'],
        ['LAYOUT', 'Layout'],
        ['QUERIES', 'Queries'],
      ]),
      select('processingMode', 'Processing', [
        ['synchronous', 'Synchronous (single page)'],
        ['asynchronous', 'Asynchronous (multi page)'],
      ]),
      num('expectedPagesPerMonth', 'Expected Pages per Month', 10000),
    ],
    // Textract is called, not provisioned: the only resource is the permission
    // to call it and, for the asynchronous API, the topic it publishes to.
    iac: {
      terraformResource: 'aws_iam_policy',
      pulumiClass: 'aws.iam.Policy',
      overrides: { featureType: null, processingMode: null, expectedPagesPerMonth: null },
    },
  },
  {
    id: 'comprehend',
    name: 'Comprehend',
    shortName: 'Compr',
    category: 'ai-ml',
    description: 'Entity, sentiment, and topic extraction from text',
    color: AI_COLOUR,
    icon: 'scan-text',
    allowedConnections: ['s3', 'lambda', 'ecs'],
    properties: [
      select('analysisType', 'Analysis', [
        ['entities', 'Entities'],
        ['sentiment', 'Sentiment'],
        ['pii', 'PII detection'],
        ['topics', 'Topic modelling'],
        ['custom-classification', 'Custom classification'],
      ]),
      num('expectedUnitsPerMonth', 'Expected Units per Month', 100000),
    ],
    iac: {
      terraformResource: 'aws_comprehend_document_classifier',
      pulumiClass: 'aws.comprehend.DocumentClassifier',
      overrides: { analysisType: null, expectedUnitsPerMonth: null },
    },
  },
  {
    id: 'rekognition',
    name: 'Rekognition',
    shortName: 'Rekog',
    category: 'ai-ml',
    description: 'Image and video analysis',
    color: AI_COLOUR,
    icon: 'image',
    allowedConnections: ['s3', 'lambda', 'ecs', 'kinesis'],
    properties: [
      select('analysisType', 'Analysis', [
        ['labels', 'Object and scene labels'],
        ['faces', 'Face detection'],
        ['moderation', 'Content moderation'],
        ['text', 'Text in image'],
      ]),
      num('expectedImagesPerMonth', 'Expected Images per Month', 10000),
    ],
    iac: {
      terraformResource: 'aws_rekognition_collection',
      pulumiClass: 'aws.rekognition.Collection',
      overrides: { analysisType: null, expectedImagesPerMonth: null },
    },
  },
  {
    id: 'transcribe',
    name: 'Transcribe',
    shortName: 'Trans',
    category: 'ai-ml',
    description: 'Speech to text',
    color: AI_COLOUR,
    icon: 'mic',
    allowedConnections: ['s3', 'lambda', 'ecs', 'kinesis'],
    properties: [
      select('mode', 'Mode', [
        ['batch', 'Batch'],
        ['streaming', 'Streaming'],
      ]),
      text('languageCode', 'Language', 'en-US'),
      bool('speakerDiarisation', 'Identify Speakers', false),
      num('expectedMinutesPerMonth', 'Expected Minutes per Month', 5000),
    ],
    iac: {
      terraformResource: 'aws_transcribe_vocabulary',
      pulumiClass: 'aws.transcribe.Vocabulary',
      overrides: { mode: null, speakerDiarisation: null, expectedMinutesPerMonth: null },
    },
  },
  {
    id: 'polly',
    name: 'Polly',
    shortName: 'Polly',
    category: 'ai-ml',
    description: 'Text to speech',
    color: AI_COLOUR,
    icon: 'audio-lines',
    allowedConnections: ['s3', 'lambda', 'ecs'],
    properties: [
      select('engine', 'Voice Engine', ['standard', 'neural', 'generative'], 'neural'),
      text('voiceId', 'Voice', 'Joanna'),
      num('expectedCharactersPerMonth', 'Expected Characters per Month', 1000000),
    ],
    iac: {
      terraformResource: 'aws_iam_policy',
      pulumiClass: 'aws.iam.Policy',
      overrides: { engine: null, voiceId: null, expectedCharactersPerMonth: null },
    },
  },
  {
    id: 'translate',
    name: 'Translate',
    shortName: 'Trnsl',
    category: 'ai-ml',
    description: 'Machine translation',
    color: AI_COLOUR,
    icon: 'languages',
    allowedConnections: ['s3', 'lambda', 'ecs'],
    properties: [
      text('sourceLanguage', 'Source Language', 'auto'),
      text('targetLanguage', 'Target Language', 'es'),
      num('expectedCharactersPerMonth', 'Expected Characters per Month', 1000000),
    ],
    iac: {
      terraformResource: 'aws_iam_policy',
      pulumiClass: 'aws.iam.Policy',
      overrides: { expectedCharactersPerMonth: null },
    },
  },
];
