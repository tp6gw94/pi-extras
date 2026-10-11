export const TAB = "    ";

// ESC sequences: OSC (ESC ] … BEL or ST), DCS, SOS, PM and APC strings (ESC P, X, ^, _ … ST),
// CSI (ESC [ params final), then any other ESC + intermediates + final byte.
const ESC_SEQUENCE =
	/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]?/g;
// C0 controls except tab and newline, DEL, and C1 controls (8-bit CSI, OSC and friends).
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function stripControls(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(ESC_SEQUENCE, "")
		.replace(CONTROL, "")
		.replace(/\t/g, TAB);
}
