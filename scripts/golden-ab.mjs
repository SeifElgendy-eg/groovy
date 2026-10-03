// Golden-image A/B check: render every scenario with a base build and with the current code, on
// the same machine and browser, and compare. No reference images are stored in the repo: the base
// is rendered fresh each time, so machine and browser differences cancel out.
//
//   node scripts/golden-ab.mjs                     compare the working tree against origin/main
//   node scripts/golden-ab.mjs --base <ref>        ...against any branch or commit
//   node scripts/golden-ab.mjs --only a,b          ...just these scenarios
//
// Intentional changes are listed one per line in tests/golden/expected-changes/<branch>.txt; only
// list files added or edited since the base are honoured (see the README there).
// CI runs exactly this (.github/workflows/ci.yml). Renders land in tests/golden/out (current) and
// tests/golden/out-base (base).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const base = arg("--base", "origin/main");
const only = arg("--only", "");
const run = (cmd, cmdArgs, cwd = root) => execFileSync(cmd, cmdArgs, { cwd, stdio: "inherit", shell: process.platform === "win32" });
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();

const baseSha = git("rev-parse", "--verify", `${base}^{commit}`);
console.log(`Base: ${base} (${baseSha.slice(0, 9)})`);

// 1. Build the base in a temporary worktree with its own dependencies (they can differ).
const work = fs.mkdtempSync(path.join(os.tmpdir(), "groovy-base-"));
const baseDir = path.join(work, "base");
run("git", ["worktree", "add", "--detach", baseDir, baseSha]);
let server;
try {
  run("npm", ["ci", "--no-audit", "--no-fund"], baseDir);
  run("npm", ["run", "build"], baseDir);

  // 2. Render baselines from the base build, measured by THIS harness and browser.
  const port = 4180 + Math.floor(Math.random() * 500);
  server = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["vite", "preview", "--outDir", path.join(baseDir, "dist"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: root, stdio: "ignore", shell: process.platform === "win32" });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const onlyArgs = only ? ["--only", only] : [];
  run("node", ["tests/golden/run.mjs", "--update", "--url", url, ...onlyArgs]);
  server.kill();
  server = null;
  const outBase = path.join(root, "tests/golden/out-base");
  fs.rmSync(outBase, { recursive: true, force: true });
  fs.cpSync(path.join(root, "tests/golden/out"), outBase, { recursive: true });

  // 3. Build the current code and compare, allowing the changes this branch declares.
  run("npm", ["run", "build"]);
  const lists = execFileSync("git", ["diff", "--name-only", "--diff-filter=AM", baseSha, "--", "tests/golden/expected-changes/*.txt"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  // Untracked list files (a new branch's file not yet committed) count too.
  const untracked = git("ls-files", "--others", "--exclude-standard", "--", "tests/golden/expected-changes/*.txt").split("\n").filter(Boolean);
  const allowed = [...new Set([...lists, ...untracked])];
  const allowArgs = [];
  if (allowed.length) {
    console.log(`Expected changes from: ${allowed.join(", ")}`);
    const combined = path.join(work, "expected-changes.txt");
    fs.writeFileSync(combined, allowed.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n"));
    allowArgs.push("--allow-changes", combined);
  }
  run("node", ["tests/golden/run.mjs", ...allowArgs, ...onlyArgs]);
} finally {
  server?.kill();
  try {
    run("git", ["worktree", "remove", "--force", baseDir]);
  } catch {}
  fs.rmSync(work, { recursive: true, force: true });
}
