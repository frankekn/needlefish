import { accessSync, appendFileSync, constants, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const catalogPath = join(repoRoot, "runner-catalog.json");
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const PINNED_VERSION = /^\d+\.\d+\.\d+$/;
const PLATFORM = /^(?:linux|darwin|win32)-(?:x64|arm64)$/;

export function readRunnerCatalog(path = catalogPath) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("runner catalog must be an object");
  }
  return parsed;
}

export function validateRunnerCatalog(catalog) {
  const binaryEnvs = new Set();
  const autoDetectOrders = new Set();
  for (const [runner, entry] of Object.entries(catalog)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`runner catalog entry must be an object: ${runner}`);
    }
    if (entry.kind !== "cli" && entry.kind !== "http") {
      throw new Error(`runner catalog kind must be cli or http: ${runner}`);
    }
    if (entry.binary !== null && (typeof entry.binary !== "string" || !entry.binary)) {
      throw new Error(`runner catalog binary must be a non-empty string or null: ${runner}`);
    }
    if (
      entry.binaryEnv !== null &&
      (typeof entry.binaryEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(entry.binaryEnv))
    ) {
      throw new Error(`runner catalog binaryEnv is invalid: ${runner}`);
    }
    if (entry.binaryEnv !== null) {
      if (binaryEnvs.has(entry.binaryEnv)) {
        throw new Error(`runner catalog binaryEnv must be unique: ${entry.binaryEnv}`);
      }
      binaryEnvs.add(entry.binaryEnv);
    }
    if (entry.autoDetectOrder !== null) {
      if (!Number.isInteger(entry.autoDetectOrder) || entry.autoDetectOrder <= 0) {
        throw new Error(`runner catalog autoDetectOrder must be positive or null: ${runner}`);
      }
      if (!entry.binary) {
        throw new Error(`auto-detected runner requires a default binary: ${runner}`);
      }
      if (autoDetectOrders.has(entry.autoDetectOrder)) {
        throw new Error(`runner catalog autoDetectOrder must be unique: ${entry.autoDetectOrder}`);
      }
      autoDetectOrders.add(entry.autoDetectOrder);
    }
    if (entry.kind === "http" && (entry.binary !== null || entry.binaryEnv !== null)) {
      throw new Error(`HTTP runner cannot declare a process binary: ${runner}`);
    }
    if (entry.hostedInstall === null) continue;
    const install = entry.hostedInstall;
    if (!entry.binary || entry.kind !== "cli") {
      throw new Error(`hosted install requires a CLI binary: ${runner}`);
    }
    if (typeof install.npmPackage !== "string" || !install.npmPackage) {
      throw new Error(`hosted install npmPackage is required: ${runner}`);
    }
    if (typeof install.defaultVersion !== "string" || !PINNED_VERSION.test(install.defaultVersion)) {
      throw new Error(`hosted install defaultVersion must be x.y.z: ${runner}`);
    }
    if (
      !Array.isArray(install.testedPlatforms) ||
      install.testedPlatforms.length === 0 ||
      install.testedPlatforms.some((platform) => typeof platform !== "string" || !PLATFORM.test(platform))
    ) {
      throw new Error(`hosted install testedPlatforms is invalid: ${runner}`);
    }
  }
  return catalog;
}

export function resolveRunnerInstall(runner, versionOverride = "", catalog = validateRunnerCatalog(readRunnerCatalog())) {
  const entry = catalog[runner];
  if (!entry) throw new Error(`unknown runner: ${runner}`);
  if (!entry.hostedInstall) {
    throw new Error(`${runner} has no managed npm install; provide its external binary instead`);
  }
  const version = versionOverride || entry.hostedInstall.defaultVersion;
  if (!VERSION.test(version)) {
    throw new Error(`runner version must be an npm version or dist-tag without paths: ${version}`);
  }
  return {
    runner,
    binary: entry.binary,
    npmPackage: entry.hostedInstall.npmPackage,
    version,
    testedPlatforms: entry.hostedInstall.testedPlatforms,
  };
}

export function runnerBinaryPath(installRoot, binary, platform = process.platform) {
  return join(installRoot, "node_modules", ".bin", platform === "win32" ? `${binary}.cmd` : binary);
}

function appendOutput(path, name, value) {
  if (!path) return;
  appendFileSync(path, `${name}=${value}\n`);
}

export function installRunner({
  runner,
  versionOverride = "",
  runnerTemp,
  githubPath,
  githubOutput,
  platform = process.platform,
  arch = process.arch,
  spawn = spawnSync,
}) {
  if (!runnerTemp) throw new Error("RUNNER_TEMP is required for managed runner installation");
  const resolved = resolveRunnerInstall(runner, versionOverride);
  const platformKey = `${platform}-${arch}`;
  if (!resolved.testedPlatforms.includes(platformKey)) {
    process.stdout.write(
      `::warning::${resolved.runner} managed setup is not CI-validated on ${platformKey}; external binary mode remains available\n`,
    );
  }
  const installRoot = join(runnerTemp, "needlefish-model-runners", resolved.runner, resolved.version);
  mkdirSync(installRoot, { recursive: true });
  const npm = platform === "win32" ? "npm.cmd" : "npm";
  const spec = `${resolved.npmPackage}@${resolved.version}`;
  const result = spawn(
    npm,
    ["install", "--no-save", "--no-audit", "--no-fund", "--prefix", installRoot, spec],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm install failed for ${spec} (exit ${result.status})`);
  const binaryPath = runnerBinaryPath(installRoot, resolved.binary, platform);
  try {
    accessSync(binaryPath, platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch {
    throw new Error(`installed runner binary is missing or not executable: ${binaryPath}`);
  }
  const packageManifestPath = join(
    installRoot,
    "node_modules",
    ...resolved.npmPackage.split("/"),
    "package.json",
  );
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  if (!packageManifest || typeof packageManifest.version !== "string" || !packageManifest.version) {
    throw new Error(`installed runner package has no version: ${packageManifestPath}`);
  }
  const installedVersion = packageManifest.version;
  const binDir = dirname(binaryPath);
  if (githubPath) appendFileSync(githubPath, `${binDir}\n`);
  appendOutput(githubOutput, "runner", resolved.runner);
  appendOutput(githubOutput, "version", installedVersion);
  appendOutput(githubOutput, "binary_path", binaryPath);
  process.stdout.write(`installed ${resolved.runner} ${installedVersion}: ${binaryPath}\n`);
  return { ...resolved, requestedVersion: resolved.version, version: installedVersion, installRoot, binaryPath, binDir };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const [runner = "", versionOverride = ""] = argv;
  installRunner({
    runner,
    versionOverride,
    runnerTemp: env.RUNNER_TEMP,
    githubPath: env.GITHUB_PATH,
    githubOutput: env.GITHUB_OUTPUT,
  });
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`setup-runner: ${message}\n`);
    process.exitCode = 1;
  }
}
