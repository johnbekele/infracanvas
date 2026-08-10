# InfraCanvas

**Visual AWS Infrastructure Designer with GitOps Integration**

Design cloud infrastructure visually, export as Terraform or Pulumi code, and push directly to GitHub with automated deployment workflows.

![InfraCanvas](https://img.shields.io/badge/InfraCanvas-AWS%20Designer-violet?style=for-the-badge)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue?style=for-the-badge)

## Features

- **Visual Designer** - Drag-and-drop AWS services onto a canvas
- **20+ AWS Services** - EC2, Lambda, RDS, S3, DynamoDB, VPC, and more
- **Live Code Preview** - See Terraform/Pulumi code update in real-time
- **Multiple IaC Outputs**
  - Terraform (HCL)
  - Pulumi TypeScript
  - Pulumi Python
- **GitHub Integration** - Push code directly to your repositories
- **GitOps Workflows** - Auto-generate GitHub Actions for CI/CD
- **VPC & Subnet Support** - Design complete network topologies
- **Connection Validation** - Smart validation for service connections
- **Export as ZIP** - Download complete project structure
- **Dark Mode** - Full dark theme support

## Quick Start

### Run Locally

You need Node 20+, pnpm, Docker, and the [GitHub CLI](https://cli.github.com) logged in
(`gh auth login`). No GitHub OAuth application is required.

```bash
git clone https://github.com/johnbekele/infracanvas.git
cd infracanvas
pnpm install

# Postgres 17 with pgvector, on port 5433
pnpm db:up
pnpm db:migrate

# Generate local secrets. AUTH_PROVIDER=token is already set in the example,
# which means the API borrows the token the gh CLI is holding.
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
sed -i '' "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$(openssl rand -hex 32)/" apps/api/.env
sed -i '' "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" apps/api/.env

pnpm dev
```

Open [http://localhost:5173](http://localhost:5173).

### How GitHub authentication works

There are two providers, selected by `AUTH_PROVIDER`.

**`token`** is for local development and single-user self-hosting. The API uses `GITHUB_TOKEN` if it
is set, and otherwise asks the `gh` CLI for the token it already holds, so there is nothing to
register and nothing to paste. Because it signs the caller in as _your_ GitHub account with `repo`
scope, it accepts requests only from the machine it runs on. Set `AUTH_TOKEN_ALLOW_REMOTE=true` only
if everyone who can reach the port is trusted with your repository access.

**`oauth`** is for a hosted, multi-user deployment. Each person authorises the application and gets
their own token, stored encrypted and keyed to their account. It needs `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET` from an OAuth app whose callback URL is `${API_URL}/auth/github/callback`.
This is the default when `AUTH_PROVIDER` is unset, so a deployment that forgets to configure it gets
the multi-user flow rather than sharing one account.

Everything after the token is obtained is identical between the two: the account is identified, the
user is upserted, and the token is encrypted with AES-256-GCM before it touches the database.

### One-Click Deploy

<img width="3003" height="1836" alt="image" src="https://github.com/user-attachments/assets/c9fa7e3a-c6c7-443c-b26a-53efc29aee42" />

### Deploying

The frontend is a static bundle and the API is a separate Express service, so the two are deployed
independently and the frontend has to be told where the API lives.

Set `VITE_API_URL` on the frontend host to the API's origin, for example
`https://infracanvas-api.onrender.com`. This is required, not optional: without it the bundle falls
back to a relative `/api` path, which only resolves under `pnpm dev`, where Vite proxies it to the
local server. A static host has nothing behind `/api` and every request returns the index page.

The API needs `APP_URL` pointed back at the frontend so CORS and the OAuth callback agree on the
same origin. See `apps/api/.env.example` for the full list.

## Usage

### Designing Infrastructure

1. **Add Services** - Drag AWS services from the palette to the canvas
2. **Connect Services** - Click and drag between service ports to create connections
3. **Configure Properties** - Select a service to edit its properties in the right panel
4. **Preview Code** - View generated IaC code in real-time

### GitHub Integration

1. **Connect GitHub** - Click the GitHub button to sign in; locally this uses your `gh` CLI token
2. **Select Repository** - Choose an existing repo or create a new one
3. **Configure & Push** - Set the directory, IaC type, and push your code
4. **GitHub Actions** - Optionally include a CI/CD workflow for automatic deployment

### Supported AWS Services

| Category        | Services                                       |
| --------------- | ---------------------------------------------- |
| **Compute**     | EC2, Lambda, ECS, EKS, Fargate                 |
| **Storage**     | S3, EBS, EFS                                   |
| **Database**    | RDS, DynamoDB, ElastiCache, Aurora             |
| **Networking**  | VPC, Subnet, ALB, NLB, API Gateway, CloudFront |
| **Security**    | IAM, Cognito, Secrets Manager, KMS             |
| **Integration** | SQS, SNS, EventBridge, Step Functions          |
| **Monitoring**  | CloudWatch                                     |

## Project Structure

```
infracanvas/
├── apps/
│   └── web/                    # React + Vite application
│       ├── src/
│       │   ├── components/     # React components
│       │   │   ├── designer/   # Canvas, nodes, panels
│       │   │   ├── github/     # GitHub integration UI
│       │   │   └── ui/         # shadcn/ui components
│       │   └── lib/
│       │       ├── stores/     # Zustand state management
│       │       ├── github/     # GitHub API utilities
│       │       └── gitops/     # Workflow generation
│       └── vite.config.ts
├── packages/
│   └── core/                   # @infracanvas/core package
│       └── src/
│           ├── aws-services.ts # AWS service definitions
│           └── codegen/        # Terraform & Pulumi generators
└── turbo.json                  # Turborepo configuration
```

## Development

### Prerequisites

- Node.js 18+
- pnpm 8+

### Commands

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Run linting
pnpm lint

# Type checking
pnpm typecheck
```

### Core Package

The `@infracanvas/core` package contains all the IaC generation logic and can be used independently:

```typescript
import { generateTerraformProject, generatePulumiProject, awsServices } from '@infracanvas/core';

// Generate Terraform from nodes and edges
const project = generateTerraformProject(nodes, edges);

// Generate Pulumi TypeScript
const pulumiProject = generatePulumiProject(nodes, edges, 'typescript');
```

## GitHub Token Scopes

When creating a Personal Access Token for GitHub integration, use these scopes:

- `repo` - Full control of private repositories

[Create a token here](https://github.com/settings/tokens/new?scopes=repo&description=InfraCanvas)

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Built with [React](https://react.dev/) and [Vite](https://vitejs.dev/)
- Canvas powered by [ReactFlow](https://reactflow.dev/)
- UI components from [shadcn/ui](https://ui.shadcn.com/)
- Icons by [Lucide](https://lucide.dev/)

---

**Made with love for the infrastructure-as-code community**
