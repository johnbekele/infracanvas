/**
 * Conventional Commits. The PR title feeds the generated changelog, and Gate 7
 * validates it with the same grammar.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'ci',
        'db',
        'ir',
        'engine',
        'rag',
        'graph',
        'brain',
        'agents',
        'analysis',
        'codegen',
        'deploy',
        'loadtest',
        'api',
        'web',
        'docs',
        'deps',
        'release',
      ],
    ],
    'subject-case': [2, 'never', ['start-case', 'pascal-case', 'upper-case']],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0],
  },
};
