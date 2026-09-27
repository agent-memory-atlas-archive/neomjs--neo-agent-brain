import {setup} from '../../../setup.mjs';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : 'AiSQLiteWriteGuardTest',
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import fs             from 'node:fs';
import os             from 'node:os';
import path           from 'node:path';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import SQLite         from '../../../../../ai/graph/storage/SQLite.mjs';

// A production-like absolute path: not `:memory:`, no `tmp`/`test` segment.
const PROD_PATH          = '/srv/neo/.neo-ai-data/sqlite/memory-core-graph.sqlite';
const PLAYWRIGHT_WORKER  = {TEST_WORKER_INDEX: '0'}; // Playwright sets this in every worker process
const UNIT_TEST_MODE_ENV = {UNIT_TEST_MODE: 'true'};
const PRODUCTION_RUNTIME = {};                       // neither test signal — the live MCP server / orchestrator

test.describe('Neo.ai.graph.storage.SQLite — test-write isolation guard (#13639 / #13624 axis-3)', () => {
    let storage;

    test.beforeEach(() => {
        storage = Neo.create(SQLite, {dbPath: ':memory:'});
    });

    test.afterEach(() => {
        storage?.destroy?.();
        storage = null;
    });

    test('isDisposableDbPath: :memory:/tmp/*test*/empty are disposable; production paths are not', () => {
        expect(storage.isDisposableDbPath(':memory:')).toBe(true);
        expect(storage.isDisposableDbPath('/var/folders/q/tmp/neo-graph.db')).toBe(true);
        expect(storage.isDisposableDbPath('/Users/x/neo-graph-test-42.db')).toBe(true);
        expect(storage.isDisposableDbPath(null)).toBe(true);
        expect(storage.isDisposableDbPath(PROD_PATH)).toBe(false);
    });

    test('blocks a write to a production graph from a Playwright worker (TEST_WORKER_INDEX set)', () => {
        expect(() => storage.assertTestWriteIsolated({dbPath: PROD_PATH, env: PLAYWRIGHT_WORKER}))
            .toThrow(/GRAPH_WRITE_GUARD/);
    });

    test('blocks a write to a production graph under UNIT_TEST_MODE (test mode resolved to a prod path = misconfig)', () => {
        expect(() => storage.assertTestWriteIsolated({dbPath: PROD_PATH, env: UNIT_TEST_MODE_ENV}))
            .toThrow(/GRAPH_WRITE_GUARD/);
    });

    test('allows disposable targets from a test context (:memory:, tmp, *test*)', () => {
        expect(() => storage.assertTestWriteIsolated({dbPath: ':memory:',        env: PLAYWRIGHT_WORKER})).not.toThrow();
        expect(() => storage.assertTestWriteIsolated({dbPath: '/tmp/neo.db',      env: PLAYWRIGHT_WORKER})).not.toThrow();
        expect(() => storage.assertTestWriteIsolated({dbPath: '/x/graph-test.db', env: UNIT_TEST_MODE_ENV})).not.toThrow();
    });

    test('zero production blast: the live runtime (no test signal) writing to a production path is never guarded', () => {
        expect(() => storage.assertTestWriteIsolated({dbPath: PROD_PATH, env: PRODUCTION_RUNTIME})).not.toThrow();
    });

    test('wired into the real write funnel: addNodes to a production-bound graph throws in a test context', async () => {
        // Await async init so the in-memory DB handle exists — otherwise addNodes early-returns on `!this.db`
        // BEFORE reaching the guard, which would false-green this assertion.
        for (let i = 0; i < 200 && !storage.db; i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
        expect(storage.db, 'SQLite in-memory DB should be initialised before the write-path assertion').toBeTruthy();

        // The DB stays in-memory (disposable + harmless); only dbPath is repointed at a prod path, so the
        // guard fires BEFORE any row is written — proving the funnel is guarded without ever touching prod.
        storage.dbPath = PROD_PATH;
        expect(() => storage.addNodes([{id: 'pollution-node', label: 'X', properties: {}}])).toThrow(/GRAPH_WRITE_GUARD/);

        // And with the DB still bound to :memory: (disposable), the same funnel allows the write (no false-positive).
        storage.dbPath = ':memory:';
        expect(() => storage.addNodes([{id: 'ok-node', label: 'X', properties: {name: 'ok'}}])).not.toThrow();
    });
});

test.describe('Neo.ai.graph.storage.SQLite — a narrow write reports the row it updated, on any connection', () => {
    // File-backed on purpose: the defect needs a SECOND connection to the same database, which
    // `:memory:` cannot give. Disposable by name and location, so the write guard admits it.
    const dbPath = path.join(os.tmpdir(), `neo-graph-test-narrow-write-${process.pid}-${Date.now()}.sqlite`);

    const openStorage = async () => {
        const storage = Neo.create(SQLite, {dbPath});

        for (let i = 0; i < 200 && !storage.db; i++) { await new Promise(resolve => setTimeout(resolve, 5)); }
        expect(storage.db, 'the file-backed SQLite must be initialised').toBeTruthy();

        return storage
    };

    test.afterAll(() => {
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, {force: true});
    });

    test('the first narrow write of a FRESH connection returns true and lands — lastInsertRowid is 0 there, which once reported a landed receipt as a missing row', async () => {
        // Seed on one connection (a plain INSERT), then close it.
        const seeding = await openStorage();

        seeding.addNodes([{id: 'MESSAGE:narrow-write', label: 'MESSAGE', properties: {subject: 'fresh connection'}}]);
        seeding.destroy();

        // A fresh connection has done no plain INSERT. SQLite restores `last_insert_rowid()` when the
        // UPDATE's trigger program ends, so it reads 0 here although the trigger inserted a GraphLog
        // row — the premise the old return value was built on, and the reason it said "missing row".
        const storage = await openStorage();

        try {
            const
                read  = () => JSON.parse(storage.db.prepare('SELECT data FROM Nodes WHERE id = ?').get('MESSAGE:narrow-write').data).properties,
                probe = storage.db.prepare("UPDATE Nodes SET data = json_set(data, '$.properties.probe', 1) WHERE id = ?").run('MESSAGE:narrow-write');

            expect(probe.changes, 'the row exists').toBe(1);
            expect(Number(probe.lastInsertRowid), 'the premise: nothing was inserted on this connection yet').toBe(0);

            expect(storage.setRecordProperty('Nodes', 'MESSAGE:narrow-write', 'readAt', '2026-09-27T13:07:11.510Z'), 'a landed write says so').toBe(true);
            expect(read().readAt).toBe('2026-09-27T13:07:11.510Z');

            expect(storage.setRecordPropertyIfAbsent('Nodes', 'MESSAGE:narrow-write', 'seenAt', 'first'), 'write-once lands once').toBe(true);
            expect(storage.setRecordPropertyIfAbsent('Nodes', 'MESSAGE:narrow-write', 'seenAt', 'second'), 'and refuses the second time').toBe(false);
            expect(read().seenAt).toBe('first');

            expect(storage.setRecordProperty('Nodes', 'MESSAGE:missing', 'readAt', 'x'), 'no row, no write').toBe(false);
        } finally {
            storage.destroy();
        }
    });
});
