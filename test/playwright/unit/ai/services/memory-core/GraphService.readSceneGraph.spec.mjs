import { setup } from '../../../../setup.mjs';

const appName = 'GraphServiceReadSceneGraphTest';

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
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import SQLite         from '../../../../../../ai/graph/storage/SQLite.mjs';
import fs             from 'fs-extra';
import path           from 'path';

/**
 * `GraphService.readSceneGraph` over a real SQLite store: the SQL RLS clause and the `isRlsVisible` recheck
 * decide what a requester sees, and the scene holds all of it, in columnar form.
 */

const
    node = (id, properties = {}) => ({id, label: properties.kind ?? 'ISSUE', properties: {name: `name ${id}`, ...properties}}),
    edge = (id, source, target, type = 'REL', properties = {}) => ({id, source, target, type, properties: {weight: 1, ...properties}});

/**
 * @summary Read the columnar answer back as rows, so an assertion names ids rather than indices.
 * @param {Object} answer
 * @returns {{nodes: String[], edges: String[]}}
 */
function rowsOf(answer) {
    const
        {ids} = answer.nodes,
        edges = [];

    for (let index = 0; index < answer.edges.length; index += 3) {
        edges.push(`${ids[answer.edges[index]]} -${answer.types[answer.edges[index + 2]]}-> ${ids[answer.edges[index + 1]]}`)
    }

    return {nodes: ids, edges}
}

test.describe('GraphService.readSceneGraph — the whole graph one viewer may see', () => {
    let GraphService, originalDb, storage, dbPath, requester;

    test.beforeAll(async () => {
        GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default;
        dbPath       = path.resolve(process.cwd(), 'tmp', `graph-scene-${globalThis.crypto.randomUUID()}.sqlite`);
        storage      = Neo.create(SQLite, {dbPath});

        // Neo.create already runs initAsync: a second call races it, and the loser's service import lands
        // after the stub below, which is how a CI worker read this graph as nobody
        await storage.ready();

        storage.RequestContextService = {getUserId: () => requester};

        storage.addNodes([
            node('shared-a'),
            node('shared-b', {kind: 'CONCEPT'}),
            node('own-x',   {userId: 'tenant-x'}),
            node('other-y', {userId: 'tenant-y'}),
            node('team-t',  {userId: 'tenant-y', visibility: 'team'}),
            node('lonely')
        ]);
        storage.addEdges([
            edge('e1', 'shared-a', 'shared-b'),
            edge('e2', 'shared-a', 'shared-b'),                                  // a parallel edge of one type
            edge('e3', 'shared-a', 'own-x', 'REL', {userId: 'tenant-x'}),
            edge('e4', 'shared-a', 'other-y'),                                   // its endpoint is tenant-y's
            edge('e5', 'shared-b', 'team-t', 'PRIVATE', {userId: 'tenant-y'}),  // a private edge between visible nodes
            edge('e6', 'shared-b', 'team-t', 'GUIDES', {visibility: 'team'})
        ])
    });

    test.beforeEach(() => {
        originalDb      = GraphService.db;
        GraphService.db = {storage};
        requester       = '@tenant-x'
    });

    test.afterEach(() => {
        GraphService.db = originalDb
    });

    test.afterAll(() => {
        if (storage.db?.open) {
            storage.db.close()
        }

        for (const suffix of ['', '-wal', '-shm']) {
            fs.removeSync(dbPath + suffix)
        }
    });

    test('RLS on nodes and edges: an unseen node leaves with its edges, a private edge between visible nodes is absent, and neither is a cut', async () => {
        const answer = await GraphService.readSceneGraph();

        expect(rowsOf(answer)).toEqual({
            nodes: ['lonely', 'own-x', 'shared-a', 'shared-b', 'team-t'],
            edges: ['shared-a -REL-> own-x', 'shared-a -REL-> shared-b', 'shared-b -GUIDES-> team-t']
        });
        expect(answer.counts, 'the node with no visible relation is in the scene, and counted').toEqual({nodes: 5, edges: 3, unlinked: 1});
        expect(answer.truncated).toEqual({nodes: false, edges: false});
        expect(answer.nodes.labels).toEqual(['name lonely', 'name own-x', 'name shared-a', 'name shared-b', 'name team-t']);
        expect(answer.kinds[answer.nodes.kinds[3]]).toBe('CONCEPT');
        expect(JSON.stringify(answer), 'display fields only: no owner, no property bag').not.toMatch(/tenant-|properties|weight/)
    });

    test('another requester sees its own graph through the same read', async () => {
        requester = 'tenant-y';

        expect(rowsOf(await GraphService.readSceneGraph())).toEqual({
            nodes: ['lonely', 'other-y', 'shared-a', 'shared-b', 'team-t'],
            edges: ['shared-a -REL-> other-y', 'shared-a -REL-> shared-b', 'shared-b -GUIDES-> team-t', 'shared-b -PRIVATE-> team-t']
        })
    });

    test('a node budget keeps the best-connected nodes and the edges among them, and says truncated', async () => {
        const answer = await GraphService.readSceneGraph({maxNodes: 2});

        expect(rowsOf(answer), 'the unlinked node goes first').toEqual({nodes: ['shared-a', 'shared-b'], edges: ['shared-a -REL-> shared-b']});
        expect(answer.budget).toEqual({maxNodes: 2, maxEdges: 500000});
        expect(answer.truncated).toEqual({nodes: true, edges: true})
    });

    test('an edge budget cuts the edge list in its order and leaves the nodes whole', async () => {
        const answer = await GraphService.readSceneGraph({maxEdges: 1});

        expect(rowsOf(answer).edges).toEqual(['shared-a -REL-> own-x']);
        expect(answer.counts.nodes).toBe(5);
        expect(answer.truncated).toEqual({nodes: false, edges: true})
    });

    test('without the durable store the read refuses rather than answer the node cache as the graph', async () => {
        GraphService.db = {nodes: {items: []}};

        await expect(GraphService.readSceneGraph()).rejects.toThrow(/needs the SQLite store/)
    });
});

test.describe('GraphService.readSceneGraph — paged across a large graph', () => {
    test('every page lands, and the plane runs other work between pages', async () => {
        const
            GraphService = (await import('../../../../../../ai/services/memory-core/GraphService.mjs')).default,
            originalDb   = GraphService.db,
            dbPath       = path.resolve(process.cwd(), 'tmp', `graph-scene-pages-${globalThis.crypto.randomUUID()}.sqlite`),
            storage      = Neo.create(SQLite, {dbPath}),
            count        = 12000,
            id           = index => `n-${String(index).padStart(5, '0')}`;

        try {
            await storage.ready();
            storage.RequestContextService = {getUserId: () => null};

            // a chain across three 5,000-row pages of each table: a page boundary that skipped a row would break it
            storage.addNodes(Array.from({length: count}, (item, index) => node(id(index))));
            storage.addEdges(Array.from({length: count - 1}, (item, index) => edge(`e-${id(index)}`, id(index), id(index + 1))));

            GraphService.db = {storage};

            let between = false;

            setImmediate(() => between = true);

            const answer = await GraphService.readSceneGraph();

            expect(between, 'a task queued behind the read ran before it finished').toBe(true);
            expect(answer.counts).toEqual({nodes: count, edges: count - 1, unlinked: 0});
            expect(answer.nodes.ids[count - 1]).toBe(id(count - 1))
        } finally {
            GraphService.db = originalDb;

            if (storage.db?.open) {
                storage.db.close()
            }

            for (const suffix of ['', '-wal', '-shm']) {
                fs.removeSync(dbPath + suffix)
            }
        }
    });
});
