import fs                         from 'node:fs';
import path                       from 'node:path';
import {CORPUS_PROJECTION_ORIGIN} from './corpusProjectionContract.mjs';

/**
 * @module ai/services/graph/contentOrigins
 * @summary The corpus's own origin catalog, read one way by every consumer — the fleet activity feed and
 * the resolved-PR bird view — so "a known origin" means the same set wherever a repository is named.
 */

/**
 * @summary Resolves the conversation origins a content root carries.
 *
 * The layout is read from the tree and the corpus's own index, never guessed from directory names:
 * a root with `issues/` directly under it is the pre-split single-origin tree — the engine's
 * `resources/content`, one origin's subtree of a corpus checkout, or the orchestrator's materialized
 * root (which keeps the corpus index verbatim while materializing one origin without its prefix,
 * so the directory decides, not the index). Otherwise a root whose `_index.json` rows carry
 * `repoSlug` is the multi-origin corpus, `<root>/<repoSlug>/{issues,pulls}` per distinct slug with
 * the Graph's origin first. An origin the index names but the tree lacks is still returned: its
 * read degrades by name in the snapshot rather than vanishing silently.
 * @param {String} contentRoot Absolute content root (the `fleet.contentRoot` leaf's value).
 * @returns {Array<{repoSlug: String, issuesDir: String, pullsDir: String}>}
 */
export function resolveContentOrigins(contentRoot) {
    const legacy = [{
        repoSlug : CORPUS_PROJECTION_ORIGIN,
        issuesDir: path.join(contentRoot, 'issues'),
        pullsDir : path.join(contentRoot, 'pulls')
    }];

    if (isDirectory(legacy[0].issuesDir)) {
        return legacy
    }

    let rows;

    try {
        rows = JSON.parse(fs.readFileSync(path.join(contentRoot, '_index.json'), 'utf8'))
    } catch {
        return legacy
    }

    const slugs = [...new Set(
        (Array.isArray(rows) ? rows : [])
            .map(row => typeof row?.repoSlug === 'string' ? row.repoSlug.trim() : '')
            .filter(Boolean)
    )].sort((a, b) => a === CORPUS_PROJECTION_ORIGIN ? -1 : b === CORPUS_PROJECTION_ORIGIN ? 1 : a.localeCompare(b));

    return slugs.length === 0 ? legacy : slugs.map(repoSlug => ({
        repoSlug,
        issuesDir: path.join(contentRoot, repoSlug, 'issues'),
        pullsDir : path.join(contentRoot, repoSlug, 'pulls')
    }))
}

/**
 * @summary Whether `dir` is an existing directory; any read error reads as "no".
 * @param {String} dir
 * @returns {Boolean}
 */
function isDirectory(dir) {
    try {
        return fs.statSync(dir).isDirectory()
    } catch {
        return false
    }
}
