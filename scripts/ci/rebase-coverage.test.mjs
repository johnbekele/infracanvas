import assert from 'node:assert/strict';
import test from 'node:test';

import { rebase } from './rebase-coverage.mjs';

test('rebases a report written from a package directory', () => {
  const xml = coberturaXml({
    sources: ['src'],
    filename: 'src/lib/env.ts',
  });

  const rebased = rebase(xml, 'apps/api');

  assert.match(rebased, /<source>apps\/api\/src<\/source>/);
  assert.match(rebased, /filename="apps\/api\/src\/lib\/env.ts"/);
});

test('leaves an already-rooted report alone', () => {
  const xml = coberturaXml({
    sources: ['apps/api/src'],
    filename: 'apps/api/src/lib/env.ts',
  });

  assert.equal(rebase(xml, 'apps/api'), xml);
  assert.equal(rebase(rebase(xml, 'apps/api'), 'apps/api'), xml);
});

test('rewrites every source element', () => {
  const xml = coberturaXml({
    sources: ['src', 'test/fixtures', 'coverage/helpers'],
    filename: 'src/lib/env.ts',
  });

  const rebased = rebase(xml, 'apps/api');

  assert.match(
    rebased,
    /<source>apps\/api\/src<\/source>\s*<source>apps\/api\/test\/fixtures<\/source>\s*<source>apps\/api\/coverage\/helpers<\/source>/
  );
});

test('fails loudly on a report it cannot parse', () => {
  assert.throws(
    () => rebase('<coverage><packages><package name="api"></coverage>', 'apps/api'),
    /Could not parse coverage XML/
  );
});

function coberturaXml({ sources, filename }) {
  return `<?xml version="1.0" ?>
<coverage>
  <sources>
${sources.map((source) => `    <source>${source}</source>`).join('\n')}
  </sources>
  <packages>
    <package name="api">
      <classes>
        <class name="env" filename="${filename}" />
      </classes>
    </package>
  </packages>
</coverage>
`;
}
