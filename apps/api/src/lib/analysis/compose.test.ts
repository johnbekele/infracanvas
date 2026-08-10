import { describe, expect, it } from 'vitest';
import { capabilityForImage, mergeComposeServices, parseCompose } from './compose.js';

const COMPOSE = `
services:
  api:
    build: ./apps/api
    ports:
      - "8000:8000"
    depends_on:
      - primary-db
      - cache
  worker:
    build:
      context: ./apps/worker
      dockerfile: Dockerfile
    depends_on:
      cache:
        condition: service_healthy
  primary-db:
    image: postgres:16-alpine
    ports:
      - "5433:5432"
  cache:
    image: redis:7
    expose:
      - 6379
`;

describe('parseCompose', () => {
  const services = parseCompose('docker-compose.yml', COMPOSE);

  it('finds every service', () => {
    expect(services.map((service) => service.name)).toEqual([
      'api',
      'worker',
      'primary-db',
      'cache',
    ]);
  });

  it('resolves a build context to a repository path', () => {
    expect(services.find((service) => service.name === 'api')?.buildContext).toBe('apps/api');
  });

  it('reads a build context from the long form', () => {
    expect(services.find((service) => service.name === 'worker')?.buildContext).toBe('apps/worker');
  });

  it('takes the container port rather than the host port', () => {
    // The host side is chosen to avoid collisions on a laptop and says nothing
    // about what the process listens on.
    expect(services.find((service) => service.name === 'primary-db')?.ports).toEqual([5432]);
  });

  it('reads expose as well as ports', () => {
    expect(services.find((service) => service.name === 'cache')?.ports).toEqual([6379]);
  });

  it('reads depends_on in both list and map form', () => {
    expect(services.find((service) => service.name === 'api')?.dependsOn).toEqual([
      'primary-db',
      'cache',
    ]);
    expect(services.find((service) => service.name === 'worker')?.dependsOn).toEqual(['cache']);
  });

  it('maps an image to the infrastructure it implies', () => {
    expect(services.find((service) => service.name === 'primary-db')?.capability).toBe('postgres');
    expect(services.find((service) => service.name === 'cache')?.capability).toBe('redis');
  });

  it('leaves a service built from source without a capability', () => {
    // A service the repository builds is application code, whatever its image
    // happens to be called.
    expect(services.find((service) => service.name === 'api')?.capability).toBeNull();
  });

  it('resolves a context relative to a nested compose file', () => {
    const nested = parseCompose(
      'deploy/compose.yaml',
      'services:\n  api:\n    build: ../apps/api\n'
    );

    expect(nested[0].buildContext).toBe('apps/api');
  });

  it('yields nothing for a file that is not valid YAML', () => {
    // Losing a compose file costs precision; failing the analysis over it costs
    // everything else the repository had to say.
    expect(parseCompose('compose.yml', 'services:\n  - [unclosed')).toEqual([]);
  });

  it('yields nothing for a YAML file that is not compose', () => {
    expect(parseCompose('compose.yml', 'name: something\nversion: 1\n')).toEqual([]);
  });
});

describe('capabilityForImage', () => {
  it('ignores a tag', () => {
    expect(capabilityForImage('postgres:16.2')).toBe('postgres');
  });

  it('ignores a registry host', () => {
    expect(capabilityForImage('public.ecr.aws/docker/library/redis:7')).toBe('redis');
  });

  it('keeps an organisation that is not a host', () => {
    expect(capabilityForImage('bitnami/kafka:3.7')).toBe('kafka');
  });

  it('ignores a digest', () => {
    expect(capabilityForImage('mongo@sha256:abc123')).toBe('mongodb');
  });

  it('returns null for an image it does not recognise', () => {
    expect(capabilityForImage('ghcr.io/acme/api:latest')).toBeNull();
  });
});

describe('mergeComposeServices', () => {
  it('lets the base file win over an override', () => {
    const base = parseCompose('compose.yml', 'services:\n  api:\n    build: ./api\n');
    const override = parseCompose(
      'compose.override.yml',
      'services:\n  api:\n    image: acme/api\n    ports:\n      - "9000:9000"\n'
    );

    const merged = mergeComposeServices([...base, ...override]);

    expect(merged).toHaveLength(1);
    expect(merged[0].buildContext).toBe('api');
    expect(merged[0].ports).toEqual([9000]);
  });
});
