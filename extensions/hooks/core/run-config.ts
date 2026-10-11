/**
 * Holds the config frozen at the start of a user prompt. While a run is active the
 * frozen copy is used even if the file changes on disk (the agent may edit it);
 * the change applies, after re-confirmation, from the next prompt.
 */
export class RunConfig<T extends { hash: string }> {
	private frozen: T | undefined;
	private active = false;
	private warned = new Set<string>();

	start(loaded: T | undefined): void {
		this.frozen = loaded;
		this.active = true;
		this.warned.clear();
	}

	end(): void {
		this.frozen = undefined;
		this.active = false;
	}

	get isActive(): boolean {
		return this.active;
	}

	get config(): T | undefined {
		return this.frozen;
	}

	/** True once per distinct on-disk hash that differs from the frozen one (undefined = file removed). */
	shouldWarnChange(currentHash: string | undefined): boolean {
		if (!this.active || !this.frozen || currentHash === this.frozen.hash) return false;
		const key = currentHash ?? "<missing>";
		if (this.warned.has(key)) return false;
		this.warned.add(key);
		return true;
	}
}
