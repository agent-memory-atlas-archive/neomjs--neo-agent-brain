import {test, expect} from '@playwright/test';
import Neo            from 'neo.mjs/src/Neo.mjs';
import * as core      from 'neo.mjs/src/core/_export.mjs';
import {mkdtemp, mkdir, rm} from 'fs/promises';
import os             from 'os';
import path           from 'path';

import {
    ARMED_ADAPTER,
    armSeatWakeRoute,
    INSTANCE_DIR_BY_HARNESS,
    resolveInstanceTuple,
    toBareIdentity
} from '../../../../../../ai/daemons/wake/armSeatWakeRoute.mjs';

/**
 * Seat wake-route arming (`ai/daemons/wake/armSeatWakeRoute.mjs`) — falsifier coverage for the
 * two failure modes that report success while a seat cannot be woken.
 *
 *   Tuple derivation    — every refusal is NAMED. An unknown harness, a missing identity, a
 *                         non-directory, and a merely absent instance dir each produce their own
 *                         reason, because a guessed tuple wakes the wrong seat on a multi-instance
 *                         host and a wrong route is worse than no route.
 *   Ownership admission — a publish that produced no route OWNED by this seat is not an arm, even
 *                         when the builder succeeded and every peer route survived.
 *   Adapter admission   — owning a route is not being reachable BY it. The adapter is declared by
 *                         the SUBSCRIPTION, so a subscription left on a non-GUI adapter publishes
 *                         cleanly, keeps this seat's own route, and would otherwise report
 *                         `armed: true` while the delivery path never moved. Measured live on a
 *                         real seat: `armed: true, routeCount: 1` with the published adapter still
 *                         `opencode-server`, on a seat that could not be woken.
 *
 * `armSeatWakeRoute` resolves the tuple through the REAL fs — only `resolveInstanceTuple` takes an
 * `fs` seam — so the arming arms below run against a real temp home containing a real instance
 * directory, and the production `stat` is exercised rather than stubbed. The reader, the builder
 * and the manifest path stay injected, so no real manifest is ever read or written.
 */

const SUBSCRIPTION_ID = 'WAKE_SUB:11111111-2222-4333-8444-555555555555';

function makeSubscription({agentIdentity = '@neo-preview', adapter = ARMED_ADAPTER, ...rest} = {}) {
    return {
        id            : SUBSCRIPTION_ID,
        status        : 'active',
        agentIdentity,
        trigger       : 'SENT_TO_ME',
        harnessTarget : 'a2a-webhook',
        harnessTargetMetadata: {
            adapter,
            signingKey  : 'a'.repeat(64),
            url         : 'http://127.0.0.1:3199/wake',
            appName     : 'OpenCode',
            addressType : 'userDataDir',
            ...rest
        }
    };
}

/** A builder stand-in: `routeSummaries` is the merged published table, exactly as the real one reports it. */
function makeBuilder({routes = [], skipped = [], throws = null} = {}) {
    return async () => {
        if (throws) {
            throw throws;
        }

        return {manifest: {}, routeSummaries: routes, skipped};
    };
}

const ownRouteOn = adapter => ({subscriptionId: SUBSCRIPTION_ID, agentIdentity: '@neo-preview', adapter});

test.describe('resolveInstanceTuple — every refusal is named', () => {

    test('a known harness with an existing instance dir yields a durable tuple', async () => {
        const fs = {stat: async () => ({isDirectory: () => true})};

        const tuple = await resolveInstanceTuple({
            env    : {NEO_AGENT_IDENTITY: '@neo-preview'},
            harness: 'opencode',
            homeDir: '/home/op',
            fs
        });

        expect(tuple).toEqual({
            identity       : '@neo-preview',
            instanceAddress: `/home/op/${INSTANCE_DIR_BY_HARNESS.opencode}/neo-preview`,
            instanceType   : 'userDataDir'
        });
    });

    test('an unknown harness is declined by name, never guessed', async () => {
        const fs = {stat: async () => ({isDirectory: () => true})};

        const tuple = await resolveInstanceTuple({
            env    : {NEO_AGENT_IDENTITY: '@neo-preview'},
            harness: 'kiro',
            homeDir: '/home/op',
            fs
        });

        expect(tuple.skipped).toBe(true);
        expect(tuple.reason).toBe("no instance-directory convention is known for harness 'kiro'");
    });

    test('an absent identity is declined — a seat that cannot name itself cannot be addressed', async () => {
        const tuple = await resolveInstanceTuple({
            env    : {},
            harness: 'opencode',
            homeDir: '/home/op',
            fs     : {stat: async () => ({isDirectory: () => true})}
        });

        expect(tuple.skipped).toBe(true);
        expect(tuple.reason).toMatch(/cannot name itself/);
    });

    test('an absent instance dir is declined as a guess, not resolved optimistically', async () => {
        const fs = {stat: async () => {throw new Error('ENOENT');}};

        const tuple = await resolveInstanceTuple({
            env    : {NEO_AGENT_IDENTITY: '@neo-preview'},
            harness: 'opencode',
            homeDir: '/home/op',
            fs
        });

        expect(tuple.skipped).toBe(true);
        expect(tuple.reason).toMatch(/does not exist, so the tuple would be a guess/);
    });

    test('a non-directory at the instance path is declined distinctly from absence', async () => {
        const fs = {stat: async () => ({isDirectory: () => false})};

        const tuple = await resolveInstanceTuple({
            env    : {NEO_AGENT_IDENTITY: '@neo-preview'},
            harness: 'opencode',
            homeDir: '/home/op',
            fs
        });

        expect(tuple.skipped).toBe(true);
        expect(tuple.reason).toMatch(/exists but is not a directory/);
    });

    test('toBareIdentity strips a leading @ and tolerates a bare name', () => {
        expect(toBareIdentity('@neo-preview')).toBe('neo-preview');
        expect(toBareIdentity('neo-preview')).toBe('neo-preview');
        expect(toBareIdentity('  @neo-preview  ')).toBe('neo-preview');
        expect(toBareIdentity(null)).toBeNull();
    });
});

test.describe('armSeatWakeRoute — preconditions', () => {

    let homeDir;

    test.beforeAll(async () => {
        homeDir = await mkdtemp(path.join(os.tmpdir(), 'neo-wake-arm-'));
        await mkdir(path.join(homeDir, INSTANCE_DIR_BY_HARNESS.opencode, 'neo-preview'), {recursive: true});
    });

    test.afterAll(async () => {
        await rm(homeDir, {recursive: true, force: true});
    });

    // Built per call: `homeDir` is assigned in beforeAll, so a literal captured at
    // describe-evaluation time would freeze `undefined` into every arm.
    const base = () => ({
        env      : {NEO_AGENT_IDENTITY: '@neo-preview'},
        homeDir,
        harness  : 'opencode',
        manifestPath: path.join(homeDir, 'routes.json')
    });

    test('a missing subscription reader is refused rather than assumed empty', async () => {
        const result = await armSeatWakeRoute({...base()});

        expect(result.armed).toBe(false);
        expect(result.reason).toMatch(/no subscription reader/);
    });

    test('a missing manifest path is refused — publishing nowhere is not arming', async () => {
        const result = await armSeatWakeRoute({...base(), manifestPath: undefined, listSubscriptions: async () => []});

        expect(result.armed).toBe(false);
        expect(result.reason).toMatch(/no manifest path/);
    });

    test('a tuple refusal propagates its own reason instead of a generic failure', async () => {
        const result = await armSeatWakeRoute({
            ...base(),
            harness          : 'kiro',
            listSubscriptions: async () => [makeSubscription()]
        });

        expect(result.armed).toBe(false);
        expect(result.reason).toMatch(/no instance-directory convention is known for harness 'kiro'/);
    });

    test('a reader returning a non-array is refused — the set must be verifiable', async () => {
        const result = await armSeatWakeRoute({
            ...base(),
            listSubscriptions: async () => ({not: 'an array'}),
            runBuilder       : makeBuilder()
        });

        expect(result.armed).toBe(false);
        expect(result.reason).toMatch(/no array, so the set is unverifiable/);
    });

    test("another seat's subscription is refused rather than published against this seat's address", async () => {
        const result = await armSeatWakeRoute({
            ...base(),
            listSubscriptions: async () => [makeSubscription({agentIdentity: '@neo-opus-ada'})],
            runBuilder       : makeBuilder()
        });

        expect(result.armed).toBe(false);
        expect(result.reason).toMatch(/refusing to publish another seat's route/);
    });

    test('a builder throw is surfaced, not swallowed into a bare false', async () => {
        const result = await armSeatWakeRoute({
            ...base(),
            listSubscriptions: async () => [makeSubscription()],
            runBuilder       : makeBuilder({throws: new Error('manifest is read-only')})
        });

        expect(result.armed).toBe(false);
        expect(result.reason).toMatch(/arming failed: manifest is read-only/);
    });
});

test.describe('armSeatWakeRoute — a success must mean a reachable seat', () => {

    let homeDir;

    test.beforeAll(async () => {
        homeDir = await mkdtemp(path.join(os.tmpdir(), 'neo-wake-arm-'));
        await mkdir(path.join(homeDir, INSTANCE_DIR_BY_HARNESS.opencode, 'neo-preview'), {recursive: true});
    });

    test.afterAll(async () => {
        await rm(homeDir, {recursive: true, force: true});
    });

    // Built per call — see the note in the preconditions block.
    const base = () => ({
        env              : {NEO_AGENT_IDENTITY: '@neo-preview'},
        homeDir,
        harness          : 'opencode',
        manifestPath     : path.join(homeDir, 'routes.json'),
        listSubscriptions: async () => [makeSubscription()]
    });

    test('a publish with no route owned by this seat is NOT an arm, even with peers surviving', async () => {
        const result = await armSeatWakeRoute({
            ...base(),
            runBuilder: makeBuilder({
                routes: [{subscriptionId: 'WAKE_SUB:other', agentIdentity: '@neo-opus-ada', adapter: ARMED_ADAPTER}]
            })
        });

        expect(result.armed).toBe(false);
        expect(result.routeCount).toBe(0);
        expect(result.reason).toMatch(/produced no route owned by @neo-preview/);
    });

    test('owning a route on the armed adapter arms, and says which adapter it published', async () => {
        const result = await armSeatWakeRoute({
            ...base(),
            runBuilder: makeBuilder({routes: [ownRouteOn(ARMED_ADAPTER)]})
        });

        expect(result.armed).toBe(true);
        expect(result.adapter).toBe(ARMED_ADAPTER);
        expect(result.routeCount).toBe(1);
    });

    test('THE FALSE SUCCESS: own route published on a non-armed adapter is a named non-success', async () => {
        // The measured shape: the arm derives the instance tuple, the builder publishes the
        // subscription's own adapter, and nothing notices the delivery path never moved.
        const result = await armSeatWakeRoute({
            ...base(),
            listSubscriptions: async () => [makeSubscription({adapter: 'opencode-server'})],
            runBuilder       : makeBuilder({routes: [ownRouteOn('opencode-server')]})
        });

        expect(result.armed).toBe(false);
        expect(result.adapter).toBe('opencode-server');
        expect(result.reason).toMatch(/delivery path was NOT switched/);
        expect(result.reason).toMatch(new RegExp(`update the subscription's adapter to '${ARMED_ADAPTER}'`));
    });

    test('the adapter is read from what the route will USE, not from the input request', async () => {
        // A builder that publishes osascript while the input subscription declares something else
        // must arm: comparing the request with itself would always agree, and always lie.
        const result = await armSeatWakeRoute({
            ...base(),
            listSubscriptions: async () => [makeSubscription({adapter: 'opencode-server'})],
            runBuilder       : makeBuilder({routes: [ownRouteOn(ARMED_ADAPTER)]})
        });

        expect(result.armed).toBe(true);
        expect(result.adapter).toBe(ARMED_ADAPTER);
    });

    test('a route whose adapter is absent is not treated as a match', async () => {
        const result = await armSeatWakeRoute({
            ...base(),
            runBuilder: makeBuilder({routes: [{subscriptionId: SUBSCRIPTION_ID, agentIdentity: '@neo-preview'}]})
        });

        expect(result.armed).toBe(false);
        expect(result.adapter).toBe('none');
    });
});
