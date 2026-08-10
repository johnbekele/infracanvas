import { describe, expect, it } from 'vitest';
import { parseDockerfilePorts, parseManifest } from './manifests.js';

describe('package.json', () => {
  it('reads the name and both dependency sets', () => {
    const manifest = parseManifest(
      'package.json',
      JSON.stringify({
        name: 'billing-api',
        dependencies: { express: '^4.18.0', pg: '^8.11.0' },
        devDependencies: { vitest: '^2.0.0' },
      }),
      'fallback'
    );

    expect(manifest?.name).toBe('billing-api');
    expect(manifest?.ecosystem).toBe('npm');
    expect(manifest?.dependencies).toEqual(['express', 'pg', 'vitest']);
  });

  it('falls back to the directory name when the manifest has no name', () => {
    const manifest = parseManifest('package.json', '{"dependencies":{}}', 'checkout');
    expect(manifest?.name).toBe('checkout');
  });

  it('returns null for malformed JSON rather than throwing', () => {
    // A template with placeholders is a normal thing to find in a real
    // repository, and should cost one component rather than the analysis.
    expect(parseManifest('package.json', '{ not json', 'fallback')).toBeNull();
  });
});

describe('requirements.txt', () => {
  it('takes the package name from a pinned requirement', () => {
    const manifest = parseManifest(
      'requirements.txt',
      'fastapi>=0.100,<1\npsycopg2-binary==2.9.9',
      'api'
    );
    expect(manifest?.dependencies).toEqual(['fastapi', 'psycopg2-binary']);
  });

  it('ignores comments, blank lines, options, and direct URLs', () => {
    const content = [
      '# runtime',
      '',
      'flask==3.0.0',
      '-r base.txt',
      '--index-url https://example.com/simple',
      'https://example.com/pkg.whl',
    ].join('\n');

    expect(parseManifest('requirements.txt', content, 'api')?.dependencies).toEqual(['flask']);
  });

  it('strips extras from a requirement', () => {
    expect(
      parseManifest('requirements.txt', 'uvicorn[standard]==0.30.0', 'api')?.dependencies
    ).toEqual(['uvicorn']);
  });
});

describe('pyproject.toml', () => {
  it('reads PEP 621 project dependencies', () => {
    const content = `
[project]
name = "brain"
dependencies = ["fastapi>=0.110", "asyncpg~=0.29"]
`;
    const manifest = parseManifest('pyproject.toml', content, 'fallback');

    expect(manifest?.name).toBe('brain');
    expect(manifest?.dependencies).toEqual(['fastapi', 'asyncpg']);
  });

  it('reads Poetry dependencies and drops the python constraint', () => {
    const content = `
[tool.poetry]
name = "worker"

[tool.poetry.dependencies]
python = "^3.12"
celery = "^5.3"
redis = "^5.0"
`;
    const manifest = parseManifest('pyproject.toml', content, 'fallback');

    expect(manifest?.name).toBe('worker');
    expect(manifest?.dependencies).toEqual(['celery', 'redis']);
  });
});

describe('go.mod', () => {
  it('reads the module name and a require block', () => {
    const content = `
module github.com/acme/checkout

go 1.22

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/jackc/pgx/v5 v5.5.0 // indirect
)
`;
    const manifest = parseManifest('go.mod', content, 'fallback');

    expect(manifest?.name).toBe('github.com/acme/checkout');
    expect(manifest?.dependencies).toEqual(['github.com/gin-gonic/gin', 'github.com/jackc/pgx/v5']);
  });

  it('reads a single-line require directive', () => {
    const content = 'module example.com/m\n\nrequire github.com/lib/pq v1.10.9\n';
    expect(parseManifest('go.mod', content, 'fallback')?.dependencies).toEqual([
      'github.com/lib/pq',
    ]);
  });
});

describe('Cargo.toml', () => {
  it('reads dependency names past the inline tables Cargo uses', () => {
    const content = `
[package]
name = "ic-engine"

[dependencies]
axum = "0.7"
tokio = { version = "1", features = ["full"] }

[dev-dependencies]
criterion = "0.5"
`;
    const manifest = parseManifest('Cargo.toml', content, 'fallback');

    expect(manifest?.name).toBe('ic-engine');
    expect(manifest?.dependencies).toEqual(['axum', 'tokio', 'criterion']);
  });

  it('treats a virtual workspace manifest as a library rather than a service', () => {
    const content = '[workspace]\nmembers = ["crates/*"]\n';
    const manifest = parseManifest('Cargo.toml', content, 'infracanvas');

    expect(manifest?.libraryHint).toBe(true);
    expect(manifest?.name).toBe('infracanvas');
  });
});

describe('Gemfile and composer.json', () => {
  it('reads gem declarations', () => {
    const content = "source 'https://rubygems.org'\n\ngem 'rails', '~> 7.1'\ngem 'sidekiq'\n";
    expect(parseManifest('Gemfile', content, 'app')?.dependencies).toEqual(['rails', 'sidekiq']);
  });

  it('drops platform requirements from composer', () => {
    const content = JSON.stringify({
      name: 'acme/shop',
      require: { php: '^8.2', 'ext-json': '*', 'laravel/framework': '^11.0' },
    });

    expect(parseManifest('composer.json', content, 'shop')?.dependencies).toEqual([
      'laravel/framework',
    ]);
  });
});

describe('pom.xml', () => {
  it('reads artifact ids', () => {
    const content = `
<project>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>`;

    expect(parseManifest('pom.xml', content, 'app')?.dependencies).toContain(
      'spring-boot-starter-web'
    );
  });
});

describe('parseDockerfilePorts', () => {
  it('reads EXPOSE directives including a protocol suffix', () => {
    expect(parseDockerfilePorts('FROM node:22\nEXPOSE 3000\nEXPOSE 8080/tcp 9090\n')).toEqual([
      3000, 8080, 9090,
    ]);
  });

  it('ignores a port outside the valid range', () => {
    expect(parseDockerfilePorts('EXPOSE 99999\n')).toEqual([]);
  });

  it('returns nothing for a Dockerfile that exposes no ports', () => {
    expect(parseDockerfilePorts('FROM alpine\nCMD ["sh"]\n')).toEqual([]);
  });
});
