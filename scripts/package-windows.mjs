// Builds the offline Windows package: release/Groovy-Windows/ and release/Groovy-Windows.zip.
//   npm run package:windows
// Layout (what the launcher expects):
//   Start Groovy.vbs, Create Desktop Shortcut.vbs, launcher/start-windows.ps1,
//   WINDOWS_OFFLINE_*.txt, app/  (the built site: index.html, assets/, models/, vendor/...)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const out = path.join(root, "release", "Groovy-Windows");

const fail = (msg) => {
  console.error("package: " + msg);
  process.exit(1);
};

// 1. A fresh build is the only thing that gets shipped.
if (!process.argv.includes("--no-build")) {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
}
if (!fs.existsSync(path.join(dist, "index.html"))) fail("dist/index.html missing - build failed?");

// 2. Everything the app needs offline must be in the build.
const REQUIRED = [
  "index.html",
  "models/face_landmarker.task",
  "models/selfie_multiclass_256x256.tflite",
  "models/bodypix-mobilenet-v1-100-s8.onnx",
  "vendor/mediapipe/wasm/vision_wasm_internal.js",
  "vendor/mediapipe/wasm/vision_wasm_internal.wasm",
  "vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm",
  "images/groovy-logo.png",
  "sample-face-test.png",
];
for (const f of REQUIRED) {
  const p = path.join(dist, f);
  if (!fs.existsSync(p) || fs.statSync(p).size === 0) fail(`missing or empty in build: ${f}`);
}
// onnxruntime's WebAssembly (body slimming) is bundled by the build under a hashed name.
if (!fs.readdirSync(path.join(dist, "assets")).some((f) => /^ort-wasm-simd-threaded.*\.wasm$/.test(f)))
  fail("missing in build: assets/ort-wasm-simd-threaded*.wasm");
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
if (/(?:src|href)=["']\/(?!\/)/.test(html)) fail("index.html has root-absolute URLs; the app is served from a sub-folder");
if (/https?:\/\//.test(html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/s, "")))
  fail("index.html references an external URL; the kiosk must work offline");

// 3. Assemble.
fs.rmSync(path.join(root, "release"), { recursive: true, force: true });
fs.mkdirSync(path.join(out, "launcher"), { recursive: true });
fs.cpSync(dist, path.join(out, "app"), { recursive: true });
for (const f of ["Start Groovy.vbs", "Create Desktop Shortcut.vbs", "WINDOWS_OFFLINE_README.txt", "WINDOWS_OFFLINE_AR.txt"])
  fs.copyFileSync(path.join(root, f), path.join(out, f));
fs.copyFileSync(path.join(root, "launcher", "start-windows.ps1"), path.join(out, "launcher", "start-windows.ps1"));

let commit = "dev";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).toString().trim();
} catch {}
const version = `${new Date().toISOString().slice(0, 10)}-${commit}`;
fs.writeFileSync(path.join(out, "app", "version.txt"), version + "\n");

// 4. Integrity manifest + zip (forward-slash names; the launcher and Windows both accept them).
const files = {};
const manifest = {};
(function walk(dir) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full);
    else {
      const rel = path.relative(path.join(root, "release"), full).split(path.sep).join("/");
      const data = fs.readFileSync(full);
      files[rel] = data;
      if (rel.startsWith("Groovy-Windows/app/")) manifest[rel.slice("Groovy-Windows/app/".length)] = createHash("sha256").update(data).digest("hex");
    }
  }
})(out);
const manifestJson = JSON.stringify(manifest, null, 2) + "\n";
fs.writeFileSync(path.join(out, "offline-assets.sha256.json"), manifestJson);
files["Groovy-Windows/offline-assets.sha256.json"] = Buffer.from(manifestJson);

const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(v)])), { level: 6 });
fs.writeFileSync(path.join(root, "release", "Groovy-Windows.zip"), zip);

console.log(`package: ${Object.keys(files).length} files, ${(zip.length / 1e6).toFixed(1)} MB zip, version ${version}`);
console.log("package: release/Groovy-Windows.zip");
