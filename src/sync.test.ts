import { describe, expect, it } from 'vitest';
import { getHistoryCollapse } from './collapsing';
import { SyncObject } from './types';

describe('sync protocol', () => {
	describe('finding bubbles for collapsing', () => {
		it('gathers a linear history with all acknowledged nodes', () => {
			const obj: SyncObject<any> = {
				base: { foo: 1 },
				peerAcks: {
					peerA: new Set(['a1', 'a2', 'a3']),
					peerB: new Set(['a1', 'a2', 'a3']),
				},
				history: {
					root: 'a1',
					latest: 'a3',
					versions: {
						a1: {
							id: 'a1',
							parents: [],
							children: ['a2'],
							patches: [
								{
									range: 'foo',
									data: 2,
								},
							],
						},
						a2: {
							id: 'a2',
							parents: ['a1'],
							children: ['a3'],
							patches: [
								{
									range: 'foo',
									data: 3,
								},
							],
						},
						a3: {
							id: 'a3',
							parents: ['a2'],
							children: [],
							patches: [
								{
									range: 'bar',
									data: true,
								},
							],
						},
					},
				},
			};

			const collapse = getHistoryCollapse(
				'peerA',
				'a',
				obj,
				new Set(['peerA', 'peerB'])
			);
			expect(collapse).toEqual({
				newBase: { foo: 3, bar: true },
				newRoot: undefined,
				removeVersions: ['a1', 'a2', 'a3'],
				objectId: 'a',
			});
		});

		it('gathers a linear history up to the point of consensus', () => {
			const obj: SyncObject<any> = {
				base: { foo: 1 },
				peerAcks: {
					peerA: new Set(['a1', 'a2', 'a3']),
					peerB: new Set(['a1', 'a2']),
				},
				history: {
					root: 'a1',
					latest: 'a3',
					versions: {
						a1: {
							id: 'a1',
							parents: [],
							children: ['a2'],
							patches: [
								{
									range: 'foo',
									data: 2,
								},
							],
						},
						a2: {
							id: 'a2',
							parents: ['a1'],
							children: ['a3'],
							patches: [
								{
									range: 'foo',
									data: 3,
								},
							],
						},
						a3: {
							id: 'a3',
							parents: ['a2'],
							children: [],
							patches: [
								{
									range: 'bar',
									data: true,
								},
							],
						},
					},
				},
			};

			const collapse = getHistoryCollapse(
				'peerA',
				'a',
				obj,
				new Set(['peerA', 'peerB'])
			);
			expect(collapse).toEqual({
				newBase: { foo: 3 },
				newRoot: 'a3',
				removeVersions: ['a1', 'a2'],
				objectId: 'a',
			});
		});

		it('returns null when no consensus exists', () => {
			const obj: SyncObject<any> = {
				base: { foo: 1 },
				peerAcks: {
					peerA: new Set(['a1', 'a2', 'a3']),
					peerB: new Set([]),
				},
				history: {
					root: 'a1',
					latest: 'a3',
					versions: {
						a1: {
							id: 'a1',
							parents: [],
							children: ['a2'],
							patches: [
								{
									range: 'foo',
									data: 2,
								},
							],
						},
						a2: {
							id: 'a2',
							parents: ['a1'],
							children: ['a3'],
							patches: [
								{
									range: 'foo',
									data: 3,
								},
							],
						},
						a3: {
							id: 'a3',
							parents: ['a2'],
							children: [],
							patches: [
								{
									range: 'bar',
									data: true,
								},
							],
						},
					},
				},
			};

			const collapse = getHistoryCollapse(
				'peerA',
				'a',
				obj,
				new Set(['peerA', 'peerB'])
			);
			expect(collapse).toBeNull();
		});

		it('collapses a simple 2-branch history up to consensus point', () => {
			const obj: SyncObject<any> = {
				base: { foo: 1 },
				peerAcks: {
					peerA: new Set(['a1', 'a2', 'a3', 'b2', 'b3', 'c4']),
					peerB: new Set(['a1', 'a2', 'a3', 'b2', 'b3', 'c4']),
				},
				history: {
					root: 'a1',
					latest: 'a3',
					versions: {
						a1: {
							id: 'a1',
							parents: [],
							children: ['a2', 'b2'],
							patches: [
								{
									range: 'foo',
									data: 2,
								},
							],
						},
						a2: {
							id: 'a2',
							parents: ['a1'],
							children: ['a3'],
							patches: [
								{
									range: 'foo',
									data: 3,
								},
							],
						},
						a3: {
							id: 'a3',
							parents: ['a2'],
							children: ['c4'],
							patches: [
								{
									range: 'bar',
									data: true,
								},
							],
						},
						b2: {
							id: 'b2',
							parents: ['a1'],
							children: ['b3'],
							patches: [
								{
									range: 'foo',
									data: 0,
								},
							],
						},
						b3: {
							id: 'b3',
							parents: ['b2'],
							children: ['c4'],
							patches: [
								{
									range: 'baz',
									data: true,
								},
							],
						},
						c4: {
							id: 'c4',
							parents: ['a3', 'b3'],
							children: ['c5'],
							patches: [],
						},
						c5: {
							id: 'c5',
							parents: ['c4'],
							children: [],
							patches: [
								{
									range: 'baz',
									data: false,
								},
							],
						},
					},
				},
			};

			const collapse = getHistoryCollapse(
				'peerA',
				'a',
				obj,
				new Set(['peerA', 'peerB'])
			);
			expect(collapse).toEqual({
				newBase: {
					foo: 0,
					baz: true,
					bar: true,
				},
				newRoot: 'c5',
				removeVersions: ['a1', 'a2', 'b2', 'a3', 'b3', 'c4'],
				objectId: 'a',
			});
		});

		it('collapses a 3-branch history up to consensus point', () => {
			/*
                  a1
                /    \
              a2      b2
            /  \      |
          a3   c3    b3
          \    |    /
           \  c4  /
            \  | /
              \/
              d5
       */
			const obj2: SyncObject<any> = {
				base: { foo: 1 },
				peerAcks: {
					peerA: new Set(['a1', 'a2', 'a3', 'c3', 'b2', 'b3', 'c4', 'd5']),
					peerB: new Set(['a1', 'a2', 'a3', 'c3', 'b2', 'b3', 'c4', 'd5']),
				},
				history: {
					root: 'a1',
					latest: 'a3',
					versions: {
						a1: {
							id: 'a1',
							parents: [],
							children: ['a2', 'b2'],
							patches: [
								{
									range: 'foo',
									data: 2,
								},
							],
						},
						a2: {
							id: 'a2',
							parents: ['a1'],
							children: ['a3', 'c3'],
							patches: [
								{
									range: 'foo',
									data: 3,
								},
							],
						},
						a3: {
							id: 'a3',
							parents: ['a2'],
							children: ['d5'],
							patches: [
								{
									range: 'bar',
									data: true,
								},
							],
						},
						b2: {
							id: 'b2',
							parents: ['a1'],
							children: ['b3'],
							patches: [
								{
									range: 'foo',
									data: 50,
								},
							],
						},
						b3: {
							id: 'b3',
							parents: ['b2'],
							children: ['d5'],
							patches: [
								{
									range: 'baz',
									data: true,
								},
							],
						},
						c3: {
							id: 'c3',
							parents: ['a2'],
							children: ['c4'],
							patches: [
								{
									range: 'corge',
									data: 'bop',
								},
							],
						},
						c4: {
							id: 'c4',
							parents: ['c3'],
							children: ['d5'],
							patches: [
								{
									range: 'foo',
									data: 100,
								},
							],
						},
						d5: {
							id: 'd5',
							parents: ['a3', 'c4', 'b3'],
							children: ['d6'],
							patches: [],
						},
						d6: {
							id: 'd6',
							parents: ['d5'],
							children: [],
							patches: [
								{
									range: 'baz',
									data: false,
								},
							],
						},
					},
				},
			};

			const collapse = getHistoryCollapse(
				'peerA',
				'a',
				obj2,
				new Set(['peerA', 'peerB'])
			);
			expect(collapse).toEqual({
				newBase: {
					foo: 50,
					baz: true,
					bar: true,
					corge: 'bop',
				},
				newRoot: 'd6',
				removeVersions: ['a1', 'a2', 'b2', 'a3', 'c3', 'b3', 'c4', 'd5'],
				objectId: 'a',
			});
		});

		it("doesn't include a non-closed bubble", () => {
			/*
                  a0
                  |
                  a1
                /    \
              a2      b2
            /  \      |
          a3   c3    b3
           \   /
            d4
       */

			const obj2: SyncObject<any> = {
				base: { foo: 1 },
				peerAcks: {
					peerA: new Set(['a0', 'a1', 'a2', 'a3', 'c3', 'b2', 'b3', 'd4']),
					peerB: new Set(['a0', 'a1', 'a2', 'a3', 'c3', 'b2', 'b3', 'd4']),
				},
				history: {
					root: 'a0',
					latest: 'a3',
					versions: {
						a0: {
							id: 'a0',
							parents: [],
							children: ['a1'],
							patches: [
								{
									range: 'foo',
									data: 0,
								},
							],
						},
						a1: {
							id: 'a1',
							parents: [],
							children: ['a2', 'b2'],
							patches: [
								{
									range: 'foo',
									data: 2,
								},
							],
						},
						a2: {
							id: 'a2',
							parents: ['a1'],
							children: ['a3', 'c3'],
							patches: [
								{
									range: 'foo',
									data: 3,
								},
							],
						},
						a3: {
							id: 'a3',
							parents: ['a2'],
							children: ['d4'],
							patches: [
								{
									range: 'bar',
									data: true,
								},
							],
						},
						b2: {
							id: 'b2',
							parents: ['a1'],
							children: ['b3'],
							patches: [
								{
									range: 'foo',
									data: 50,
								},
							],
						},
						b3: {
							id: 'b3',
							parents: ['b2'],
							children: [],
							patches: [
								{
									range: 'baz',
									data: true,
								},
							],
						},
						c3: {
							id: 'c3',
							parents: ['a2'],
							children: ['d4'],
							patches: [
								{
									range: 'corge',
									data: 'bop',
								},
							],
						},
						d4: {
							id: 'd4',
							parents: ['c3'],
							children: [],
							patches: [
								{
									range: 'foo',
									data: 100,
								},
							],
						},
					},
				},
			};

			const collapse = getHistoryCollapse(
				'peerA',
				'a',
				obj2,
				new Set(['peerA', 'peerB'])
			);
			expect(collapse).toEqual({
				newBase: {
					foo: 0,
				},
				newRoot: 'a1',
				removeVersions: ['a0'],
				objectId: 'a',
			});
		});
	});
});
