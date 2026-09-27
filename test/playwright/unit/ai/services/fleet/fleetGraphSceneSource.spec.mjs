import {expect, test} from '@playwright/test';
import {
    createFleetGraphSceneSource,
    projectScene,
    qualifyNodeId
} from '../../../../../../ai/services/fleet/fleetGraphSceneSource.mjs';

// `FleetControlBridge` (which the wiring imports) and the policy ledgers reach `neo.mjs`, whose modules call
// `Neo.gatekeep` at module-evaluation time. They are loaded DYNAMICALLY, after the framework entrypoint has
// established the global, because a static import hoists above any statement here and would evaluate those
// modules against whatever ambient state the worker happened to inherit.
await import('neo.mjs/src/Neo.mjs');

const {default: FleetControlBridge} = await import('../../../../../../ai/services/fleet/FleetControlBridge.mjs');
const {wireFleetGraphSceneSource} = await import('../../../../../../ai/services/fleet/wireFleetGraphSceneSource.mjs');
const {FLEET_METHOD_SCOPE_CLASSES, FLEET_S1_METHOD_POLICY} = await import('../../../../../../ai/services/fleet/fleetServerPolicy.mjs');
const {FLEET_WIRE_METHODS} = await import('../../../../../../src/fleet/contract/wire.mjs');

const
    NOW    = '2026-09-27T09:00:00.000Z',
    NOW_MS = Date.parse(NOW);

/**
 * @summary A columnar `get_graph_scene` answer, built from readable rows the way the Memory Core encodes it.
 * @param {Object[]} nodes `{id, kind, label}`
 * @param {Object[]} edges `{source, target, type?}`
 * @param {Object} [extra] Fields to override (`counts`, `budget`, `truncated`)
 * @returns {Object}
 */
function answerOf(nodes, edges, extra = {}) {
    const
        kinds = [...new Set(nodes.map(node => node.kind))],
        types = [...new Set(edges.map(edge => edge.type ?? null))],
        index = new Map(nodes.map((node, position) => [node.id, position]));

    return {
        kinds,
        types,
        nodes    : {ids: nodes.map(node => node.id), kinds: nodes.map(node => kinds.indexOf(node.kind)), labels: nodes.map(node => node.label)},
        edges    : edges.flatMap(edge => [index.get(edge.source), index.get(edge.target), types.indexOf(edge.type ?? null)]),
        counts   : {nodes: nodes.length, edges: edges.length, unlinked: 0},
        budget   : {maxNodes: 250000, maxEdges: 500000},
        truncated: {nodes: false, edges: false},
        ...extra
    }
}

const
    NODES = [
        {id: 'issue-7',  kind: 'ISSUE',        label: 'Seven'},
        {id: 'pr-101',   kind: 'PULL_REQUEST', label: 'One-oh-one'},
        {id: 'concept-a', kind: 'CONCEPT',     label: 'A'}
    ],
    EDGES = [
        {source: 'pr-101', target: 'issue-7',   type: 'RESOLVES'},
        {source: 'pr-101', target: 'concept-a', type: 'TAGGED_CONCEPT'}
    ],
    ROUTE = {status: 'available', route: {route: {items: [{id: 'issue-7'}, {id: 'pr-101'}]}}};

/**
 * @summary The two operations a source reads through, answering the fixture graph and route.
 * @param {Object} [overrides]
 * @returns {Object}
 */
function seams(overrides = {}) {
    return {
        getComputedRoute: async () => ROUTE,
        getGraphScene   : async () => answerOf(NODES, EDGES),
        now             : () => NOW_MS,
        ...overrides
    }
}

test.describe('fleetGraphSceneSource', () => {
    test('the scene is the graph, and the route rides as its overlay', async () => {
        const read = await createFleetGraphSceneSource(seams()).readGraphScene();

        expect(read.capability).toEqual({state: 'current', reason: null});
        expect(read.capturedAt).toBe(NOW);
        expect(read.scene.route, 'the route ids, qualified like the nodes they name').toEqual(['neomjs/neo#issue-7', 'neomjs/neo#pr-101']);
        expect(read.scene.nodes).toEqual([
            {id: 'neomjs/neo#concept-a', label: 'A',          kind: 'CONCEPT'},
            {id: 'neomjs/neo#issue-7',   label: 'Seven',      kind: 'ISSUE'},
            {id: 'neomjs/neo#pr-101',    label: 'One-oh-one', kind: 'PULL_REQUEST'}
        ]);
        expect(read.scene.edges).toEqual([
            {from: 'neomjs/neo#pr-101', to: 'neomjs/neo#concept-a', type: 'TAGGED_CONCEPT'},
            {from: 'neomjs/neo#pr-101', to: 'neomjs/neo#issue-7',   type: 'RESOLVES'}
        ]);
        expect(read.scene.counts).toEqual({nodes: 3, edges: 2, seeds: 2, unlinked: 0});
        expect(read.scene.completeness).toBe('complete')
    });

    test('a route that cannot be read leaves the overlay empty and never withholds the graph', async () => {
        for (const getComputedRoute of [async () => { throw new Error('down') }, async () => ({status: 'missing', reason: 'route-sidecar-missing'})]) {
            const read = await createFleetGraphSceneSource(seams({getComputedRoute})).readGraphScene();

            expect(read.capability.state).toBe('current');
            expect(read.scene.route).toEqual([]);
            expect(read.scene.nodes).toHaveLength(3)
        }
    });

    test('the graph read receives the budget it was asked for, and a cut there reads truncated with that budget', async () => {
        const
            asked  = [],
            source = createFleetGraphSceneSource(seams({
                getGraphScene: async budget => {
                    asked.push(budget);

                    return answerOf(NODES, EDGES, {budget: {maxNodes: 2, maxEdges: 500000}, truncated: {nodes: true, edges: false}})
                }
            })),
            read   = await source.readGraphScene({maxNodes: 2});

        expect(asked).toEqual([{maxNodes: 2}]);
        expect(read.scene.completeness).toBe('truncated');
        expect(read.scene.budget).toEqual({maxNodes: 2, maxEdges: 500000, maxBytes: 64 * 1024 * 1024})
    });

    test('a scope cut never reads as a budget cut: an answer the graph narrowed by RLS is complete', async () => {
        // The Memory Core leaves a node the reader may not see out, with its edges, and does not flag it.
        const read = await createFleetGraphSceneSource(seams({
            getGraphScene: async () => answerOf(NODES.slice(0, 2), EDGES.slice(0, 1))
        })).readGraphScene();

        expect(read.scene.completeness).toBe('complete');
        expect(read.scene.counts.nodes).toBe(2)
    });

    test('ids are origin-qualified and two reads of one graph are byte-equal', async () => {
        const
            source = createFleetGraphSceneSource(seams()),
            first  = await source.readGraphScene(),
            second = await source.readGraphScene();

        expect(JSON.stringify(second.scene)).toBe(JSON.stringify(first.scene));
        expect(second.snapshotId).toBe(first.snapshotId);
        expect(qualifyNodeId('neomjs/other#issue-3'), 'an already-qualified id is left alone').toBe('neomjs/other#issue-3')
    });

    test('a failed or malformed graph read is unavailable with its reason, never a fabricated scene', async () => {
        const failed    = await createFleetGraphSceneSource(seams({getGraphScene: async () => { throw new Error('down') }})).readGraphScene(),
              malformed = await createFleetGraphSceneSource(seams({getGraphScene: async () => ({nodes: []})})).readGraphScene();

        expect(failed).toEqual({capability: {state: 'unavailable', reason: 'graph-read-failed'}, scene: null, snapshotId: null, capturedAt: NOW});
        expect(malformed.capability).toEqual({state: 'unavailable', reason: 'graph-answer-malformed'});
        expect(malformed.scene).toBeNull()
    });

    test('an empty graph is degraded, not an empty ok', async () => {
        const read = await createFleetGraphSceneSource(seams({getGraphScene: async () => answerOf([], [])})).readGraphScene();

        expect(read.capability).toEqual({state: 'degraded', reason: 'no-rows-resolved'})
    });

    test('an unwired slot is a distinct, honest state from a wired one', () => {
        // The stub bridge keeps the process singleton out of it, so both arms hold in one run.
        const bridge = {};

        expect(wireFleetGraphSceneSource({bridge, getComputedRoute: async () => ROUTE}), 'a half-resolved caller wires nothing').toBeNull();
        expect(bridge.graphSceneSource).toBeUndefined();

        const wired = wireFleetGraphSceneSource({...seams(), bridge});

        expect(wired).toBeTruthy();
        expect(bridge.graphSceneSource).toBe(wired)
    });
});

test.describe('fleetGraphSceneSource — pure projection', () => {
    test('the same answer yields the same scene whatever order its rows arrived in', () => {
        const
            straight = projectScene({graph: answerOf(NODES, EDGES)}),
            shuffled = projectScene({graph: answerOf([...NODES].reverse(), [...EDGES].reverse())});

        expect(shuffled).toEqual(straight)
    });

    test('a relation the graph does not name stays absent, never a placeholder', () => {
        const scene = projectScene({graph: answerOf(NODES, [{source: 'pr-101', target: 'issue-7'}])});

        expect(scene.edges).toEqual([{from: 'neomjs/neo#pr-101', to: 'neomjs/neo#issue-7'}])
    });

    test('the byte budget trims edges first, then nodes, from the end, and says truncated', () => {
        const
            // measured under a budget of the same width as the one below, since the budget is in the scene
            whole    = projectScene({graph: answerOf(NODES, EDGES), maxBytes: 999}),
            budget   = Buffer.byteLength(JSON.stringify(whole)) - 1,
            trimmed  = projectScene({graph: answerOf(NODES, EDGES), maxBytes: budget}),
            starved  = projectScene({graph: answerOf(NODES, EDGES), maxBytes: 300});

        expect(trimmed.edges, 'the last edge goes first').toEqual(whole.edges.slice(0, 1));
        expect(trimmed.nodes).toEqual(whole.nodes);
        expect(trimmed.completeness).toBe('truncated');
        expect(trimmed.counts.edges).toBe(1);
        expect(Buffer.byteLength(JSON.stringify(trimmed))).toBeLessThanOrEqual(budget);

        expect(starved.edges, 'nodes go only once no edge is left').toEqual([]);
        expect(starved.nodes.length).toBeLessThan(whole.nodes.length);
        expect(Buffer.byteLength(JSON.stringify(starved))).toBeLessThanOrEqual(300)
    });
});

test.describe('fleetGraphScene — wire contract', () => {
    test('the method is on the wire vocabulary and its policy row exists', () => {
        expect(FLEET_WIRE_METHODS).toContain('fleetGraphScene');
        expect(FLEET_S1_METHOD_POLICY.fleetGraphScene, 'the S1 policy row names the method').toBeTruthy();
        expect(FLEET_METHOD_SCOPE_CLASSES, 'and a scope class, so the read is declared').toBeTruthy()
    });

    test('the bridge slot is the one the pane reads', () => {
        expect(FleetControlBridge.graphSceneSource, 'the slot exists before anything is wired into it').toBeDefined();
        expect(FleetControlBridge.graphSceneSource ?? null, 'unwired is null, not a fabricated source').toBeNull()
    });
});
