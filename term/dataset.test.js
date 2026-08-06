'use strict';
/*
 * Plain-assert unit tests for dataset.js, run alongside smoke.js (see
 * package.json's "test" script). No framework - this repo keeps that bar low.
 */
const assert = require('assert');
const { stratifiedSample } = require('./dataset.js');

function fakeDataset(rows) {
	// rows: [{ sex, location }]
	return {
		dataforselector: {
			SEX: rows.map((r) => r.sex),
			LOCATION: rows.map((r) => r.location),
		},
		columns: ['SEX', 'LOCATION'],
		rowCount: rows.length,
	};
}

function run(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
		return true;
	} catch (e) {
		console.log(`FAIL ${name}`);
		console.log('     ' + e.message);
		return false;
	}
}

const results = [];

results.push(run('sample-group-size sums to exactly the requested target per group', () => {
	// Mirrors the GULLS proportions that overshot under ceil(): 100 female /
	// 100 male should come back as exactly 100 and 100, not 103/102.
	const counts = {
		'FEMALE / MARAETAI': 321, 'FEMALE / PIHA': 344, 'FEMALE / WAITAWA': 301, 'FEMALE / MURIWAI': 314,
		'MALE / MARAETAI': 352, 'MALE / PIHA': 303, 'MALE / WAITAWA': 277, 'MALE / MURIWAI': 275,
	};
	const rows = [];
	for (const [key, n] of Object.entries(counts)) {
		const [sex, location] = key.split(' / ');
		for (let i = 0; i < n; i++) rows.push({ sex, location });
	}
	const ds = fakeDataset(rows);
	const { strata } = stratifiedSample(ds, ['SEX', 'LOCATION'], {
		groupSizes: { FEMALE: 100, MALE: 100 },
		seed: 1,
	});

	const totalsByGroup = { FEMALE: 0, MALE: 0 };
	for (const s of strata) totalsByGroup[s.key.split(' / ')[0]] += s.sampled;

	assert.strictEqual(totalsByGroup.FEMALE, 100, `female total was ${totalsByGroup.FEMALE}, want 100`);
	assert.strictEqual(totalsByGroup.MALE, 100, `male total was ${totalsByGroup.MALE}, want 100`);
}));

results.push(run('sample-group-size gives every stratum at least floor(share) and never over-allocates', () => {
	const rows = [];
	for (let i = 0; i < 30; i++) rows.push({ sex: 'A', location: 'X' });
	for (let i = 0; i < 30; i++) rows.push({ sex: 'A', location: 'Y' });
	for (let i = 0; i < 40; i++) rows.push({ sex: 'A', location: 'Z' });
	const ds = fakeDataset(rows);
	const { strata } = stratifiedSample(ds, ['SEX', 'LOCATION'], {
		groupSizes: { A: 10 },
		seed: 42,
	});
	const total = strata.reduce((sum, s) => sum + s.sampled, 0);
	assert.strictEqual(total, 10, `total was ${total}, want 10`);
	for (const s of strata) assert.ok(s.sampled <= s.available, `${s.key} sampled more than available`);
}));

const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} dataset tests passed`);
if (ok !== results.length) process.exitCode = 1;
