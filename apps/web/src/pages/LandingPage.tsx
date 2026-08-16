import { Link } from 'react-router-dom';
import { ArrowRight, Github } from 'lucide-react';

import { Corners, Label, Panel } from '@/components/ui/blueprint';
import { LogoIcon } from '@/components/ui/Logo';
import { capabilities } from '@/lib/simulation/capabilities';

/**
 * What the product is, in the order someone deciding whether to try it needs.
 *
 * It used to sell a diagram-to-Terraform exporter, which is a thing this can
 * still do and is no longer the reason to use it. The reason is the simulation:
 * four models that answer what a design will cost, how available it will be,
 * how fast it will answer and where it will stop scaling -- before any of it
 * exists.
 *
 * The statistics are counted from the code at load. There are no traction
 * numbers here because there is no traction to report, and a tool arguing for
 * honest figures cannot open with invented ones.
 */
export function LandingPage() {
  const { services, contracts, rules, slas } = capabilities();

  return (
    <div className="bg-background min-h-screen">
      <header className="border-border border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <LogoIcon size={28} />
            <span className="font-heading text-lg font-semibold uppercase tracking-wide">
              InfraCanvas
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/johnbekele/infracanvas"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
              aria-label="GitHub repository"
            >
              <Github className="h-5 w-5" />
            </a>
            <Link
              to="/designer"
              className="border-primary bg-primary text-primary-foreground border px-3 py-1.5 text-sm font-medium"
            >
              Open the canvas
            </Link>
          </div>
        </div>
      </header>

      <section className="border-border border-b px-4 py-20">
        <div className="mx-auto max-w-3xl">
          <Label>Architecture simulation</Label>
          <h1 className="font-heading mt-3 text-4xl font-semibold uppercase leading-[1.05] sm:text-6xl">
            Know what your AWS architecture costs
            <span className="text-primary block">before you deploy it</span>
          </h1>
          <p className="text-muted-foreground mt-6 max-w-2xl text-lg">
            Draw a design, or connect a repository and have one proposed from the code. InfraCanvas
            prices it against the published AWS price list, composes its availability from the
            published SLAs, solves a queueing network for its latency, and finds the first limit it
            will hit under load.
          </p>
          <p className="mt-4 max-w-2xl text-lg">
            Then it shows every rate, quantity and assumption behind each figure — and names
            everything it could not model, so a total reads as the floor it is rather than as an
            answer.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/designer"
              className="border-primary bg-primary text-primary-foreground flex items-center gap-2 border px-4 py-2 font-medium"
            >
              Start drawing
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/repositories"
              className="border-border hover:bg-secondary flex items-center gap-2 border px-4 py-2 font-medium"
            >
              Connect a repository
            </Link>
          </div>
        </div>
      </section>

      <section className="border-border bg-card border-b px-4 py-10">
        <div className="mx-auto grid max-w-6xl gap-px sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            value={String(services)}
            label="AWS services on the canvas"
            note="Compute, data, networking, AI and ML."
          />
          <Stat
            value={String(contracts)}
            label="Resources with a full contract"
            note="Priced, given an availability, and rule-checked."
          />
          <Stat
            value={String(rules)}
            label="Well-Architected rules"
            note="Each names the exact field and the fix."
          />
          <Stat
            value={String(slas)}
            label="Published SLAs modelled"
            note="Availability comes from AWS, not from us."
          />
        </div>
      </section>

      <section className="px-4 py-16">
        <div className="mx-auto max-w-6xl">
          <h2 className="font-heading text-2xl font-semibold uppercase">How it goes</h2>
          <div className="mt-6 grid gap-4 lg:grid-cols-3">
            <Step
              index="01"
              title="Draw it, or have it drawn"
              body="Place services on the canvas with containment that matches AWS — resources inside subnets, subnets inside a VPC. Or connect a GitHub repository and let the analysis propose an architecture from what the code actually does."
            />
            <Step
              index="02"
              title="Read the simulation"
              body="Four models run over the design on every change: cost from the price snapshot, availability composed along the request path, latency from a queueing network, and the first limit reached as load rises. Every assumption behind them is an input you can argue with."
            />
            <Step
              index="03"
              title="Ship it"
              body="Generate Pulumi or Terraform for the design you settled on, with a workflow to deploy it. The code comes from the same document the figures came from, so what you deploy is what was priced."
            />
          </div>
        </div>
      </section>

      <section className="border-border bg-card border-y px-4 py-16">
        <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-2">
          <div>
            <Label>The copilot</Label>
            <h2 className="font-heading mt-2 text-2xl font-semibold uppercase">
              A design tool that argues back
            </h2>
            <p className="text-muted-foreground mt-4">
              Tell it what you care about — spend less, trade latency for accuracy, survive an
              availability zone failure — and it edits the architecture rather than describing an
              edit. Every proposal arrives as a typed patch with the cost, availability and findings
              delta it would cause, and nothing changes until you accept it.
            </p>
            <p className="text-muted-foreground mt-4">
              It runs on your own model key, so the reasoning budget and the provider are yours.
            </p>
          </div>

          <Panel>
            <Label>What honesty costs us</Label>
            <ul className="text-muted-foreground mt-3 space-y-3 text-sm">
              <li>
                <span className="text-foreground">No measured metrics.</span> Nothing here has
                observed a request yet, so there are no time-series charts. Curves are drawn against
                load, which the models can genuinely compute.
              </li>
              <li>
                <span className="text-foreground">Partial coverage, stated.</span> Rules exist for a
                small set of resource kinds. The dashboard shows which pillars were checked rather
                than a row of green ticks.
              </li>
              <li>
                <span className="text-foreground">Every total names its gaps.</span> Resources that
                could not be priced or given an availability are listed by name beside the figure
                they are missing from.
              </li>
            </ul>
          </Panel>
        </div>
      </section>

      <section className="px-4 py-20">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-heading text-3xl font-semibold uppercase">
            Nothing to install, nothing to sign up for
          </h2>
          <p className="text-muted-foreground mt-3">
            The canvas and all four models run in the browser. Open it and draw something.
          </p>
          <Link
            to="/designer"
            className="border-primary bg-primary text-primary-foreground mt-6 inline-flex items-center gap-2 border px-4 py-2 font-medium"
          >
            Open the canvas
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      <footer className="border-border border-t px-4 py-8">
        <div className="text-muted-foreground mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-sm sm:flex-row">
          <div className="flex items-center gap-2">
            <LogoIcon size={18} />
            <span>InfraCanvas — MIT licensed</span>
          </div>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/johnbekele/infracanvas"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground"
            >
              GitHub
            </a>
            <a
              href="https://github.com/johnbekele/infracanvas/blob/main/docs"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground"
            >
              Documentation
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Stat({ value, label, note }: { value: string; label: string; note: string }) {
  return (
    <div className="bg-card relative p-4">
      <Corners />
      <p className="tabular font-heading text-3xl font-semibold leading-none">{value}</p>
      <p className="mt-1.5 text-sm font-medium">{label}</p>
      <p className="text-muted-foreground mt-0.5 text-xs">{note}</p>
    </div>
  );
}

function Step({ index, title, body }: { index: string; title: string; body: string }) {
  return (
    <div className="border-border bg-card relative border p-4">
      <Corners />
      <Label>{index}</Label>
      <h3 className="font-heading mt-1 text-lg font-semibold uppercase">{title}</h3>
      <p className="text-muted-foreground mt-2 text-sm">{body}</p>
    </div>
  );
}
