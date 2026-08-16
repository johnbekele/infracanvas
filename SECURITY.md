# Security policy

## Supported versions

Only `main` is supported. There are no release branches, so fixes land on `main` and are what a
self-hoster pulls.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

https://github.com/johnbekele/infracanvas/security/advisories/new

Do not open a public issue for a vulnerability that could expose credentials or give an attacker a
path into a connected cloud account.

## Response windows

- Acknowledgement within **72 hours** of a private report.
- A fix on `main`, or a public advisory describing the issue, within **90 days**.

These are the windows a solo maintainer can actually meet. If a report needs more time, that is said
in the advisory thread rather than left silent.

## In scope

- This repository (API, web, brain, engine, gates, and scripts)
- Generated infrastructure code this project emits
- Generated workflows this project emits

## Out of scope

- A self-hoster's own AWS account, IAM policies, and network exposure
- Third-party services InfraCanvas talks to (GitHub, AWS, model providers)
- Dependency CVEs with no demonstrated path through this code

## No bounty

There is no bug bounty. Credit in the advisory is offered instead.
