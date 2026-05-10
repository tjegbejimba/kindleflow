import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, "extension");
const outputDir = join(root, "dist", "extensions");
const workDir = join(outputDir, ".work");
const requiredFiles = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
];

for (const file of requiredFiles) {
  if (!existsSync(join(sourceDir, file))) {
    throw new Error(`Extension package is missing ${file}`);
  }
}

const baseManifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8"));
validateManifest(baseManifest);

rmSync(outputDir, { force: true, recursive: true });
mkdirSync(outputDir, { recursive: true });

packageBrowser("chrome", {
  ...baseManifest,
  browser_specific_settings: undefined
});

packageBrowser("firefox", baseManifest);

rmSync(workDir, { force: true, recursive: true });
console.log(`Packaged extension ZIPs in ${relativePath(outputDir)}`);

function packageBrowser(browser, manifest) {
  const browserDir = join(workDir, browser);
  rmSync(browserDir, { force: true, recursive: true });
  mkdirSync(browserDir, { recursive: true });

  for (const file of requiredFiles.filter((file) => file !== "manifest.json")) {
    cpSync(join(sourceDir, file), join(browserDir, file));
  }
  writeFileSync(join(browserDir, "manifest.json"), `${JSON.stringify(stripUndefined(manifest), null, 2)}\n`);

  const zipPath = join(outputDir, `kindleflow-${browser}.zip`);
  rmSync(zipPath, { force: true });
  execFileSync("zip", ["-qr", zipPath, "."], { cwd: browserDir, stdio: "inherit" });
  console.log(`- ${relativePath(zipPath)}`);
}

function validateManifest(manifest) {
  if (manifest.manifest_version !== 3) {
    throw new Error("Extension must use Manifest V3 for Chrome and Firefox store submission.");
  }
  if (!manifest.name || !manifest.version || !manifest.description) {
    throw new Error("Extension manifest must include name, version, and description.");
  }
  if (!manifest.browser_specific_settings?.gecko?.id) {
    throw new Error("Firefox package requires browser_specific_settings.gecko.id.");
  }
  if (!manifest.browser_specific_settings.gecko.data_collection_permissions?.required?.includes("none")) {
    throw new Error("Firefox package requires data_collection_permissions.required to declare no data collection.");
  }
}

function stripUndefined(value) {
  return JSON.parse(JSON.stringify(value));
}

function relativePath(path) {
  return path.replace(`${root}/`, "");
}
