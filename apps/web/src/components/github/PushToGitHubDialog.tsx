import { useState, useEffect } from 'react';
import {
  Github, GitBranch, FolderGit2, Loader2, CheckCircle2,
  XCircle, ExternalLink, Plus, RefreshCw
} from 'lucide-react';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useDesignerStore } from '@/lib/stores/designer-store';
import { githubApi } from '@/lib/api/client';
import {
  generateTerraformProject,
  generatePulumiProject,
} from '@infracanvas/core';
import { generateWorkflow, generateWorkflowReadme } from '@/lib/gitops';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  owner: { login: string };
}

interface GitHubBranch {
  name: string;
  commit: { sha: string };
}

interface PushToGitHubDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 'select-repo' | 'configure' | 'pushing' | 'success' | 'error';
type IaCType = 'terraform' | 'pulumi-ts' | 'pulumi-py';

export function PushToGitHubDialog({
  open,
  onOpenChange,
}: PushToGitHubDialogProps) {
  const { isAuthenticated, login } = useAuthStore();
  const { nodes, edges, designName } = useDesignerStore();

  const [step, setStep] = useState<Step>('select-repo');
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [branches, setBranches] = useState<GitHubBranch[]>([]);
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState('main');
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [_isLoadingBranches, setIsLoadingBranches] = useState(false);

  // Config state
  const [iacType, setIacType] = useState<IaCType>('terraform');
  const [directory, setDirectory] = useState('infrastructure');
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranchName, setNewBranchName] = useState('');
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [includeWorkflow, setIncludeWorkflow] = useState(true);

  // New repo state
  const [showNewRepo, setShowNewRepo] = useState(false);
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoPrivate] = useState(true);
  const [isCreatingRepo, setIsCreatingRepo] = useState(false);

  // Result state
  const [pushResult, setPushResult] = useState<{ success: boolean; message: string; commitUrl?: string } | null>(null);

  // Load repos on mount
  useEffect(() => {
    if (open && isAuthenticated) {
      loadRepos();
    }
  }, [open, isAuthenticated]);

  // Load branches when repo changes
  useEffect(() => {
    if (selectedRepo) {
      loadBranches();
    }
  }, [selectedRepo]);

  // Set default commit message
  useEffect(() => {
    if (!commitMessage) {
      setCommitMessage(`Add ${designName} infrastructure`);
    }
  }, [designName]);

  const loadRepos = async () => {
    setIsLoadingRepos(true);
    try {
      const repoList = await githubApi.listRepos();
      setRepos(repoList);
    } catch (error) {
      console.error('Failed to load repos:', error);
    } finally {
      setIsLoadingRepos(false);
    }
  };

  const loadBranches = async () => {
    if (!selectedRepo) return;
    setIsLoadingBranches(true);
    try {
      const branchList = await githubApi.listBranches(
        selectedRepo.owner.login,
        selectedRepo.name
      );
      setBranches(branchList);
      // Set default branch
      if (!selectedBranch || !branchList.find(b => b.name === selectedBranch)) {
        setSelectedBranch(selectedRepo.default_branch || 'main');
      }
    } catch (error) {
      console.error('Failed to load branches:', error);
    } finally {
      setIsLoadingBranches(false);
    }
  };

  const handleCreateRepo = async () => {
    if (!newRepoName.trim()) return;
    setIsCreatingRepo(true);
    try {
      const response = await githubApi.createRepo(
        newRepoName.trim(),
        `Infrastructure for ${designName}`,
        newRepoPrivate
      );
      // Refetch repos to get the full repo object with owner info
      await loadRepos();
      const fullRepo = repos.find(r => r.name === response.name);
      if (fullRepo) {
        setSelectedRepo(fullRepo);
      }
      setShowNewRepo(false);
      setNewRepoName('');
    } catch (error) {
      console.error('Failed to create repo:', error);
    } finally {
      setIsCreatingRepo(false);
    }
  };

  const handleCreateBranch = async () => {
    if (!selectedRepo || !newBranchName.trim()) return;
    setIsCreatingBranch(true);
    try {
      await githubApi.createBranch(
        selectedRepo.owner.login,
        selectedRepo.name,
        newBranchName.trim(),
        selectedBranch
      );
      await loadBranches();
      setSelectedBranch(newBranchName.trim());
      setNewBranchName('');
    } catch (error) {
      console.error('Failed to create branch:', error);
    } finally {
      setIsCreatingBranch(false);
    }
  };

  const handlePush = async () => {
    if (!selectedRepo) return;

    setStep('pushing');

    try {
      // Generate files based on IaC type
      let files: { path: string; content: string }[] = [];

      if (iacType === 'terraform') {
        const project = generateTerraformProject(nodes, edges);
        files = project.files.map((f) => ({
          path: `${directory}/${f.path}`,
          content: f.content,
        }));
      } else {
        const language = iacType === 'pulumi-ts' ? 'typescript' : 'python';
        const project = generatePulumiProject(nodes, edges, language);
        files = project.files.map((f) => ({
          path: `${directory}/${f.path}`,
          content: f.content,
        }));
      }

      // Add GitHub Actions workflow if enabled
      if (includeWorkflow) {
        const workflow = generateWorkflow({
          iacType,
          directory,
          branch: selectedBranch,
          autoApply: false,
        });
        files.push({
          path: workflow.path,
          content: workflow.content,
        });

        // Add README with setup instructions
        const readme = generateWorkflowReadme(iacType);
        files.push({
          path: `${directory}/README.md`,
          content: readme,
        });
      }

      const result = await githubApi.pushFiles(
        selectedRepo.owner.login,
        selectedRepo.name,
        selectedBranch,
        commitMessage,
        files
      );

      setPushResult({
        success: result.success,
        message: result.message,
        commitUrl: result.commitUrl,
      });
      setStep(result.success ? 'success' : 'error');
    } catch (error) {
      setPushResult({
        success: false,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      setStep('error');
    }
  };

  const handleClose = () => {
    setStep('select-repo');
    setPushResult(null);
    onOpenChange(false);
  };

  if (!open) return null;

  if (!isAuthenticated) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
        <div className="relative bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md mx-4 p-6 text-center">
          <Github className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <h2 className="text-lg font-semibold mb-2">Connect GitHub</h2>
          <p className="text-gray-500 mb-6">
            Sign in with GitHub to push infrastructure code directly to your repositories.
          </p>
          <Button onClick={login} className="gap-2">
            <Github className="w-4 h-4" />
            Connect GitHub
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      <div className="relative bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-3">
          <FolderGit2 className="w-5 h-5 text-violet-500" />
          <h2 className="font-semibold text-gray-900 dark:text-white">
            Push to GitHub
          </h2>
        </div>

        {/* Content */}
        <div className="p-6">
          {step === 'select-repo' && (
            <div className="space-y-4">
              {/* Repository Selection */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Repository</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1"
                    onClick={() => setShowNewRepo(!showNewRepo)}
                  >
                    <Plus className="w-3 h-3" />
                    New
                  </Button>
                </div>

                {showNewRepo ? (
                  <div className="flex gap-2">
                    <Input
                      placeholder="my-infrastructure"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                    />
                    <Button
                      onClick={handleCreateRepo}
                      disabled={!newRepoName.trim() || isCreatingRepo}
                    >
                      {isCreatingRepo ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create'}
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Select
                      value={selectedRepo?.full_name || ''}
                      onValueChange={(value) => {
                        const repo = repos.find((r) => r.full_name === value);
                        setSelectedRepo(repo || null);
                      }}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select a repository" />
                      </SelectTrigger>
                      <SelectContent>
                        {repos.map((repo) => (
                          <SelectItem key={repo.id} value={repo.full_name}>
                            {repo.full_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={loadRepos}
                      disabled={isLoadingRepos}
                    >
                      <RefreshCw className={`w-4 h-4 ${isLoadingRepos ? 'animate-spin' : ''}`} />
                    </Button>
                  </div>
                )}
              </div>

              {/* Branch Selection */}
              {selectedRepo && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Branch</Label>
                  </div>
                  <div className="flex gap-2">
                    <Select
                      value={selectedBranch}
                      onValueChange={setSelectedBranch}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {branches.map((branch) => (
                          <SelectItem key={branch.name} value={branch.name}>
                            <div className="flex items-center gap-2">
                              <GitBranch className="w-3 h-3" />
                              {branch.name}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder="new-branch"
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      className="w-32"
                    />
                    <Button
                      variant="outline"
                      onClick={handleCreateBranch}
                      disabled={!newBranchName.trim() || isCreatingBranch}
                    >
                      {isCreatingBranch ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
              )}

              <Button
                className="w-full"
                onClick={() => setStep('configure')}
                disabled={!selectedRepo}
              >
                Continue
              </Button>
            </div>
          )}

          {step === 'configure' && (
            <div className="space-y-4">
              {/* IaC Type */}
              <div className="space-y-2">
                <Label>Infrastructure as Code</Label>
                <Select value={iacType} onValueChange={(v) => setIacType(v as IaCType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="terraform">Terraform (HCL)</SelectItem>
                    <SelectItem value="pulumi-ts">Pulumi (TypeScript)</SelectItem>
                    <SelectItem value="pulumi-py">Pulumi (Python)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Directory */}
              <div className="space-y-2">
                <Label>Directory</Label>
                <Input
                  value={directory}
                  onChange={(e) => setDirectory(e.target.value)}
                  placeholder="infrastructure"
                />
                <p className="text-xs text-gray-500">
                  Files will be pushed to: <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">{directory}/</code>
                </p>
              </div>

              {/* Commit Message */}
              <div className="space-y-2">
                <Label>Commit Message</Label>
                <Textarea
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Add infrastructure"
                  rows={2}
                />
              </div>

              {/* GitHub Actions Workflow */}
              <div className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg">
                <input
                  type="checkbox"
                  id="include-workflow"
                  checked={includeWorkflow}
                  onChange={(e) => setIncludeWorkflow(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 text-violet-600 focus:ring-violet-500"
                />
                <label htmlFor="include-workflow" className="flex-1 cursor-pointer">
                  <span className="text-sm font-medium text-gray-900 dark:text-white">
                    Include GitHub Actions workflow
                  </span>
                  <p className="text-xs text-gray-500">
                    Auto-deploy on push with plan/apply stages
                  </p>
                </label>
              </div>

              {/* Summary */}
              <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg text-sm">
                <p className="text-gray-600 dark:text-gray-400">
                  Push {nodes.length} resources as {iacType} to{' '}
                  <span className="font-medium text-gray-900 dark:text-white">
                    {selectedRepo?.full_name}:{selectedBranch}
                  </span>
                </p>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setStep('select-repo')}
                >
                  Back
                </Button>
                <Button
                  className="flex-1 gap-2"
                  onClick={handlePush}
                >
                  <Github className="w-4 h-4" />
                  Push
                </Button>
              </div>
            </div>
          )}

          {step === 'pushing' && (
            <div className="text-center py-8">
              <Loader2 className="w-12 h-12 mx-auto mb-4 text-violet-500 animate-spin" />
              <p className="text-gray-600 dark:text-gray-400">
                Pushing to {selectedRepo?.full_name}...
              </p>
            </div>
          )}

          {step === 'success' && pushResult && (
            <div className="text-center py-8">
              <CheckCircle2 className="w-12 h-12 mx-auto mb-4 text-green-500" />
              <h3 className="text-lg font-semibold mb-2">Success!</h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                {pushResult.message}
              </p>
              {pushResult.commitUrl && (
                <a
                  href={pushResult.commitUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-violet-600 hover:text-violet-700"
                >
                  View commit
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
              <div className="mt-6">
                <Button onClick={handleClose}>Done</Button>
              </div>
            </div>
          )}

          {step === 'error' && pushResult && (
            <div className="text-center py-8">
              <XCircle className="w-12 h-12 mx-auto mb-4 text-red-500" />
              <h3 className="text-lg font-semibold mb-2">Push Failed</h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                {pushResult.message}
              </p>
              <div className="flex gap-2 justify-center">
                <Button variant="outline" onClick={() => setStep('configure')}>
                  Try Again
                </Button>
                <Button onClick={handleClose}>Close</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
