#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesiredLabels, buildMirrorBody, buildStandingLabelDemotions, parseArgs } from '../mirror-fork-issue.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('mirror-fork-issue parseArgs requires issue and accepts fork remote', () => {
  const parsed = parseArgs([
    'node',
    'mirror-fork-issue.mjs',
    '--issue',
    '966',
    '--fork-remote',
    'personal'
  ]);

  assert.equal(parsed.issue, 966);
  assert.equal(parsed.forkRemote, 'personal');
});

test('buildMirrorBody prefixes the upstream issue pointer exactly once', () => {
  const body = buildMirrorBody({
    url: 'https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action/issues/966',
    body: '## Summary\n- downstream helper\n'
  });

  assert.match(body, /^<!-- upstream-issue-url:/);
  assert.match(body, /## Summary/);
});

test('buildDesiredLabels keeps the fork standing label and reuses only labels present on the fork repo', () => {
  const labels = buildDesiredLabels(['ci', 'standing-priority', 'governance'], ['ci', 'fork-standing-priority']);
  assert.deepEqual(labels, ['ci', 'fork-standing-priority']);
});

test('buildStandingLabelDemotions removes stale open standing labels from non-target fork issues', () => {
  const demotions = buildStandingLabelDemotions(
    [
      { number: 300, state: 'OPEN', labels: [{ name: 'fork-standing-priority' }, { name: 'enhancement' }] },
      { number: 301, state: 'OPEN', labels: ['fork-standing-priority', 'ci', 'standing-priority'] },
      { number: 305, state: 'OPEN', labels: ['fork-standing-priority', 'bug'] },
      { number: 299, state: 'OPEN', labels: ['standing-priority'] },
      { number: 250, state: 'CLOSED', labels: ['fork-standing-priority', 'governance'] }
    ],
    305
  );

  assert.deepEqual(demotions, [
    { number: 300, labels: ['enhancement'] },
    { number: 301, labels: ['ci'] },
    { number: 299, labels: [] }
  ]);
});

test('mirror-fork-issue uses supported gh label list lookup instead of gh label view', () => {
  const source = readFileSync(path.join(repoRoot, 'tools', 'priority', 'mirror-fork-issue.mjs'), 'utf8');

  assert.doesNotMatch(source, /gh',\s*\['label', 'view'/);
  assert.match(source, /runGhJson\(/);
  assert.match(source, /'label', 'list'/);
  assert.match(source, /'--json', 'name'/);
});
