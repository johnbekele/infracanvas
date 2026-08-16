import { describe, expect, it } from 'vitest';
import { awsServices, getServiceById } from '../aws-services';
import { argumentNameFor, emitPulumi, emitTerraform, identifierFor, snakeCase } from './emit';

describe('the catalog', () => {
  it('gives every service an iac mapping', () => {
    for (const service of awsServices) {
      expect(service.iac, `${service.id} has no iac mapping`).toBeDefined();
    }
  });

  it('has no duplicate service ids', () => {
    const ids = awsServices.map((service) => service.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('generates code for every service that provisions something', () => {
    for (const service of awsServices) {
      if (!service.iac.terraformResource) continue;

      const node = { id: service.id, serviceId: service.id, properties: {} };

      expect(emitTerraform(node), `no terraform for ${service.id}`).not.toBe('');
      expect(emitPulumi(node, 'python'), `no pulumi python for ${service.id}`).not.toBe('');
      expect(emitPulumi(node, 'typescript'), `no pulumi typescript for ${service.id}`).not.toBe('');
    }
  });

  it('emits nothing for a placement construct that provisions no resource', () => {
    // An availability zone constrains where subnets go; it is not a resource.
    const zone = { id: 'az', serviceId: 'availability-zone', properties: {} };
    expect(emitTerraform(zone)).toBe('');
  });

  it('emits nothing for the groups that only organise a diagram', () => {
    // A region or an account is a boundary the reader needs and the provider does
    // not. Drawing one has to stay free of consequences for the generated code.
    for (const id of [
      'aws-cloud',
      'region',
      'aws-account',
      'corporate-data-center',
      'auto-scaling-group',
      'spot-fleet',
      'elastic-beanstalk-container',
      'server-contents',
      'ec2-instance-contents',
      'iot-greengrass',
      'iot-greengrass-deployment',
    ]) {
      expect(getServiceById(id), `${id} is not in the catalog`).toBeDefined();
      expect(emitTerraform({ id, serviceId: id, properties: {} }), `${id} emitted`).toBe('');
    }
  });

  // Both are drawn as boxes now, and being a box is a canvas concern: it must not
  // reach the provider.
  it('still emits the resources for the groups that are also resources', () => {
    const sg = emitTerraform({ id: 'sg', serviceId: 'security-group', properties: {} });
    expect(sg).toContain('aws_security_group');

    const workflow = emitTerraform({ id: 'wf', serviceId: 'step-functions', properties: {} });
    expect(workflow).toContain('aws_sfn_state_machine');
  });

  it('offers a service for every AI capability the analyser detects', () => {
    const aiServiceIds = awsServices
      .filter((service) => service.category === 'ai-ml')
      .map((service) => service.id);

    for (const id of ['bedrock', 'sagemaker-endpoint', 'opensearch-vector', 'textract']) {
      expect(aiServiceIds).toContain(id);
    }
  });
});

describe('argument naming', () => {
  it('converts a property name to snake case for terraform', () => {
    expect(snakeCase('containerPort')).toBe('container_port');
    expect(snakeCase('cpu')).toBe('cpu');
  });

  it('keeps camel case for pulumi typescript', () => {
    const service = getServiceById('ecr')!;
    expect(argumentNameFor(service.iac, 'scanOnPush', 'pulumi-ts')).toBe('scanOnPush');
    expect(argumentNameFor(service.iac, 'scanOnPush', 'pulumi-python')).toBe('scan_on_push');
  });

  it('drops a property that configures the canvas rather than the resource', () => {
    const service = getServiceById('ecs-cluster')!;
    expect(argumentNameFor(service.iac, 'capacityProvider', 'terraform')).toBeNull();
  });
});

describe('tagging', () => {
  const untagged = { id: 'lake', serviceId: 'lake-formation', properties: {} };

  it('tags a resource by default', () => {
    const node = { id: 'warehouse', serviceId: 'redshift', properties: {} };

    expect(emitTerraform(node)).toContain('tags = local.common_tags');
    expect(emitPulumi(node, 'python')).toContain('tags={**tags');
    expect(emitPulumi(node, 'typescript')).toContain('tags: { ...tags');
  });

  it('omits tags where the provider has no such argument', () => {
    // Lake Formation registrations take no tags, and an argument the provider
    // does not recognise fails the plan for the whole file rather than for the
    // one resource.
    expect(emitTerraform(untagged)).not.toContain('tags');
    expect(emitPulumi(untagged, 'python')).not.toContain('tags');
    expect(emitPulumi(untagged, 'typescript')).not.toContain('tags');
  });

  it('still closes the block it left the tags out of', () => {
    expect(emitTerraform(untagged).trimEnd().endsWith('}')).toBe(true);
    expect(emitPulumi(untagged, 'python').trimEnd().endsWith(')')).toBe(true);
    expect(emitPulumi(untagged, 'typescript').trimEnd().endsWith('});')).toBe(true);
  });
});

describe('emitting one resource', () => {
  const node = {
    id: 'search-primary',
    serviceId: 'opensearch',
    properties: { domainName: 'orders', instanceCount: 3 },
  };

  it('writes the property values it was given', () => {
    const terraform = emitTerraform(node);

    expect(terraform).toContain('resource "aws_opensearch_domain" "search_primary"');
    expect(terraform).toContain('domain_name = "orders"');
    expect(terraform).toContain('instance_count = 3');
  });

  it('falls back to the catalog default for a property left unset', () => {
    expect(emitTerraform(node)).toContain('volume_size = 20');
  });

  it('quotes booleans the way each language expects', () => {
    const python = emitPulumi(node, 'python');
    const typescript = emitPulumi(node, 'typescript');

    expect(python).toContain('dedicated_master=False');
    expect(typescript).toContain('dedicatedMaster: false');
  });

  it('emits the same resource type for terraform and pulumi', () => {
    // A design that generates an OpenSearch domain in one target and something
    // else in the other is worse than one that generates neither.
    expect(emitTerraform(node)).toContain('aws_opensearch_domain');
    expect(emitPulumi(node, 'python')).toContain('aws.opensearch.Domain');
  });

  it('references the subnet a node was placed in', () => {
    const service = getServiceById('rds');
    expect(service).toBeDefined();

    const placed = emitTerraform(
      { id: 'database-primary', serviceId: 'rds', properties: {} },
      { parent: { serviceId: 'private-subnet', resourceName: 'network_private' } }
    );

    if (service?.iac.fromParent) {
      expect(placed).toContain('network_private');
    }
  });
});

describe('identifiers', () => {
  it('turns a node id into something every target accepts', () => {
    expect(identifierFor({ id: 'compute-apps/maia-api', serviceId: 'ecs', properties: {} })).toBe(
      'compute_apps_maia_api'
    );
  });

  it('does not start an identifier with a digit', () => {
    expect(identifierFor({ id: '3rd-party', serviceId: 'ecs', properties: {} })).toBe(
      'r_3rd_party'
    );
  });

  it('drops separators at both ends rather than emitting a leading underscore', () => {
    expect(identifierFor({ id: '--api--', serviceId: 'ecs', properties: {} })).toBe('api');
  });

  it('falls back to a name when the id has nothing usable in it', () => {
    expect(identifierFor({ id: '///', serviceId: 'ecs', properties: {} })).toBe('resource');
  });

  it('stays fast on an id that is almost all separators', () => {
    // A trailing-run trim backtracks quadratically here, which is a denial of
    // service on an id that arrives from a repository path.
    const id = `${'-'.repeat(50_000)}a${'-'.repeat(50_000)}`;
    const started = performance.now();

    expect(identifierFor({ id, serviceId: 'ecs', properties: {} })).toBe('a');
    expect(performance.now() - started).toBeLessThan(100);
  });
});
