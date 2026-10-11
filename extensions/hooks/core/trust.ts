import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function hashConfig(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Remembers which hooks.json content (by sha256) the user approved, keyed by the
 * config file's absolute path. Stored outside the repo so a cloned repo cannot
 * pre-approve itself.
 */
export class TrustStore {
	private readonly file: string;
	constructor(file: string) {
		this.file = file;
	}

	private async load(): Promise<Record<string, string>> {
		try {
			const data = JSON.parse(await readFile(this.file, "utf8")) as unknown;
			return typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, string>) : {};
		} catch {
			return {};
		}
	}

	async isTrusted(configPath: string, hash: string): Promise<boolean> {
		return (await this.load())[configPath] === hash;
	}

	async trust(configPath: string, hash: string): Promise<void> {
		const data = await this.load();
		data[configPath] = hash;
		await mkdir(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		await rename(tmp, this.file);
	}
}
