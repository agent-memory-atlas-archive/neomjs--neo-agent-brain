import {test, expect} from '@playwright/test';
import path           from 'path';
import {generate}     from 'neo-agent-skills/agents-md';
import {
    HOME_INSTRUCTION_FILES,
    SEAT_INSTRUCTION_STATES,
    projectSeatInstructions
} from '../../../../../../ai/services/fleet/projectSeatInstructions.mjs';

// Reads the checkout through an injected `lstat` and writes nothing, so every case runs on a fake filesystem.

const
    {NOT_APPLICABLE, PROJECTED, REPOSITORY_SUPPLIED} = SEAT_INSTRUCTION_STATES,
    HOME = path.resolve('/srv/agents/neo-seat/harness/claude-code'),
    REPO = path.resolve('/srv/agents/neo-seat/neomjs/neo-agent-brain'),
    GATE = /No AiConfig work without reading ADR-0019/;

function fakeFileSystem(present = []) {
    const paths = new Set(present);

    return {
        lstat: async filePath => {
            if (paths.has(filePath)) return {};
            throw Object.assign(new Error(`ENOENT: ${filePath}`), {code: 'ENOENT'})
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

    test('a repository the Skills source does not declare is not-applicable, never a failed start', async () => {
        for (const repoSlug of ['acme/neo', 'neomjs/not-declared', 'neo', null]) {
            expect(await project({repoSlug}), String(repoSlug)).toMatchObject({state: NOT_APPLICABLE})
        }
    });

    test('a harness with no witnessed user-scope slot is not-applicable', async () => {
        for (const harnessType of ['claude-desktop', 'kimi-code', 'opencode']) {
            expect(HOME_INSTRUCTION_FILES[harnessType]).toBeUndefined();
            expect(await project({harnessType}), harnessType).toMatchObject({state: NOT_APPLICABLE})
        }
    });

    test('only ENOENT means absent: an unreadable checkout path fails loud', async () => {
        const fileSystem = {lstat: async () => {throw Object.assign(new Error('EACCES: denied'), {code: 'EACCES'})}};

        await expect(project({fileSystem})).rejects.toThrow('EACCES')
    })
});
