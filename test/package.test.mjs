import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
test("npm tarball contains only intended files and loads independently through Pi", async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-foreground-pack-"));
  try {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const packed = await exec("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], { cwd: root });
    const [info] = JSON.parse(packed.stdout);
    assert.deepEqual(info.files.map((file) => file.path).sort(), [
      "CHANGELOG.md", "LICENSE", "README.md", "RELEASING.md", "extensions/index.js", "lib/policy.js", "package.json",
    ].sort());
    await exec("tar", ["-xzf", join(temp, info.filename), "-C", temp]);
    const loader = new DefaultResourceLoader({
      cwd: temp, agentDir: temp, settingsManager: SettingsManager.inMemory({ packages: [] }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(temp, "package", "extensions", "index.js")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual([...loaded.extensions[0].tools.keys()], ["orca_terminal", "orca_agent"]);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
