import {test, expect}          from '@playwright/test';
import {spawnSync}             from 'node:child_process';
import fs                      from 'node:fs';
import os                      from 'node:os';
import path                    from 'node:path';
import {parsePlaywrightReport} from '../../../ai/services/ingestion/CiFailureIngestor.mjs';
import {
    diffFailures, formatFailureLog, readReport, summarizeReport
} from '../compareUnitFailures.mjs';

const ROOT = '/work/repo';

/** @summary One Playwright JSON report built from flat test rows, nested the way the reporter nests them. */
function report(rows, {errors = [], rootDir = `${ROOT}/test/playwright/unit`} = {}) {
    const files = new Map();

    for (const {file = 'ai/a.spec.mjs', describe = [], title, project = 'unit-brain', status, line = 10, column = 5, message = 'Error: boom'} of rows) {
        let suite = files.get(file) ?? {title: file, file, specs: [], suites: []};

        files.set(file, suite);

        for (const name of describe) {
            let child = suite.suites.find(item => item.title === name);

            child || suite.suites.push(child = {title: name, file, specs: [], suites: []});
            suite = child
        }

        suite.specs.push({title, file, line, column, tests: [{
            projectName: project,
            status,
            results    : {
                flaky     : [{status: 'failed', error: {message}}, {status: 'passed'}],
                unexpected: [{status: 'failed', error: {message}}]
            }[status] ?? [{status: 'passed'}]
        }]})
    }

    return {config: {rootDir}, suites: [...files.values()], errors}
}

const fail = (title, extra = {}) => ({title, status: 'unexpected', ...extra}),
      pass = (title, extra = {}) => ({title, status: 'expected', ...extra});

/** @summary The three sets for a head and a base built from rows. */
function diff(headRows, baseRows, {head = {}, base = {}} = {}) {
    return diffFailures(
        summarizeReport(report(headRows, head), 'head', ROOT).failures,
        summarizeReport(report(baseRows, base), 'base', ROOT).failures
    )
}

test.describe('compareUnitFailures', () => {
    test('a failure only the head has is introduced, one only the base has is fixed, one both have is pre-existing', () => {
        expect(diff(
            [fail('kept'), fail('broken'), pass('repaired')],
            [fail('kept'), pass('broken'), fail('repaired')]
        )).toEqual({
            introduced : ['unit-brain › ai/a.spec.mjs › broken'],
            fixed      : ['unit-brain › ai/a.spec.mjs › repaired'],
            preexisting: ['unit-brain › ai/a.spec.mjs › kept']
        })
    });

    test('a line shift inside a failing spec is not a new failure', () => {
        expect(diff([fail('kept', {line: 40})], [fail('kept', {line: 12})]).introduced).toEqual([])
    });

    test('the project and the describe path are part of a test\'s identity', () => {
        expect(diff(
            [fail('t', {project: 'unit'}), fail('t'), fail('t', {describe: ['Outer']})],
            [fail('t', {project: 'unit'})]
        ).introduced).toEqual(['unit-brain › ai/a.spec.mjs › Outer › t', 'unit-brain › ai/a.spec.mjs › t'])
    });

    test('a renamed failing test reads as one fixed and one introduced', () => {
        expect(diff([fail('new name')], [fail('old name')])).toEqual({
            introduced : ['unit-brain › ai/a.spec.mjs › new name'],
            fixed      : ['unit-brain › ai/a.spec.mjs › old name'],
            preexisting: []
        })
    });

    test('a test that passed only on a retry fails, as the unit config\'s failOnFlakyTests does in CI', () => {
        const flaky = {title: 'retried', status: 'flaky'};

        expect(diff([flaky], [pass('retried')]).introduced).toEqual(['unit-brain › ai/a.spec.mjs › retried']);
        expect(diff([flaky], [flaky]).preexisting).toEqual(['unit-brain › ai/a.spec.mjs › retried'])
    });

    test('a top-level error is diffed by its first line', () => {
        const loadError = {message: '\x1b[31mError: cannot load ai/b.spec.mjs\x1b[39m\n    at load'};

        expect(diff([pass('t')], [pass('t')], {head: {errors: [loadError]}}).introduced).toEqual(['global › Error: cannot load ai/b.spec.mjs']);
        expect(diff([pass('t')], [pass('t')], {head: {errors: [loadError]}, base: {errors: [loadError]}}).introduced).toEqual([])
    });

    test('a report that ran no test, or cannot be read, is refused and names its side', () => {
        expect(() => summarizeReport(report([]), 'base', ROOT)).toThrow('the base report ran no test');
        expect(() => readReport('head', path.join(os.tmpdir(), 'compare-unit-failures-absent.json'))).toThrow(/^the head report cannot be read \(ENOENT\)/)
    });

    test('the introduced failures print in the grammar the defect ledger reads', () => {
        const {failures} = summarizeReport(report([
            fail('first', {describe: ['Suite'], line: 12, column: 5, message: '\x1b[2mError: expect(received).toBe(expected)\x1b[22m\n\nExpected: 1'}),
            fail('second', {file: 'ai/b.spec.mjs', line: 3, column: 1, message: 'TypeError: nope'})
        ]), 'head', ROOT);

        const parsed = parsePlaywrightReport(formatFailureLog([...failures.values()]));

        expect(parsed.complete).toBe(true);
        expect(parsed.declared).toBe(2);
        expect(parsed.failures.map(({project, file, line, column, titlePath, symptom}) => ({project, file, line, column, titlePath, symptom}))).toEqual([
            {project: 'unit-brain', file: 'test/playwright/unit/ai/a.spec.mjs', line: 12, column: 5, titlePath: ['Suite', 'first'], symptom: 'expect(received).toBe(expected)'},
            {project: 'unit-brain', file: 'test/playwright/unit/ai/b.spec.mjs', line: 3, column: 1, titlePath: ['second'], symptom: null}
        ])
    });

    test('the command exits 1 on an introduced failure and 0 on pre-existing ones, and appends its summary', () => {
        const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-unit-failures-')),
              summary = path.join(dir, 'summary.md'),
              script  = path.resolve(import.meta.dirname, '../compareUnitFailures.mjs'),
              write   = (name, rows) => {
                  const file = path.join(dir, name);

                  fs.writeFileSync(file, JSON.stringify(report(rows)));
                  return file
              },
              run     = (...args) => spawnSync(process.execPath, [script, ...args], {cwd: dir, encoding: 'utf8', env: {...process.env, GITHUB_STEP_SUMMARY: summary}});

        try {
            const base = write('base.json', [fail('kept')]);

            const kept = run('--head', write('kept.json', [fail('kept')]), '--base', base);
            expect(kept.status).toBe(0);
            expect(kept.stdout).toContain('0 introduced, 0 fixed, 1 pre-existing');

            const broken = run('--head', write('broken.json', [fail('kept'), fail('broken')]), '--base', base);
            expect(broken.status).toBe(1);
            expect(broken.stdout).toMatch(/^ {2}1 failed$/m);
            expect(fs.readFileSync(summary, 'utf8')).toContain('**Introduced: 1**');

            const absent = run('--head', path.join(dir, 'absent.json'), '--base', base);
            expect(absent.status).toBe(1);
            expect(absent.stderr).toContain('the head report cannot be read');

            const oneSided = run('--head', base);
            expect(oneSided.status).toBe(1);
            expect(oneSided.stderr).toContain('both --head and --base are required')
        } finally {
            fs.rmSync(dir, {force: true, recursive: true})
        }
    });
});
