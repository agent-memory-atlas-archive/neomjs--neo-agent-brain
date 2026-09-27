import {setup} from '../../../../setup.mjs';

const appName = 'MailboxListCostTest';

setup({
    neoConfig: {
        unitTestMode: true
    },
    appConfig: {
        name             : appName,
        isMounted        : () => true,
        vnodeInitialising: false
    }
});

import {test, expect} from '@playwright/test';
import {performance}  from 'node:perf_hooks';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import                        'neo.mjs/src/manager/Instance.mjs';
import RequestContextService from '../../../../../../ai/mcp/server/shared/services/RequestContextService.mjs';

/**
 * @summary A page hydrates what the page holds, not what the mailbox holds.
 *
 * `listMessages` served `limit` rows by evaluating every message the identity could see: it
 * hydrated every broadcast's vicinity, read each candidate's receipt state, built each summary,
 * sorted them all and sliced last. On the plane that was one storage read per candidate for
 * thousands of candidates per page, on every cockpit tick and every turn start.
 *
 * The observer counts the two things that scaled with the mailbox: vicinity loads from storage and
 * prepared SQLite statements. The bound is a constant per served row plus a constant per call —
 * generous, so a page-first read passes with room, and a mailbox-wide walk cannot: the fixture
 * seeds many more candidates than the bound admits, both direct and broadcast, because the
 * broadcast fan-out is the path that hydrated `AGENT:*` wholesale. What the bound does NOT claim:
 * the match set is still named, counted and sorted inside SQLite (one statement each, a temporary
 * B-tree for the order), so that work grows with the matches — the per-message reads and the
 * hydration are what the page bounds.
 *
 * `NEO_LIST_COST_SEED` sets the fixture size (an even number, half direct, half broadcast); the
 * default keeps CI short, and a 10k run is recorded on the PR that landed the bound. Seeding goes
 * through the real accept path, which is why the fixture is not larger by default.
 */
test.describe.configure({mode: 'serial'});

const
    SENDER           = '@list-cost-sender',
    RECIPIENT        = '@list-cost-recipient',
    SEEDED           = Math.max(2, Number(process.env.NEO_LIST_COST_SEED) || 1_000),
    SEEDED_DIRECT    = Math.ceil(SEEDED / 2),
    SEEDED_BROADCAST = Math.floor(SEEDED / 2),
    LIMIT            = 50,
    READS_PER_ROW    = 8,
    READS_PER_CALL   = 32,
    READ_BOUND       = READS_PER_CALL + READS_PER_ROW * LIMIT;

test.describe('MailboxService.listMessages — the cost of a page is bounded by the page', () => {
    let MailboxService, GraphService, LifecycleService;

    const asRecipient = callback => RequestContextService.run({agentIdentityNodeId: RECIPIENT}, callback);

    /**
     * @summary Runs `callback` while counting storage vicinity loads and prepared SQLite statements.
     * @param {Function} callback
     * @returns {Promise<{result: *, vicinityLoads: Number, statements: Number, ms: Number}>}
     */
    async function observeStorage(callback) {
        const storage = GraphService.db.storage,
              sqlite  = storage.db,
              counts  = {vicinityLoads: 0, statements: 0},
              started = performance.now();

        expect(typeof storage.loadNodeVicinitySync, 'the unit graph must be storage-backed for this arm to observe anything').toBe('function');
        expect(typeof sqlite?.prepare).toBe('function');

        storage.loadNodeVicinitySync = function(...args) {
            counts.vicinityLoads++;
            return Object.getPrototypeOf(storage).loadNodeVicinitySync.apply(this, args)
        };
        sqlite.prepare = function(...args) {
            counts.statements++;
            return Object.getPrototypeOf(sqlite).prepare.apply(this, args)
        };

        try {
            return {result: await callback(), ...counts, ms: Math.round(performance.now() - started)}
        } finally {
            delete storage.loadNodeVicinitySync;
            delete sqlite.prepare
        }
    }

    /**
     * @summary Records one observation on the report and the console, so a run at any fixture size
     * leaves its numbers behind.
     * @param {String} label
     * @param {Object} observed
     */
    function report(label, observed) {
        const line = `${label} (${SEEDED} seeded, limit ${LIMIT}): ${observed.vicinityLoads} vicinity loads, ${observed.statements} statements, ${observed.ms} ms; bound ${READ_BOUND}`;

        test.info().annotations.push({type: 'reads', description: line});
        console.log(`[list-messages-cost] ${line}`);
    }

    test.beforeAll(async () => {
        test.setTimeout(Math.max(60_000, SEEDED * 20));

        GraphService     = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        MailboxService   = (await import('../../../../../../ai/services/memory-core/MailboxService.mjs')).default;
        LifecycleService = (await import('../../../../../../ai/services/memory-core/lifecycle/SystemLifecycleService.mjs')).default;

        if (!LifecycleService._initPromise) {
            await LifecycleService.initAsync();
        } else {
            await LifecycleService.ready();
        }

        GraphService.upsertNode({id: SENDER,    type: 'AgentIdentity', name: 'List Cost Sender',    properties: {accountType: 'agent'}});
        GraphService.upsertNode({id: RECIPIENT, type: 'AgentIdentity', name: 'List Cost Recipient', properties: {accountType: 'agent'}});

        const started = performance.now();

        for (let i = 0; i < Math.max(SEEDED_DIRECT, SEEDED_BROADCAST); i++) {
            if (i < SEEDED_DIRECT) {
                await RequestContextService.run({agentIdentityNodeId: SENDER}, () => MailboxService.addMessage({
                    to     : RECIPIENT,
                    subject: `cost fixture direct ${String(i).padStart(5, '0')}`,
                    body   : 'one of many direct rows the page will not show'
                }));
            }
            if (i < SEEDED_BROADCAST) {
                await RequestContextService.run({agentIdentityNodeId: SENDER}, () => MailboxService.addMessage({
                    to     : 'AGENT:*',
                    subject: `cost fixture broadcast ${String(i).padStart(5, '0')}`,
                    body   : 'one of many broadcast rows the page will not show'
                }));
            }
        }

        console.log(`[list-messages-cost] seeded ${SEEDED} messages through addMessage in ${Math.round(performance.now() - started)} ms`);
    });

    test('a warm-cache page reads a bounded number of rows and statements, whatever the mailbox holds', async () => {
        // The first read warms the vicinity cache; the second is the steady state every cockpit
        // tick pays. Both are recorded, the bound is asserted on the steady state.
        const cold = await observeStorage(() => asRecipient(() => MailboxService.listMessages({box: 'inbox', limit: LIMIT}))),
              warm = await observeStorage(() => asRecipient(() => MailboxService.listMessages({box: 'inbox', limit: LIMIT})));

        expect(warm.result.messages).toHaveLength(LIMIT);
        expect(warm.result.totalCount, 'the count stays the count of the filter').toBe(SEEDED_DIRECT + SEEDED_BROADCAST);
        expect(warm.result.truncated).toBe(true);

        report('cold page', cold);
        report('warm page', warm);

        expect(warm.statements, `prepared statements for a page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND);
        expect(warm.vicinityLoads, `vicinity loads for a page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND)
    });

    test('an unread-only page is bounded the same way — the status filter must not reintroduce the walk', async () => {
        const page = await observeStorage(() => asRecipient(() => MailboxService.listMessages({box: 'inbox', status: 'unread', limit: LIMIT})));

        expect(page.result.messages).toHaveLength(LIMIT);
        expect(page.result.totalCount).toBe(SEEDED_DIRECT + SEEDED_BROADCAST);

        report('unread page', page);

        expect(page.statements, `prepared statements for an unread page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND)
    });

    test('the MCP adapter\'s page — `recordSeen: true` stamps the rows it serves — is bounded by the same page', async () => {
        // The tool is the caller the plane metric measures: its SEEN stamps are one write per served
        // row and must not cost more than the page either.
        const page = await observeStorage(() => asRecipient(() => MailboxService.listMessages({box: 'inbox', limit: LIMIT}, {recordSeen: true})));

        expect(page.result.messages).toHaveLength(LIMIT);
        expect(page.result.totalCount).toBe(SEEDED_DIRECT + SEEDED_BROADCAST);

        report('recordSeen page', page);

        expect(page.statements, `prepared statements for a recordSeen page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND);
        expect(page.vicinityLoads, `vicinity loads for a recordSeen page of ${LIMIT} (bound ${READ_BOUND})`).toBeLessThanOrEqual(READ_BOUND)
    });
});
