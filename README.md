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

```bash
# Clone the repository
git clone https://github.com/johnbekele/infracanvas.git
cd infracanvas

# Install dependencies
pnpm install

# Start development server
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### One-Click Deploy

<img width="3003" height="1836" alt="image" src="https://github.com/user-attachments/assets/c9fa7e3a-c6c7-443c-b26a-53efc29aee42" />

## Usage

### Designing Infrastructure

1. **Add Services** - Drag AWS services from the palette to the canvas
2. **Connect Services** - Click and drag between service ports to create connections
3. **Configure Properties** - Select a service to edit its properties in the right panel
4. **Preview Code** - View generated IaC code in real-time

### GitHub Integration

1. **Connect GitHub** - Click the GitHub button and enter your Personal Access Token
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
