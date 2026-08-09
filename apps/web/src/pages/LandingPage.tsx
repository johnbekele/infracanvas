import { Link } from 'react-router-dom';
import { ArrowRight, Github, Cloud, Code, GitBranch, Zap, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LogoIcon } from '@/components/ui/Logo';

export function LandingPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white dark:from-gray-950 dark:to-gray-900">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center gap-2">
              <LogoIcon size={32} />
              <span className="text-xl font-bold text-gray-900 dark:text-white">InfraCanvas</span>
            </div>
            <div className="flex items-center gap-4">
              <a
                href="https://github.com/johnbekele/infracanvas"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
              >
                <Github className="h-5 w-5" />
              </a>
              <Link to="/designer">
                <Button>Open Designer</Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="mb-6 text-4xl font-bold text-gray-900 sm:text-5xl lg:text-6xl dark:text-white">
            Visual AWS Infrastructure
            <span className="block text-violet-600">Designer</span>
          </h1>
          <p className="mx-auto mb-8 max-w-2xl text-xl text-gray-600 dark:text-gray-400">
            Design your AWS architecture visually and export production-ready Terraform or Pulumi
            code. Push directly to GitHub for automated deployments.
          </p>
          <div className="flex flex-col justify-center gap-4 sm:flex-row">
            <Link to="/designer">
              <Button size="lg" className="w-full gap-2 sm:w-auto">
                Start Designing
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
            <a
              href="https://github.com/johnbekele/infracanvas"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="outline" size="lg" className="w-full gap-2 sm:w-auto">
                <Github className="h-4 w-4" />
                View on GitHub
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="bg-gray-50 px-4 py-20 sm:px-6 lg:px-8 dark:bg-gray-900">
        <div className="mx-auto max-w-7xl">
          <h2 className="mb-12 text-center text-3xl font-bold text-gray-900 dark:text-white">
            Everything you need for IaC
          </h2>
          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
            <FeatureCard
              icon={Cloud}
              title="20+ AWS Services"
              description="Support for EC2, Lambda, S3, RDS, DynamoDB, API Gateway, and many more AWS services."
            />
            <FeatureCard
              icon={Code}
              title="Multi-Language Export"
              description="Export to Terraform HCL, Pulumi TypeScript, or Pulumi Python with proper modules."
            />
            <FeatureCard
              icon={Github}
              title="GitHub Integration"
              description="Push your infrastructure code directly to GitHub repositories with one click."
            />
            <FeatureCard
              icon={GitBranch}
              title="GitOps Ready"
              description="Auto-generate GitHub Actions workflows for CI/CD deployments."
            />
            <FeatureCard
              icon={Zap}
              title="Real-time Preview"
              description="See your generated code update in real-time as you design."
            />
            <FeatureCard
              icon={Shield}
              title="Best Practices"
              description="Generated code follows AWS and IaC best practices out of the box."
            />
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="mb-4 text-3xl font-bold text-gray-900 dark:text-white">
            Ready to visualize your infrastructure?
          </h2>
          <p className="mb-8 text-lg text-gray-600 dark:text-gray-400">
            No account required. Start designing right now.
          </p>
          <Link to="/designer">
            <Button size="lg" className="gap-2">
              Open Designer
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 px-4 py-8 dark:border-gray-800">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2">
            <LogoIcon size={20} />
            <span className="text-sm text-gray-600 dark:text-gray-400">
              InfraCanvas - MIT License
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/johnbekele/infracanvas"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
            >
              GitHub
            </a>
            <a
              href="https://github.com/johnbekele/infracanvas/blob/main/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
            >
              Documentation
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-violet-100 dark:bg-violet-900/30">
        <Icon className="h-6 w-6 text-violet-600" />
      </div>
      <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
      <p className="text-gray-600 dark:text-gray-400">{description}</p>
    </div>
  );
}
