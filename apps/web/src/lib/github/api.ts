// GitHub API utilities for InfraCanvas
import type { GitHubUser, GitHubRepo, GitHubBranch, PushResult } from './types';

const GITHUB_API = 'https://api.github.com';

async function githubFetch<T>(
  endpoint: string,
  token: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${GITHUB_API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `GitHub API error: ${response.status}`);
  }

  return response.json();
}

export async function getUser(token: string): Promise<GitHubUser> {
  return githubFetch<GitHubUser>('/user', token);
}

export async function listRepos(token: string): Promise<GitHubRepo[]> {
  // Get repos where user can push (owned + collaborator)
  const repos = await githubFetch<GitHubRepo[]>(
    '/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator',
    token
  );
  return repos;
}

export async function getRepo(
  token: string,
  owner: string,
  repo: string
): Promise<GitHubRepo> {
  return githubFetch<GitHubRepo>(`/repos/${owner}/${repo}`, token);
}

export async function createRepo(
  token: string,
  name: string,
  description: string = '',
  isPrivate: boolean = true
): Promise<GitHubRepo> {
  return githubFetch<GitHubRepo>('/user/repos', token, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description,
      private: isPrivate,
      auto_init: true,
    }),
  });
}

export async function listBranches(
  token: string,
  owner: string,
  repo: string
): Promise<GitHubBranch[]> {
  return githubFetch<GitHubBranch[]>(
    `/repos/${owner}/${repo}/branches`,
    token
  );
}

export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  branchName: string,
  fromBranch: string
): Promise<void> {
  // Get the SHA of the source branch
  const refResponse = await githubFetch<{ object: { sha: string } }>(
    `/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`,
    token
  );

  // Create new branch
  await githubFetch(`/repos/${owner}/${repo}/git/refs`, token, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: refResponse.object.sha,
    }),
  });
}

export async function getFileSha(
  token: string,
  owner: string,
  repo: string,
  path: string,
  branch: string
): Promise<string | null> {
  try {
    const response = await githubFetch<{ sha: string }>(
      `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`,
      token
    );
    return response.sha;
  } catch {
    return null;
  }
}

export async function pushFile(
  token: string,
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string,
  sha?: string | null
): Promise<{ commit: { html_url: string } }> {
  const body: Record<string, string> = {
    message,
    content: btoa(unescape(encodeURIComponent(content))), // Base64 encode with UTF-8 support
    branch,
  };

  if (sha) {
    body.sha = sha;
  }

  return githubFetch(`/repos/${owner}/${repo}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function pushFiles(
  token: string,
  owner: string,
  repo: string,
  files: { path: string; content: string }[],
  message: string,
  branch: string
): Promise<PushResult> {
  try {
    let lastCommitUrl = '';

    for (const file of files) {
      // Check if file exists to get SHA
      const sha = await getFileSha(token, owner, repo, file.path, branch);

      const result = await pushFile(
        token,
        owner,
        repo,
        file.path,
        file.content,
        message,
        branch,
        sha
      );

      lastCommitUrl = result.commit.html_url;
    }

    return {
      success: true,
      message: `Successfully pushed ${files.length} files`,
      commitUrl: lastCommitUrl,
    };
  } catch (error) {
    return {
      success: false,
      message: 'Failed to push files',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// Push multiple files in a single commit using the Git Data API
export async function pushFilesAtomic(
  token: string,
  owner: string,
  repo: string,
  files: { path: string; content: string }[],
  message: string,
  branch: string
): Promise<PushResult> {
  try {
    // 1. Get the current commit SHA
    const refResponse = await githubFetch<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/ref/heads/${branch}`,
      token
    );
    const currentCommitSha = refResponse.object.sha;

    // 2. Get the tree SHA
    const commitResponse = await githubFetch<{ tree: { sha: string } }>(
      `/repos/${owner}/${repo}/git/commits/${currentCommitSha}`,
      token
    );
    const baseTreeSha = commitResponse.tree.sha;

    // 3. Create blobs for each file
    const treeItems = await Promise.all(
      files.map(async (file) => {
        const blobResponse = await githubFetch<{ sha: string }>(
          `/repos/${owner}/${repo}/git/blobs`,
          token,
          {
            method: 'POST',
            body: JSON.stringify({
              content: file.content,
              encoding: 'utf-8',
            }),
          }
        );

        return {
          path: file.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blobResponse.sha,
        };
      })
    );

    // 4. Create a new tree
    const treeResponse = await githubFetch<{ sha: string }>(
      `/repos/${owner}/${repo}/git/trees`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          base_tree: baseTreeSha,
          tree: treeItems,
        }),
      }
    );

    // 5. Create a new commit
    const newCommitResponse = await githubFetch<{ sha: string; html_url: string }>(
      `/repos/${owner}/${repo}/git/commits`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({
          message,
          tree: treeResponse.sha,
          parents: [currentCommitSha],
        }),
      }
    );

    // 6. Update the branch reference
    await githubFetch(
      `/repos/${owner}/${repo}/git/refs/heads/${branch}`,
      token,
      {
        method: 'PATCH',
        body: JSON.stringify({
          sha: newCommitResponse.sha,
        }),
      }
    );

    return {
      success: true,
      message: `Successfully pushed ${files.length} files in a single commit`,
      commitUrl: `https://github.com/${owner}/${repo}/commit/${newCommitResponse.sha}`,
    };
  } catch (error) {
    console.error('Atomic push failed:', error);
    // Fall back to sequential push
    return pushFiles(token, owner, repo, files, message, branch);
  }
}
