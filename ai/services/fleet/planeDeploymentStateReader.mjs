/**
 * @module ai/services/fleet/planeDeploymentStateReader
 * @summary The plane-mode deployment-state read: `get_deployment_state_snapshot` through the admitted
 * plane client, answering in the reader-verdict shape `createDeploymentStateReadSource` consumes.
 *
 * The plane tool IS `readDeploymentStateSnapshot` served over MCP — the same `{status, snapshot,
 * ageMs, reason}` verdict the file reader returns — so this adapter hands the answer back untouched
 * and the projection (`projectDeploymentStateForFleet`) keeps doing the redaction. Sibling of
 * `planeWhoIsOnlineReader`: a fleet process attached to a plane reads the plane's truth, never its
 * own data root, which has no orchestrator writing a snapshot.
 */

/**
 * @summary Build the plane-mode `readImpl` for `createDeploymentStateReadSource`.
 * @param {Object} planeClient The admitted plane client (`callTool`).
 * @returns {Function} `async () => verdict` — the plane's reader verdict; throws when the answer carries no verdict.
 */
export function createPlaneDeploymentStateReader(planeClient) {
    return async () => {
        const payload = await planeClient.callTool('get_deployment_state_snapshot', {});

        if (typeof payload?.status !== 'string') {
            throw new Error('plane get_deployment_state_snapshot answer unreadable')
        }

        return payload
    }
}

export default createPlaneDeploymentStateReader;
