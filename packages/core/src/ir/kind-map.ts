import type { IrNode, ResourceKind } from '@infracanvas/ir-schema';

import { getServiceById } from '../aws-services';
import type { CanvasNodeType } from './canvas';

/**
 * IR kind to catalogue entry, written out rather than derived from string
 * similarity. `elasticache_cluster` and `elasticache` look close enough to
 * guess at, `secretsmanager_secret` and `secrets-manager` do not, and a mapping
 * that is right four times out of five is worse than one that is explicit.
 *
 * `undefined` means the canvas has no shape for the kind. Conversion refuses
 * rather than dropping the node, because a canvas missing a resource prices
 * differently from the document it came from.
 */
const SERVICE_BY_KIND: Record<ResourceKind, string | undefined> = {
  vpc: 'vpc-environment',
  subnet: 'public-subnet', // The tier picks the entry; see `serviceIdForNode`.
  internet_gateway: undefined,
  nat_gateway: 'nat-gateway',
  security_group: 'security-group',
  ec2_instance: 'ec2',
  lambda_function: 'lambda',
  ecs_cluster: 'ecs-cluster',
  ecs_service: 'ecs',
  alb: 'alb',
  nlb: 'nlb',
  api_gateway: 'api-gateway',
  cloudfront_distribution: 'cloudfront',
  route53_zone: 'route53',
  s3_bucket: 's3',
  rds_instance: 'rds',
  dynamodb_table: 'dynamodb',
  elasticache_cluster: 'elasticache',
  sns_topic: 'sns',
  sqs_queue: 'sqs',
  iam_role: 'iam',
  cognito_user_pool: 'cognito',
  cloudwatch_log_group: 'cloudwatch',
  secretsmanager_secret: 'secrets-manager',
  sagemaker_endpoint: 'sagemaker-endpoint',
  amazon_mq_broker: 'amazon-mq',
  eventbridge_rule: 'eventbridge',
  kinesis_stream: 'kinesis',
  msk_cluster: 'msk',
  ses_identity: 'ses',
  step_functions_state_machine: 'step-functions',
  textract_processor: 'textract',
};

/**
 * The reverse direction, including the spellings the catalogue accumulated
 * before the IR existed. `vpc` and `vpc-environment` are the same resource:
 * the first was a service node, the second the container that replaced it, and
 * both still appear in saved designs.
 */
const KIND_BY_SERVICE: Record<string, ResourceKind> = {
  'vpc-environment': 'vpc',
  vpc: 'vpc',
  'public-subnet': 'subnet',
  'private-subnet': 'subnet',
  'nat-gateway': 'nat_gateway',
  'security-group': 'security_group',
  ec2: 'ec2_instance',
  lambda: 'lambda_function',
  'ecs-cluster': 'ecs_cluster',
  ecs: 'ecs_service',
  alb: 'alb',
  nlb: 'nlb',
  'api-gateway': 'api_gateway',
  cloudfront: 'cloudfront_distribution',
  route53: 'route53_zone',
  s3: 's3_bucket',
  rds: 'rds_instance',
  dynamodb: 'dynamodb_table',
  elasticache: 'elasticache_cluster',
  sns: 'sns_topic',
  sqs: 'sqs_queue',
  iam: 'iam_role',
  cognito: 'cognito_user_pool',
  cloudwatch: 'cloudwatch_log_group',
  'secrets-manager': 'secretsmanager_secret',
  'sagemaker-endpoint': 'sagemaker_endpoint',
  'amazon-mq': 'amazon_mq_broker',
  eventbridge: 'eventbridge_rule',
  kinesis: 'kinesis_stream',
  msk: 'msk_cluster',
  ses: 'ses_identity',
  'step-functions': 'step_functions_state_machine',
  textract: 'textract_processor',
};

/** Undefined for a kind the canvas has no catalogue entry for. */
export function kindToServiceId(kind: ResourceKind): string | undefined {
  return SERVICE_BY_KIND[kind];
}

/** Undefined for a catalogue entry with no IR kind, which is most of them. */
export function serviceIdToKind(serviceId: string): ResourceKind | undefined {
  return KIND_BY_SERVICE[serviceId];
}

/** The catalogue entry for a node, which for a subnet depends on its tier. */
export function serviceIdForNode(node: IrNode): string | undefined {
  if (node.kind === 'subnet') {
    return node.params.tier === 'public' ? 'public-subnet' : 'private-subnet';
  }
  return kindToServiceId(node.kind);
}

/** Which React Flow node type renders this node. */
export function canvasTypeForNode(node: IrNode): CanvasNodeType {
  switch (node.kind) {
    case 'vpc':
      return 'vpc-environment';
    case 'subnet':
      return node.params.tier === 'public' ? 'public-subnet' : 'private-subnet';
    case 'ecs_cluster':
      return 'ecs-cluster';
    default:
      return 'service';
  }
}

/** Kinds the canvas cannot draw, computed rather than listed twice. */
export function unrenderableKinds(): ResourceKind[] {
  return (Object.keys(SERVICE_BY_KIND) as ResourceKind[]).filter((kind) => {
    const serviceId = SERVICE_BY_KIND[kind];
    return serviceId === undefined || getServiceById(serviceId) === undefined;
  });
}
