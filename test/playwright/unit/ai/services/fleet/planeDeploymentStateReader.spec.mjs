import {expect, test}                       from '@playwright/test';
import {createDeploymentStateReadSource}    from '../../../../../../ai/services/fleet/createDeploymentStateReadSource.mjs';
import {createPlaneDeploymentStateReader}   from '../../../../../../ai/services/fleet/planeDeploymentStateReader.mjs';
import {DEPLOYMENT_STATE_PROJECTION_STATES} from '../../../../../../ai/services/fleet/projectDeploymentStateForFleet.mjs';

/**
 * The plane-mode deployment-state read: a fleet process attached to a plane serves the PLANE's snapshot
 * through the admitted client, projected by the same `projectDeploymentStateForFleet` the file reader
 * feeds — the installed Fleet Manager's System view was reading "snapshot missing" off its own data
 * root while the plane answered `available` with five services.
 */
test.describe('planeDeploymentStateReader — the plane-mode deployment-state read', () => {
    const planeVerdict = () => ({
        ok          : true,
        status      : 'available',
        filePath    : '/app/.neo-ai-data/deployment-state/snapshot.json',
        ageMs       : 37856,
        staleAfterMs: 120000,
        reason      : null,
        snapshot    : {
            schemaVersion: 1,
            recordType   : 'deployment-state',
            generatedAt  : 1700000000000,
            services     : [
                {schemaVersion: 1, recordType: 'deployment-service-state', serviceKey: 'mc-server', status: 'healthy', observedAt: 1700000000000},
                {schemaVersion: 1, recordType: 'deployment-service-state', serviceKey: 'kb-server', status: 'healthy', observedAt: 1700000000000}
            ]
        }
    });

    test('the request is the plane tool with no arguments, and the verdict comes back untouched', async () => {
        const
            calls   = [],
            verdict = planeVerdict(),
            reader  = createPlaneDeploymentStateReader({
                callTool: (name, args) => {
                    calls.push([name, args]);
                    return Promise.resolve(verdict)
                }
            });

        await expect(reader()).resolves.toBe(verdict);
        expect(calls).toEqual([['get_deployment_state_snapshot', {}]])
    });

    test('through the read-source, the plane\'s verdict projects the plane\'s services — the same projection the file reader feeds', async () => {
        const source = createDeploymentStateReadSource({
            path        : '',
            staleAfterMs: 120000,
            maxBytes    : 262144,
            readImpl    : createPlaneDeploymentStateReader({callTool: () => Promise.resolve(planeVerdict())}),
            now         : () => 1700000000000 + 37856
        });

        const projection = await source.produceDeploymentState();

        expect(projection.state).toBe(DEPLOYMENT_STATE_PROJECTION_STATES.ok);
        expect(projection.reason).toBeNull();
        expect(projection.services.map(service => service.serviceKey)).toEqual(['mc-server', 'kb-server']);
        expect(projection.ageMs).toBe(37856)
    });

    // the plane aged the snapshot on ITS horizon; this process's leaf never re-ages the verdict
    for (const [label, verdict, localHorizon, expected] of [
        ['a plane STALE verdict stays stale under a longer local horizon',     {ok: false, status: 'stale', ageMs: 90000, staleAfterMs: 60000, reason: 'snapshot-stale'}, 120000, 'stale'],
        ['a plane AVAILABLE verdict stays ok under a shorter local horizon',   {ageMs: 90000, staleAfterMs: 120000},                                                     60000, 'ok'],
        ['a plane horizon of 0 (staleness disabled) keeps an old snapshot ok', {ageMs: 86400000, staleAfterMs: 0},                                                       60000, 'ok']
    ]) {
        test(label, async () => {
            const source = createDeploymentStateReadSource({
                path        : '',
                staleAfterMs: localHorizon,
                maxBytes    : 262144,
                readImpl    : createPlaneDeploymentStateReader({callTool: () => Promise.resolve({...planeVerdict(), ...verdict})})
            });

            const projection = await source.produceDeploymentState();

            expect(projection.state).toBe(DEPLOYMENT_STATE_PROJECTION_STATES[expected]);
            expect(projection.ageMs).toBe(verdict.ageMs);
            expect(projection.services).toHaveLength(2)
        });
    }

    test('a plane answer without a snapshot projects unavailable under the plane\'s own reason, never a fabricated plane', async () => {
        const source = createDeploymentStateReadSource({
            path    : '',
            readImpl: createPlaneDeploymentStateReader({
                callTool: () => Promise.resolve({ok: false, status: 'unavailable', reason: 'snapshot-missing', snapshot: null})
            })
        });

        await expect(source.produceDeploymentState()).resolves.toMatchObject({
            state   : DEPLOYMENT_STATE_PROJECTION_STATES.unavailable,
            reason  : 'snapshot-missing',
            services: []
        })
    });

    test('an answer without a verdict throws — the source turns that into honest unavailable, never a guess', async () => {
        const reader = createPlaneDeploymentStateReader({
            callTool: () => Promise.resolve({services: 'not a reader verdict'})
        });

        await expect(reader()).rejects.toThrow('plane get_deployment_state_snapshot answer unreadable')
    });

    test('a client rejection propagates untouched — degradation policy belongs to the consumer', async () => {
        const reader = createPlaneDeploymentStateReader({
            callTool: () => Promise.reject(new Error('plane unreachable'))
        });

        await expect(reader()).rejects.toThrow('plane unreachable')
    });

    test('and that consumer, the read-source, projects a throwing reader as unavailable / snapshot-read-failed — the wire verb never fails upstream for a snapshot it could not read', async () => {
        const source = createDeploymentStateReadSource({
            path    : '',
            readImpl: createPlaneDeploymentStateReader({callTool: () => Promise.reject(new Error('plane unreachable'))})
        });

        await expect(source.produceDeploymentState()).resolves.toMatchObject({
            state   : DEPLOYMENT_STATE_PROJECTION_STATES.unavailable,
            reason  : 'snapshot-read-failed',
            services: []
        })
    });
});
