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
 * @param {Object}      options
 * @param {String}      options.harnessType
 * @param {String}      options.homeRoot       The harness's home: `instanceHome`, or the Codex home inside it
 * @param {String|null} options.repoSlug       The seat's repository, `<owner>/<name>`
 * @param {String}      options.targetRepoRoot The seat's checkout
 * @param {Object}      options.fileSystem     `fs/promises`-shaped; only `lstat` is read
 * @returns {Promise<Object>} `{state, reason}`, or `{state: 'projected', filePath, content}`
 */
export async function projectSeatInstructions({harnessType, homeRoot, repoSlug, targetRepoRoot, fileSystem}) {
    const fileName = HOME_INSTRUCTION_FILES[harnessType];

    if (!fileName) {
        return {state: NOT_APPLICABLE, reason: `'${harnessType}' has no witnessed user-scope instruction file`}
    }

    const [owner, name] = typeof repoSlug === 'string' ? repoSlug.split('/') : [];

    if (!SKILLS_OWNER || owner !== SKILLS_OWNER || !readSupported().repos.has(name)) {
        return {state: NOT_APPLICABLE, reason: `the Skills source declares no repository '${repoSlug}'`}
    }

    for (const file of REPOSITORY_INSTRUCTION_FILES[harnessType]) {
        if (await exists(path.join(targetRepoRoot, file), fileSystem)) {
            return {state: REPOSITORY_SUPPLIED, reason: `the checkout carries ${file}`}
        }
    }

    return {
        state   : PROJECTED,
        filePath: path.join(homeRoot, fileName),
        content : generate({audience: 'maintainer', repos: [name]}).text
    }
}

/**
 * @summary Whether an entry exists at the path, a symlink included. Only `ENOENT` means absent; any other error
 * is a failed observation and throws.
 * @param {String} filePath
 * @param {Object} fileSystem
 * @returns {Promise<Boolean>}
 */
async function exists(filePath, fileSystem) {
    try {
        await fileSystem.lstat(filePath);
        return true
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error
    }
}
