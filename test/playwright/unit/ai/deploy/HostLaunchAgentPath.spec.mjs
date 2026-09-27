import {test, expect} from '@playwright/test';
import fs             from 'fs';
import path           from 'path';

const
    repoRoot  = process.cwd(),
    runbook   = 'ai/scripts/lifecycle/local-agent-os/README.md',
    templates = ['deploy/host/com.neomjs.agent-os-wake.plist', 'deploy/host/com.neomjs.agent-os-host-edge.plist'];

/**
 * @summary Reads the `PATH` a LaunchAgent template declares in its `EnvironmentVariables` dict.
 * @param {String} file Repo-relative template path
 * @returns {String|undefined}
 */
function declaredPath(file) {
    const env = fs.readFileSync(path.join(repoRoot, file), 'utf8')
        .match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? '';

    return env.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)?.[1]
}

test.describe('the host LaunchAgents run on a declared PATH, never the installing shell\'s', () => {
    test('both templates declare one PATH with no placeholder and nothing under a home directory', () => {
        const [wake, hostEdge] = templates.map(declaredPath);

        expect(wake, 'the wake template declares PATH').toBeTruthy();
        expect(hostEdge, 'both agents run on the same PATH').toBe(wake);
        expect(wake).not.toContain('__');
        expect(wake.split(':')).toEqual(expect.arrayContaining(['/usr/bin', '/bin', '/usr/sbin']));
        expect(wake.split(':').filter(dir => dir.startsWith('/Users/') || dir.startsWith('~'))).toEqual([])
    });

    test('the runbook never copies the installing shell\'s PATH, and checks each installed one', () => {
        const source = fs.readFileSync(path.join(repoRoot, runbook), 'utf8');

        expect(source).not.toContain('EnvironmentVariables.PATH -string "${PATH}"');
        expect(source).toContain('assert_daemon_path "${NEO_WAKE_PLIST}"');
        expect(source).toContain('assert_daemon_path "${NEO_HOST_EDGE_PLIST}"')
    })
});
