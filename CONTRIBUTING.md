# Contributing to InfraCanvas

Thank you for your interest in contributing to InfraCanvas! This document provides guidelines and instructions for contributing.

## Code of Conduct

Please be respectful and considerate in all interactions. We want to maintain a welcoming environment for everyone.

## Getting Started

### Prerequisites

- Node.js 18 or higher
- pnpm 8 or higher
- Git

### Development Setup

1. **Fork and clone the repository**

   ```bash
   git clone https://github.com/YOUR_USERNAME/infracanvas.git
   cd infracanvas
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

3. **Start the development server**

   ```bash
   pnpm dev
   ```

4. **Open the app**

   Visit [http://localhost:5173](http://localhost:5173)

## Project Structure

```
infracanvas/
├── apps/
│   └── web/                    # Main React application
│       ├── src/
│       │   ├── components/     # React components
│       │   │   ├── designer/   # Canvas and node components
│       │   │   ├── github/     # GitHub integration
│       │   │   └── ui/         # shadcn/ui components
│       │   ├── lib/
│       │   │   ├── stores/     # Zustand stores
│       │   │   ├── github/     # GitHub API utilities
│       │   │   └── gitops/     # Workflow generation
│       │   └── pages/          # Route pages
│       └── vite.config.ts
├── packages/
│   └── core/                   # Core IaC generation package
│       └── src/
│           ├── aws-services.ts # AWS service definitions
│           ├── codegen/        # Code generators
│           └── types.ts        # Type definitions
└── turbo.json
```

## Making Changes

### Workflow

1. **Create a feature branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Follow the existing code style
   - Add tests if applicable
   - Update documentation if needed

3. **Test your changes**

   ```bash
   pnpm build
   pnpm lint
   pnpm typecheck
   ```

4. **Commit your changes**

   Use clear, descriptive commit messages:

   ```bash
   git commit -m "feat: add support for AWS Lambda Layers"
   ```

5. **Push and create a Pull Request**

   ```bash
   git push origin feature/your-feature-name
   ```

### Commit Message Format

We follow conventional commits:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Maintenance tasks

## Adding AWS Services

To add a new AWS service:

1. **Edit `packages/core/src/aws-services.ts`**

   Add the service definition:

   ```typescript
   {
     id: 'aws-service-name',
     name: 'Service Name',
     category: 'Category',
     description: 'Description of the service',
     icon: 'icon-name',
     color: '#hexcolor',
     defaultProperties: {
       // Default property values
     },
     propertySchema: [
       // Property definitions
     ],
     connections: {
       // Connection rules
     },
   }
   ```

2. **Add Terraform generation in `packages/core/src/codegen/terraform.ts`**

3. **Add Pulumi generation in `packages/core/src/codegen/pulumi.ts`**

4. **Test the new service**
   - Verify it appears in the service palette
   - Test drag and drop
   - Test property editing
   - Test code generation

## Pull Request Guidelines

- **Keep PRs focused** - One feature or fix per PR
- **Write clear descriptions** - Explain what and why
- **Include screenshots** - For UI changes
- **Update documentation** - If behavior changes
- **Test thoroughly** - Ensure the build passes

## Questions?

Feel free to open an issue if you have questions or need help getting started.

Thank you for contributing!
