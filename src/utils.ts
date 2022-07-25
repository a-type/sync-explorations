export function removeFromSet<T>(set: Set<T>, values: T[]) {
	for (const value of values) {
		set.delete(value);
	}
}

export function mergeToSet<T>(set: Set<T>, values: T[]) {
	for (const value of values) {
		set.add(value);
	}
}

export function cloneDeep<T>(obj: T): T {
	return JSON.parse(JSON.stringify(obj));
}
