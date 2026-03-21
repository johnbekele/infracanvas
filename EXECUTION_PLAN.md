# InfraCanvas - Detailed Execution Plan

This document contains step-by-step execution plans for each phase.

---

## Phase 1: Project Setup ✅ COMPLETE

### 1.1 Initialize Monorepo ✅
- [x] Create `/Users/yohansbekele/infracanvas/` directory
- [x] Create root `package.json` with Turborepo
- [x] Create `pnpm-workspace.yaml`
- [x] Create `turbo.json` configuration
- [x] Create root `tsconfig.json`
- [x] Create `.gitignore`
- [x] Create `.prettierrc` and `.prettierignore`

### 1.2 Set up packages/core ✅
- [x] Create `packages/core/package.json`
- [x] Create `packages/core/tsconfig.json`
- [x] Create `packages/core/tsup.config.ts`
- [x] Create directory structure: `src/`, `src/codegen/`

### 1.3 Set up apps/web ✅
- [x] Create `apps/web/package.json` with all dependencies
- [x] Create `apps/web/tsconfig.json`
- [x] Create `apps/web/vite.config.ts`
- [x] Create `apps/web/index.html`
- [x] Create `apps/web/tailwind.config.js`
- [x] Create `apps/web/postcss.config.js`
- [x] Create `apps/web/src/index.css` with Tailwind and CSS variables
- [x] Create `apps/web/src/main.tsx` with React Router and React Query
- [x] Create `apps/web/src/App.tsx` with routes
- [x] Create `apps/web/src/lib/utils.ts` (cn function)

### 1.4 Create UI Components ✅
- [x] `components/ui/button.tsx`
- [x] `components/ui/input.tsx`
- [x] `components/ui/label.tsx`
- [x] `components/ui/textarea.tsx`
- [x] `components/ui/switch.tsx`
- [x] `components/ui/select.tsx`
- [x] `components/ui/tabs.tsx`
- [x] `components/ui/toggle-group.tsx`
- [x] `components/ui/dropdown-menu.tsx`
- [x] `components/ui/tooltip.tsx`
- [x] `components/ui/toaster.tsx`

### 1.5 Create Pages ✅
- [x] `pages/LandingPage.tsx`
- [x] `pages/DesignerPage.tsx`
- [x] `pages/CallbackPage.tsx` (for OAuth)

---

## Phase 2: Core Migration ✅ COMPLETE

### 2.1 Migrate Core Types ✅
- [x] Create `packages/core/src/types.ts`
  - ServiceNodeData interface
  - ArchitectureDesign interface
  - VpcHierarchy, SubnetHierarchy types
  - PulumiLanguage type

### 2.2 Migrate AWS Services ✅
- [x] Create `packages/core/src/aws-services.ts`
  - Copy all 20+ service definitions
  - Update branding from "Archyra" to "InfraCanvas"
  - Export serviceCategories, awsServices
  - Export getServiceById, getServicesByCategory, canConnect

### 2.3 Migrate Code Generators ✅
- [x] Create `packages/core/src/codegen/terraform.ts`
  - generateTerraform() - single file preview
  - generateTerraformProject() - modular project
  - All module generators (EC2, Lambda, S3, RDS, etc.)
- [x] Create `packages/core/src/codegen/pulumi.ts`
  - generatePulumi() - single file preview
  - generatePulumiProject() - full project
  - TypeScript and Python generators
- [x] Create `packages/core/src/codegen/zip.ts`
  - exportTerraformZip()
  - exportPulumiZip()
  - downloadBlob()

### 2.4 Create Core Index ✅
- [x] Create `packages/core/src/index.ts`
  - Export all types
  - Export all services
  - Export all generators

### 2.5 Migrate Designer Store ✅
- [x] Create `apps/web/src/lib/stores/designer-store.ts`
  - Copied from Archyra
  - Updated imports to use `@infracanvas/core`
  - Changed localStorage key to `infracanvas-designer-v1`

### 2.6 Migrate Designer Components ✅
- [x] Create `apps/web/src/components/designer/DesignerCanvas.tsx`
  - Removed `'use client'` directive
  - Updated imports to use `@infracanvas/core`
- [x] Create `apps/web/src/components/designer/ServiceNode.tsx`
- [x] Create `apps/web/src/components/designer/VpcEnvironmentNode.tsx`
- [x] Create `apps/web/src/components/designer/SubnetNode.tsx`
- [x] Create `apps/web/src/components/designer/ServicePalette.tsx`
- [x] Create `apps/web/src/components/designer/PropertiesPanel.tsx`
- [x] Create `apps/web/src/components/designer/CodePanel.tsx`
- [x] Create `apps/web/src/components/designer/DesignerToolbar.tsx`
- [x] Create `apps/web/src/components/designer/DeletableEdge.tsx`
- [x] Create `apps/web/src/components/designer/index.ts` (barrel export)

### 2.7 Update DesignerPage ✅
- [x] Updated `pages/DesignerPage.tsx` to use migrated components
- [x] Wired up ReactFlow with proper providers

### 2.8 Test Build ✅
- [x] Run `pnpm install` in root
- [x] Run `pnpm build` to verify no errors
- Build output:
  - @infracanvas/core: dist/index.js (56.66 KB), dist/index.mjs (56.17 KB)
  - @infracanvas/web: dist/index.html, dist/assets/index.css (50.24 KB), dist/assets/index.js (816.78 KB)

---

## Phase 3: GitHub Integration ⏳ PENDING

### 3.1 GitHub Auth Utilities
- [ ] Create `apps/web/src/lib/github/config.ts`
  - GitHub OAuth app configuration
  - Client ID, redirect URI
- [ ] Create `apps/web/src/lib/github/auth.ts`
  - generatePKCEChallenge()
  - initiateOAuthFlow()
  - exchangeCodeForToken()
  - refreshToken()
  - logout()
- [ ] Create `apps/web/src/lib/github/api.ts`
  - createOctokit() - authenticated client
  - getUser()
  - listRepos()
  - getRepo()
  - createRepo()
  - listBranches()
  - createBranch()
  - pushFiles()
- [ ] Create `apps/web/src/lib/github/types.ts`
  - GitHubUser interface
  - GitHubRepo interface
  - GitHubBranch interface
- [ ] Create `apps/web/src/lib/github/hooks.ts`
  - useGitHubAuth() - auth state hook
  - useGitHubUser() - current user query
  - useGitHubRepos() - repos list query
  - useGitHubBranches() - branches query

### 3.2 GitHub UI Components
- [ ] Create `apps/web/src/components/github/GitHubLoginButton.tsx`
  - Login/logout button
  - Show user avatar when logged in
- [ ] Create `apps/web/src/components/github/RepositorySelector.tsx`
  - Dropdown to select existing repo
  - Option to create new repo
- [ ] Create `apps/web/src/components/github/BranchSelector.tsx`
  - Dropdown to select branch
  - Option to create new branch
- [ ] Create `apps/web/src/components/github/CommitDialog.tsx`
  - Commit message input
  - File preview
  - Confirm/cancel buttons
- [ ] Create `apps/web/src/components/github/PushToGitHubButton.tsx`
  - Main trigger button
  - Opens full push flow dialog

### 3.3 Update Callback Page
- [ ] Update `pages/CallbackPage.tsx`
  - Handle OAuth code exchange
  - Store token securely
  - Redirect to designer

### 3.4 Integrate with Toolbar
- [ ] Update `DesignerToolbar.tsx`
  - Add GitHub login button
  - Add "Push to GitHub" in export menu

---

## Phase 4: GitOps Pipeline ⏳ PENDING

### 4.1 Workflow Templates
- [ ] Create `apps/web/src/lib/gitops/templates/terraform.yml`
  - GitHub Actions workflow for Terraform
  - terraform init, plan, apply
  - AWS credentials from secrets
- [ ] Create `apps/web/src/lib/gitops/templates/pulumi-ts.yml`
  - GitHub Actions workflow for Pulumi TypeScript
  - pulumi preview, up
- [ ] Create `apps/web/src/lib/gitops/templates/pulumi-py.yml`
  - GitHub Actions workflow for Pulumi Python

### 4.2 Workflow Generator
- [ ] Create `apps/web/src/lib/gitops/workflow-generator.ts`
  - generateTerraformWorkflow()
  - generatePulumiWorkflow()
  - Include workflow in push if user opts in

### 4.3 Workflow Options UI
- [ ] Add checkbox in CommitDialog
  - "Include GitHub Actions workflow"
  - Select workflow type

---

## Phase 5: Polish & Launch ⏳ PENDING

### 5.1 Documentation
- [ ] Create `README.md` with:
  - Project description
  - Screenshots/GIFs
  - Quick start guide
  - Features list
  - Deploy buttons
- [ ] Create `LICENSE` (MIT)
- [ ] Create `CONTRIBUTING.md`
- [ ] Create `SECURITY.md`

### 5.2 CI/CD Workflows
- [ ] Create `.github/workflows/ci.yml`
  - Lint, typecheck, test, build
  - Run on PR and push to main
- [ ] Create `.github/workflows/release.yml`
  - Publish @infracanvas/core to npm
  - Trigger on version tag
- [ ] Create `.github/workflows/deploy-docs.yml`
  - Deploy docs to GitHub Pages

### 5.3 Deploy Buttons
- [ ] Add Vercel deploy button to README
- [ ] Add Netlify deploy button to README
- [ ] Test one-click deploys

### 5.4 Final Testing
- [ ] Manual test full design flow
- [ ] Manual test GitHub OAuth flow
- [ ] Manual test push to repository
- [ ] Test on Vercel deployment

### 5.5 Create GitHub Repository
- [ ] Initialize git in infracanvas/
- [ ] Create remote repo: johnbekele/infracanvas
- [ ] Push initial commit
- [ ] Set up branch protection

---

## Verification Checklist

### Unit Tests
- [ ] AWS service definitions load correctly
- [ ] Terraform generator produces valid HCL
- [ ] Pulumi generator produces valid TypeScript/Python
- [ ] ZIP exporter creates downloadable files

### Integration Tests
- [ ] Canvas renders with drag-and-drop
- [ ] Nodes connect with edges
- [ ] Properties panel updates node data
- [ ] Code panel shows generated code

### E2E Tests
- [ ] Full design flow: add → connect → export
- [ ] GitHub OAuth flow
- [ ] Push to repository flow
