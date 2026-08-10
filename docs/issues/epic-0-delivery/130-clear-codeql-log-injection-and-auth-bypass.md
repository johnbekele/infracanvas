---
title: '[api] Clear the CodeQL log injection and optional-auth bypass alerts'
labels: tier:1, size:s, area:api, epic:0-delivery
---

### Epic

#1

### Context

The ruleset requires every review thread to be resolved before a pull request can merge, and CodeQL
opens a thread for each alert it finds. Alerts standing open on `main` therefore block unrelated
work, which is what happened to #47.

Two alerts remain after the rate limiter is replaced and the duplicated Vercel API is deleted:

- `js/log-injection` at `apps/api/src/routes/github/push.ts:232`. `console.error('...', error)`
  writes an error whose message can contain text echoed from a request body or a GitHub API
  response. A newline in that text lets a caller append a line that looks like a separate log
  record. Twelve other call sites share the shape; only one currently has a traced path from user
  input, so fixing that one alone would leave the pattern to reappear.
- `js/user-controlled-bypass` at `apps/api/src/middleware/auth.ts:90`. `optionalAuth` branches on
  `if (token)` before verifying it, so a value the caller supplies decides whether a signature check
  happens at all. The behaviour is correct today because the inner branch still verifies, but the
  shape is the one the query warns about and it is one edit away from being a real bypass.

### Contract

```typescript
// apps/api/src/lib/log.ts
export function sanitiseForLog(value: unknown): string;
export function logError(context: string, error: unknown): void;

// apps/api/src/lib/jwt.ts - widened so callers need no presence check
export async function verifySessionToken(
  token: string | null | undefined
): Promise<SessionPayload | null>;
```

`sanitiseForLog` JSON-encodes an error so its stack survives as escaped text, then strips any
separator the encoder emits raw and truncates, so one entry cannot span lines or flood the log.
`context` is a fixed string supplied by the caller and is never interpolated from a request.

Both steps have to be written the way the CodeQL query models them, or the alert stays open on a
correct fix: `JsonStringifySanitizer` treats the output of `JSON.stringify` as a barrier, and
`StringReplaceSanitizer` matches only a replacement of a newline with the _empty_ string. Replacing
with a space, or matching a character class, is not recognised.

### Files

- CREATE `apps/api/src/lib/log.ts`
- CREATE `apps/api/src/lib/log.test.ts`
- CREATE `apps/api/src/middleware/auth.test.ts`
- MODIFY `apps/api/src/lib/jwt.ts` - accept an absent token
- MODIFY `apps/api/src/middleware/auth.ts` - drop the branch on the raw token
- MODIFY the nine files calling `console.error` with an error value

### Acceptance Criteria

- [ ] No file under `apps/api/src` calls `console.error` except `lib/log.ts`
- [ ] A newline inside an error message cannot start a new log line
- [ ] An error stack is still recoverable from the log output
- [ ] `optionalAuth` performs no branch on the token before verification
- [ ] `optionalAuth` still admits a valid token from either a cookie or a bearer header
- [ ] Both CodeQL alerts close on the branch

### Required Tests

- `keeps a forged log record on the line it was written to`
- `preserves an error stack as escaped text rather than dropping it`
- `falls back to String for a value JSON cannot encode`
- `truncates so one entry cannot flood the log`
- `ignores a token signed with another secret` - for both `optionalAuth` and `requireAuth`
- `continues anonymously when no token is present`

### Performance Budget

n/a. The sanitiser runs only on an error path.

### Out of Scope

- Do not introduce a logging framework; this is a helper, and structured logging is its own decision
- Do not change any route's response body or status code
- Do not touch `console.log` on the startup and shutdown paths, which carry no request data

### Dependencies

None. Independent of #23 and #48.

### Verification

```bash
grep -rn "console.error" apps/api/src --include='*.ts'   # only lib/log.ts
pnpm lint
pnpm turbo build typecheck test
```

### Risk Tier

tier:1 - auth, IAM, deploy, credentials, or codegen

### Size

size:s - under 200 lines
