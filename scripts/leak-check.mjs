#!/usr/bin/env node
/* Leak check for the public repository.
 *
 * The maintainer's personal material lives in workshop/, a separate private
 * repository inside this checkout (ignored here). .gitignore keeps a plain
 * `git add .` away from it, but not `git add -f`, not a gitlink, and not a
 * real path or name typed into a comment. This script is the second line and
 * runs from the hooks in scripts/git-hooks/:
 *
 *   --staged            pre-commit: staged paths, gitlinks, added lines, the
 *                       author and committer identity git is about to use
 *   --message <file>    commit-msg: the commit message
 *   --push <remote>     pre-push: every commit about to be pushed (refs on
 *                       stdin), including its author and committer
 *   --all               manual: every tracked path and text file of the index
 *
 * Path rules are built in. Content rules come from workshop/leak-patterns.txt
 * (one regular expression per line, case-insensitive); without a workshop the
 * check runs with path rules only. Images are not inspected. Any failure to
 * run git blocks as well: a check that cannot look must not wave through.
 *
 * Exit codes: 0 clean, 1 findings, 2 the check itself failed. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Paths that belong to the workshop or its links (mirrors .gitignore). */
export const FORBIDDEN_PATHS = [
  /^workshop(\/|$)/,
  /^CLAUDE(\.local)?\.md$/,
  /^\.claude\//,
  /^\.handoffs(\/|$)/,
  /^fundus(\/|$)/,
  /^scratchpad\//,
  /^\.worktrees\//,
  /^\.superpowers\//,
  /^config\/colony\.local\.json$/,
];

const ZERO = /^0+$/;

/** Parses the pattern file. Throws with the line number on a broken regex. */
export function parsePatterns(text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    try {
      out.push(new RegExp(line, 'i'));
    } catch (err) {
      throw new Error(`leak-patterns.txt line ${i + 1}: ${err.message}`);
    }
  });
  return out;
}

/** Reason why a path must not be in the public repository, or null. */
export function checkPath(path) {
  const rule = FORBIDDEN_PATHS.find((re) => re.test(path));
  return rule ? `path belongs to the workshop (${rule.source})` : null;
}

/** Lines of `text` that match a pattern, labelled for the report. */
export function scanText(label, text, patterns) {
  const findings = [];
  text.split('\n').forEach((line, i) => {
    const hit = patterns.find((re) => re.test(line));
    if (hit) findings.push({ where: `${label}:${i + 1}`, reason: `matches /${hit.source}/`, text: line });
  });
  return findings;
}

/** Added lines of a unified diff (any context size) that match a pattern. */
export function scanDiff(diff, patterns, label = '') {
  const findings = [];
  let file = null;
  let lineNo = 0;
  let header = false; // inside a file header; an added line "++ x" also starts with "+++ "
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) {
      header = true;
      file = null;
      continue;
    }
    if (header && line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) header = false;
    if (header) continue;
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (file === null) continue;
    if (line.startsWith('+')) {
      const text = line.slice(1);
      const hit = patterns.find((re) => re.test(text));
      if (hit) findings.push({ where: `${label}${file}:${lineNo}`, reason: `matches /${hit.source}/`, text });
      lineNo++;
    } else if (line.startsWith(' ')) {
      lineNo++;
    }
  }
  return findings;
}

/** Entries of `git diff --raw -z`: forbidden paths and gitlinks. */
export function scanRaw(raw, label = '') {
  const findings = [];
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i];
    if (!head.startsWith(':')) continue;
    const [, newMode, , , status] = head.slice(1).split(' ');
    // Renames and copies carry two paths; the second is the new one.
    const paths = /^[RC]/.test(status) ? [parts[i + 1], parts[i + 2]] : [parts[i + 1]];
    i += paths.length;
    if (status === 'D') continue;
    const path = paths[paths.length - 1];
    const reason = checkPath(path);
    if (reason) findings.push({ where: `${label}${path}`, reason });
    if (newMode === '160000') findings.push({ where: `${label}${path}`, reason: 'gitlink (embedded repository)' });
  }
  return findings;
}

function git(root, args, input) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, input });
}

function loadPatterns(root) {
  const file = join(root, 'workshop', 'leak-patterns.txt');
  if (existsSync(file)) return parsePatterns(readFileSync(file, 'utf8'));
  if (existsSync(join(root, 'workshop'))) {
    console.error('leak-check: workshop/ has no leak-patterns.txt, content rules are off');
  }
  return [];
}

function checkCommit(root, sha, patterns) {
  const label = `${sha.slice(0, 7)} `;
  const common = ['--no-commit-id', '-r', '--root', '--diff-merges=first-parent'];
  return [
    ...scanRaw(git(root, ['diff-tree', ...common, '--raw', '-z', '--no-abbrev', sha]), label),
    ...scanDiff(git(root, ['diff-tree', ...common, '-p', '-U0', '--no-color', '--no-ext-diff', sha]), patterns, label),
    ...scanText(`${label}message`, git(root, ['log', '-1', '--format=%B', sha]), patterns),
    // Author and committer end up in every public commit, e.g. a work
    // address from the global git config.
    ...scanText(`${label}identity`, git(root, ['log', '-1', '--format=%an <%ae>%n%cn <%ce>', sha]), patterns),
  ];
}

function commitsToPush(root, remote, stdin) {
  const shas = new Set();
  for (const line of stdin.split('\n')) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // deleting a remote ref
    let list;
    try {
      list = ZERO.test(remoteSha) ? null : git(root, ['rev-list', `${remoteSha}..${localSha}`]);
    } catch {
      list = null; // remote tip unknown locally
    }
    list ??= git(root, ['rev-list', localSha, '--not', `--remotes=${remote}`]);
    for (const sha of list.split('\n').filter(Boolean)) shas.add(sha);
  }
  return [...shas];
}

function scanIndex(root, patterns) {
  const findings = [];
  const entries = git(root, ['ls-files', '-s', '-z']).split('\0').filter(Boolean);
  for (const entry of entries) {
    const [meta, path] = entry.split('\t');
    const reason = checkPath(path);
    if (reason) findings.push({ where: path, reason });
    if (meta.startsWith('160000')) {
      findings.push({ where: path, reason: 'gitlink (embedded repository)' });
      continue;
    }
    const full = join(root, path);
    if (!patterns.length || !existsSync(full)) continue;
    const buf = readFileSync(full);
    if (buf.includes(0)) continue; // binary
    findings.push(...scanText(path, buf.toString('utf8'), patterns));
  }
  return findings;
}

function report(findings, what) {
  if (!findings.length) return 0;
  console.error(`leak-check: ${findings.length} finding(s) in ${what}. Nothing personal goes into this repository.`);
  for (const f of findings) {
    console.error(`  ${f.where}: ${f.reason}${f.text ? `\n    ${f.text.trim().slice(0, 160)}` : ''}`);
  }
  console.error('Fix the content (or move it to workshop/). Do not bypass with --no-verify.');
  return 1;
}

function main(argv) {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const patterns = loadPatterns(root);
  const mode = argv[0];
  if (mode === '--staged') {
    const findings = [
      ...scanRaw(git(root, ['diff', '--cached', '--raw', '-z', '--no-abbrev'])),
      ...scanDiff(git(root, ['diff', '--cached', '-U0', '--no-color', '--no-ext-diff']), patterns),
      ...scanText('identity', git(root, ['var', 'GIT_AUTHOR_IDENT']) + git(root, ['var', 'GIT_COMMITTER_IDENT']), patterns),
    ];
    return report(findings, 'the staged changes');
  }
  if (mode === '--message') {
    const text = readFileSync(resolve(argv[1]), 'utf8')
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .join('\n');
    return report(scanText('commit message', text, patterns), 'the commit message');
  }
  if (mode === '--push') {
    const stdin = readFileSync(0, 'utf8');
    const shas = commitsToPush(root, argv[1] ?? 'origin', stdin);
    const findings = shas.flatMap((sha) => checkCommit(root, sha, patterns));
    return report(findings, `${shas.length} commit(s) to push`);
  }
  if (mode === '--all') {
    return report(scanIndex(root, patterns), 'the tracked files');
  }
  console.error('usage: leak-check.mjs --staged | --message <file> | --push <remote> | --all');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`leak-check: could not run (${err.message.split('\n')[0]}), blocking to be safe`);
    process.exitCode = 2;
  }
}
