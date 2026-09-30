import {test, expect} from '@playwright/test';
import path           from 'path';
import {generate}     from 'neo-agent-skills/agents-md';
import {
    HOME_INSTRUCTION_FILES,
    SEAT_INSTRUCTION_STATES,
    projectSeatInstructions
} from '../../../../../../ai/services/fleet/projectSeatInstructions.mjs';

// Reads the checkout through injected `stat`, `lstat` and `access` and writes nothing, so every case runs on a
// fake filesystem.

const
    {NOT_APPLICABLE, PROJECTED, REPOSITORY_SUPPLIED} = SEAT_INSTRUCTION_STATES,
    HOME                                             = path.resolve('/srv/agents/neo-seat/harness/claude-code'),
    REPO                                             = path.resolve('/srv/agents/neo-seat/neomjs/neo-agent-brain'),
    GATE                                             = /No AiConfig work without reading ADR-0019/;

/**
 * @summary A checkout on a fake filesystem. A list names readable files; an object maps a path to `file`,
 * `directory`, `dangling` (a link to nothing) or `unreadable`.
 */
function fakeFileSystem(entries = []) {
    const
        kinds  = Array.isArray(entries) ? Object.fromEntries(entries.map(entry => [entry, 'file'])) : entries,
        failed = (code, filePath) => Object.assign(new Error(`${code}: ${filePath}`), {code});

    return {
        lstat : async filePath => {
            if (kinds[filePath]) return {};
            throw failed('ENOENT', filePath)
        },
        stat  : async filePath => {
            if (!kinds[filePath] || kinds[filePath] === 'dangling') throw failed('ENOENT', filePath);
            return {isFile: () => kinds[filePath] !== 'directory'}
        },
        access: async filePath => {
            if (kinds[filePath] === 'unreadable') throw failed('EACCES', filePath)
        }
    }
}

function project(options) {
    return projectSeatInstructions({
        harnessType   : 'claude-code',
        homeRoot      : HOME,
        repoSlug      : 'neomjs/neo-agent-brain',
        targetRepoRoot: REPO,
        fileSystem    : fakeFileSystem(),
        ...options
    })
}

test.describe('projectSeatInstructions (a seat\'s maintainer instructions in its harness home)', () => {
    test('a Claude seat on a repository with no instruction file gets the composition as <home>/CLAUDE.md', async () => {
        const result = await project({});

        expect(result.state).toBe(PROJECTED);
        expect(result.filePath).toBe(path.join(HOME, 'CLAUDE.md'));
        expect(result.content).toBe(generate({audience: 'maintainer', repos: ['neo-agent-brain']}).text);
        // the Brain-only gate reaches a Brain seat, which no repository file carries today
        expect(result.content).toMatch(GATE)
    });

    test('Codex seats get AGENTS.md in the home they are handed, codex-desktop\'s nested home included', async () => {
        for (const [harnessType, homeRoot] of [['codex', HOME], ['codex-desktop', path.join(HOME, 'codex-home')]]) {
            const result = await project({harnessType, homeRoot, repoSlug: 'neomjs/neo-agent-institution'});

            expect(result).toMatchObject({state: PROJECTED, filePath: path.join(homeRoot, 'AGENTS.md')});
            expect(result.content).not.toMatch(GATE)
        }
    });

    test('a checkout supplies a seat\'s instructions only through the files that seat\'s harness reads', async () => {
        const
            supplies = {
                'claude-code'  : ['CLAUDE.md', path.join('.claude', 'CLAUDE.md')],
                'codex'        : ['AGENTS.override.md', 'AGENTS.md'],
                'codex-desktop': ['AGENTS.override.md', 'AGENTS.md']
            },
            files = ['CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'AGENTS.override.md', 'AGENTS.md'];

        for (const [harnessType, own] of Object.entries(supplies)) {
            for (const file of files) {
                const
                    fileSystem = fakeFileSystem([path.join(REPO, file)]),
                    expected   = own.includes(file) ? REPOSITORY_SUPPLIED : PROJECTED;

                expect(await project({fileSystem, harnessType, repoSlug: 'neomjs/neo'}), `${harnessType} beside ${file}`)
                    .toMatchObject({state: expected})
            }
        }
    });

    test('a repository the Skills source does not declare is not-applicable, never a failed start, and names the home slot', async () => {
        for (const repoSlug of ['acme/neo', 'neomjs/not-declared', 'neo', null]) {
            expect(await project({repoSlug}), String(repoSlug))
                .toMatchObject({state: NOT_APPLICABLE, filePath: path.join(HOME, 'CLAUDE.md')})
        }
    });

    test('a checkout that supplies the instructions still names the home slot, so a file Fleet wrote can be retired', async () => {
        expect(await project({fileSystem: fakeFileSystem([path.join(REPO, 'CLAUDE.md')])}))
            .toMatchObject({state: REPOSITORY_SUPPLIED, reason: 'the checkout carries CLAUDE.md', filePath: path.join(HOME, 'CLAUDE.md')})
    });

    test('a harness with no witnessed user-scope slot is not-applicable, with no slot to name', async () => {
        for (const harnessType of ['claude-desktop', 'kimi-code', 'opencode']) {
            const result = await project({harnessType});

            expect(HOME_INSTRUCTION_FILES[harnessType]).toBeUndefined();
            expect(result, harnessType).toMatchObject({state: NOT_APPLICABLE});
            expect(result.filePath, harnessType).toBeUndefined()
        }
    });

    test('a checkout entry the harness cannot read never supplies the instructions: the composition is written and the entry is named', async () => {
        for (const [kind, why] of [['directory', 'not a file'], ['dangling', 'a link to nothing'], ['unreadable', 'unreadable']]) {
            const result = await project({fileSystem: fakeFileSystem({[path.join(REPO, 'CLAUDE.md')]: kind})});

            expect(result, kind).toMatchObject({state: PROJECTED, ignored: [`CLAUDE.md (${why})`]});
            expect(result.reason, kind).toContain(`CLAUDE.md (${why}) cannot supply instructions`)
        }
    });

    test('an unusable entry does not hide a usable one the harness also reads', async () => {
        const fileSystem = fakeFileSystem({
            [path.join(REPO, 'AGENTS.override.md')]: 'directory',
            [path.join(REPO, 'AGENTS.md')]         : 'file'
        });

        expect(await project({fileSystem, harnessType: 'codex', repoSlug: 'neomjs/neo'}))
            .toMatchObject({state: REPOSITORY_SUPPLIED, reason: 'the checkout carries AGENTS.md'})
    });

    test('only ENOENT means absent: a checkout path that cannot be observed fails loud', async () => {
        const fileSystem = {stat: async () => {throw Object.assign(new Error('EACCES: denied'), {code: 'EACCES'})}};

        await expect(project({fileSystem})).rejects.toThrow('EACCES')
    })
});
