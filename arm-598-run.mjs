import fs from 'node:fs/promises';

const {armSeatWakeRoute, resolveInstanceTuple} = await import('./ai/daemons/wake/armSeatWakeRoute.mjs');

const MANIFEST = '/Users/tobiasuhlig/Library/Application Support/Neo/AgentOS/wake/routes.json';
const MC       = process.env.NEO_MCP_URL || 'http://127.0.0.1:3102/mc/mcp';
const TOKEN    = process.env.GH_TOKEN;

// 1. Prove the tuple resolves BEFORE arming, so a null pid is a named skip and not a wrong route.
const tuple = await resolveInstanceTuple({harness: 'opencode'});
console.log('tuple          :', JSON.stringify(tuple));
if (tuple.skipped) {
    console.log('ARM NOT ATTEMPTED — the resolver declined, as designed.');
    process.exit(0);
}

// 2. Read this seat's OWN subscriptions, supplied by the Memory Core MCP surface with the seat
//    credential. The signingKey is server-minted, so it is passed in as data and never minted,
//    derived or guessed here; this runner prints no part of it.
const SUB_FILE = process.env.SUB_FILE;

async function listSubscriptions() {
    return JSON.parse(await fs.readFile(SUB_FILE, 'utf8'));
}

const subscriptions = await listSubscriptions();
console.log('subscriptions  :', subscriptions.length, '|', subscriptions.map(s => s.agentIdentity).join(', '));

// 3. Arm.
const result = await armSeatWakeRoute({
    harness          : 'opencode',
    manifestPath     : MANIFEST,
    listSubscriptions
});

console.log('arm result     :', JSON.stringify(result, null, 2));
