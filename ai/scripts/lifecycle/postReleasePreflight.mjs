import path from 'node:path';

/**
 * @summary Fail-closed preflight for the Brain-side post-release lifecycle — the safety envelope the
 * split command no longer inherits.
 *
 * While the KB upload lived inside `publish.mjs`, it inherited that script's preconditions: the
 * branch check had already run, `git checkout dev` had already happened, and the working tree held
 * exactly what the release process itself had produced. Splitting the command turned those
 * inherited preconditions into PROTOCOL FIELDS — implicit while one process, they must be explicit
 * (and mechanically asserted) when the second half is independently runnable from an arbitrary
 * checkout state. This module owns that assertion, deliberately free of any service import so it
 * is unit-testable without booting the Brain.
 *
 * Four gates, all before the first irreversible mutation:
 *
 * 1. **Target root** — explicitly supplied, Engine-identified, and distinct from the Brain runtime.
 * 2. **Branch** — the upload reads the released `dev` state, so it runs from `dev` only.
 * 3. **Version** — derived from the target's `package.json` ONLY (no CLI flag: an interpolated flag was both
 *    an injection surface and a version-mismatch class; removal beats validation) and still
 *    shape-checked as strict semver before it reaches a shell string.
 * 4. **Starting state** — the working tree is clean. `publish.mjs` leaves nothing behind, since the
 *    release note stays where it was authored, so any dirt is named and refused rather than
 *    uploaded as if it had been released.
 */

/**
 * Strict semver shape (optional pre-release suffix), asserted before any shell interpolation.
 * @type {RegExp}
 */
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Resolves the explicit target-repository authority for the Brain-side release command.
 *
 * Runtime root and target root are separate authorities. The npm command starts in the Brain
 * checkout, so ambient cwd is structurally the WRONG target and is never consulted here. The
 * caller must name an Engine checkout, which is identified from its manifest before any service
 * graph loads or any release mutation begins.
 * @param {Object} config
 * @param {String[]} config.argv CLI arguments after the script path.
 * @param {Function} config.readPackageJson Reads `<target>/package.json` (test seam).
 * @param {String} config.runtimeRoot Absolute or relative Brain runtime root.
 * @param {Function} [config.resolvePath=path.resolve] Path resolver (test seam).
 * @returns {String} Absolute Engine target root.
 * @throws {Error} When the binding is absent, malformed, aliases the runtime, or is not Engine.
 */
export function resolveTargetRepoRoot({argv, readPackageJson, runtimeRoot, resolvePath = path.resolve}) {
    if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--target-repo-root' ||
        typeof argv[1] !== 'string' || !argv[1].trim()) {
        throw new Error(
            'Post-release sync refused: target repository root is required explicitly. ' +
            'Usage: npm run ai:post-release-sync -- --target-repo-root /absolute/path/to/neo. ' +
            'Ambient process.cwd() is never a target-root fallback.'
        )
    }

    if (typeof runtimeRoot !== 'string' || !runtimeRoot.trim()) {
        throw new Error('Post-release sync refused: Brain runtime root is unavailable.')
    }

    const
        targetRoot  = resolvePath(argv[1]),
        resolvedRun = resolvePath(runtimeRoot);

    if (targetRoot === resolvedRun) {
        throw new Error(
            'Post-release sync refused: targetRepoRoot aliases agentosRuntimeRoot. ' +
            'Name the Engine checkout explicitly; the Brain checkout is never the release corpus.'
        )
    }

    let manifest;

    try {
        manifest = readPackageJson(targetRoot)
    } catch (error) {
        throw new Error(
            `Post-release sync refused: cannot read target package.json at ${targetRoot}: ${error.message}`
        )
    }

    if (manifest?.name !== 'neo.mjs') {
        throw new Error(
            `Post-release sync refused: targetRepoRoot must identify the Engine package "neo.mjs" ` +
            `(found ${JSON.stringify(manifest?.name)} at ${targetRoot}).`
        )
    }

    return targetRoot
}

/**
 * @summary Binds a child npm process to the already-validated target release version.
 *
 * `npm run ai:post-release-sync` starts in the Brain package, so its inherited
 * `npm_package_version` is Brain's package version. The uploader deliberately consumes that npm
 * field when present. Overwrite only that field with the Engine target's manifest version while
 * preserving the rest of the launch environment.
 *
 * @param {Object} config
 * @param {Object} [config.baseEnv=process.env] Parent process environment.
 * @param {String} config.version Validated Engine release version.
 * @returns {Object} Child process environment carrying the Engine release version.
 */
export function buildReleaseChildEnvironment({baseEnv = process.env, version}) {
    return {...baseEnv, npm_package_version: version}
}

/**
 * Resolves and validates the release version from the package manifest.
 * @param {Object} config
 * @param {Function} config.readPackageJson Returns the parsed root package.json (test seam).
 * @returns {String} The validated version, without a leading `v`.
 * @throws {Error} When the manifest version is absent or not strict semver.
 */
export function resolveReleaseVersion({readPackageJson}) {
    const version = readPackageJson()?.version;

    if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
        throw new Error(
            `Post-release sync refused: package.json version ${JSON.stringify(version)} is not strict semver. ` +
            'The version is derived from the manifest only — there is deliberately no CLI override.'
        );
    }

    return version;
}

/**
 * Asserts the current branch is `dev` — the release is cut from it, so the upload reads its state.
 * @param {Object} config
 * @param {Function} config.getCurrentBranch Returns the current branch name (test seam).
 * @returns {void}
 * @throws {Error} On any other branch.
 */
export function assertOnDevBranch({getCurrentBranch}) {
    const branch = getCurrentBranch();

    if (branch !== 'dev') {
        throw new Error(
            `Post-release lifecycle refused: must run on 'dev' (current: ${JSON.stringify(branch)}). ` +
            'The release is cut from dev, and uploading any other state would publish what was not released.'
        );
    }
}

/**
 * Asserts the working tree is clean — the release leaves nothing behind in the Engine checkout.
 * @param {Object} config
 * @param {Function} config.getPorcelainStatus Returns `git status --porcelain` output (test seam).
 * @returns {void}
 * @throws {Error} Naming every dirty path, so the operator cleans deliberately.
 */
export function assertAdmissibleStartingState({getPorcelainStatus}) {
    const status = getPorcelainStatus();

    // A failed probe is NOT a clean tree. The status runner returns null on failure; normalizing
    // that to '' would pass a gate whose one job is establishing working-tree truth — the exact
    // fail-open this preflight exists to prevent, one layer up.
    if (typeof status !== 'string') {
        throw new Error(
            'Post-release lifecycle refused: could not establish working-tree truth (`git status --porcelain` failed). ' +
            'A gate that cannot observe the tree must not admit the upload.'
        );
    }

    const dirty = status.split('\n').filter(line => line.trim());

    if (dirty.length > 0) {
        throw new Error(
            'Post-release lifecycle refused: the working tree holds changes the release did not produce:\n' +
            `${dirty.join('\n')}\nAdmissible starting state: clean. Commit, stash, or clean first.`
        );
    }
}
