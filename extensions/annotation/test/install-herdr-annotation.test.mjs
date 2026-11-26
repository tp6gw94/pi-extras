import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const INSTALLER = fileURLToPath(new URL("../bin/install-herdr-annotation.mjs", import.meta.url));
const SOURCE = fileURLToPath(new URL("../herdr-mod/", import.meta.url));
const FILES = ["client.js", "keyboard.js", "main.js", "mod.json", "model.js"];

function fakeHome(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi-extras-herdr-install-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function install({ home, appHome, installer = INSTALLER } = {}) {
	const env = { ...process.env };
	delete env.HERDR_APP_HOME;
	if (home !== undefined) env.HOME = home;
	if (appHome !== undefined) env.HERDR_APP_HOME = appHome;
	return spawnSync(process.execPath, [installer], { env, encoding: "utf8" });
}

test("ships an executable Node ESM installer", () => {
	assert.notEqual(statSync(INSTALLER).mode & 0o111, 0);
	assert.match(readFileSync(INSTALLER, "utf8"), /^#!\/usr\/bin\/env node\n/);
});

test("installs the mod files and leaves existing app files alone", (t) => {
	const home = fakeHome(t);
	const settings = join(home, "settings.json");
	const keys = join(home, "keys.json");
	const otherMod = join(home, "mods", "other", "mod.json");
	writeFileSync(settings, '{"zoom":2}\n');
	writeFileSync(keys, '{"toggle":"ctrl-t"}\n');
	mkdirSync(join(home, "mods", "other"), { recursive: true });
	writeFileSync(otherMod, '{"place":"none"}\n');

	const result = install({ appHome: home });
	assert.equal(result.status, 0, result.stderr);
	const target = join(home, "mods", "pi-annotate");
	assert.deepEqual(readdirSync(target).sort(), FILES);
	for (const file of FILES) assert.equal(readFileSync(join(target, file), "utf8"), readFileSync(join(SOURCE, file), "utf8"), file);
	assert.equal(readFileSync(settings, "utf8"), '{"zoom":2}\n');
	assert.equal(readFileSync(keys, "utf8"), '{"toggle":"ctrl-t"}\n');
	assert.equal(readFileSync(otherMod, "utf8"), '{"place":"none"}\n');
});

test("uses ~/.config/herdr-app when HERDR_APP_HOME is unset or empty", (t) => {
	for (const appHome of [undefined, ""]) {
		const home = fakeHome(t);
		const result = install({ home, appHome });
		assert.equal(result.status, 0, result.stderr);
		assert.ok(readdirSync(join(home, ".config", "herdr-app", "mods", "pi-annotate")).length > 0);
	}
});

test("removes only its newly reserved directory when a source file cannot be read", (t) => {
	const root = fakeHome(t);
	const packageHome = join(root, "package");
	const installer = join(packageHome, "extensions", "annotation", "bin", "install-herdr-annotation.mjs");
	const source = join(packageHome, "extensions", "annotation", "herdr-mod");
	mkdirSync(join(packageHome, "extensions", "annotation", "bin"), { recursive: true });
	mkdirSync(source);
	copyFileSync(INSTALLER, installer);
	for (const file of FILES) if (file !== "model.js") copyFileSync(join(SOURCE, file), join(source, file));

	const appHome = join(root, "app-home");
	const settings = join(appHome, "settings.json");
	const otherMod = join(appHome, "mods", "other", "mod.json");
	mkdirSync(join(appHome, "mods", "other"), { recursive: true });
	writeFileSync(settings, '{"zoom":2}\n');
	writeFileSync(otherMod, '{"place":"none"}\n');

	const result = install({ appHome, installer });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /model\.js/);
	assert.equal(existsSync(join(appHome, "mods", "pi-annotate")), false);
	assert.equal(readFileSync(settings, "utf8"), '{"zoom":2}\n');
	assert.equal(readFileSync(otherMod, "utf8"), '{"place":"none"}\n');
});

for (const kind of ["directory", "file", "symlink"]) {
	test(`refuses an existing ${kind} at the mod path without replacing it`, (t) => {
		const home = fakeHome(t);
		const mods = join(home, "mods");
		const target = join(mods, "pi-annotate");
		mkdirSync(mods, { recursive: true });
		let outside;
		if (kind === "directory") {
			mkdirSync(target);
			writeFileSync(join(target, "keep.txt"), "keep\n");
		} else if (kind === "file") {
			writeFileSync(target, "keep\n");
		} else {
			outside = join(home, "outside");
			mkdirSync(outside);
			writeFileSync(join(outside, "keep.txt"), "keep\n");
			symlinkSync(outside, target);
		}

		const result = install({ appHome: home });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /already exists\. Back it up and move it outside the mods directory before reinstalling\./);
		if (kind === "directory") assert.deepEqual(readdirSync(target), ["keep.txt"]);
		if (kind === "file") assert.equal(readFileSync(target, "utf8"), "keep\n");
		if (kind === "symlink") {
			assert.ok(lstatSync(target).isSymbolicLink());
			assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep\n");
			assert.deepEqual(readdirSync(outside), ["keep.txt"]);
		}
	});
}
