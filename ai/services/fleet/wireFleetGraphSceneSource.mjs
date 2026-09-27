import FleetControlBridge            from './FleetControlBridge.mjs';
import {createFleetGraphSceneSource} from './fleetGraphSceneSource.mjs';

/**
 * @module ai/services/fleet/wireFleetGraphSceneSource
 * @summary Installs the graph-scene source onto the Fleet control bridge at the authenticated
 * server entry. Both operations are resolved at that use site through the same operation boundary
 * the Golden Path source rides (the `wireFleetGoldenPathSource` shape): the route from the Memory
 * Core's `get_computed_route`, the graph from its `get_graph_scene`. This wiring imports neither
 * MCP tool service nor request context, and a caller that cannot resolve its operations leaves the
 * slot unwired, so the bridge keeps answering its honest `unavailable` default instead of a
 * fabricated graph.
 */

/**
 * @summary Wire one process-lifetime graph-scene source.
 * @param {Object} options
 * @param {Function} options.getComputedRoute
 * @param {Function} options.getGraphScene
 * @param {Function} [options.now]
 * @param {String} [options.origin]
 * @param {Object} [options.bridge=FleetControlBridge]
 * @param {Function} [options.createSource=createFleetGraphSceneSource]
 * @returns {Object|null}
 */
export function wireFleetGraphSceneSource({
    getComputedRoute,
    getGraphScene,
    now,
    origin,
    bridge       = FleetControlBridge,
    createSource = createFleetGraphSceneSource
} = {}) {
    if (typeof getComputedRoute !== 'function' || typeof getGraphScene !== 'function') {
        return null
    }

    bridge.graphSceneSource = createSource({
        getComputedRoute,
        getGraphScene,
        ...(now    ? {now}    : {}),
        ...(origin ? {origin} : {})
    });

    return bridge.graphSceneSource
}

export default wireFleetGraphSceneSource;
