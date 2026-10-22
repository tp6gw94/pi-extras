import { decodeKittyPrintable, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { bindings } from "./state.ts";

export const namedKeys: readonly KeyId[] = [...new Set(bindings.flatMap((binding) => binding.keys).filter((key): key is KeyId => key.length > 1))];

export function keyOf(data: string): string | undefined {
	for (const name of namedKeys) if (matchesKey(data, name)) return name;
	const printable = decodeKittyPrintable(data) ?? data;
	return [...printable].length === 1 && printable >= " " ? printable : undefined;
}
