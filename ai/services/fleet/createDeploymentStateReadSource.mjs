import {readDeploymentStateSnapshot}    from '../memory-core/helpers/deploymentStateBridgeStore.mjs';
import {projectDeploymentStateForFleet} from './projectDeploymentStateForFleet.mjs';

/**
 * @module ai/services/fleet/createDeploymentStateReadSource
 * @summary The fleet-server-side READER half of the deployment-state surface: the orchestrator writes its
 * bounded deployment-state snapshot to `AiConfig.orchestrator.deploymentStateBridge.snapshotPath`
 * (`DeploymentStateBridgeService#writeSnapshotIfDue`, atomic), and the Memory Core's
 * `readDeploymentStateSnapshot` owns how that file is interpreted — the byte cap, the snapshot's own
 * `generatedAt` aged against the staleness horizon, the schema diagnostics, and the difference between an
 * absent file and a failed read. This factory is a thin adapter over that one reader: it never re-interprets
 * the file, it maps the reader's verdict onto the closed wire projection (`projectDeploymentStateForFleet`),
 * the shape `FleetControlBridge.deploymentStateSource` expects — never the raw file. Sibling of
 * `createBootIdentityReadSource`: the same cross-process shape (the fleet server and the orchestrator are
 * separate processes), the same fail-soft contract — every reader verdict short of a usable snapshot is an
 * honest `unavailable` carrying the reader's own reason code, never a fabricated plane. READ-ONLY,
 * observe-only: no actuator rides this source.
 */

/**
 * @summary Build a deployment-state read-source over the orchestrator's snapshot file.
 * @param {Object}   options
 * @param {String}   options.path          The resolved `snapshotPath` leaf value.
 * @param {Number}   options.staleAfterMs  The resolved `staleAfterMs` leaf value, handed to the reader, which ages the snapshot against it.
 * @param {Number}   options.maxBytes      The resolved `maxSnapshotBytes` leaf value; a larger file is refused unparsed.
 * @param {Function} [options.readImpl=readDeploymentStateSnapshot] The snapshot reader seam — the Memory Core's own (injected in specs).
 * @param {Function} [options.now=Date.now] The clock the snapshot's `generatedAt` is aged against (injected in specs).
 * @returns {{produceDeploymentState: Function}} the read-source `FleetControlBridge.deploymentStateSource` expects.
 */
export function createDeploymentStateReadSource({path, staleAfterMs, maxBytes, readImpl = readDeploymentStateSnapshot, now = Date.now} = {}) {
    return {
        async produceDeploymentState() {
            let read;

            // The file reader answers every failure as a verdict; a plane reader can THROW (transport,
            // an unreadable answer). Either way the source projects an honest `unavailable` — the wire
            // verb never fails upstream for a snapshot it merely could not read.
            try {
                read = await readImpl({filePath: path, now: now(), staleAfterMs, maxBytes});
            } catch {
                return projectDeploymentStateForFleet(null, {reason: 'snapshot-read-failed'});
            }

            // `available` and `stale` both hand back the parsed snapshot with its `generatedAt` age, and the
            // verdict is carried as the reader decided it — a plane verdict on the plane's horizon, `0`
            // disabling staleness — never re-aged against this process's leaf. Every other verdict — a degraded
            // schema, an absent file, a failed read, an oversized file, an unconfigured path — is projected as
            // `unavailable` under the reader's own reason code, never re-derived here.
            if (read && (read.status === 'available' || read.status === 'stale') && read.snapshot) {
                return projectDeploymentStateForFleet(read.snapshot, {ageMs: read.ageMs, stale: read.status === 'stale'});
            }

            return projectDeploymentStateForFleet(null, {reason: read?.reason || 'snapshot-read-failed'});
        }
    };
}
