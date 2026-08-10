import { describe, expect, it } from 'vitest';
import { classifyComponent, isDeployable, type ClassifyInput } from './classify.js';

function input(overrides: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    path: 'apps/thing',
    capabilities: [],
    dockerfiles: [],
    hasComposeService: false,
    libraryHint: false,
    hasNestedComponents: false,
    ...overrides,
  };
}

describe('classifyComponent', () => {
  it('classifies a web framework with a container as an api', () => {
    expect(
      classifyComponent(
        input({ capabilities: ['http-server'], dockerfiles: ['apps/thing/Dockerfile'] })
      )
    ).toBe('api');
  });

  it('classifies a task queue with no exposed port as a worker', () => {
    expect(
      classifyComponent(
        input({ capabilities: ['background-jobs'], dockerfiles: ['apps/thing/Dockerfile'] })
      )
    ).toBe('worker');
  });

  it('classifies a front end framework as a front end', () => {
    expect(classifyComponent(input({ capabilities: ['frontend'] }))).toBe('frontend');
  });

  it('classifies a model component with no request path as a model service', () => {
    expect(
      classifyComponent(
        input({ capabilities: ['gpu-inference'], dockerfiles: ['apps/thing/Dockerfile'] })
      )
    ).toBe('ml-service');
  });

  it('treats a service that both serves and infers as an api', () => {
    // It answers requests, so it belongs behind the load balancer. That it also
    // needs a GPU survives on the component's capabilities.
    expect(
      classifyComponent(
        input({
          capabilities: ['http-server', 'gpu-inference'],
          dockerfiles: ['apps/thing/Dockerfile'],
        })
      )
    ).toBe('api');
  });

  it('classifies a package with no container as a library', () => {
    expect(classifyComponent(input({ path: 'packages/shared', libraryHint: true }))).toBe(
      'library'
    );
  });

  it('excludes a test directory however much it looks like a service', () => {
    expect(
      classifyComponent(
        input({
          path: 'tests/e2e',
          capabilities: ['http-server'],
          dockerfiles: ['tests/e2e/Dockerfile'],
        })
      )
    ).toBe('test');
  });

  it('excludes example and template directories', () => {
    expect(classifyComponent(input({ path: 'examples/quickstart' }))).toBe('example');
    expect(classifyComponent(input({ path: '_templates/service' }))).toBe('example');
    expect(classifyComponent(input({ path: 'pocs/spike' }))).toBe('example');
  });

  it('treats a root manifest above other components as the workspace itself', () => {
    expect(
      classifyComponent(input({ path: '.', capabilities: ['frontend'], hasNestedComponents: true }))
    ).toBe('library');
  });

  it('still deploys a root manifest that ships its own container', () => {
    expect(
      classifyComponent(
        input({
          path: '.',
          capabilities: ['http-server'],
          dockerfiles: ['Dockerfile'],
          hasNestedComponents: true,
        })
      )
    ).toBe('api');
  });

  it('treats a container with no stated role as a worker rather than dropping it', () => {
    expect(classifyComponent(input({ dockerfiles: ['apps/thing/Dockerfile'] }))).toBe('worker');
  });
});

describe('isDeployable', () => {
  it('deploys a front end without a container, because it builds to files', () => {
    expect(isDeployable('frontend', false)).toBe(true);
  });

  it('does not deploy a service that ships no container', () => {
    expect(isDeployable('worker', false)).toBe(false);
  });

  it('does not deploy a library, a test, or an example', () => {
    expect(isDeployable('library', true)).toBe(false);
    expect(isDeployable('test', true)).toBe(false);
    expect(isDeployable('example', true)).toBe(false);
  });
});
