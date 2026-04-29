import { execFileSync } from "node:child_process";
import { readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptsDir = join(repoRoot, "scripts");
const outDir = join(tmpdir(), "pi-telegram-behavior-check");
const generatedTsconfig = join(repoRoot, "tsconfig.behavior-check.generated.json");

function discoverCheckScripts() {
  return readdirSync(scriptsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^check-.+\.ts$/.test(entry.name))
    .map((entry) => `scripts/${entry.name}`)
    .sort((left, right) => left.localeCompare(right));
}

const checkScripts = discoverCheckScripts();
if (checkScripts.length === 0) {
  throw new Error("No behavior check scripts found under scripts/check-*.ts");
}

rmSync(outDir, { recursive: true, force: true });
rmSync(generatedTsconfig, { force: true });

try {
  writeFileSync(
    generatedTsconfig,
    `${JSON.stringify(
      {
        extends: "./tsconfig.behavior-check.json",
        include: ["index.ts", "src/**/*.ts", ...checkScripts],
      },
      null,
      2,
    )}\n`,
  );

  const tscBin = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(tscBin, ["tsc", "--project", generatedTsconfig, "--outDir", outDir], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  writeFileSync(join(outDir, "package.json"), '{"type":"module"}\n');
  symlinkSync(join(repoRoot, "node_modules"), join(outDir, "node_modules"), "dir");

  for (const checkScript of checkScripts) {
    const compiledScript = checkScript.replace(/\.ts$/, ".js");
    execFileSync(process.execPath, [join(outDir, compiledScript)], { stdio: "inherit" });
  }
} finally {
  rmSync(generatedTsconfig, { force: true });
}
