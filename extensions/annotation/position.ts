export const BOX_MAX_WIDTH = 60;

export interface ReleasePoint {
	/** 0-based screen column of the mouse release. */
	x: number;
	/** 0-based screen row of the mouse release. */
	y: number;
	/** 0-based screen row of the press that started the selection, when known. */
	pressY?: number;
}

export interface BoxPlacement {
	row: number;
	col: number;
}

export function boxWidth(columns: number): number {
	return Math.max(1, Math.min(BOX_MAX_WIDTH, columns));
}

/**
 * The row below the selection, at the release column. When the box would run past the bottom, it
 * goes above the selection instead. Both are clamped to the screen.
 */
export function boxPlacement(point: ReleasePoint, box: { width: number; height: number }, screen: { columns: number; rows: number }): BoxPlacement {
	const first = Math.min(point.y, point.pressY ?? point.y);
	const last = Math.max(point.y, point.pressY ?? point.y);
	const below = last + 1;
	const row = below + box.height <= screen.rows ? below : first - box.height;
	return {
		row: clamp(row, 0, screen.rows - box.height),
		col: clamp(point.x, 0, screen.columns - box.width),
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, Math.max(min, max)));
}
