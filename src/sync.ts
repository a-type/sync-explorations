import { EventEmitter } from 'events';

type Json = Record<string, any>;

type Patch<T extends Json> = {
	range: string;
	data: any;
};

type Version<T> = {
	id: string;
	parents: string[];
	children: string[];
	patches: Patch<T>[];
};

type VersionInfo<T> = {
	id: string;
	patches: Patch<T>[];
	parents: string[];
};

type History<T> = {
	root: string | undefined;
	latest: string | undefined;
	versions: Record<string, Version<T>>;
};

export type SyncObject<T extends Json> = {
	base: T;
	history: History<T>;
	/* Record of all versions we know a peer has seen */
	peerAcks: Record<string, Set<string>>;
};

// this is exteremely basic with no error checks, in real life you'd want a proper patching solution
function applyPatch<T extends Json>(base: T, patch: Patch<T>): T {
	if (patch.range.startsWith('-')) {
		// delete patch
		const [key, ...rest] = patch.range.slice(1).split('.');
		if (rest.length === 0) {
			delete base[key];
			return base;
		} else {
			return {
				...base,
				[key as keyof T]: applyPatch(base[key as keyof T], {
					...patch,
					range: '-' + rest.join('.'),
				}),
			};
		}
	} else {
		const [key, ...rest] = patch.range.split('.');
		if (rest.length === 0) {
			return { ...base, [key as keyof T]: patch.data };
		} else {
			return {
				...base,
				[key as keyof T]: applyPatch(base[key as keyof T], {
					...patch,
					range: rest.join('.'),
				}),
			};
		}
	}
}

// deterministically insert a patch into history such that any set
// of patches inserted at any time will end up with the same ordering
function insertVersion<T extends Json>(
	history: History<T>,
	info: VersionInfo<T>
) {
	if (history.versions[info.id]) {
		console.log('I already have', info.id);
		return;
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
}

function generateVersion() {
	return Math.floor(Math.random() * 1000000).toFixed(0);
}

function traverseHistory<T>(
	history: History<T>,
	visitor: (v: Version<T>) => void
) {
	if (!history.root) return;
	traverseFromVersion(history, history.root, visitor);
}
function traverseFromVersion(
	history: History<Json>,
	version: string,
	visitor: (v: Version<Json>) => void
) {
	let current = history.versions[version];
	visitor(current);
	// breadth-first traversal
	for (const child of current.children) {
		visitor(history.versions[child]);
	}
	for (const child of current.children) {
		traverseFromVersion(history, child, visitor);
	}
}

// message protocol types
type MessageHello<T extends Json> = {
	catchup: Record<string, VersionInfo<T>[]>;
};

type MessageHelloBack<T extends Json> = {
	catchup: Record<string, VersionInfo<T>[]>;
};

type MessageAckVersion = {
	objectId: string;
	version: string;
};

type MessageRealtimePatch<T> = {
	sourcePeer: string;
	objectId: string;
	patch: Patch<T>;
};

type MessageRealtimePatchAck = {
	objectId: string;
	version: string;
};

export class SyncClient<T> extends EventEmitter {
	private _objects = {} as Record<string, SyncObject<T>>;
	private _views = {} as Record<string, T>;
	topic: string;
	identity: string;
	private isServer: boolean;

	private _peers: Record<string, SyncClient<T>> = {};
	get peers() {
		return this._peers;
	}

	constructor({
		identity,
		topic,
		seed,
		isServer,
	}: {
		identity: string;
		topic: string;
		seed?: Record<string, T>;
		isServer?: boolean;
	}) {
		super();

		this.identity = identity;
		this.topic = topic;
		this.isServer = !!isServer;

		if (seed) {
			this._objects = Object.entries(seed).reduce((acc, [key, value]) => {
				acc[key] = {
					base: value,
					history: { root: undefined, latest: undefined, versions: {} },
					peerAcks: { [this.identity]: new Set() },
				};
				return acc;
			}, {} as Record<string, SyncObject<T>>);
			for (const key of Object.keys(this._objects)) {
				this.refreshView(key);
			}
		}
	}

	private refreshView = (id: string) => {
		const obj = this._objects[id];
		let view = obj.base;
		traverseHistory(obj.history, (v) => {
			view = v.patches.reduce(applyPatch, view);
		});
		this._views[id] = view;
	};

	get = (id: string) => {
		if (this._views[id]) {
			return this._views[id];
		}
		// resolve and flatten into a final object before returning
		const obj = this._objects[id];
		if (!obj) return null;
		this.refreshView(id);
		return this._views[id];
	};

	getRaw = (id: string) => {
		const obj = this._objects[id];
		if (!obj) return null;
		return obj;
	};

	ids = () => {
		return Object.keys(this._objects);
	};

	set = (id: string, range: string, value?: any) => {
		const obj = this._objects[id];
		if (!obj) throw new Error('No object with id ' + id);
		const parent = obj.history.latest;
		const patch: Patch<T> = {
			range,
			data: value,
		};
		const version = {
			id: generateVersion(),
			parents: parent ? [parent] : [],
			patches: [patch],
		};
		insertVersion(obj.history, version);
		obj.history.latest = version.id;

		// self-ack the version
		this.receiveVersionAck(this.identity, {
			objectId: id,
			version: version.id,
		});

		this.refreshView(id);
		this.emit(`change:${id}`);
		this.emit(`patch:${id}`, patch);

		// simulated network push of patch to connected peers
		for (const peer of Object.values(this._peers)) {
			peer.receiveVersion(this.identity, {
				objectId: id,
				version,
			});
		}
	};

	private receiveVersion = (
		fromPeer: string,
		{
			objectId,
			version,
		}: {
			objectId: string;
			version: VersionInfo<T>;
		}
	) => {
		const obj = this._objects[objectId];
		if (!obj) throw new Error('No object with id ' + objectId);

		insertVersion(obj.history, version);
		this.refreshView(objectId);

		// self-ack the version
		this.receiveVersionAck(this.identity, {
			objectId: objectId,
			version: version.id,
		});
		// ack the version for the peer that sent
		this.receiveVersionAck(fromPeer, {
			objectId: objectId,
			version: version.id,
		});

		// ack to the sender if we are connected to them
		this._peers[fromPeer]?.receiveVersionAck(this.identity, {
			objectId,
			version: version.id,
		});

		// TODO: UNVALIDATED ASSUMPTION
		obj.history.latest = version.id;

		if (this.isServer) {
			for (const peerId of Object.keys(this._peers)) {
				if (peerId === fromPeer) continue;

				// emit to all other peers
				this._peers[peerId].receiveVersion(this.identity, {
					objectId,
					version,
				});
			}
		}

		this.emit(`change:${objectId}`);
	};

	private receiveVersionAck = (
		fromPeer: string,
		{ objectId, version }: MessageAckVersion
	) => {
		const obj = this._objects[objectId];
		if (!obj) throw new Error('No object with id ' + objectId);
		if (!obj.peerAcks[fromPeer]) obj.peerAcks[fromPeer] = new Set();
		obj.peerAcks[fromPeer].add(version);
		console.log(this.identity, 'received ack of', version, 'from', fromPeer);
	};

	private receiveHello = (fromPeer: string, msg: MessageHello<T>) => {
		for (const [id, versions] of Object.entries(msg.catchup)) {
			for (const version of versions) {
				this.receiveVersion(fromPeer, { objectId: id, version });
			}
			// case: server connects to new client and learns of a divergent
			// history branch. server needs to merge the branches and
			// send the new history to the new client.
			if (this.isServer) {
				this.mergeLeaves(this._objects[id]);
			}
		}
		const backlog = this.getVersionsFor(fromPeer);
		console.log(this.identity, 'hello backing', fromPeer);
		this._peers[fromPeer].receiveHelloBack(this.identity, {
			catchup: backlog,
		});

		// case: server is connected to one client and another client
		// comes online.
		// we want the first client to receive their copy of
		// the second client's new history bootstraps
		if (this.isServer) {
			for (const peer of Object.values(this._peers)) {
				if (peer.identity === fromPeer) continue;

				// TODO: this probably deserves its own protocol exchange
				console.log(
					this.identity,
					'catching up peer',
					peer.identity,
					'with new hello patches from',
					fromPeer
				);
				peer.receiveHelloBack(this.identity, {
					catchup: this.getVersionsFor(peer.identity),
				});
			}
		}
	};

	private mergeLeaves = (obj: SyncObject<T>) => {
		const leaves = Object.values(obj.history.versions).filter(
			(v) => v.children.length === 0
		);
		if (leaves.length === 1) return leaves[0];
		const merge: Version<T> = {
			id: generateVersion(),
			parents: leaves.map((v) => v.id),
			// empty patches - this just exists to link the branches together
			patches: [],
			children: [],
		};
		obj.history.versions[merge.id] = merge;
		obj.history.latest = merge.id;
		return merge;
	};

	private receiveHelloBack = (fromPeer: string, msg: MessageHelloBack<T>) => {
		for (const [id, versions] of Object.entries(msg.catchup)) {
			for (const version of versions) {
				this.receiveVersion(fromPeer, { objectId: id, version });
			}
		}
	};

	private getVersionsFor = (peerId: string) => {
		const versions: Record<string, Version<T>[]> = {};
		for (const [id, obj] of Object.entries(this._objects)) {
			// get the acked versions for this peer, defaulting to a new set if needed
			const peerVersions = (obj.peerAcks[peerId] =
				obj.peerAcks[peerId] || new Set());

			// one catch here is that versions have to be sent in order,
			// oldest first.
			for (const version of Object.keys(obj.history.versions)) {
				if (!peerVersions.has(version)) {
					if (!versions[id]) versions[id] = [];
					const versionList = versions[id];
					// FIXME: this is going to be ugly
					const childIndex = versionList.findIndex((v) =>
						v.parents.includes(version)
					);
					if (childIndex !== -1) {
						// insert before child
						versionList.splice(childIndex, 0, obj.history.versions[version]);
					} else {
						versions[id].push(obj.history.versions[version]);
					}
				}
			}
		}
		return versions;
	};

	connect = (peer: SyncClient<T>) => {
		console.log(this.identity, 'connecting to', peer.identity);
		// rest spreading to create a new object because React... eh.
		this._peers = { ...this._peers, [peer.identity]: peer };
		// simulate mutual connection
		peer._peers = { ...peer._peers, [this.identity]: this };

		// negotiate history exchange with peer:
		// - connecting peer provides its history updates relative to
		//   its understanding of the other peer's view of history
		// - other peer responds with any missing history it thinks
		//   this peer needs
		// - this peer acks the history
		peer.receiveHello(this.identity, {
			catchup: this.getVersionsFor(peer.identity),
		});

		this.emit('connected', peer.identity);
		peer.emit('connected', this.identity);
		console.log(this.identity, 'connected to', peer.identity);
	};

	disconnect = (peer: SyncClient<T>) => {
		delete this._peers[peer.identity];
		this._peers = { ...this._peers };

		delete peer._peers[this.identity];
		peer._peers = { ...peer._peers };

		this.emit('disconnected', peer.identity);
		console.log(this.identity, 'disconnected from', peer.identity);
	};
}
