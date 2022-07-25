export type Json = Record<string, any>;

export type Patch<T extends Json> = {
	range: string;
	data: any;
};

export type Version<T> = {
	id: string;
	parents: string[];
	children: string[];
	patches: Patch<T>[];
};

export type VersionInfo<T> = {
	id: string;
	patches: Patch<T>[];
	parents: string[];
};

export type History<T> = {
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
