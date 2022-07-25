import { Json, Patch } from './types';

// this is exteremely basic with no error checks, in real life you'd want a proper patching solution
export function applyPatch<T extends Json>(base: T, patch: Patch<T>): T {
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
