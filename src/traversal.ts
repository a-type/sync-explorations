import { History, Json, Version } from './types';

export function traverseHistory<T>(
	history: History<T>,
	visitor: (v: Version<T>) => boolean | void
) {
	if (!history.root) return;
	traverseFromVersion(history, history.root, visitor);
}
function traverseFromVersion(
	history: History<Json>,
	version: string,
	visitor: (v: Version<Json>) => boolean | void
) {
	let current = history.versions[version];
	// this traversal is resilient to missing nodes in the history
	if (!current) {
		return;
	}

	visitor(current);
	// breadth-first-ish? traversal
	for (const child of current.children) {
		traverseFromVersion(history, child, visitor);
	}
}
