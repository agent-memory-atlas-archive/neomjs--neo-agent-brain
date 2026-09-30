import {constants}               from 'node:fs';
import {createRequire}           from 'node:module';
import path                      from 'node:path';
import {generate, readSupported} from 'neo-agent-skills/agents-md';

/**
 * @summary What becomes of a seat's instructions file. `projected`: Fleet writes the maintainer composition into
 * the harness home. `not-applicable`: the harness has no witnessed user-scope slot, or the Skills source declares
 * no such repository. `repository-supplied`: the seat's checkout already carries the file the harness loads.
 * @member {Object}
 */
export const SEAT_INSTRUCTION_STATES = Object.freeze({
    NOT_APPLICABLE     : 'not-applicable',
    PROJECTED          : 'projected',
    REPOSITORY_SUPPLIED: 'repository-supplied'
});

/**
 * @summary The user-scope instruction file each harness reads from its home in every session. A harness joins
 * only once a first session has been seen loading it there.
 * @member {Object}
 */
export const HOME_INSTRUCTION_FILES = Object.freeze({
    'claude-code'  : 'CLAUDE.md',
    'codex'        : 'AGENTS.md',
    'codex-desktop': 'AGENTS.md'
});

/**
 * The checkout files each harness loads as project instructions. A checkout carrying one already supplies the
 * seat's rules, and a home copy beside it loads them twice: Claude reads user and project files under no shared
 * cap, and Codex reads its home file whole, outside the byte budget its project files share.
 */
const REPOSITORY_INSTRUCTION_FILES = Object.freeze({
    'claude-code'  : Object.freeze(['CLAUDE.md', path.join('.claude', 'CLAUDE.md')]),
    'codex'        : Object.freeze(['AGENTS.override.md', 'AGENTS.md']),
    'codex-desktop': Object.freeze(['AGENTS.override.md', 'AGENTS.md'])
});

/**
 * The organization whose repositories the Skills source declares: the one that publishes it. Derived from the
 * package's own metadata, so Fleet names no tenant.
 */
const SKILLS_OWNER = /github\.com[/:]([^/]+)\//.exec(createRequire(import.meta.url)('neo-agent-skills/package.json').repository?.url ?? '')?.[1] ?? null;

const {NOT_APPLICABLE, PROJECTED, REPOSITORY_SUPPLIED} = SEAT_INSTRUCTION_STATES;

/**
 * @summary Projects a seat's maintainer instructions into its harness home. It reads the checkout and writes
 * nothing; the preparer converges what it returns.
 *
 * Every state of a harness with a home slot names that slot as `filePath`, so the preparer can also retire a
 * file Fleet wrote earlier when the seat no longer takes it. A checkout entry supplies instructions only when
 * it is a file the harness can read, a symlink to one included; a directory, a link to nothing or an
 * unreadable file cannot, so the composition is written and the entry is named in `ignored`.
 * @param {Object}      options
 * @param {String}      options.harnessType
 * @param {String}      options.homeRoot       The harness's home: `instanceHome`, or the Codex home inside it
 * @param {String|null} options.repoSlug       The seat's repository, `<owner>/<name>`
 * @param {String}      options.targetRepoRoot The seat's checkout
 * @param {Object}      options.fileSystem     `fs/promises`-shaped; reads `stat`, `lstat` and `access`
 * @returns {Promise<Object>} `{state, reason, filePath?, content?, ignored?}`: `content` only when `projected`
 */
export async function projectSeatInstructions({harnessType, homeRoot, repoSlug, targetRepoRoot, fileSystem}) {
    const fileName = HOME_INSTRUCTION_FILES[harnessType];

    if (!fileName) {
        return {state: NOT_APPLICABLE, reason: `'${harnessType}' has no witnessed user-scope instruction file`}
    }

    const
        filePath      = path.join(homeRoot, fileName),
        [owner, name] = typeof repoSlug === 'string' ? repoSlug.split('/') : [];

    if (!SKILLS_OWNER || owner !== SKILLS_OWNER || !readSupported().repos.has(name)) {
        return {state: NOT_APPLICABLE, reason: `the Skills source declares no repository '${repoSlug}'`, filePath}
    }

    const ignored = [];

    for (const file of REPOSITORY_INSTRUCTION_FILES[harnessType]) {
        const usable = await inspectCheckoutFile(path.join(targetRepoRoot, file), fileSystem);

        if (usable === true) {
            return {state: REPOSITORY_SUPPLIED, reason: `the checkout carries ${file}`, filePath}
        }

        usable && ignored.push(`${file} (${usable})`)
    }

    return {
        state : PROJECTED,
        reason: ignored.length
            ? `the checkout's ${ignored.join(', ')} cannot supply instructions, so Fleet writes the composition for '${name}'`
            : `Fleet writes the composition for '${name}'`,
        filePath,
        content: generate({audience: 'maintainer', repos: [name]}).text,
        ...(ignored.length ? {ignored} : {})
    }
}

/**
 * @summary Whether a checkout entry is a file the harness can read. `null`: nothing is there. `true`: a
 * readable file, through a symlink or not. Otherwise the reason it cannot supply instructions. Only `ENOENT`
 * means absent and only `EACCES` or `EPERM` means unreadable; any other error is a failed observation and throws.
 * @param {String} filePath
 * @param {Object} fileSystem
 * @returns {Promise<Boolean|String|null>}
 */
async function inspectCheckoutFile(filePath, fileSystem) {
    let stats;

    try {
        stats = await fileSystem.stat(filePath)
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;

        try {
            await fileSystem.lstat(filePath)
        } catch (entryError) {
            if (entryError?.code === 'ENOENT') return null;
            throw entryError
        }

        return 'a link to nothing'
    }

    if (!stats.isFile()) return 'not a file';

    try {
        await fileSystem.access(filePath, constants.R_OK)
    } catch (error) {
        if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'unreadable';
        throw error
    }

    return true
}
