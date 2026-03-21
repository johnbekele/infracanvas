# InfraCanvas - Extraction Plan

## Overview

**Problem:** The AWS Architecture Designer in Archyra is a powerful visual IaC tool that deserves to be a standalone open-source project.

**Goal:** Extract the architecture designer into **InfraCanvas** - an open-source visual AWS infrastructure designer with GitHub integration for GitOps workflows.

**Source Project:** `/Users/yohansbekele/Archyra`
**Target Project:** `/Users/yohansbekele/infracanvas`

---

## Project Specifications

| Attribute | Value |
|-----------|-------|
| **Name** | InfraCanvas |
| **Type** | Open-source (MIT license) |
| **Framework** | React + Vite |
| **Distribution** | npm package + GitHub source |
| **Auth** | GitHub OAuth (optional, for repo integration) |
| **Cloud Scope** | AWS only (20+ services) |
| **IaC Outputs** | Terraform HCL, Pulumi TypeScript, Pulumi Python |
| **GitHub Features** | Push to repo + GitHub Actions workflow generation |

---

## Repository Structure

```
infracanvas/
├── apps/
│   └── web/                          # React + Vite app
│       ├── src/
│       │   ├── components/
│       │   │   ├── designer/         # Canvas, nodes, panels
│       │   │   ├── ui/               # shadcn/ui components
│       │   │   └── github/           # GitHub integration UI
│       │   ├── lib/
│       │   │   ├── stores/           # Zustand stores
│       │   │   ├── github/           # GitHub API utilities
│       │   │   └── gitops/           # Workflow generation
│       │   ├── pages/                # React Router pages
│       │   └── App.tsx
│       ├── index.html
│       └── vite.config.ts
├── packages/
│   └── core/                         # Publishable @infracanvas/core
│       ├── src/
│       │   ├── aws-services.ts
│       │   ├── codegen/
│       │   │   ├── terraform.ts
│       │   │   ├── pulumi.ts
│       │   │   └── zip.ts
│       │   └── types.ts
│       └── package.json
├── docs/                             # Documentation
├── .github/workflows/                # CI/CD
├── turbo.json
├── package.json
├── README.md
├── LICENSE
└── CONTRIBUTING.md
```

---

## Files to Extract from Archyra

### Core Logic (→ `packages/core/`)

| Source File | Purpose |
|-------------|---------|
| `/lib/aws-services.ts` | AWS service definitions |
| `/lib/codegen/terraform-generator.ts` | Terraform HCL generation |
| `/lib/codegen/pulumi-generator.ts` | Pulumi TS/Python generation |
| `/lib/codegen/zip-exporter.ts` | ZIP packaging |
| `/lib/architecture-types.ts` | TypeScript types |

### Designer Components (→ `apps/web/src/components/designer/`)

| Source File | Purpose |
|-------------|---------|
| `/components/designer/DesignerCanvas.tsx` | Main ReactFlow canvas |
| `/components/designer/ServiceNode.tsx` | AWS service node rendering |
| `/components/designer/VpcEnvironmentNode.tsx` | VPC container node |
| `/components/designer/SubnetNode.tsx` | Subnet container node |
| `/components/designer/ServicePalette.tsx` | Service selection sidebar |
| `/components/designer/PropertiesPanel.tsx` | Node property editor |
| `/components/designer/CodePanel.tsx` | Live code preview |
| `/components/designer/DesignerToolbar.tsx` | Canvas controls |
| `/components/designer/DeletableEdge.tsx` | Custom edge connections |

### State Management (→ `apps/web/src/lib/stores/`)

| Source File | Purpose |
|-------------|---------|
| `/lib/stores/designer-store.ts` | Zustand store for canvas state |

---

## Dependencies

### Keep from Archyra
- `reactflow` - Diagram canvas
- `zustand` - State management
- `jszip` - ZIP export
- `framer-motion` - Animations
- `lucide-react` - Icons
- All Radix UI components
- `tailwind-merge`, `clsx`, `class-variance-authority`

### New Dependencies
- `@octokit/rest` - GitHub API client
- `react-router-dom` - Client-side routing
- `@tanstack/react-query` - Data fetching/caching

---

## Implementation Phases

See `EXECUTION_PLAN.md` for detailed execution steps.

| Phase | Description | Duration |
|-------|-------------|----------|
| Phase 1 | Project Setup | 3-4 days |
| Phase 2 | Core Migration | 4-5 days |
| Phase 3 | GitHub Integration | 5-7 days |
| Phase 4 | GitOps Pipeline | 3-4 days |
| Phase 5 | Polish & Launch | 3-4 days |

---

## Key Decisions

1. **React + Vite over Next.js** - No SSR needed, lighter bundle
2. **Monorepo with Turborepo** - Allows publishing `@infracanvas/core` separately
3. **GitHub OAuth with PKCE** - Secure, no backend required
4. **pnpm** - Fast installs, efficient disk usage
5. **MIT License** - Maximum adoption potential
