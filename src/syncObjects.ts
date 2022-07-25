import { SyncObject } from './types';
import { cloneDeep } from './utils';

export const clone = <T>(obj: SyncObject<T>): SyncObject<T> => {
	return {
		base: cloneDeep(obj.base),
		peerAcks: Object.keys(obj.peerAcks).reduce((acc, key) => {
			acc[key] = new Set(obj.peerAcks[key]);
			return acc;
		}, {} as Record<string, Set<string>>),
		history: cloneDeep(obj.history),
	};
};
