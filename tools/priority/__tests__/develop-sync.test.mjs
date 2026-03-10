#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  resolveForkRemoteTargets,
  buildParityReportPath,
  buildPwshArgs,
  buildProtectedSyncBranchName,
  isProtectedBranchSyncFailure,
  runDevelopSync
} from '../develop-sync.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('develop-sync parseArgs accepts fork-remote and report overrides', () => {
  const parsed = parseArgs([
    'node',
    'develop-sync.mjs',
    '--fork-remote',
    'all',
    '--report',
    'custom/report.json'
  ]);

  assert.equal(parsed.forkRemote, 'all');
  assert.equal(parsed.reportPath, 'custom/report.json');
});

test('resolveForkRemoteTargets defaults to origin and supports all lanes', () => {
  assert.deepEqual(resolveForkRemoteTargets(null, {}), ['origin']);
  assert.deepEqual(resolveForkRemoteTargets('personal', {}), ['personal']);
  assert.deepEqual(resolveForkRemoteTargets('all', {}), ['origin', 'personal']);
});

test('buildPwshArgs pins the selected remote and parity path', () => {
  const repoRoot = '/tmp/repo';
  const parityReportPath = buildParityReportPath(repoRoot, 'personal');
  const args = buildPwshArgs({
    repoRoot,
    remote: 'personal',
    parityReportPath
  });

  assert.ok(args.includes('-HeadRemote'));
  assert.ok(args.includes('personal'));
  assert.ok(args.includes(parityReportPath));
});

test('protected branch sync failure detection only triggers for policy-blocked pushes', () => {
  assert.equal(
    isProtectedBranchSyncFailure(
      'remote: error: GH013: Repository rule violations found.\nremote: Changes must be made through a pull request.'
    ),
    true
  );
  assert.equal(
    isProtectedBranchSyncFailure('fatal: not possible to fast-forward, aborting.'),
    false
  );
});

test('protected develop sync branch names are deterministic per remote/head sha', () => {
  assert.equal(
    buildProtectedSyncBranchName('origin', 'develop', 'ABCDEF0123456789'),
    'sync/origin-develop-abcdef012345'
  );
});

test('develop-sync falls back to a protected-fork PR lane when direct push is policy blocked', async () => {
  const spawnCalls = [];
  const runCalls = [];
  const ghJsonCalls = [];
  const ghGraphqlCalls = [];
  let mergePolls = 0;
  const writes = new Map();

  const result = await runDevelopSync({
    repoRoot: '/tmp/repo',
    options: {
      forkRemote: 'origin',
      reportPath: 'tests/results/_agent/issue/develop-sync-report.json'
    },
    env: {},
    spawnSyncFn: (command, args) => {
      spawnCalls.push({ command, args });
      if (command === 'pwsh' && args.some((entry) => entry.endsWith('Sync-OriginUpstreamDevelop.ps1'))) {
        return {
          status: 1,
          stdout: '',
          stderr: 'remote: error: GH013: Repository rule violations found.\nremote: Changes must be made through a pull request.\nremote: Changes must be made through the merge queue.'
        };
      }
      if (command === 'pwsh' && args.some((entry) => entry.endsWith('Watch-PRChecksSafe.ps1'))) {
        return { status: 0, stdout: 'All tracked checks completed successfully.\n', stderr: '' };
      }
      if (command === 'node' && args.some((entry) => entry.endsWith('merge-sync-pr.mjs'))) {
        return { status: 0, stdout: '[priority:merge-sync] final mode=auto reason=merge-queue-branch-develop\n', stderr: '' };
      }
      if (command === 'node' && args.some((entry) => entry.endsWith('report-origin-upstream-parity.mjs'))) {
        return { status: 0, stdout: '', stderr: '' };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
    runFn: (command, args) => {
      runCalls.push({ command, args });
      if (command !== 'git') {
        throw new Error(`Unexpected run command ${command}`);
      }
      const serialized = args.join(' ');
      if (serialized === 'rev-parse refs/heads/develop') {
        return '0123456789abcdef0123456789abcdef01234567';
      }
      if (serialized === 'push --force-with-lease origin refs/heads/develop:refs/heads/sync/origin-develop-0123456789ab') {
        return '';
      }
      if (serialized === 'fetch --all --prune') {
        return '';
      }
      throw new Error(`Unexpected git run: ${serialized}`);
    },
    ensureGhCliFn: () => {},
    tryResolveRemoteFn: (_repoRoot, remote) => ({
      parsed: {
        owner: 'LabVIEW-Community-CI-CD',
        repo: 'compare-vi-cli-action-fork',
        remoteName: remote
      }
    }),
    runGhJsonFn: (_repoRoot, args) => {
      ghJsonCalls.push(args);
      if (args[0] === 'pr' && args[1] === 'list') {
        return [];
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        mergePolls += 1;
        return {
          number: 88,
          url: 'https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action-fork/pull/88',
          state: mergePolls >= 2 ? 'MERGED' : 'OPEN',
          mergedAt: mergePolls >= 2 ? '2026-03-10T02:40:00Z' : null,
          headRefName: 'sync/origin-develop-0123456789ab',
          baseRefName: 'develop',
          mergeStateStatus: 'CLEAN',
          mergeable: 'MERGEABLE'
        };
      }
      throw new Error(`Unexpected gh json call: ${args.join(' ')}`);
    },
    loadRepositoryGraphMetadataFn: () => ({
      id: 'R_repo',
      nameWithOwner: 'LabVIEW-Community-CI-CD/compare-vi-cli-action-fork'
    }),
    runGhGraphqlFn: (_repoRoot, query, variables) => {
      ghGraphqlCalls.push({ query, variables });
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: 88,
              url: 'https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action-fork/pull/88'
            }
          }
        }
      };
    },
    mkdirSyncFn: () => {},
    writeFileSyncFn: (filePath, contents) => {
      writes.set(filePath, contents);
    },
    readFileSyncFn: (filePath) => {
      if (filePath.endsWith('origin-upstream-parity.json')) {
        return JSON.stringify({
          tipDiff: {
            fileCount: 0
          }
        });
      }
      if (writes.has(filePath)) {
        return writes.get(filePath);
      }
      throw new Error(`Unexpected read: ${filePath}`);
    },
    sleepFn: async () => {}
  });

  assert.equal(result.report.actions.length, 1);
  assert.equal(result.report.actions[0].mode, 'protected-pull-request');
  assert.equal(
    result.report.actions[0].protectedSync.pullRequest.url,
    'https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action-fork/pull/88'
  );
  assert.ok(
    spawnCalls.some(
      (call) => call.command === 'pwsh' && call.args.some((entry) => entry.endsWith('Watch-PRChecksSafe.ps1'))
    ),
    'expected safe PR watcher invocation'
  );
  assert.ok(
    spawnCalls.some(
      (call) => call.command === 'node' && call.args.some((entry) => entry.endsWith('merge-sync-pr.mjs'))
    ),
    'expected merge-sync helper invocation'
  );
  assert.ok(
    ghGraphqlCalls.some((call) => call.variables.headRefName === 'sync/origin-develop-0123456789ab'),
    'expected protected sync PR creation'
  );
});

test('Sync-OriginUpstreamDevelop forwards the requested parity report path to the parity reporter', () => {
  const scriptPath = path.join(repoRoot, 'tools', 'priority', 'Sync-OriginUpstreamDevelop.ps1');
  const source = readFileSync(scriptPath, 'utf8');

  assert.match(source, /report-origin-upstream-parity\.mjs'/);
  assert.match(source, /'--output-path'/);
  assert.match(source, /\$parityReportPath/);
  assert.match(source, /'rev-parse', '--git-dir'/);
  assert.match(source, /\$lockPath = Join-Path \$gitDir \$lockName/);
});
