import { spawnSync } from "node:child_process";
import { GITHUB_SETUP_BRANCH, GITHUB_WORKFLOW, PREVIOUS_GITHUB_WORKFLOW } from "./github.js";

const PATH = ".github/workflows/needlefish.yml";
const BRANCH = GITHUB_SETUP_BRANCH;
const OWNER = "Needlefish setup template 1";
const SECRET = "NEEDLEFISH_CODEX_API_KEY";
// Leave time for the desktop's 120-second command limit and process cleanup.
const OPERATION_TIMEOUT_MS = 105_000;
const DEADLINE_MESSAGE = "GitHub setup deadline exceeded. Setup was not completed. Confirmed changes may already exist; inspect status and retry to reconcile them. No model review was completed.";

function remainingSetupMs(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error(DEADLINE_MESSAGE);
  return remaining;
}

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
function gh(deadline: number, args: string[], input?: string, allowMissing = false): string | undefined {
  const timeout = Math.min(60_000, remainingSetupMs(deadline));
  const result = spawnSync("gh", args, { encoding: "utf8", input,
    timeout, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GH_HOST: "github.com", GH_DEBUG: "", DEBUG: "", GH_PROMPT_DISABLED: "1" } });
  remainingSetupMs(deadline);
  if (result.error && "code" in result.error && result.error.code === "ETIMEDOUT" && timeout < 60_000) throw new Error(DEADLINE_MESSAGE);
  if (result.error) throw new Error("GitHub CLI unavailable or timed out. Install the official gh CLI, check your connection, and retry.");
  if (result.status !== 0) {
    if (allowMissing && /HTTP 404/.test(result.stderr)) return undefined;
    throw new Error("GitHub request failed. Check GitHub sign-in, repository admin permission, organization policy, Actions availability and network. No model review was completed.");
  }
  return result.stdout;
}
function api(deadline: number, endpoint: string, payload?: { [key: string]: Json }, method?: string, allowMissing = false): Json | undefined {
  const args = ["api", "--hostname", "github.com", endpoint];
  if (method) args.push("--method", method);
  if (payload) args.push("--input", "-");
  const output = gh(deadline, args, payload ? JSON.stringify(payload) : undefined, allowMissing);
  if (output === undefined) return undefined;
  try { return JSON.parse(output) as Json; } catch { throw new Error("GitHub returned invalid JSON. Retry after checking your connection."); }
}
function required(deadline: number, endpoint: string, payload?: { [key: string]: Json }, method?: string): Json {
  const value = api(deadline, endpoint, payload, method);
  if (value === undefined) throw new Error("GitHub returned no data.");
  return value;
}
function repositoryName(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/.test(value) || value.endsWith("/.") || value.endsWith("/..")) {
    throw new Error("Choose a repository using --repository owner/name.");
  }
  return value;
}
function workflow(deadline: number, repository: string, ref: string): { content: string; sha: string } | undefined {
  const value = api(deadline, `repos/${repository}/contents/${PATH}?ref=${encodeURIComponent(ref)}`, undefined, undefined, true);
  if (value === undefined) return undefined;
  const file = object(value);
  if (file.type !== "file" || file.encoding !== "base64") throw new Error("Existing workflow is not a supported regular file. Ask its owner to inspect it.");
  return { content: Buffer.from(string(file.content), "base64").toString("utf8"), sha: string(file.sha) };
}

function actionReferences(content: string): string[] {
  return [...content.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)/gm)].map(match => string(match[1]));
}
function policyMatches(pattern: string, reference: string): boolean {
  const expression = (pattern.includes("@") ? pattern : pattern + "@*")
    .split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp("^" + expression + "$", "i").test(reference);
}
function actionsPolicy(deadline: number, repository: string, admin: boolean) {
  if (!admin) return { allowed: false, reason: "Repository admin permission is required to inspect Actions policy." };
  const policy = object(required(deadline, `repos/${repository}/actions/permissions`));
  if (policy.enabled !== true) return { allowed: false, reason: "GitHub Actions is disabled. Ask the repository or organization administrator to enable it." };
  if (policy.allowed_actions === "all") return { allowed: true, reason: "Actions policy permits the pinned actions. Hosted-runner capacity and AI quota remain unverified." };
  if (policy.allowed_actions !== "selected") return { allowed: false, reason: "Actions policy does not permit the required public actions. Ask an administrator to allow the pinned workflow actions." };
  const selected = object(required(deadline, `repos/${repository}/actions/permissions/selected-actions`));
  const patterns = array(selected.patterns_allowed ?? []).map(string);
  const references = actionReferences(GITHUB_WORKFLOW);
  const needlefish = references.find(ref => ref.startsWith("frankekn/needlefish@"));
  if (!needlefish) throw new Error("The setup template is missing its pinned public action.");
  const [slug, ref] = needlefish.split("@");
  const composite = object(required(deadline, `repos/${slug}/contents/action.yml?ref=${ref}`));
  if (composite.encoding !== "base64") throw new Error("Could not inspect the pinned action dependencies.");
  references.push(...actionReferences(Buffer.from(string(composite.content), "base64").toString("utf8")));
  const denied = references.filter(reference => {
    if (patterns.some(pattern => pattern.startsWith("!") && policyMatches(pattern.slice(1), reference))) return true;
    return !(selected.github_owned_allowed === true && reference.startsWith("actions/"))
      && !patterns.some(pattern => !pattern.startsWith("!") && policyMatches(pattern, reference));
  });
  return denied.length === 0
    ? { allowed: true, reason: "The selected-actions policy permits the pinned workflow and composite dependencies. Hosted-runner capacity and AI quota remain unverified." }
    : { allowed: false, reason: `Ask a repository or organization administrator to permit these pinned actions: ${denied.join(", ")}. Verified-publisher policy alone is not assumed to allow these repositories.` };
}
function setupBranch(deadline: number, repository: string, defaultBranch: string, requireOpenDiff: boolean) {
  const value = api(deadline, `repos/${repository}/git/ref/heads/${BRANCH}`, undefined, undefined, true);
  if (value === undefined) return undefined;
  const head = string(object(object(value).object ?? null).sha);
  const commit = object(required(deadline, `repos/${repository}/git/commits/${head}`));
  const content = workflow(deadline, repository, head);
  if (commit.message !== OWNER || content?.content !== GITHUB_WORKFLOW) return { head, conflict: "The setup branch contains unrecognized changes. Preserve it and ask its owner to inspect it." };
  const parents = array(commit.parents ?? null).map(object);
  if (parents.length !== 1) return { head, conflict: "The setup commit has unrecognized parentage. Preserve it and ask its owner to inspect it." };
  const original = object(required(deadline, `repos/${repository}/compare/${encodeURIComponent(string(parents[0]?.sha))}...${encodeURIComponent(head)}`));
  const originalFiles = array(original.files ?? null).map(object);
  let conflict = originalFiles.length !== 1 || originalFiles[0]?.filename !== PATH || original.total_commits !== 1
    ? "The setup commit has additional changes. Preserve it and ask its owner to inspect it." : null;
  if (!conflict && requireOpenDiff) {
    const comparison = object(required(deadline, `repos/${repository}/compare/${encodeURIComponent(defaultBranch)}...${encodeURIComponent(head)}`));
    const files = array(comparison.files ?? null).map(object);
    if (files.length !== 1 || files[0]?.filename !== PATH || comparison.total_commits !== 1) conflict = "The setup branch has additional changes. Preserve it and ask its owner to inspect it.";
  }
  return { head, conflict };
}

export function inspectGithubSetup(requestedRepository: string, deadline = performance.now() + OPERATION_TIMEOUT_MS) {
  repositoryName(requestedRepository);
  const repo = object(required(deadline, `repos/${requestedRepository}`));
  const repository = repositoryName(string(repo.full_name));
  const defaultBranch = string(repo.default_branch);
  const admin = repo.permissions !== undefined && object(repo.permissions).admin === true;
  const policy = actionsPolicy(deadline, repository, admin);
  const actions = policy.allowed;
  const existing = workflow(deadline, repository, defaultBranch);
  let conflict: string | null = existing && existing.content !== GITHUB_WORKFLOW && existing.content !== PREVIOUS_GITHUB_WORKFLOW
    ? "Existing needlefish.yml differs from the known template. Preserve it and ask its owner to reconcile changes." : null;
  const files = api(deadline, `repos/${repository}/contents/.github/workflows?ref=${encodeURIComponent(defaultBranch)}`, undefined, undefined, true);
  if (files !== undefined) {
    for (const entry of array(files)) {
      const file = object(entry);
      const name = string(file.name);
      if (name === "needlefish.yml" || !/\.ya?ml$/.test(name)) continue;
      if (file.type !== "file") { conflict = "A workflow entry is not a regular file. Ask its owner to inspect the workflows directory."; continue; }
      const raw = object(required(deadline, `repos/${repository}/contents/.github/workflows/${encodeURIComponent(name)}?ref=${encodeURIComponent(defaultBranch)}`));
      if (raw.encoding !== "base64") throw new Error("Could not inspect existing workflows.");
      const content = Buffer.from(string(raw.content), "base64").toString("utf8").replace(/^\s*#.*$/gm, "");
      if (/frankekn\/needlefish(?:@|\/)/i.test(content) || (/needlefish/i.test(content) && /--github/.test(content))) conflict = `Another workflow (${name}) already configures Needlefish. Ask its owner to reconcile it.`;
    }
  }
  let secret: "present" | "missing" | "unknown" = "unknown";
  if (admin) {
    const metadata = api(deadline, `repos/${repository}/actions/secrets/${SECRET}`, undefined, undefined, true);
    secret = metadata === undefined ? "missing" : "present";
  }
  const pulls = array(required(deadline, `repos/${repository}/pulls?state=open&head=${encodeURIComponent(repository.split("/")[0] + ":" + BRANCH)}&per_page=100`));
  const branch = setupBranch(deadline, repository, defaultBranch, existing?.content !== GITHUB_WORKFLOW || pulls.length > 0);
  if (branch?.conflict) conflict = branch.conflict;
  let prUrl: string | null = null;
  if (pulls.length > 0) {
    const pr = object(pulls[0] ?? null);
    const base = object(pr.base ?? null), head = object(pr.head ?? null);
    if (pulls.length !== 1 || !branch || branch.conflict || typeof pr.body !== "string" || !pr.body.includes(`<!-- ${OWNER} -->`)
      || base.ref !== defaultBranch || head.ref !== BRANCH || head.sha !== branch.head || object(head.repo ?? null).full_name !== repository) {
      conflict = "An existing setup PR has unrecognized ownership, contents or target branch. Inspect it before setup; it was not changed.";
    } else if (!conflict) prUrl = string(pr.html_url);
  }
  const phase: "conflict" | "merged" | "pr_created" | "preview" = conflict ? "conflict" : existing?.content === GITHUB_WORKFLOW ? "merged" : prUrl ? "pr_created" : "preview";
  return { schemaVersion: 1, repository, defaultBranch, admin, actions, actionsReason: policy.reason, phase, conflict, secret, branchHead: branch?.head ?? null,
    authentication: "unknown", firstReview: "not_verified", prUrl, workflow: GITHUB_WORKFLOW, currentWorkflow: existing?.content ?? null,
    disclosure: "Trusted same-repository PR code and rules go to OpenAI Codex (gpt-5.6-terra/high). OpenAI usage and GitHub Actions may incur charges. Fork, bot and untrusted PRs fail without review. Secret metadata does not prove authentication or quota. Branch protection is unchanged.",
    settingsUrl: `https://github.com/${repository}/settings/actions`,
    removal: `Disable Needlefish review in the repository Actions UI. To remove it, inspect ${PATH} and remove only the unmodified owned workflow through a PR. Delete ${SECRET} separately only after checking other users. Preserve other workflows and required checks.`,
  };
}

function createSetupPr(deadline: number, repository: string) {
  const status = inspectGithubSetup(repository, deadline);
  if (!status.admin) throw new Error("A repository administrator must enable setup. Ask the repository owner to grant admin access or perform setup.");
  if (!status.actions) throw new Error(status.actionsReason);
  if (status.conflict) throw new Error(status.conflict);
  if (status.phase === "merged") return status;
  const endpoint = `repos/${status.repository}`;
  let branchHead = status.branchHead;
  if (branchHead === null) {
    const base = object(required(deadline, `${endpoint}/git/ref/heads/${encodeURIComponent(status.defaultBranch)}`));
    const parent = string(object(base.object ?? null).sha);
    const commit = object(required(deadline, `${endpoint}/git/commits/${parent}`));
    const tree = object(required(deadline, `${endpoint}/git/trees`, { base_tree: string(object(commit.tree ?? null).sha),
      tree: [{ path: PATH, mode: "100644", type: "blob", content: GITHUB_WORKFLOW }] }, "POST"));
    const created = object(required(deadline, `${endpoint}/git/commits`, { message: OWNER, tree: string(tree.sha), parents: [parent] }, "POST"));
    branchHead = string(created.sha);
    required(deadline, `${endpoint}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: branchHead }, "POST");
  }
  if (!status.prUrl) {
    const current = object(required(deadline, `${endpoint}/git/ref/heads/${BRANCH}`));
    if (object(current.object ?? null).sha !== branchHead) throw new Error("The setup branch changed during setup. No PR was created; inspect and retry.");
    required(deadline, `${endpoint}/pulls`, { title: "Enable Needlefish hosted PR review", head: BRANCH, base: status.defaultBranch,
      body: `<!-- ${OWNER} -->\nUses GitHub-hosted runners and the pinned Needlefish template.\n\n${status.disclosure}\n\nSet repository secret ${SECRET} separately. Review and merge this PR in your browser. The reserved setup branch fails before model calls. Its failed guard means not reviewed, not a passing required review. No credential validation or branch protection change has been performed.`, draft: false }, "POST");
  }
  return inspectGithubSetup(repository, deadline);
}

export async function runGuidedGithubSetup(request: SetupRequest) {
  if (request.action === "login") {
    if (!request.confirm) throw new Error("GitHub login requests official gh repository and workflow authorization and stores it in the gh credential store. Confirm with --confirm.");
    const login = spawnSync("gh", ["auth", "login", "--hostname", "github.com", "--web", "--scopes", "workflow", "--git-protocol", "https", "--skip-ssh-key"], {
      stdio: ["inherit", 2, 2], timeout: 16 * 60_000, env: { ...process.env, GH_HOST: "github.com", GH_DEBUG: "", DEBUG: "" },
    });
    if (login.status !== 0) throw new Error("GitHub login was not completed. Check the official gh CLI and retry.");
    return { schemaVersion: 1, phase: "signed_in", firstReview: "not_verified" };
  }
  const deadline = performance.now() + OPERATION_TIMEOUT_MS;
  gh(deadline, ["auth", "status", "--hostname", "github.com"]);
  if (request.action === "repositories") {
    const output = gh(deadline, ["api", "--hostname", "github.com", "--paginate", "--slurp", "user/repos?affiliation=owner,collaborator,organization_member&per_page=100"]);
    const pages: Json = JSON.parse(output ?? "null") as Json;
    const repositories = array(pages).flatMap(array).map(object).filter(repo => repo.archived === false && repo.permissions !== undefined && object(repo.permissions).admin === true)
      .map(repo => ({ name: string(repo.full_name), private: repo.private === true }));
    return { schemaVersion: 1, phase: "repositories", repositories };
  }
  const repository = repositoryName(request.repository);
  if (request.action === "status") return inspectGithubSetup(repository, deadline);
  if (!request.confirm) throw new Error("This action changes the selected GitHub repository. Preview status first, then explicitly use --confirm.");
  if (request.action === "create-pr") return createSetupPr(deadline, repository);
  const status = inspectGithubSetup(repository, deadline);
  if (status.conflict) throw new Error("Resolve the setup conflict before provisioning a credential. No secret was changed. " + status.conflict);
  if (!status.admin || !status.actions) throw new Error("A repository administrator must enable Actions before setting the secret.");
  if (!request.replaceSecret) throw new Error("GitHub secret writes can replace an existing value, including one created concurrently. Confirm this selected repository with --replace-secret after checking other users.");
  if (status.secret === "unknown") throw new Error("Could not establish whether the secret exists. Nothing was changed.");
  if (process.stdin.isTTY) throw new Error("Credential input must use a secure stdin pipe, never an argument or interactive echoed input.");
  const chunks: Buffer[] = [];
  let size = 0;
  const inputTimer = setTimeout(() => process.stdin.destroy(new Error(DEADLINE_MESSAGE)), remainingSetupMs(deadline));
  inputTimer.unref();
  try {
    for await (const chunk of process.stdin) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += data.length;
      if (size > 16_384) throw new Error("Credential input exceeds the supported limit. Nothing was changed.");
      chunks.push(data);
    }
  } finally {
    clearTimeout(inputTimer);
  }
  const credential = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!credential || /[\r\n\0]/.test(credential)) throw new Error("Provide one non-empty credential through stdin. Nothing was changed.");
  gh(deadline, ["secret", "set", SECRET, "--repo", status.repository], credential);
  return { ...status, secret: "present", authentication: "unknown", firstReview: "not_verified" };
}
