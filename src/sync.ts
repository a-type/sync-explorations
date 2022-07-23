import { EventEmitter } from "events";

type Json = Record<string, any>;

type Patch<T extends Json> = {
  version: string;
  parent?: string;
  range: string;
  data: any;
};

type SyncObject<T extends Json> = {
  base: T;
  patches: Patch<T>[];
  peerVersions: Record<string, string>;
};

function toSyncObject<T extends Json>(initial: T) {
  return {
    base: initial,
    patches: [],
    peerVersions: {}
  };
}

function applyPatch<T extends Json>(base: T, patch: Patch<T>): T {
  // this is exteremely basic with no error checks, in real life you'd want a proper patching solution
  const [key, ...rest] = patch.range.split(".");
  if (rest.length === 0) {
    return { ...base, [key as keyof T]: patch.data };
  } else {
    return {
      ...base,
      [key as keyof T]: applyPatch(base[key as keyof T], {
        ...patch,
        range: rest.join(".")
      })
    };
  }
}

// FIXME: NOT DETERMINISTIC LOL
// deterministically insert a patch into history such that any set
// of patches inserted at any time will end up with the same ordering
function insertPatch<T extends Json>(history: Patch<T>[], patch: Patch<T>) {
  // iterate to find the parent in history. if parent is not found, insert at the
  // end?
  // special cases:
  // - inserting a patch with no parent into a list which already has parenting
  // - inserting a patch whose parent is not found in the list? probably the same as above.

  const parentIndex = history.findIndex((p) => p.version === patch.parent);

  if (parentIndex === -1) {
    if (history.length === 0) {
      // brand new history, first patch.
      history.push(patch);
      return history.length - 1;
    } else {
      throw new Error(
        "Cannot insert patch with version " +
          patch.version +
          " and parent " +
          patch.parent +
          ": parent not found in history. I know of: " +
          history.map((p) => p.version).join(", ")
      );
    }
  } else {
    // the next N patches could have the same parent.
    // to insert deterministically, we compare versions and
    // insert in lexical order among other siblings
    let insertionIndex = parentIndex + 1;
    while (
      history[insertionIndex] &&
      history[insertionIndex].parent === patch.parent &&
      history[insertionIndex].version < patch.version
    ) {
      insertionIndex++;
    }
    // special case: the patch already exists in our history
    if (history[insertionIndex]?.version === patch.version) {
      console.log("I already have", patch.version);
      return insertionIndex;
    }

    history.splice(insertionIndex, 0, patch);
    return insertionIndex;
  }
}

function generateVersion() {
  return Math.floor(Math.random() * 1000000).toFixed(0);
}

// message protocol types
type MessageHello<T extends Json> = {
  catchup: Record<string, Patch<T>[]>;
};

type MessageHelloBack<T extends Json> = {
  // TODO: this might be redudnant
  acks: Record<string, string>;
  catchup: Record<string, Patch<T>[]>;
};

type MessageHelloBackBack = {
  // TODO: this might be redundant
  acks: Record<string, string>;
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

  private _peers: Record<string, SyncClient<T>> = {};
  get peers() {
    return this._peers;
  }

  constructor({
    identity,
    topic,
    seed
  }: {
    identity: string;
    topic: string;
    seed?: Record<string, T>;
  }) {
    super();

    this.identity = identity;
    this.topic = topic;
    if (seed) {
      this._objects = Object.entries(seed).reduce((acc, [key, value]) => {
        acc[key] = toSyncObject(value);
        return acc;
      }, {} as Record<string, SyncObject<T>>);
      for (const key of Object.keys(this._objects)) {
        this.refreshView(key);
      }
    }
  }

  private refreshView = (id: string) => {
    const obj = this._objects[id];
    this._views[id] = obj.patches.reduce(applyPatch, obj.base);
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

  set = (id: string, range: string, value: any) => {
    const obj = this._objects[id];
    if (!obj) throw new Error("No object with id " + id);
    const parent = obj.patches.length
      ? obj.patches[obj.patches.length - 1].version
      : undefined;
    const patch = {
      parent,
      version: generateVersion(),
      range,
      data: value
    };
    insertPatch(obj.patches, patch);

    this.refreshView(id);
    this.emit(`change:${id}`);
    this.emit(`patch:${id}`, patch);

    // simulated network push of patch to connected peers
    for (const peer of Object.values(this._peers)) {
      peer.receiveRealtimePatch(this.identity, {
        sourcePeer: this.identity,
        objectId: id,
        patch
      });
    }
  };

  private receivePatches = (
    fromPeer: string,
    objectId: string,
    patches: Patch<T>[]
  ) => {
    const obj = this._objects[objectId];
    if (!obj) throw new Error("No object with id " + objectId);
    let earliestInsertedIndex = Infinity;
    for (const patch of patches) {
      const insertedAt = insertPatch(obj.patches, patch);
      earliestInsertedIndex = Math.min(earliestInsertedIndex, insertedAt);
    }

    // record the latest version we know that peer has seen.
    const latestVersion = patches[patches.length - 1].version;
    obj.peerVersions[fromPeer] = latestVersion;

    this.refreshView(objectId);
    this.emit(`change:${objectId}`);

    if (earliestInsertedIndex !== Infinity) {
      for (const peerId of Object.keys(obj.peerVersions)) {
        if (peerId === fromPeer) continue;

        this.rewindPeer(peerId, objectId, earliestInsertedIndex);
      }
    }
  };

  private rewindPeer = (peerId: string, objectId: string, versionIndex: number) => {
    const obj = this._objects[objectId];
    if (!obj) throw new Error("No object with id " + objectId);
    const peerVersion = obj.peerVersions[peerId];
    if (peerVersion && obj.patches.findIndex((p) => p.version === peerVersion) < versionIndex) {
      // peer is already further back in history
      return;
    }
    obj.peerVersions[peerId] = obj.patches[versionIndex].version;
    // if peer is online, send immediately
    if (this._peers[peerId]) {
      this._peers[peerId].receiveHelloBack(
        this.identity,
        { acks: {},
        catchup: { [objectId]:
        obj.patches.slice(versionIndex)
        },
      }
      );
    }
  }

  private receiveRealtimePatch = (
    fromPeer: string,
    msg: MessageRealtimePatch<T>
  ) => {
    this.receivePatches(fromPeer, msg.objectId, [msg.patch]);
    for (const peer of Object.values(this._peers)) {
      if (peer.identity !== fromPeer && peer.identity !== msg.sourcePeer) {
        peer.receiveRealtimePatch(this.identity, msg);
      }
    }

    // TODO: prevent infinite gossip loops

    this._peers[fromPeer].receiveRealtimePatchAck(this.identity, {
      objectId: msg.objectId,
      version: msg.patch.version
    });
  };

  private receiveRealtimePatchAck = (
    fromPeer: string,
    msg: MessageRealtimePatchAck
  ) => {
    this._objects[msg.objectId].peerVersions[fromPeer] = msg.version;
  };

  private receiveHello = (fromPeer: string, msg: MessageHello<T>) => {
    const acks: Record<string, string> = {};
    for (const [id, patches] of Object.entries(msg.catchup)) {
      this.receivePatches(fromPeer, id, patches);
      const ourLatestVersion = this._objects[id].patches[
        this._objects[id].patches.length - 1
      ].version;
      acks[id] = ourLatestVersion;
    }
    const backPatches = this.getPatchesFor(fromPeer)
    console.log(this.identity, 'hello backing', fromPeer)
    this._peers[fromPeer].receiveHelloBack(this.identity, {
      acks,
      catchup: backPatches
    });

    // case: server is connected to one client and another client
    // comes online.
    // we want the first client to receive their copy of
    // the second client's new history bootstraps
    for (const peer of Object.values(this._peers)) {
      if (peer.identity === fromPeer) continue;

      // TODO: this probably deserves its own protocol exchange
      console.log(this.identity, 'catching up peer', peer.identity, 'with new hello patches from', fromPeer);
      peer.receiveHelloBack(this.identity, {
        catchup: this.getPatchesFor(peer.identity),
        acks: {}
      });
    }
  };

  private receiveHelloBack = (fromPeer: string, msg: MessageHelloBack<T>) => {
    for (const [id, version] of Object.entries(msg.acks)) {
      this._objects[id].peerVersions[fromPeer] = version;
    }

    const acks: Record<string, string> = {};
    for (const [id, patches] of Object.entries(msg.catchup)) {
      this.receivePatches(fromPeer, id, patches);
      const ourLatestVersion = this._objects[id].patches[
        this._objects[id].patches.length - 1
      ].version;
      acks[id] = ourLatestVersion;
    }
    console.log(this.identity, 'hello-back-backing', fromPeer);
    this._peers[fromPeer].receiveHelloBackBack(this.identity, { acks });
  };

  private receiveHelloBackBack = (
    fromPeer: string,
    msg: MessageHelloBackBack
  ) => {
    for (const [id, version] of Object.entries(msg.acks)) {
      this._objects[id].peerVersions[fromPeer] = version;
    }
  };

  private getPatchesFor = (peerId: string) => {
    const patches: Record<string, Patch<T>[]> = {};
    for (const [id, obj] of Object.entries(this._objects)) {
      const peerVersion = obj.peerVersions[peerId];
      let relativeHistoryStart = obj.patches.findIndex(
        (p) => p.version === peerVersion
      );
      // if the peer has never been seen before, send all history
      // TODO: good idea?
      const patchRange = obj.patches.slice(relativeHistoryStart + 1);
      if (patchRange.length) {
        console.log(`${this.identity} sees ${peerId} at ${peerVersion}`);
        console.log(
          `${this.identity} sending ${patchRange.length} patches to peer ${peerId} for object ${id}`
        );
        patches[id] = patchRange;
      }
    }
    return patches;
  };

  connect = (peer: SyncClient<T>) => {
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
      catchup: this.getPatchesFor(peer.identity)
    });

    this.emit("connected", peer.identity);
    peer.emit("connected", this.identity);
    console.log(this.identity, "connected to", peer.identity);
  };

  disconnect = (peer: SyncClient<T>) => {
    delete this._peers[peer.identity];
    this._peers = { ...this._peers };

    delete peer._peers[this.identity];
    peer._peers = { ...peer._peers };

    this.emit("disconnected", peer.identity);
    console.log(this.identity, "disconnected from", peer.identity);
  };
}
