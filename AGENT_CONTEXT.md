# InfraCanvas - Agent Context File

**Last Updated:** 2026-03-19
**Current Phase:** Phase 2 - Core Migration ✅ COMPLETE

---

## Quick Context

This is an extraction project to create **InfraCanvas** from the Archyra AWS Architecture Designer.

- **Source:** `/Users/yohansbekele/Archyra`
- **Target:** `/Users/yohansbekele/infracanvas`
- **Goal:** Standalone open-source visual AWS infrastructure designer

---

## Current Status

### ✅ COMPLETED

#### Phase 1: Project Setup (100%)
- Monorepo structure with Turborepo + pnpm
- `packages/core/` - TypeScript package with tsup
- `apps/web/` - Vite + React + TypeScript + Tailwind
- 11 shadcn/ui components created
- 3 pages created (Landing, Designer, Callback)

#### Phase 2: Core Migration (100%) ✅
- `packages/core/src/types.ts` ✅
- `packages/core/src/aws-services.ts` ✅ (20+ services)
- `packages/core/src/codegen/terraform.ts` ✅
- `packages/core/src/codegen/pulumi.ts` ✅
- `packages/core/src/codegen/zip.ts` ✅
- `packages/core/src/index.ts` ✅
- `apps/web/src/lib/stores/designer-store.ts` ✅
- All 9 designer components migrated ✅:
  - [x] DesignerCanvas.tsx
  - [x] ServiceNode.tsx
  - [x] VpcEnvironmentNode.tsx
  - [x] SubnetNode.tsx
  - [x] ServicePalette.tsx
  - [x] PropertiesPanel.tsx
  - [x] CodePanel.tsx
  - [x] DesignerToolbar.tsx
  - [x] DeletableEdge.tsx
  - [x] index.ts (barrel export)
- Build tested: `pnpm build` ✅

### ⏳ PENDING

- Phase 3: GitHub Integration
- Phase 4: GitOps Pipeline
- Phase 5: Polish & Launch

---

## File Locations Reference

### Source Files (Archyra)
```
/Users/yohansbekele/Archyra/
├── lib/
│   ├── aws-services.ts
│   ├── architecture-types.ts
│   ├── stores/designer-store.ts
│   └── codegen/
│       ├── terraform-generator.ts
│       ├── pulumi-generator.ts
│       └── zip-exporter.ts
└── components/designer/
    ├── DesignerCanvas.tsx
    ├── ServiceNode.tsx
    ├── VpcEnvironmentNode.tsx
    ├── SubnetNode.tsx
    ├── ServicePalette.tsx
    ├── PropertiesPanel.tsx
    ├── CodePanel.tsx
    ├── DesignerToolbar.tsx
    └── DeletableEdge.tsx
```

### Target Files (InfraCanvas)
```
/Users/yohansbekele/infracanvas/
├── packages/core/src/
│   ├── index.ts ✅
│   ├── types.ts ✅
│   ├── aws-services.ts ✅
│   └── codegen/
│       ├── terraform.ts ✅
│       ├── pulumi.ts ✅
│       └── zip.ts ✅
└── apps/web/src/
    ├── components/
    │   ├── ui/ ✅ (11 components)
    │   ├── designer/ ⏳ (needs migration)
    │   └── github/ ⏳ (Phase 3)
    ├── lib/
    │   ├── utils.ts ✅
    │   ├── stores/ ⏳ (needs migration)
    │   ├── github/ ⏳ (Phase 3)
    │   └── gitops/ ⏳ (Phase 4)
    └── pages/
        ├── LandingPage.tsx ✅
        ├── DesignerPage.tsx ✅ (needs update)
        └── CallbackPage.tsx ✅
```

---

## Migration Notes

### Import Changes Required
When migrating components from Archyra to InfraCanvas:

1. **Remove `'use client'`** - Not needed in Vite
2. **Update `@/` imports:**
   - `@/lib/aws-services` → `@infracanvas/core`
   - `@/lib/stores/designer-store` → `@/lib/stores/designer-store`
   - `@/components/ui/*` → `@/components/ui/*` (same)
3. **Update branding:**
   - "Archyra" → "InfraCanvas"
   - "archyra-" → "infracanvas-" (localStorage keys)

### Key Exports from @infracanvas/core
```typescript
// AWS Services
import { awsServices, serviceCategories, getServiceById, canConnect } from '@infracanvas/core';

// Code Generators
import { generateTerraform, generateTerraformProject } from '@infracanvas/core';
import { generatePulumi, generatePulumiProject } from '@infracanvas/core';

// ZIP Export
import { exportTerraformZip, exportPulumiZip, downloadBlob } from '@infracanvas/core';

// Types
import type { ServiceNodeData, PulumiLanguage } from '@infracanvas/core';
```

---

## Next Steps (In Order)

1. Create `apps/web/src/lib/stores/designer-store.ts`
2. Create all 9 designer components in `apps/web/src/components/designer/`
3. Update `DesignerPage.tsx` to wire everything together
4. Test build with `pnpm install && pnpm build`
5. Mark Phase 2 complete, update this file
6. Begin Phase 3: GitHub Integration

---

## Commands

```bash
# Navigate to project
cd /Users/yohansbekele/infracanvas

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run development server
pnpm dev

# Build core package only
cd packages/core && pnpm build
```

---

## Session History

| Date | Session | Work Done |
|------|---------|-----------|
| 2026-03-19 | Session 1 | Phase 1 complete, Phase 2 started (core logic migrated) |

---

*Update this file after completing each phase or significant milestone.*
