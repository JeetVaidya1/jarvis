import { shellExec } from "./shell.js";

async function ghAvailable(): Promise<boolean> {
  const result = await shellExec("which gh", undefined, 5000);
  return !result.startsWith("ERROR");
}

async function ghCommand(args: string, workingDir?: string): Promise<string> {
  return shellExec(`gh ${args}`, workingDir, 30_000);
}

async function githubApiFetch(
  endpoint: string,
): Promise<string> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    return "ERROR: GITHUB_TOKEN not set. Configure it in .env for API fallback.";
  }

  try {
    const url = endpoint.startsWith("https://")
      ? endpoint
      : `https://api.github.com${endpoint}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "jarvis-agent",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      return `ERROR: GitHub API ${response.status} ${response.statusText}`;
    }

    return JSON.stringify(await response.json(), null, 2);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR fetching GitHub API: ${msg}`;
  }
}

export async function githubStatus(repo?: string): Promise<string> {
  const hasGh = await ghAvailable();

  if (!repo) {
    if (hasGh) {
      const result = await ghCommand(
        "repo list --limit 20 --json name,description,updatedAt,visibility",
      );
      if (!result.startsWith("ERROR")) {
        try {
          const repos = JSON.parse(result) as Array<{
            name: string;
            description: string;
            updatedAt: string;
            visibility: string;
          }>;
          return repos
            .map(
              (r) =>
                `- **${r.name}** (${r.visibility}) — ${r.description || "no description"}\n  Updated: ${r.updatedAt}`,
            )
            .join("\n");
        } catch {
          return result;
        }
      }
    }
    return githubApiFetch("/user/repos?sort=updated&per_page=20");
  }

  if (hasGh) {
    const parts: string[] = [];

    const commits = await ghCommand(
      `api repos/${repo}/commits --jq '.[0:5] | .[] | "\\(.sha[0:7]) \\(.commit.message | split("\\n") | .[0])"'`,
    );
    if (!commits.startsWith("ERROR")) {
      parts.push("## Recent Commits\n" + commits);
    }

    const prs = await ghCommand(
      `pr list --repo ${repo} --limit 5 --json number,title,author,createdAt,state`,
    );
    if (!prs.startsWith("ERROR")) {
      parts.push("## Open PRs\n" + prs);
    }

    const issues = await ghCommand(
      `issue list --repo ${repo} --limit 5 --json number,title,createdAt,state`,
    );
    if (!issues.startsWith("ERROR")) {
      parts.push("## Open Issues\n" + issues);
    }

    return parts.join("\n\n") || `No data found for ${repo}`;
  }

  return githubApiFetch(`/repos/${repo}`);
}

export async function githubGetPrs(repo: string): Promise<string> {
  const hasGh = await ghAvailable();

  if (hasGh) {
    const result = await ghCommand(
      `pr list --repo ${repo} --limit 10 --json number,title,author,createdAt,statusCheckRollup,headRefName`,
    );
    if (!result.startsWith("ERROR")) {
      try {
        const prs = JSON.parse(result) as Array<{
          number: number;
          title: string;
          author: { login: string };
          createdAt: string;
          headRefName: string;
          statusCheckRollup: Array<{ state: string }>;
        }>;

        if (prs.length === 0) return `No open PRs in ${repo}`;

        return prs
          .map((pr) => {
            const checks = pr.statusCheckRollup;
            const status =
              checks.length === 0
                ? "no checks"
                : checks.every((c) => c.state === "SUCCESS")
                  ? "checks passing"
                  : "checks failing";
            return `#${pr.number} — ${pr.title}\n  by ${pr.author.login} | ${pr.headRefName} | ${status} | ${pr.createdAt}`;
          })
          .join("\n\n");
      } catch {
        return result;
      }
    }
  }

  return githubApiFetch(`/repos/${repo}/pulls?state=open&per_page=10`);
}

export async function githubCreateIssue(
  repo: string,
  title: string,
  body: string,
  labels?: string[],
): Promise<string> {
  const hasGh = await ghAvailable();

  if (hasGh) {
    const labelFlag =
      labels && labels.length > 0
        ? ` --label "${labels.join(",")}"`
        : "";
    const result = await ghCommand(
      `issue create --repo ${repo} --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"${labelFlag}`,
    );
    return result;
  }

  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    return "ERROR: Neither gh CLI nor GITHUB_TOKEN available.";
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "jarvis-agent",
        },
        body: JSON.stringify({ title, body, labels: labels ?? [] }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      return `ERROR creating issue: HTTP ${response.status}`;
    }

    const data = (await response.json()) as {
      html_url: string;
      number: number;
    };
    return `Issue created: #${data.number}\n${data.html_url}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR creating issue: ${msg}`;
  }
}

export async function githubGetCommits(
  repo: string,
  limit: number = 10,
): Promise<string> {
  const capped = Math.min(Math.max(1, limit), 50);
  const hasGh = await ghAvailable();

  if (hasGh) {
    const result = await ghCommand(
      `api repos/${repo}/commits?per_page=${capped} --jq '.[] | "\\(.sha[0:7]) \\(.commit.author.date) \\(.commit.author.name): \\(.commit.message | split("\\n") | .[0])"'`,
    );
    return result;
  }

  return githubApiFetch(`/repos/${repo}/commits?per_page=${capped}`);
}

export async function githubRunWorkflow(
  repo: string,
  workflowId: string,
): Promise<string> {
  const hasGh = await ghAvailable();

  if (hasGh) {
    const result = await ghCommand(
      `workflow run ${workflowId} --repo ${repo}`,
    );
    if (result.startsWith("ERROR")) {
      return result;
    }
    return `Workflow ${workflowId} triggered for ${repo}.\n${result}`;
  }

  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    return "ERROR: Neither gh CLI nor GITHUB_TOKEN available.";
  }

  try {
    // Get default branch
    const repoResponse = await fetch(
      `https://api.github.com/repos/${repo}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "jarvis-agent",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const repoData = (await repoResponse.json()) as {
      default_branch: string;
    };

    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "jarvis-agent",
        },
        body: JSON.stringify({ ref: repoData.default_branch }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      return `ERROR triggering workflow: HTTP ${response.status}`;
    }

    return `Workflow ${workflowId} triggered for ${repo} on ${repoData.default_branch}.`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR triggering workflow: ${msg}`;
  }
}
