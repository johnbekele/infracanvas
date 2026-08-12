import { resourceKinds } from '@infracanvas/ir-schema';
import { describe, expect, it } from 'vitest';

import { getServiceById } from '../aws-services';
import {
  canvasTypeForNode,
  kindToServiceId,
  serviceIdForNode,
  serviceIdToKind,
  unrenderableKinds,
} from './kind-map';

describe('kind mapping', () => {
  it('maps every kind the canvas can draw to a catalogue entry that exists', () => {
    for (const kind of resourceKinds()) {
      const serviceId = kindToServiceId(kind);
      if (serviceId === undefined) continue;
      expect(getServiceById(serviceId), `${kind} -> ${serviceId}`).toBeDefined();
    }
  });

  it('names exactly the kinds the canvas cannot draw', () => {
    expect(unrenderableKinds()).toEqual(['internet_gateway']);
  });

  it('collapses both vpc spellings onto one ir kind', () => {
    expect(serviceIdToKind('vpc')).toBe('vpc');
    expect(serviceIdToKind('vpc-environment')).toBe('vpc');
    expect(kindToServiceId('vpc')).toBe('vpc-environment');
  });

  it('keeps an ecs cluster and an ecs service as separate kinds', () => {
    expect(serviceIdToKind('ecs-cluster')).toBe('ecs_cluster');
    expect(serviceIdToKind('ecs')).toBe('ecs_service');
    expect(kindToServiceId('ecs_cluster')).toBe('ecs-cluster');
    expect(kindToServiceId('ecs_service')).toBe('ecs');
  });

  it('picks the subnet catalogue entry from the tier', () => {
    const subnet = (tier: 'public' | 'private') =>
      ({
        id: 'subnet-a',
        kind: 'subnet',
        name: 'A',
        params: { tier, cidrBlock: '10.0.1.0/24', availabilityZone: 'eu-west-1a' },
      }) as const;

    expect(serviceIdForNode(subnet('public'))).toBe('public-subnet');
    expect(serviceIdForNode(subnet('private'))).toBe('private-subnet');
    expect(canvasTypeForNode(subnet('public'))).toBe('public-subnet');
    expect(canvasTypeForNode(subnet('private'))).toBe('private-subnet');
  });

  it('round trips every mapped kind through the catalogue and back', () => {
    for (const kind of resourceKinds()) {
      const serviceId = kindToServiceId(kind);
      if (serviceId === undefined) continue;
      // A subnet's two catalogue entries collapse onto one kind, which is the
      // one asymmetry the mapping is allowed.
      const expected = kind === 'subnet' ? 'subnet' : kind;
      expect(serviceIdToKind(serviceId), serviceId).toBe(expected);
    }
  });

  it('returns undefined for a catalogue entry with no ir kind', () => {
    expect(serviceIdToKind('bedrock')).toBeUndefined();
    expect(serviceIdToKind('not-a-service')).toBeUndefined();
  });
});
