import {test, expect} from '@playwright/test';

import {
    assertAdmissibleStartingState,
    assertOnDevBranch,
    buildReleaseChildEnvironment,
    resolveReleaseVersion,
    resolveTargetRepoRoot,
    SEMVER_PATTERN
} from '../../../../../../ai/scripts/lifecycle/postReleasePreflight.mjs';

/**
 * The split release protocol's fail-closed preflight. While KB upload, full sync,
 * and the archive commit ran inside `publish.mjs`, they inherited its branch check, its
 * `git checkout dev`, and a working tree the release itself had produced. As an independently
 * runnable command those preconditions are protocol fields — each arm here is one field, with the
 * refusal direction proven, since a preflight that cannot refuse is prose.
 */
test.describe('postReleasePreflight (#17239)', () => {
    test.describe('resolveTargetRepoRoot — explicit target authority, never ambient cwd', () => {
        const
            resolvePath     = value => ({brain: '/runtime/brain', engine: '/targets/neo'}[value] ?? value),
            readPackageJson = root => root === '/targets/neo' ? {name: 'neo.mjs'} : {name: 'neo-agent-brain'};

        test('returns the Engine target named by the explicit binding', () => {
            expect(resolveTargetRepoRoot({
                argv: ['--target-repo-root', 'engine'], readPackageJson, resolvePath, runtimeRoot: 'brain'
            })).toBe('/targets/neo')
        });

        test('refuses missing, malformed, and extra arguments — cwd is never a fallback', () => {
            for (const argv of [[], ['engine'], ['--target-repo-root'], ['--target-repo-root', ''],
                ['--target-repo-root', 'engine', 'extra']]) {
                expect(() => resolveTargetRepoRoot({argv, readPackageJson, resolvePath, runtimeRoot: 'brain'}))
                    .toThrow(/required explicitly/)
            }
        });

        test('refuses a target that aliases the Brain runtime root', () => {
            expect(() => resolveTargetRepoRoot({
                argv: ['--target-repo-root', 'brain'], readPackageJson, resolvePath, runtimeRoot: 'brain'
            })).toThrow(/aliases agentosRuntimeRoot/)
        });

        test('refuses a readable checkout whose manifest is not the Engine package', () => {
            expect(() => resolveTargetRepoRoot({
                argv: ['--target-repo-root', '/other'], readPackageJson, resolvePath, runtimeRoot: 'brain'
            })).toThrow(/must identify the Engine package/)
        });

        test('refuses an unreadable target manifest by naming the target', () => {
            expect(() => resolveTargetRepoRoot({
                argv           : ['--target-repo-root', '/missing'],
                readPackageJson: () => { throw new Error('ENOENT') },
                resolvePath,
                runtimeRoot    : 'brain'
            })).toThrow(/cannot read target package\.json at \/missing: ENOENT/)
        })
    });

    test.describe('resolveReleaseVersion — manifest-only, strict semver before any shell string', () => {
        test('returns a valid manifest version', () => {
            expect(resolveReleaseVersion({readPackageJson: () => ({version: '13.2.0'})})).toBe('13.2.0');
            expect(resolveReleaseVersion({readPackageJson: () => ({version: '14.0.0-beta.1'})})).toBe('14.0.0-beta.1');
        });

        test('refuses non-semver, shell-metacharacter, and absent versions by naming the value', () => {
            for (const version of ['13.2', '13.2.0; rm -rf /', 'v13.2.0', undefined, 42]) {
                expect(() => resolveReleaseVersion({readPackageJson: () => ({version})}),
                    `version ${JSON.stringify(version)} must be refused`)
                    .toThrow(/not strict semver/);
            }
        });

        test('the pattern itself rejects command-injection shapes — the flag it replaces accepted them', () => {
            expect(SEMVER_PATTERN.test('13.2.0"; rm -rf "/')).toBe(false);
            expect(SEMVER_PATTERN.test('$(whoami)')).toBe(false);
        });
    });

    test('the uploader child receives the Engine version, never Brain package metadata', () => {
        expect(buildReleaseChildEnvironment({
            baseEnv: {npm_package_name: 'neo-agent-brain', npm_package_version: '0.0.0', TOKEN: 'kept'},
            version: '13.2.0'
        })).toEqual({
            npm_package_name   : 'neo-agent-brain',
            npm_package_version: '13.2.0',
            TOKEN              : 'kept'
        })
    });

    test.describe('assertOnDevBranch — the upload reads the state the release was cut from', () => {
        test('passes on dev', () => {
            expect(() => assertOnDevBranch({getCurrentBranch: () => 'dev'})).not.toThrow();
        });

        test('refuses any other branch, and a null branch reading', () => {
            for (const branch of ['main', 'vega/17239-class-a-severance', '', null]) {
                expect(() => assertOnDevBranch({getCurrentBranch: () => branch}),
                    `branch ${JSON.stringify(branch)} must be refused`)
                    .toThrow(/must run on 'dev'/);
            }
        });
    });

    test.describe('assertAdmissibleStartingState — the release leaves the tree clean, and only a clean tree passes', () => {
        test('a clean tree passes', () => {
            expect(() => assertAdmissibleStartingState({getPorcelainStatus: () => ''})).not.toThrow();
        });

        test('a FAILED status probe is refused — unobservable is not clean', () => {
            // The status runner returns null on failure. Normalizing that to '' would bless a
            // fail-open: unobservable tree state must refuse the upload, not admit it.
            for (const probe of [null, undefined]) {
                expect(() => assertAdmissibleStartingState({getPorcelainStatus: () => probe}),
                    `probe ${String(probe)} must be refused`)
                    .toThrow(/could not establish working-tree truth/);
            }
        });

        test('a release-note deletion is refused by name — publish.mjs keeps the note', () => {
            for (const line of [' D .github/RELEASE_NOTES/v13.2.0.md', ' D resources/content/release-notes/v13.2.0.md']) {
                expect(() => assertAdmissibleStartingState({getPorcelainStatus: () => line}), line)
                    .toThrow(/v13\.2\.0\.md/);
            }
        });

        test('every dirty path is named, so the operator cleans deliberately', () => {
            const run = () => assertAdmissibleStartingState({
                getPorcelainStatus: () => [' M src/Neo.mjs', '?? scratch.mjs'].join('\n')
            });

            expect(run).toThrow(/src\/Neo\.mjs/);
            expect(run).toThrow(/scratch\.mjs/);
        });
    });
});
