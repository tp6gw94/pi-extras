export class FixCounter {
	private used = 0;
	private max: number;
	constructor(max: number) {
		this.max = max;
	}

	reset(max?: number): void {
		this.used = 0;
		if (max !== undefined) this.max = max;
	}

	setMax(max: number): void {
		this.max = max;
	}

	get attempts(): number {
		return this.used;
	}

	get limit(): number {
		return this.max;
	}

	get exhausted(): boolean {
		return this.used >= this.max;
	}

	tryConsume(): number | undefined {
		if (this.used >= this.max) return undefined;
		this.used++;
		return this.used;
	}
}
