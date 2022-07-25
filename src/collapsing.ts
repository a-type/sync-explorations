import { applyPatch } from './patches';
import { traverseHistory } from './traversal';
import { Json, SyncObject, Version } from './types';

type Bubble<T extends Json> = {
	start: Version<T>;
	end: Version<T> | null;
	contains: string[];
};

export const getHistoryCollapse = <T extends Json>(
	identity: string,
	objectId: string,
	obj: SyncObject<T>,
	knownPeers: Set<string>
) => {
	// we can collapse history for any versions which meet the criteria:
	// every version in the version range has been acked by every known peer
	// we don't leave any dangling branches

	if (!obj.history.root) return null;

	// start from the root, the most likely to be confirmed by all.
	const bubble = findBubble(identity, obj, obj.history.root, knownPeers);

	// if we didn't find a bubble, there's nothing to do
	if (bubble.contains.length === 0) return null;

	// we found a bubble, so we can collapse it.
	// we need to remove all versions in the bubble from the history,
	// then set the new root,
	// then update the base to reflect all the patches from the
	// removed versions.

	// traverse from the root to the end of the bubble, applying patches
	// as we would for computing a view
	let view = obj.base;
	const historySubset = bubble.contains.reduce((acc, version) => {
		acc[version] = obj.history.versions[version];
		return acc;
	}, {} as Record<string, Version<T>>);
	traverseHistory<T>(
		{
			latest: bubble.end?.id,
			versions: historySubset,
			root: bubble.start.id,
		},
		(version) => {
			view = version.patches.reduce(applyPatch, view);
		}
	);

	// the new root is the child of end. if end has no children,
	// we collapsed the whole tree! that's fine.
	const newRoot = bubble.end?.id || undefined;

	// remove the versions from the history and update the base
	return {
		newBase: view,
		newRoot,
		removeVersions: bubble.contains,
		objectId,
	};
};

// using Braid's terminology here, maybe incorrectly.
// a bubble is any connected set of versions which are
// acknowledged by every peer and which start and end with
// a single node and include no unterminated branches
const findBubble = <T extends Json>(
	identity: string,
	obj: SyncObject<T>,
	startAt: string,
	knownPeers: Set<string>
): Bubble<T> => {
	let end: Version<T> | null = null;
	const allVersions = new Array<string>();

	// keep following bubbles until we reach an end.
	let current: Version<T> | null = obj.history.versions[startAt];
	while (current) {
		// if there are multiple children on this level
		// if (pointer.length > 1) {
		const result: { end: Version<T>; contains: Set<string> } | null =
			exploreBranchedBubble<T>(obj, current, knownPeers);
		if (result) {
			allVersions.push(...result.contains);
			// continue on from the end of the bubble
			current = result.end;
			// update the end of the bubble - this might be null,
			// which means we reached the end of history - we collapsed
			// the whole thing!
			end = result.end;
		} else {
			// bubble failed, stop here.
			current = null;
		}
	}

	return {
		start: obj.history.versions[startAt],
		end: end,
		contains: allVersions,
	};
};

const exploreBranchedBubble = <T extends Json>(
	obj: SyncObject<T>,
	startNode: Version<T>,
	knownPeers: Set<string>
): { end: Version<T>; contains: Set<string> } | null => {
	if (!isAckedByAllKnownPeers(obj, startNode.id, knownPeers)) {
		return null;
	}

	const seen = new Set<string>();
	seen.add(startNode.id);

	// no branches - just check this node.
	if (startNode.children.length < 2) {
		return {
			end: obj.history.versions[startNode.children[0]] || null,
			contains: seen,
		};
	}

	let branchCount = Math.max(0, startNode.children.length - 1);
	// to do this we track a "seen" list to not recount the same nodes
	// then we do breadth-first traversal down the tree. each node
	// is checked for ack; if no ack, we bail.
	// if ack, we add it to the seen list and add its children to the list for
	// next iteration.
	let thisIteration = [...startNode.children];
	let end;
	while (thisIteration.length > 0) {
		const version = thisIteration.shift()!;
		if (seen.has(version)) continue;

		const v = obj.history.versions[version];

		if (!isAckedByAllKnownPeers(obj, v.id, knownPeers)) return null;

		// these are all Math.max(0...) because if we reach a leaf
		// we don't want to negatively increment the branch count...
		// it hints there's a more elegant solution but meh

		// if this is a merge node, decrement branch count by its parents
		branchCount -= Math.max(0, v.parents.length - 1);
		// if this is the root of a new branch, increment branch count
		branchCount += Math.max(0, v.children.length - 1);

		if (branchCount === 0) {
			// we found the node that closes all known open branches.
			// record it as the end node. we don't proceed further.
			return {
				end: v,
				contains: seen,
			};
		} else {
			seen.add(v.id);

			// append on the children of this node to process next
			// ... it might be more efficient to rely on the continue above than
			// to try to deduplicate these here.
			thisIteration.push(
				...v.children.filter((child) => {
					// only visit children after we've visited all their parents,
					// which we're guaranteed to do if this bubble is closed
					const childVersion = obj.history.versions[child];
					return (
						!seen.has(child) &&
						childVersion.parents.every((parent) => seen.has(parent))
					);
				})
			);
		}
	}

	// if we make it here, that means there were branches that never closed -
	// branchCount was > 0 but there were no more children to process.
	// we can't merge this bubble.
	return null;
};

const isAckedByAllKnownPeers = <T extends Json>(
	obj: SyncObject<T>,
	version: string,
	knownPeers: Set<string>
) => {
	for (const peer of knownPeers) {
		if (!obj.peerAcks[peer].has(version)) return false;
	}
	return true;
};
