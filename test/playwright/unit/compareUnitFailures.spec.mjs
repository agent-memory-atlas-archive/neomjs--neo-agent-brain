import {test, expect}                            from '@playwright/test';
import {spawnSync}                               from 'node:child_process';
import fs                                        from 'node:fs';
import os                                        from 'node:os';
import path                                      from 'node:path';
import {buildDefectNotes, parsePlaywrightReport} from '../../../ai/services/ingestion/CiFailureIngestor.mjs';
import {
    cutShort, diffFailures, formatFailureLog, readReport, summarizeReport
} from '../compareUnitFailures.mjs';

const ROOT = '/work/repo';

/** @summary The run and job a CI log came from, as the ledger's ingest names them. */
const RUN = {id: 1, name: 'Brain Unit', path: '.github/workflows/brain-unit.yml', headBranch: 'b', headSha: 'c', htmlUrl: 'u', event: 'pull_request'},
      JOB = {id: 2, name: 'unit', htmlUrl: 'u'};

/**
 * @summary One Playwright JSON report built from flat test rows, nested the way the reporter nests them. A row's
 * `error` is what its failed result carries; `unrun` lists a test the run never reached.
 */
function report(rows, {errors = [], rootDir = `${ROOT}/test/playwright/unit`} = {}) {
    const files = new Map();

    for (const {file = 'ai/a.spec.mjs', describe = [], title, project = 'unit-brain', status, line = 10, column = 5, message = 'Error: boom', error = {message}, unrun = false} of rows) {
        let suite = files.get(file) ?? {title: file, file, specs: [], suites: []};

        files.set(file, suite);

        for (const name of describe) {
            let child = suite.suites.find(item => item.title === name);

            child || suite.suites.push(child = {title: name, file, specs: [], suites: []});
            suite = child
        }

        suite.specs.push({title, file, line, column, tests: [{
            projectName: project,
            status     : unrun ? 'skipped' : status,
            results    : unrun ? [] : {
                flaky     : [{status: 'failed', error}, {status: 'passed'}],
                skipped   : [{status: 'skipped'}],
                unexpected: [{status: 'failed', error}]
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

    test('a report that recorded no test result, or cannot be read, is refused and names its side', () => {
        const summary = (rows, side) => summarizeReport(report(rows), side, ROOT);

        expect(() => summary([], 'base')).toThrow('the base report recorded no test result');
        // a listed test the run never reached carries a status, never a result
        expect(() => summary([pass('teardown', {unrun: true})], 'head')).toThrow('the head report recorded no test result');
        expect(() => summary([pass('teardown', {unrun: true}), fail('late', {unrun: true})], 'base')).toThrow('the base report recorded no test result');
        // a skip is a recorded result, and one reached test vouches for its run
        expect(summary([{title: 'skipped', status: 'skipped'}], 'head').counts.skipped).toBe(1);
        expect(summary([pass('ran'), pass('teardown', {unrun: true})], 'head').unrun.size).toBe(1);
        expect(() => readReport('head', path.join(os.tmpdir(), 'compare-unit-failures-absent.json'))).toThrow(/^the head report cannot be read \(ENOENT\)/)
    });

    test('a head run cut short refuses: a test the base ran and the head never reached vouches for nothing', () => {
        const summary = rows => summarizeReport(report(rows), 'side', ROOT);

        expect(cutShort(summary([pass('ran'), pass('late', {unrun: true})]), summary([pass('ran'), pass('late')])))
            .toEqual(['unit-brain › ai/a.spec.mjs › late']);
        // a teardown both runs time out before is not held against the head
        expect(cutShort(summary([pass('ran'), pass('teardown', {unrun: true})]), summary([pass('ran'), pass('teardown', {unrun: true})])))
            .toEqual([])
    });

    test('the introduced failures print in the grammar the defect ledger reads, and each becomes a note whatever it threw', () => {
        const {failures} = summarizeReport(report([
            fail('first', {describe: ['Suite'], line: 12, column: 5, message: '\x1b[2mError: expect(received).toBe(expected)\x1b[22m\n\nExpected: 1'}),
            fail('typed', {file: 'ai/b.spec.mjs', line: 3, column: 1, message: 'TypeError: nope\n    at x (ai/b.spec.mjs:4:2)'}),
            fail('timeout', {line: 20, message: 'Test timeout of 30000ms exceeded.'}),
            fail('thrown', {line: 30, error: {value: "'boom'"}}),
            fail('silent', {line: 40, error: {}})
        ]), 'head', ROOT);

        const parsed = parsePlaywrightReport(formatFailureLog([...failures.values()])),
              {notes, skipped} = buildDefectNotes({failures: parsed.failures, run: RUN, job: JOB, repoSlug: 'neomjs/neo-agent-brain'});

        expect([parsed.complete, parsed.declared]).toEqual([true, 5]);
        expect(parsed.failures.find(failure => failure.titlePath.at(-1) === 'first'))
            .toMatchObject({project: 'unit-brain', file: 'test/playwright/unit/ai/a.spec.mjs', line: 12, column: 5, titlePath: ['Suite', 'first']});
        expect(notes.map(note => note.subject).sort()).toEqual([
            'defect-note: test/playwright/unit/ai/a.spec.mjs › Suite › first broke expect(received).toBe(expected)',
            'defect-note: test/playwright/unit/ai/a.spec.mjs › silent broke the report records no error for this test',
            "defect-note: test/playwright/unit/ai/a.spec.mjs › thrown broke 'boom'",
            'defect-note: test/playwright/unit/ai/a.spec.mjs › timeout broke Test timeout of 30000ms exceeded.',
            'defect-note: test/playwright/unit/ai/b.spec.mjs › typed broke TypeError: nope'
        ]);
        expect(skipped, 'no failure is dropped for want of an Error: line').toEqual([])
    });

    test('the command\'s own log files exactly the introduced tests: a pre-existing failure files nothing', () => {
        // the command prints paths relative to its cwd, which resolves the temp dir's symlinks
        const dir    = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compare-unit-failures-notes-'))),
              script = path.resolve(import.meta.dirname, '../compareUnitFailures.mjs'),
              write  = (name, rows) => {
                  const file = path.join(dir, name);

                  fs.writeFileSync(file, JSON.stringify(report(rows, {rootDir: path.join(dir, 'test/playwright/unit')})));
                  return file
              };

        try {
            const kept = fail('kept', {message: 'TypeError: already broken'}),
                  run  = spawnSync(process.execPath, [script,
                      '--head', write('head.json', [kept, fail('typed', {message: 'TypeError: nope'}), fail('thrown', {error: {value: '42'}})]),
                      '--base', write('base.json', [kept, pass('typed'), pass('thrown')])
                  ], {cwd: dir, encoding: 'utf8', env: {...process.env, GITHUB_STEP_SUMMARY: ''}}),
                  {notes, skipped} = buildDefectNotes({failures: parsePlaywrightReport(run.stdout).failures, run: RUN, job: JOB, repoSlug: 'neomjs/neo-agent-brain'});

            expect(run.status).toBe(1);
            expect(notes.map(({surface, symptom}) => [surface, symptom])).toEqual([
                ['test/playwright/unit/ai/a.spec.mjs › thrown', '42'],
                ['test/playwright/unit/ai/a.spec.mjs › typed',  'TypeError: nope']
            ]);
            expect(skipped).toEqual([])
        } finally {
            fs.rmSync(dir, {force: true, recursive: true})
        }
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
            expect(oneSided.stderr).toContain('both --head and --base are required');

            const short = run('--head', write('short.json', [fail('kept'), pass('late', {unrun: true})]), '--base', write('whole.json', [fail('kept'), pass('late')]));
            expect(short.status).toBe(1);
            expect(short.stderr).toContain('the head run never reached 1 test(s) the base ran');

            // a report listing only tests nobody reached is refused on either side, and names it
            const listed = write('listed.json', [pass('teardown', {unrun: true})]);

            for (const [side, args] of [['head', ['--head', listed, '--base', base]], ['base', ['--head', write('ran.json', [fail('kept')]), '--base', listed]]]) {
                const refused = run(...args);

                expect(refused.status, side).toBe(1);
                expect(refused.stderr).toContain(`the ${side} report recorded no test result`)
            }
        } finally {
            fs.rmSync(dir, {force: true, recursive: true})
        }
    });
});
