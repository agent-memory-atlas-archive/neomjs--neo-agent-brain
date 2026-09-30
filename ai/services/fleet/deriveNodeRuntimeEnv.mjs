/**
 * @summary Keep Node execution mode on the MCP child when Fleet itself runs inside Electron.
 * An explicit different Node executable owns its own runtime; no parent environment is copied.
 * @param {String} nodePath Selected Node executable.
 * @param {Object} [runtime=process] Host runtime facts (`execPath`, `versions.electron`).
 * @returns {Object} Non-secret child environment additions.
 */
export function deriveNodeRuntimeEnv(nodePath, runtime = process) {
    return nodePath === runtime.execPath && runtime.versions?.electron
        ? {ELECTRON_RUN_AS_NODE: '1'}
        : {};
}
