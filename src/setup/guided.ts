import { spawnSync } from "node:child_process";
import { GITHUB_WORKFLOW } from "./github.js";

const PATH = ".github/workflows/needlefish.yml";
const BRANCH = "needlefish/setup-v1";
const OWNER = "Needlefish setup template 1";
const SECRET = "NEEDLEFISH_CODEX_API_KEY";

export type SetupAction = "repositories" | "login" | "status" | "create-pr" | "set-secret";
export interface SetupRequest {
  readonly action: SetupAction;
  readonly repository?: string;
  readonly confirm: boolean;
  readonly replaceSecret: boolean;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function object(value: Json): { [key: string]: Json } {
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("GitHub returned invalid data. Retry after checking your connection.");
  return value;
}
function string(value: Json | undefined): string {
  if (typeof value !== "string") throw new Error("GitHub returned invalid data. Retry after checking your connection.");
  return value;
}
function array(value: Json): Json[] {
  if (!Array.isArray(value)) throw new Error("GitHub returned invalid data. Retry after checking your connection.");
  return value;
}
function gh(args: string[], input?: string, allowMissing = false): string | undefined {
  const result = spawnSync("gh", args, { encoding: "utf8", input,
    timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_HOST: "github.com", GH_DEBUG: "", DEBUG: "", GH_PROMPT_DISABLED: "1" } });
  if (result.error) throw new Error("GitHub CLI unavailable or timed out. Install the official gh CLI, check your connection, and retry.");
  if (result.status !== 0) {
    if (allowMissing && /HTTP 404/.test(result.stderr)) return undefined;
    throw new Error("GitHub request failed. Check GitHub sign-in, repository admin permission, organization policy, Actions availability and network. No model review was completed.");
  }
  return result.stdout;
}
function api(endpoint: string, payload?: { [key: string]: Json }, method?: string, allowMissing = false): Json | undefined {
  const args = ["api", "--hostname", "github.com", endpoint];
  if (method) args.push("--method", method);
  if (payload) args.push("--input", "-");
  const output = gh(args, payload ? JSON.stringify(payload) : undefined, allowMissing);
  if (output === undefined) return undefined;
  try { return JSON.parse(output) as Json; } catch { throw new Error("GitHub returned invalid JSON. Retry after checking your connection."); }
}
function required(endpoint: string, payload?: { [key: string]: Json }, method?: string): Json {
  const value = api(endpoint, payload, method);
  if (value === undefined) throw new Error("GitHub returned no data.");
  return value;
}
function repositoryName(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(value) || value.endsWith("/.") || value.endsWith("/..")) {
    throw new Error("Choose a repository using --repository owner/name.");
  }
  return value;
}
function workflow(repository: string, ref: string): { content: string; sha: string } | undefined {
  const value = api(`repos/${repository}/contents/${PATH}?ref=${encodeURIComponent(ref)}`, undefined, undefined, true);
  if (value === undefined) return undefined;
  const file = object(value);
  if (file.type !== "file" || file.encoding !== "base64") throw new Error("Existing workflow is not a supported regular file. Ask its owner to inspect it.");
  return { content: Buffer.from(string(file.content), "base64").toString("utf8"), sha: string(file.sha) };
}

export function inspectGithubSetup(repository: string) {
  repositoryName(repository);
  const repo = object(required(`repos/${repository}`));
  const defaultBranch = string(repo.default_branch);
  const admin = repo.permissions !== undefined && object(repo.permissions).admin === true;
  const actions = admin ? object(required(`repos/${repository}/actions/permissions`)).enabled === true : false;
  const existing = workflow(repository, defaultBranch);
  let conflict: string | null = existing && existing.content !== GITHUB_WORKFLOW
    ? "Existing needlefish.yml differs from the known template. Preserve it and ask its owner to reconcile changes." : null;
  const files = api(`repos/${repository}/contents/.github/workflows?ref=${encodeURIComponent(defaultBranch)}`, undefined, undefined, true);
  if (files !== undefined) {
    for (const entry of array(files)) {
      const file = object(entry);
      const name = string(file.name);
      if (name === "needlefish.yml" || !/\.ya?ml$/.test(name)) continue;
      if (file.type !== "file") { conflict = "A workflow entry is not a regular file. Ask its owner to inspect the workflows directory."; continue; }
      const raw = object(required(`repos/${repository}/contents/.github/workflows/${encodeURIComponent(name)}?ref=${encodeURIComponent(defaultBranch)}`));
      if (raw.encoding !== "base64") throw new Error("Could not inspect existing workflows.");
      const content = Buffer.from(string(raw.content), "base64").toString("utf8").replace(/^\s*#.*$/gm, "");
      if (/frankekn\/needlefish(?:@|\/)/i.test(content) || (/needlefish/i.test(content) && /--github/.test(content))) conflict = `Another workflow (${name}) already configures Needlefish. Ask its owner to reconcile it.`;
    }
  }
  let secret: "present" | "missing" | "unknown" = "unknown";
  if (admin) {
    const metadata = api(`repos/${repository}/actions/secrets/${SECRET}`, undefined, undefined, true);
    secret = metadata === undefined ? "missing" : "present";
  }
  const pulls = array(required(`repos/${repository}/pulls?state=open&head=${encodeURIComponent(repository.split("/")[0] + ":" + BRANCH)}&per_page=100`));
  const owned = pulls.map(object).find(pr => typeof pr.body === "string" && pr.body.includes(`<!-- ${OWNER} -->`));
  const prUrl = owned ? string(owned.html_url) : null;
  const phase: "conflict" | "merged" | "pr_created" | "preview" = conflict ? "conflict" : existing ? "merged" : prUrl ? "pr_created" : "preview";
  return { schemaVersion: 1, repository, defaultBranch, admin, actions, phase, conflict, secret,
    authentication: "unknown", firstReview: "not_verified", prUrl, workflow: GITHUB_WORKFLOW, currentWorkflow: existing?.content ?? null,
    disclosure: "Trusted same-repository PR code and rules go to OpenAI Codex (gpt-5.6-terra/high). OpenAI usage and GitHub Actions may incur charges. Fork, bot and untrusted PRs fail without review. Secret metadata does not prove authentication or quota. Branch protection is unchanged.",
    settingsUrl: `https://github.com/${repository}/settings/actions`,
    removal: `Disable Needlefish review in the repository Actions UI. To remove it, inspect ${PATH} and remove only the unmodified owned workflow through a PR. Delete ${SECRET} separately only after checking other users. Preserve other workflows and required checks.`,
  };
}

function createSetupPr(repository: string) {
  const status = inspectGithubSetup(repository);
  if (!status.admin) throw new Error("A repository administrator must enable setup. Ask the repository owner to grant admin access or perform setup.");
  if (!status.actions) throw new Error("GitHub Actions is disabled. Ask the repository or organization administrator to enable the pinned public action and GitHub-hosted runners.");
  if (status.conflict) throw new Error(status.conflict);
  if (status.phase === "merged") return status;
  const endpoint = `repos/${repository}`;
  const existing = api(`${endpoint}/git/ref/heads/${BRANCH}`, undefined, undefined, true);
  if (existing !== undefined) {
    const head = string(object(object(existing).object ?? null).sha);
    const commit = object(required(`${endpoint}/git/commits/${head}`));
    const content = workflow(repository, BRANCH);
    if (commit.message !== OWNER || content?.content !== GITHUB_WORKFLOW) throw new Error("The setup branch contains unrecognized changes. Preserve it and ask its owner to inspect it.");
    const comparison = object(required(`${endpoint}/compare/${encodeURIComponent(status.defaultBranch)}...${encodeURIComponent(BRANCH)}`));
    const files = array(comparison.files ?? null).map(object);
    if (files.length !== 1 || files[0]?.filename !== PATH || comparison.total_commits !== 1) throw new Error("The setup branch has additional changes. Preserve it and ask its owner to inspect it.");
  } else {
    const base = object(required(`${endpoint}/git/ref/heads/${encodeURIComponent(status.defaultBranch)}`));
    const parent = string(object(base.object ?? null).sha);
    const commit = object(required(`${endpoint}/git/commits/${parent}`));
    const tree = object(required(`${endpoint}/git/trees`, { base_tree: string(object(commit.tree ?? null).sha),
      tree: [{ path: PATH, mode: "100644", type: "blob", content: GITHUB_WORKFLOW }] }, "POST"));
    const created = object(required(`${endpoint}/git/commits`, { message: OWNER, tree: string(tree.sha), parents: [parent] }, "POST"));
    required(`${endpoint}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: string(created.sha) }, "POST");
  }
  if (!status.prUrl) {
    required(`${endpoint}/pulls`, { title: "Enable Needlefish hosted PR review", head: BRANCH, base: status.defaultBranch,
      body: `<!-- ${OWNER} -->\nUses GitHub-hosted runners and the pinned Needlefish template.\n\n${status.disclosure}\n\nSet repository secret ${SECRET} separately. Review and merge this PR in your browser. No model call, credential validation or branch protection change has been performed.`, draft: false }, "POST");
  }
  return inspectGithubSetup(repository);
}

export async function runGuidedGithubSetup(request: SetupRequest) {
  if (request.action === "login") {
    if (!request.confirm) throw new Error("GitHub login requests official gh repository and workflow authorization and stores it in the gh credential store. Confirm with --confirm.");
    const login = spawnSync("gh", ["auth", "login", "--hostname", "github.com", "--web", "--scopes", "workflow", "--git-protocol", "https", "--skip-ssh-key"], {
      stdio: "inherit", timeout: 16 * 60_000, env: { ...process.env, GH_HOST: "github.com", GH_DEBUG: "", DEBUG: "" },
    });
    if (login.status !== 0) throw new Error("GitHub login was not completed. Check the official gh CLI and retry.");
    return { schemaVersion: 1, phase: "signed_in", firstReview: "not_verified" };
  }
  gh(["auth", "status", "--hostname", "github.com"]);
  if (request.action === "repositories") {
    const output = gh(["api", "--hostname", "github.com", "--paginate", "--slurp", "user/repos?affiliation=owner,collaborator,organization_member&per_page=100"]);
    const pages: Json = JSON.parse(output ?? "null") as Json;
    const repositories = array(pages).flatMap(array).map(object).filter(repo => repo.archived === false && repo.permissions !== undefined && object(repo.permissions).admin === true)
      .map(repo => ({ name: string(repo.full_name), private: repo.private === true }));
    return { schemaVersion: 1, phase: "repositories", repositories };
  }
  const repository = repositoryName(request.repository);
  if (request.action === "status") return inspectGithubSetup(repository);
  if (!request.confirm) throw new Error("This action changes the selected GitHub repository. Preview status first, then explicitly use --confirm.");
  if (request.action === "create-pr") return createSetupPr(repository);
  const status = inspectGithubSetup(repository);
  if (!status.admin || !status.actions) throw new Error("A repository administrator must enable Actions before setting the secret.");
  if (!request.replaceSecret) throw new Error("GitHub secret writes can replace an existing value, including one created concurrently. Confirm this selected repository with --replace-secret after checking other users.");
  if (status.secret === "unknown") throw new Error("Could not establish whether the secret exists. Nothing was changed.");
  if (process.stdin.isTTY) throw new Error("Credential input must use a secure stdin pipe, never an argument or interactive echoed input.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 16_384) throw new Error("Credential input exceeds the supported limit. Nothing was changed.");
    chunks.push(data);
  }
  const credential = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!credential || /[\r\n\0]/.test(credential)) throw new Error("Provide one non-empty credential through stdin. Nothing was changed.");
  gh(["secret", "set", SECRET, "--repo", repository], credential);
  return { ...status, secret: "present", authentication: "unknown", firstReview: "not_verified" };
}
