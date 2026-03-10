#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getRepoRoot, run } from './lib/branch-utils.mjs';
import {
  buildCreatePullRequestMutation,
  buildRepositorySlug,
  ensureGhCli,
  extractPullRequestFromMutation,
  loadRepositoryGraphMetadata,
  resolveActiveForkRemoteName,
  runGhGraphql,
  runGhJson,
  tryResolveRemote
} from './lib/remote-utils.mjs';

const DEFAULT_REPORT_PATH = path.join('tests', 'results', '_agent', 'issue', 'develop-sync-report.json');
const SUPPORTED_FORK_REMOTES = new Set(['origin', 'personal']);
const PROTECTED_BRANCH_PATTERNS = [
  /GH013/i,
  /protected branch/i,
  /Changes must be made through a pull request/i,
  /Changes must be made through the merge queue/i,
  /required status checks/i
];
const DEFAULT_MERGE_WAIT_POLL_MS = 15000;
const DEFAULT_MERGE_WAIT_MAX_POLLS = 120;
const DEFAULT_CHECK_WAIT_POLL_MS = 5000;
const DEFAULT_CHECK_WAIT_MAX_POLLS = 36;
const NO_CHECKS_REPORTED_PATTERN = /no checks reported/i;

function printUsage() {
  console.log('Usage: node tools/priority/develop-sync.mjs [options]');
  console.log('');
  console.log('Options:');
  console.log('  --fork-remote <origin|personal|all>  Select which fork remote to sync (default: AGENT_PRIORITY_ACTIVE_FORK_REMOTE or origin).');
  console.log(`  --report <path>                      Write aggregate report JSON (default: ${DEFAULT_REPORT_PATH}).`);
  console.log('  -h, --help                           Show this help text and exit.');
}

export function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const options = {
    forkRemote: null,
    reportPath: DEFAULT_REPORT_PATH,
    help: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--fork-remote' || arg === '--report') {
      const next = args[index + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`Missing value for ${arg}.`);
      }
      index += 1;
      if (arg === '--fork-remote') {
        options.forkRemote = next;
      } else {
        options.reportPath = next;
      }
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

export function resolveForkRemoteTargets(value, env = process.env) {
  const selected = String(value || resolveActiveForkRemoteName(env))
    .trim()
    .toLowerCase();
  if (!selected || selected === 'origin') {
    return ['origin'];
  }
  if (selected === 'all') {
    return ['origin', 'personal'];
  }
  if (!SUPPORTED_FORK_REMOTES.has(selected)) {
    throw new Error(`Unsupported --fork-remote '${value}'. Expected origin, personal, or all.`);
  }
  return [selected];
}

export function buildParityReportPath(repoRoot, remote) {
  return path.join(repoRoot, 'tests', 'results', '_agent', 'issue', `${remote}-upstream-parity.json`);
}

export function buildPwshArgs({ repoRoot, remote, parityReportPath }) {
  return [
    '-NoLogo',
    '-NoProfile',
    '-File',
    path.join(repoRoot, 'tools', 'priority', 'Sync-OriginUpstreamDevelop.ps1'),
    '-HeadRemote',
    remote,
    '-ParityReportPath',
    parityReportPath
  ];
}

function emitCapturedOutput(result, {
  stdoutStream = process.stdout,
  stderrStream = process.stderr
} = {}) {
  const stdoutText = String(result?.stdout ?? '');
  const stderrText = String(result?.stderr ?? '');
  if (stdoutText) {
    stdoutStream.write(stdoutText);
  }
  if (stderrText) {
    stderrStream.write(stderrText);
  }
}

function captureResultText(result) {
  const parts = [];
  const stdoutText = String(result?.stdout ?? '').trim();
  const stderrText = String(result?.stderr ?? '').trim();
  if (stdoutText) {
    parts.push(stdoutText);
  }
  if (stderrText) {
    parts.push(stderrText);
  }
  return parts.join('\n').trim();
}

export function isProtectedBranchSyncFailure(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return false;
  }
  return PROTECTED_BRANCH_PATTERNS.filter((pattern) => pattern.test(normalized)).length >= 2;
}

export function buildProtectedSyncBranchName(remote, branch, headSha) {
  const normalizedRemote = String(remote || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  const normalizedBranch = String(branch || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  const shortSha = String(headSha || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-f0-9]+/g, '')
    .slice(0, 12);
  if (!normalizedRemote || !normalizedBranch || shortSha.length === 0) {
    throw new Error('Unable to build protected sync branch name from the current remote/branch/SHA.');
  }
  return `sync/${normalizedRemote}-${normalizedBranch}-${shortSha}`;
}

export function buildProtectedSyncPrTitle(remote, branch, headSha) {
  const shortSha = String(headSha || '').trim().slice(0, 12);
  return `[sync] ${remote}/${branch} <= upstream/${branch} (${shortSha})`;
}

export function buildProtectedSyncPrBody(remote, branch, headSha) {
  const shortSha = String(headSha || '').trim().slice(0, 12);
  return [
    '## Summary',
    `- Sync \`${remote}/${branch}\` to \`upstream/${branch}\` at \`${shortSha}\`.`,
    '',
    '## Testing',
    `- node tools/npm/run-script.mjs priority:develop:sync -- --fork-remote ${remote}`
  ].join('\n');
}

export function buildMergeSummaryPath(repoRoot, remote) {
  return path.join(repoRoot, 'tests', 'results', '_agent', 'issue', `${remote}-develop-sync-merge-summary.json`);
}

export function resolveForkRepository(repoRoot, remote, tryResolveRemoteFn = tryResolveRemote) {
  const resolved = tryResolveRemoteFn(repoRoot, remote);
  if (!resolved?.parsed) {
    throw new Error(`Unable to resolve git remote '${remote}'.`);
  }
  return resolved.parsed;
}

function runCapturedCommand(command, args, {
  cwd,
  spawnSyncFn = spawnSync,
  allowFailure = false,
  inheritOutput = true
} = {}) {
  const result = spawnSyncFn(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (inheritOutput) {
    emitCapturedOutput(result);
  }
  if (!allowFailure && result.status !== 0) {
    const diagnostic = captureResultText(result) || `exit ${result.status}`;
    throw new Error(`${command} ${args.join(' ')} failed: ${diagnostic}`);
  }
  return result;
}

export function findExistingProtectedSyncPr({
  repoRoot,
  repository,
  syncBranch,
  branch,
  runGhJsonFn = runGhJson
}) {
  const pulls = runGhJsonFn(
    repoRoot,
    [
      'pr',
      'list',
      '--repo',
      buildRepositorySlug(repository),
      '--state',
      'open',
      '--head',
      syncBranch,
      '--base',
      branch,
      '--json',
      'number,url,state,headRefName,baseRefName'
    ]
  );
  return Array.isArray(pulls) && pulls.length > 0 ? pulls[0] : null;
}

export function createProtectedSyncPr({
  repoRoot,
  repository,
  syncBranch,
  branch,
  title,
  body,
  loadRepositoryGraphMetadataFn = loadRepositoryGraphMetadata,
  runGhGraphqlFn = runGhGraphql
}) {
  const metadata = loadRepositoryGraphMetadataFn(repoRoot, repository, { runGhGraphqlFn });
  const request = buildCreatePullRequestMutation({
    repositoryId: metadata.id,
    headRefName: syncBranch,
    baseRefName: branch,
    title,
    body
  });
  const payload = runGhGraphqlFn(repoRoot, request.query, request.variables);
  const pullRequest = extractPullRequestFromMutation(payload);
  if (!pullRequest?.number || !pullRequest?.url) {
    throw new Error(`Protected sync PR creation returned no pull request for ${buildRepositorySlug(repository)}.`);
  }
  console.log(pullRequest.url);
  return pullRequest;
}

export async function waitForProtectedSyncPrMerged({
  repoRoot,
  repository,
  prNumber,
  pollIntervalMs = DEFAULT_MERGE_WAIT_POLL_MS,
  maxPolls = DEFAULT_MERGE_WAIT_MAX_POLLS,
  runGhJsonFn = runGhJson,
  sleepFn = delay
}) {
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    const pr = runGhJsonFn(
      repoRoot,
      [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        buildRepositorySlug(repository),
        '--json',
        'number,url,state,mergedAt,headRefName,baseRefName,mergeStateStatus,mergeable,autoMergeRequest'
      ]
    );
    const state = String(pr?.state ?? '').trim().toUpperCase();
    if (pr?.mergedAt || state === 'MERGED') {
      return pr;
    }
    if (state === 'CLOSED') {
      throw new Error(`Protected sync PR #${prNumber} closed without merge.`);
    }
    if (poll < maxPolls) {
      await sleepFn(pollIntervalMs);
    }
  }

  throw new Error(`Timed out waiting for protected sync PR #${prNumber} to merge.`);
}

function summarizeCheckBuckets(checks = []) {
  const summary = {
    pass: 0,
    fail: 0,
    pending: 0,
    skipping: 0,
    cancel: 0
  };
  for (const check of checks) {
    const bucket = String(check?.bucket ?? '').trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, bucket)) {
      summary[bucket] += 1;
    }
  }
  return summary;
}

export async function waitForProtectedSyncPrChecks({
  repoRoot,
  repository,
  prNumber,
  pollIntervalMs = DEFAULT_CHECK_WAIT_POLL_MS,
  maxPolls = DEFAULT_CHECK_WAIT_MAX_POLLS,
  runGhJsonFn = runGhJson,
  sleepFn = delay
}) {
  const repositorySlug = buildRepositorySlug(repository);
  for (let poll = 1; poll <= maxPolls; poll += 1) {
    let checks = [];
    try {
      checks = runGhJsonFn(
        repoRoot,
        [
          'pr',
          'checks',
          String(prNumber),
          '--json',
          'name,state,workflow,bucket,link',
          '--required',
          '--repo',
          repositorySlug
        ]
      );
    } catch (error) {
      const message = error?.message ?? String(error);
      if (!NO_CHECKS_REPORTED_PATTERN.test(message)) {
        throw error;
      }
    }

    const normalizedChecks = Array.isArray(checks) ? checks : [];
    const summary = summarizeCheckBuckets(normalizedChecks);
    if (normalizedChecks.length > 0) {
      console.log(
        `[priority:develop-sync] pr=${prNumber} required-checks pass=${summary.pass} fail=${summary.fail} pending=${summary.pending} skip=${summary.skipping} cancel=${summary.cancel}`
      );
    }
    if (summary.fail > 0 || summary.cancel > 0) {
      throw new Error(`Protected sync PR #${prNumber} has failing required checks.`);
    }
    if (normalizedChecks.length > 0 && summary.pending === 0) {
      return normalizedChecks;
    }
    if (poll < maxPolls) {
      await sleepFn(pollIntervalMs);
    }
  }

  throw new Error(`Timed out waiting for required checks on protected sync PR #${prNumber}.`);
}

function verifyParityReport(parityReportPath, readFileSyncFn = readFileSync) {
  const payload = JSON.parse(readFileSyncFn(parityReportPath, 'utf8'));
  const tipDiffCount = Number(payload?.tipDiff?.fileCount ?? Number.NaN);
  if (!Number.isInteger(tipDiffCount)) {
    throw new Error(`Parity report at ${parityReportPath} is missing tipDiff.fileCount.`);
  }
  if (tipDiffCount !== 0) {
    throw new Error(`Origin/upstream parity failed: tipDiff.fileCount=${tipDiffCount} (expected 0).`);
  }
  return payload;
}

export async function runProtectedForkSync({
  repoRoot,
  remote,
  branch = 'develop',
  parityReportPath,
  runFn = run,
  ensureGhCliFn = ensureGhCli,
  runGhJsonFn = runGhJson,
  runGhGraphqlFn = runGhGraphql,
  loadRepositoryGraphMetadataFn = loadRepositoryGraphMetadata,
  tryResolveRemoteFn = tryResolveRemote,
  spawnSyncFn = spawnSync,
  readFileSyncFn = readFileSync,
  sleepFn = delay
}) {
  ensureGhCliFn();
  const repository = resolveForkRepository(repoRoot, remote, tryResolveRemoteFn);
  const repositorySlug = buildRepositorySlug(repository);
  const localHead = runFn('git', ['rev-parse', `refs/heads/${branch}`], { cwd: repoRoot });
  const syncBranch = buildProtectedSyncBranchName(remote, branch, localHead);
  const syncRefspec = `refs/heads/${branch}:refs/heads/${syncBranch}`;

  runFn('git', ['push', '--force-with-lease', remote, syncRefspec], { cwd: repoRoot });

  let pullRequest = findExistingProtectedSyncPr({
    repoRoot,
    repository,
    syncBranch,
    branch,
    runGhJsonFn
  });
  let created = false;
  if (!pullRequest) {
    pullRequest = createProtectedSyncPr({
      repoRoot,
      repository,
      syncBranch,
      branch,
      title: buildProtectedSyncPrTitle(remote, branch, localHead),
      body: buildProtectedSyncPrBody(remote, branch, localHead),
      loadRepositoryGraphMetadataFn,
      runGhGraphqlFn
    });
    created = true;
  }

  await waitForProtectedSyncPrChecks({
    repoRoot,
    repository,
    prNumber: pullRequest.number,
    runGhJsonFn,
    sleepFn
  });

  runCapturedCommand(
    'node',
    [
      path.join(repoRoot, 'tools', 'priority', 'merge-sync-pr.mjs'),
      '--pr',
      String(pullRequest.number),
      '--repo',
      repositorySlug,
      '--keep-branch',
      '--summary-path',
      buildMergeSummaryPath(repoRoot, remote)
    ],
    {
      cwd: repoRoot,
      spawnSyncFn
    }
  );

  const mergedPr = await waitForProtectedSyncPrMerged({
    repoRoot,
    repository,
    prNumber: pullRequest.number,
    runGhJsonFn,
    sleepFn
  });

  runFn('git', ['fetch', '--all', '--prune'], { cwd: repoRoot });
  runCapturedCommand(
    'node',
    [
      path.join(repoRoot, 'tools', 'priority', 'report-origin-upstream-parity.mjs'),
      '--base-ref',
      `upstream/${branch}`,
      '--head-ref',
      `${remote}/${branch}`,
      '--output-path',
      parityReportPath
    ],
    {
      cwd: repoRoot,
      spawnSyncFn
    }
  );
  verifyParityReport(parityReportPath, readFileSyncFn);

  return {
    mode: 'protected-pull-request',
    repository: repositorySlug,
    syncBranch,
    pullRequest: {
      number: pullRequest.number,
      url: pullRequest.url,
      created,
      mergedAt: mergedPr?.mergedAt ?? null
    },
    mergeSummaryPath: path.relative(repoRoot, buildMergeSummaryPath(repoRoot, remote)).replace(/\\/g, '/')
  };
}

export async function runDevelopSync({
  repoRoot = getRepoRoot(),
  options = parseArgs(),
  env = process.env,
  spawnSyncFn = spawnSync,
  runFn = run,
  ensureGhCliFn = ensureGhCli,
  runGhJsonFn = runGhJson,
  runGhGraphqlFn = runGhGraphql,
  loadRepositoryGraphMetadataFn = loadRepositoryGraphMetadata,
  tryResolveRemoteFn = tryResolveRemote,
  mkdirSyncFn = mkdirSync,
  writeFileSyncFn = writeFileSync,
  readFileSyncFn = readFileSync,
  sleepFn = delay
} = {}) {
  const remotes = resolveForkRemoteTargets(options.forkRemote, env);
  const actions = [];

  for (const remote of remotes) {
    const parityReportPath = buildParityReportPath(repoRoot, remote);
    const args = buildPwshArgs({ repoRoot, remote, parityReportPath });
    const result = runCapturedCommand('pwsh', args, {
      cwd: repoRoot,
      spawnSyncFn,
      allowFailure: true
    });
    let mode = 'direct';
    let protectedSync = null;
    if (result.status !== 0) {
      const failureText = captureResultText(result);
      if (!isProtectedBranchSyncFailure(failureText)) {
        throw new Error(`priority:develop:sync failed for ${remote}. ${failureText}`.trim());
      }
      protectedSync = await runProtectedForkSync({
        repoRoot,
        remote,
        branch: 'develop',
        parityReportPath,
        runFn,
        ensureGhCliFn,
        runGhJsonFn,
        runGhGraphqlFn,
        loadRepositoryGraphMetadataFn,
        tryResolveRemoteFn,
        spawnSyncFn,
        readFileSyncFn,
        sleepFn
      });
      mode = protectedSync.mode;
    }
    actions.push({
      remote,
      mode,
      parityReportPath: path.relative(repoRoot, parityReportPath).replace(/\\/g, '/'),
      protectedSync
    });
  }

  const reportPath = path.isAbsolute(options.reportPath) ? options.reportPath : path.join(repoRoot, options.reportPath);
  mkdirSyncFn(path.dirname(reportPath), { recursive: true });
  const report = {
    schema: 'priority/develop-sync-report@v1',
    generatedAt: new Date().toISOString(),
    repositoryRoot: repoRoot,
    remotes,
    actions
  };
  writeFileSyncFn(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report, reportPath };
}

export async function main(argv = process.argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return 0;
  }
  const { reportPath, report } = await runDevelopSync({ options });
  console.log(`[priority:develop-sync] report=${reportPath} remotes=${report.remotes.join(',')}`);
  return 0;
}

const modulePath = path.resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === modulePath) {
  main(process.argv)
    .then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
    })
    .catch((error) => {
      console.error(`[priority:develop-sync] ${error.message}`);
      process.exitCode = 1;
    });
}
