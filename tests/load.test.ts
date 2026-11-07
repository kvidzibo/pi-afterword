import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("manifest factory-loads through Pi without tools or model requests", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-afterword-load-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const root = fileURLToPath(new URL("../", import.meta.url));
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const loader = new DefaultResourceLoader({
		cwd: agentDir, agentDir,
		settingsManager: SettingsManager.inMemory({ packages: [] }),
		noExtensions: true,
		additionalExtensionPaths: manifest.pi.extensions.map((path: string) => join(root, path)),
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
	});
	await loader.reload();
	const result = loader.getExtensions();
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	const extension = result.extensions[0];
	assert.deepEqual([...extension.commands.keys()], ["pi-afterword"]);
	assert.equal(extension.tools.size, 0);
	assert.deepEqual([...extension.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
});
