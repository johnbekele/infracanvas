import { Link } from 'react-router-dom';
import { ArrowRight, Github, Cloud, Code, GitBranch, Zap, Shield } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LogoIcon } from '@/components/ui/Logo';

export function LandingPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white dark:from-gray-950 dark:to-gray-900">
      {/* Header */}
      <header className="border-b border-gray-200 dark:border-gray-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
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
                <Github className="w-5 h-5" />
              </a>
              <Link to="/designer">
                <Button>Open Designer</Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto text-center">
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-gray-900 dark:text-white mb-6">
            Visual AWS Infrastructure
            <span className="block text-violet-600">Designer</span>
          </h1>
          <p className="text-xl text-gray-600 dark:text-gray-400 mb-8 max-w-2xl mx-auto">
            Design your AWS architecture visually and export production-ready Terraform or Pulumi
            code. Push directly to GitHub for automated deployments.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link to="/designer">
              <Button size="lg" className="gap-2 w-full sm:w-auto">
                Start Designing
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <a
              href="https://github.com/johnbekele/infracanvas"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Button variant="outline" size="lg" className="gap-2 w-full sm:w-auto">
                <Github className="w-4 h-4" />
                View on GitHub
              </Button>
            </a>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50 dark:bg-gray-900">
        <div className="max-w-7xl mx-auto">
          <h2 className="text-3xl font-bold text-center text-gray-900 dark:text-white mb-12">
            Everything you need for IaC
          </h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
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
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center">
          <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-4">
            Ready to visualize your infrastructure?
          </h2>
          <p className="text-lg text-gray-600 dark:text-gray-400 mb-8">
            No account required. Start designing right now.
          </p>
          <Link to="/designer">
            <Button size="lg" className="gap-2">
              Open Designer
              <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800 py-8 px-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
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
    <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700">
      <div className="w-12 h-12 bg-violet-100 dark:bg-violet-900/30 rounded-lg flex items-center justify-center mb-4">
        <Icon className="w-6 h-6 text-violet-600" />
      </div>
      <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{title}</h3>
      <p className="text-gray-600 dark:text-gray-400">{description}</p>
    </div>
  );
}
