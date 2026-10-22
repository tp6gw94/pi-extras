import { decodeKittyPrintable, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { bindings } from "./state.ts";

const keyNames = bindings.flatMap((binding) => binding.keys);
const named = keyNames.filter((key): key is KeyId => key.length > 1);

export const namedKeys: readonly KeyId[] = [...new Set(named)];

export function keyOf(data: string): string | undefined {
	for (const name of namedKeys) if (matchesKey(data, name)) return name;
	const printable = decodeKittyPrintable(data) ?? data;
	return [...printable].length === 1 && printable >= " " ? printable : undefined;
}
