// deterministically insert a patch into history such that any set

import { History, Json, VersionInfo } from './types';

// of patches inserted at any time will end up with the same ordering
// returns true if version was inserted, false if it was duplicate.
export function insertVersion<T extends Json>(
	history: History<T>,
	info: VersionInfo<T>
): boolean {
	if (history.versions[info.id]) {
		console.log('I already have', info.id);
		return false;
	}
	// iterate to find the parent in history. if parent is not found, insert at the
	// end?
	// special cases:
	// - inserting a patch with no parent into a list which already has parenting
	// - inserting a patch whose parent is not found in the list? probably the same as above.

	if (!info.parents.length) {
		if (Object.keys(history.versions).length === 0) {
			// brand new history, first patch.
			history.versions[info.id] = {
				id: info.id,
				parents: info.parents,
				children: [],
				patches: info.patches,
			};
			history.root = info.id;
			history.latest = info.id;
		} else {
			throw new Error(
				'Cannot insert version ' +
					info.id +
					' with parents ' +
					info.parents +
					': parent not found in history. I know of: ' +
					Object.keys(history.versions)
			);
		}
	} else if (!history.root) {
		throw new Error(
			`Cannot insert version ${info.id} with parents ${info.parents}: history has no root`
		);
	} else {
		// find all parents ad add as child
		for (const parent of info.parents) {
			const parentVersion = history.versions[parent];
			if (!parentVersion) {
				throw new Error(
					`Cannot insert version ${info.id} with parents ${
						info.parents
					}: parent not found in history. I know of: ${Object.keys(
						history.versions
					)}`
				);
			}
			parentVersion.children.push(info.id);
			parentVersion.children.sort();
		}
		history.versions[info.id] = {
			id: info.id,
			parents: info.parents,
			children: [],
			patches: info.patches,
		};
	}

	return true;
}

export function generateVersion() {
	return Math.floor(Math.random() * 1000000).toFixed(0);
}
