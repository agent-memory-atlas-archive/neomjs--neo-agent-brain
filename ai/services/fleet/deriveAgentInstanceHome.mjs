import path from 'path';
import {
    assertContained,
    assertRoot,
    assertSeatSegment,
    HARNESS_SEGMENT
} from './deriveAgentRepoPath.mjs';

/**
 * @summary Derive the instance home of a Fleet agent's isolated harness config/state directory:
 * `<instanceRoot>/<agentId>/harness/<harnessType>`, beside the agent's clones.
 *
 * The pure half of harness-instance provisioning: path math only, with no fs / env / config access.
 * The home is what `CODEX_HOME` / `CLAUDE_CONFIG_DIR` point at (see
 * {@link Neo.ai.services.fleet.deriveHarnessLaunchSpec}).
 *
 * Two invariants are load-bearing because a harness home carries per-agent **auth + session state**:
 * - **Stable:** identical inputs map to the identical home, so an agent's auth never forks.
 * - **Collision-free:** every segment is the raw value itself, validated and never rewritten, so
 *   distinct agents or harness families never share a home. The home is keyed by the Fleet
 *   **agent id, NEVER `githubUsername`**: two Fleet agents may share one GitHub identity, never a home.
 *
 * The `harness` segment is one no clone owner may take ({@link HARNESS_SEGMENT}), so a checkout and a
 * harness home never meet. The resolved path is asserted to stay **contained** under `instanceRoot`.
 *
 * `instanceRoot` is required, never defaulted, derived or read from env here: the consuming service
 * passes the resolved `AiConfig.fleet.agentsRoot`.
 *
 * @param {Object} options
 * @param {String} options.instanceRoot An absolute path to the trusted agents root.
 * @param {String} options.agentId      The Fleet agent id (untrusted).
 * @param {String} options.harnessType  The harness family, e.g. `'codex'` (untrusted).
 * @returns {String} `<instanceRoot>/<agentId>/harness/<harnessType>`, absolute, stable, contained.
 * @throws {Error} If `instanceRoot` is not an absolute path, `agentId` / `harnessType` fails the
 * segment rule, or (defense-in-depth) the resolved path escapes `instanceRoot`.
 */
export function deriveAgentInstanceHome({instanceRoot, agentId, harnessType} = {}) {
    const root = assertRoot(instanceRoot, 'instanceRoot', 'deriveAgentInstanceHome');

    assertSeatSegment(agentId,     'agentId',     'deriveAgentInstanceHome');
    assertSeatSegment(harnessType, 'harnessType', 'deriveAgentInstanceHome');

    return assertContained(root, path.resolve(root, agentId, HARNESS_SEGMENT, harnessType), 'deriveAgentInstanceHome')
}
