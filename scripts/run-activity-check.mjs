import { execFileSync } from "node:child_process";
import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outDir = join(tmpdir(), "pi-telegram-activity-check");
rmSync(outDir, { recursive: true, force: true });

const tscBin = process.platform === "win32" ? "npx.cmd" : "npx";
execFileSync(tscBin, ["tsc", "--project", "tsconfig.activity-check.json", "--outDir", outDir], { stdio: "inherit" });
writeFileSync(join(outDir, "package.json"), '{"type":"module"}\n');
symlinkSync(join(process.cwd(), "node_modules"), join(outDir, "node_modules"), "dir");
execFileSync(process.execPath, [join(outDir, "scripts", "check-callback-updates.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-activity-rendering.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-pairing-and-format.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-final-delivery.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-preview-manager.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-client-compact.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-client-turn-delivery.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-client-abort-turn.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-client-final-handoff.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-client-info.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-retry-aware-finalization.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-runtime-pi-hooks.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-manual-compaction.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-telegram-command-routing.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-model-picker.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-telegram-text-replies.js")], { stdio: "inherit" });
execFileSync(process.execPath, [join(outDir, "scripts", "check-session-route-cleanup.js")], { stdio: "inherit" });
