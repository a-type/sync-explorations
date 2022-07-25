import { EventEmitter } from 'events';
import { Collapse, getHistoryCollapse } from './collapsing';
import { generateVersion, insertVersion } from './history';
import { applyPatch } from './patches';
import { clone } from './syncObjects';
import { traverseHistory } from './traversal';
import {
	Json,
	Patch,
	VersionInfo,
	History,
	Version,
	SyncObject,
} from './types';
import { mergeToSet, removeFromSet } from './utils';

// message protocol types
type ObjectChangesSummary<T> = {
	versions: VersionInfo<T>[];
	peerAcks: Record<string, string[]>;
};

type MessageHello<T extends Json> = {
	catchup: Record<string, ObjectChangesSummary<T>>;
	missingObjects: Record<string, SyncObject<T>>;
	knownPeers: string[];
};

type MessageHelloBack<T extends Json> = {
	catchup: Record<string, ObjectChangesSummary<T>>;
	missingObjects: Record<string, SyncObject<T>>;
	knownPeers: string[];
};

type MessageHelloBackBack<T extends Json> = {
	missingAcks: Record<string, string[]>;
};

type MessageHelloBackBackAck = {};

type MessageAckVersion = {
	objectId: string;
	version: string;
};

type MessageCollapse<T> = {
	objectId: string;
	newBase: T;
	newRoot: string;
	removeVersions: string[];
};

export class SyncClient<T> extends EventEmitter {
	private _objects = {} as Record<string, SyncObject<T>>;
	private _views = {} as Record<string, T>;
	topic: string;
	identity: string;
	private isServer: boolean;
	private _knownPeers = new Set<string>();

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
		this.updateVersionAck(id, this.identity, version.id);

		this.refreshView(id);
		this.emit(`change:${id}`);
		this.emit(`patch:${id}`, patch);

		// simulated network push of patch to connected peers
		for (const peer of Object.values(this._peers)) {
			this.simulateSend(() => {
				peer.receiveVersion(this.identity, {
					objectId: id,
					version,
				});
			});
		}
	};

	// simulated send - queues a task to run the callback
	// latency could be added...
	private simulateSend = (send: () => void) => {
		setTimeout(send, 10);
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

		console.log(
			this.identity,
			'received version',
			version.id,
			'from',
			fromPeer
		);

		const wasNew = insertVersion(obj.history, version);
		if (wasNew) {
			this.refreshView(objectId);
			// self-ack the version
			this.updateVersionAck(objectId, this.identity, version.id);
		}

		// ack the version for the peer that sent
		this.updateVersionAck(objectId, fromPeer, version.id);

		this.simulateSend(() => {
			// ack to the sender if we are connected to them
			this._peers[fromPeer]?.receiveVersionAck(this.identity, {
				objectId,
				version: version.id,
			});
		});

		if (wasNew) {
			// TODO: UNVALIDATED ASSUMPTION
			console.log(this.identity, 'set latest to', version.id);
			obj.history.latest = version.id;

			this.collapseObjectHistory(objectId);
		}

		if (wasNew && this.isServer) {
			for (const peerId of Object.keys(this._peers)) {
				if (peerId === fromPeer) continue;

				// emit to all other peers
				this.simulateSend(() => {
					this._peers[peerId].receiveVersion(this.identity, {
						objectId,
						version,
					});
					// also transmit the ack from the original sender
					this._peers[peerId].receiveVersionAck(fromPeer, {
						objectId,
						version: version.id,
					});
				});
			}
		}

		if (wasNew) {
			this.emit(`change:${objectId}`);
		}
	};

	private updateVersionAck = (
		objectId: string,
		peerId: string,
		version: string
	) => {
		const obj = this._objects[objectId];
		if (!obj) throw new Error('No object with id ' + objectId);
		if (!obj.peerAcks[peerId]) obj.peerAcks[peerId] = new Set();
		obj.peerAcks[peerId].add(version);
	};

	private receiveVersionAck = (
		fromPeer: string,
		{ objectId, version }: MessageAckVersion
	) => {
		this.updateVersionAck(objectId, fromPeer, version);
		console.log(this.identity, 'received ack of', version, 'from', fromPeer);

		this.collapseObjectHistory(objectId);

		if (this.isServer) {
			// broadcast ack to other clients
			for (const peerId of Object.keys(this._peers)) {
				if (peerId === fromPeer) continue;
				this.simulateSend(() => {
					this._peers[peerId].receiveVersionAck(fromPeer, {
						objectId,
						version,
					});
				});
			}
		}
	};

	private mergePeerAcks = (
		objectId: string,
		peerAcks: Record<string, string[]>
	) => {
		const obj = this._objects[objectId];
		if (!obj) throw new Error('No object with id ' + objectId);
		for (const [peerId, versions] of Object.entries(peerAcks)) {
			// this should probably be done somewhere more intentional
			this._knownPeers.add(peerId);

			console.log(this.identity, 'merging acks', peerId, versions);
			if (!obj.peerAcks[peerId]) {
				obj.peerAcks[peerId] = new Set();
			}
			mergeToSet(obj.peerAcks[peerId], versions);
		}
	};

	private applyCatchup = (
		fromPeer: string,
		catchup: Record<string, ObjectChangesSummary<T>>
	) => {
		for (const [id, summary] of Object.entries(catchup)) {
			for (const version of summary.versions) {
				this.receiveVersion(fromPeer, { objectId: id, version });
			}
			this.mergePeerAcks(id, summary.peerAcks);
			// case: server connects to new client and learns of a divergent
			// history branch. server needs to merge the branches and
			// send the new history to the new client.
			if (this.isServer) {
				this.mergeLeaves(this._objects[id]);
			}
		}
	};

	private applyMissingObjects = (
		fromPeer: string,
		missingObjects: Record<string, SyncObject<T>>
	) => {
		for (const [id, obj] of Object.entries(missingObjects)) {
			this._objects[id] = obj;
			const allVersions = Object.keys(obj.history.versions);
			for (const version of allVersions) {
				this.receiveVersionAck(this.identity, {
					objectId: id,
					version,
				});
				this.simulateSend(() => {
					this._peers[fromPeer]?.receiveVersionAck(this.identity, {
						objectId: id,
						version,
					});
				});
			}
		}
	};

	private receiveHello = (fromPeer: string, msg: MessageHello<T>) => {
		console.log(this.identity, 'received hello from', fromPeer, msg);
		this.applyCatchup(fromPeer, msg.catchup);
		this.applyMissingObjects(fromPeer, msg.missingObjects);
		mergeToSet(this._knownPeers, msg.knownPeers);

		const backlog = this.getChangeSummariesFor(fromPeer);
		console.log(this.identity, 'hello backing', fromPeer);
		this.simulateSend(() => {
			this._peers[fromPeer].receiveHelloBack(this.identity, {
				catchup: backlog.summaries,
				missingObjects: backlog.missingObjects,
				knownPeers: Array.from(this._knownPeers),
			});
		});

		// TODO: do we need an ack first?
		this.collapseAllHistory();

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
				const { summaries, missingObjects } = this.getChangeSummariesFor(
					peer.identity
				);
				this.simulateSend(() => {
					peer.receiveHelloBack(this.identity, {
						catchup: summaries,
						missingObjects,
						knownPeers: Array.from(this._knownPeers),
					});
				});
			}
		}

		this.emit('connected', fromPeer);
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
		console.log(this.identity, 'received hello back from', fromPeer, msg);
		this.applyCatchup(fromPeer, msg.catchup);
		this.applyMissingObjects(fromPeer, msg.missingObjects);
		mergeToSet(this._knownPeers, msg.knownPeers);

		// TODO: do we need to ack first?
		this.collapseAllHistory();

		this.emit('connected', fromPeer);
	};

	private getChangeSummariesFor = (peerId: string) => {
		const summaries: Record<string, ObjectChangesSummary<T>> = {};
		const missingObjects: Record<string, SyncObject<T>> = {};

		for (const [id, obj] of Object.entries(this._objects)) {
			// get the acked versions for this peer, defaulting to a new set if needed
			const peerVersions = obj.peerAcks[peerId];

			if (!peerVersions) {
				// this is a missing object for that peer - it has not seen it yet
				obj.peerAcks[peerId] = new Set();
				// cloning only necessary since this demo is all in-memory - IRL this
				// would be serialized across the network
				missingObjects[id] = clone(obj);
			} else {
				// this is fairly talkative - all peer acks will be sent for
				// every object
				if (!summaries[id]) {
					summaries[id] = {
						peerAcks: this.getPeerAcksFor(id),
						versions: [],
					};
				}
				// one catch here is that versions have to be sent in order,
				// oldest first.
				for (const version of Object.keys(obj.history.versions)) {
					if (!peerVersions.has(version)) {
						const versionList = summaries[id].versions;
						// FIXME: this is going to be ugly
						const childIndex = versionList.findIndex((v) =>
							v.parents.includes(version)
						);
						if (childIndex !== -1) {
							// insert before child
							versionList.splice(childIndex, 0, obj.history.versions[version]);
						} else {
							versionList.push(obj.history.versions[version]);
						}
					}
				}
			}
		}
		return { summaries, missingObjects };
	};

	private getPeerAcksFor = (objectId: string) => {
		const obj = this._objects[objectId];
		if (!obj) throw new Error('No object with id ' + objectId);
		return Object.keys(obj.peerAcks).reduce((acc, peerId) => {
			console.log(obj.peerAcks[peerId]);
			acc[peerId] = Array.from(obj.peerAcks[peerId]);
			return acc;
		}, {} as Record<string, string[]>);
	};

	private collapseAllHistory = () => {
		for (const id of Object.keys(this._objects)) {
			this.collapseObjectHistory(id);
		}
	};

	private collapseObjectHistory = (id: string) => {
		const collapse = this.getHistoryCollapse(id, this._objects[id]);
		if (collapse) {
			this.applyCollapse(collapse);
		}
	};

	private getHistoryCollapse = (objectId: string, obj: SyncObject<T>) => {
		return getHistoryCollapse(this.identity, objectId, obj, this._knownPeers);
	};

	private applyCollapse = (msg: Collapse<T>) => {
		console.log(
			this.identity,
			'collapsing history',
			'removing',
			msg.removeVersions,
			'setting new root',
			msg.newRoot
		);
		const obj = this._objects[msg.objectId];
		if (!obj) return;

		// apply resolved base
		obj.base = msg.newBase;
		// set the root pointer
		obj.history.root = msg.newRoot;
		// remove parents from the new root
		if (msg.newRoot) {
			obj.history.versions[msg.newRoot].parents = [];
		}
		// remove the versions from the history
		obj.history.versions = Object.keys(obj.history.versions).reduce(
			(acc, version) => {
				if (!msg.removeVersions.includes(version)) {
					acc[version] = obj.history.versions[version];
				}
				return acc;
			},
			{} as Record<string, Version<T>>
		);
		// special case: if history is totally collapsed, we should
		// reset latest
		if (Object.keys(obj.history.versions).length === 0) {
			console.log(this.identity, 'resetting latest');
			obj.history.latest = undefined;
		}
		// also clear the acked versions for all peers since they no longer need to be stored.
		for (const peer of Object.keys(obj.peerAcks)) {
			console.log(this.identity, 'removing acks', peer, msg.removeVersions);
			removeFromSet(obj.peerAcks[peer], msg.removeVersions);
		}
		this.refreshView(msg.objectId);
		this.emit(`change:${msg.objectId}`);
	};

	connect = (peer: SyncClient<T>) => {
		console.log(this.identity, 'connecting to', peer.identity);
		// rest spreading to create a new object because React... eh.
		this._peers = { ...this._peers, [peer.identity]: peer };
		// simulate mutual connection
		peer._peers = { ...peer._peers, [this.identity]: this };

		this._knownPeers.add(peer.identity);
		peer._knownPeers.add(this.identity);

		// negotiate history exchange with peer:
		// - connecting peer provides its history updates relative to
		//   its understanding of the other peer's view of history
		// - other peer responds with any missing history it thinks
		//   this peer needs
		// - this peer acks the history
		const initialHello = this.getChangeSummariesFor(peer.identity);
		this.simulateSend(() => {
			peer.receiveHello(this.identity, {
				catchup: initialHello.summaries,
				missingObjects: initialHello.missingObjects,
				knownPeers: Array.from(this._knownPeers),
			});
		});

		// moved to hello/helloback handlers
		// this.emit('connected', peer.identity);
		// peer.emit('connected', this.identity);
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
