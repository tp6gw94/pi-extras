#!/usr/bin/env node
import { copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FILES = ["main.js", "model.js", "client.js", "mod.json"];
const source = fileURLToPath(new URL("../herdr-mod/", import.meta.url));
const appHome = process.env.HERDR_APP_HOME || join(homedir(), ".config/herdr-app");
const mods = join(appHome, "mods");
const target = join(mods, "pi-annotate");

async function install() {
	await mkdir(mods, { recursive: true });
	try {
		await mkdir(target);
	} catch (error) {
		if (error.code === "EEXIST") throw new Error(`${target} already exists. Back it up and move it outside the mods directory before reinstalling.`);
		throw error;
	}
	try {
		for (const file of FILES) await copyFile(join(source, file), join(target, file));
	} catch (error) {
		await rm(target, { recursive: true, force: true });
		throw error;
	}
	console.log(`Installed the Herdr annotation mod to ${target}.`);
}

try {
	await install();
} catch (error) {
	console.error(`pi-extras-install-herdr-annotation: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
