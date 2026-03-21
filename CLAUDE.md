# Project Development Guidelines

## Workflow & Review Process

- **Phase Reviews**: Always ask for user review after completing each development phase before proceeding to the next
- **Architectural Decisions**: If implementation requires architectural decisions, stop and discuss options with the user before implementing
- **Incremental Development**: Break work into reviewable phases rather than large monolithic changes

## Git & GitHub Configuration

**CRITICAL**: Never use Claude profile for any git/GitHub operations.

- Always use MCP GitHub tools (`mcp__github__*`) for remote operations (push, PR, issues, branches)
- Use terminal git commands only for local operations (staging, committing, local branches)
- Do NOT include any Claude/AI co-author attribution in commits
- Do NOT add "Co-Authored-By: Claude" or similar lines
- Only use the user's GitHub profile (johnbekele) for all operations

## Pre-Push Checklist

Before pushing any code:
1. Run linter and fix all issues
2. Write clean, comprehensive tests
3. Run all tests and ensure they pass
4. Fix any failing tests before pushing
5. Review changes for security vulnerabilities

## Code Quality Standards

### Modularity
- Keep components small and focused - one responsibility per file
- Do NOT pack multiple components in a single file
- Extract reusable logic into separate modules
- Organize files precisely in well-named folders

### TypeScript
- Avoid `any` type unless absolutely necessary
- Use proper type definitions and interfaces
- Prefer strict typing for reliability

### Architecture Principles
- **Reliable**: Robust error handling, graceful degradation
- **Low Latency**: Optimize for performance, minimize unnecessary operations
- **Easy to Use**: Clear APIs, intuitive interfaces
- **Secured**: Follow OWASP guidelines, validate inputs, sanitize outputs
- **Horizontally Scalable**: Stateless design, avoid bottlenecks

## Technology Preferences

- Prefer open source and free solutions
- Use the best algorithms for the problem at hand
- Document trade-offs when multiple options exist

## Repository Organization

- Keep mono repo structure clean and navigable
- Maintain clear folder hierarchy
- Use consistent naming conventions
- Keep AI context clean with precise file organization
- Remove unused code and dependencies

## Folder Structure Guidelines

```
src/
  components/     # UI components (one per file)
  hooks/          # Custom React hooks
  utils/          # Utility functions
  services/       # API and external service integrations
  types/          # TypeScript type definitions
  constants/      # Application constants
  config/         # Configuration files
tests/
  unit/           # Unit tests
  integration/    # Integration tests
docs/             # Documentation
```

## Testing Standards

- Write tests alongside code, not as an afterthought
- Cover edge cases and error scenarios
- Keep tests readable and maintainable
- Use descriptive test names that explain the expected behavior
