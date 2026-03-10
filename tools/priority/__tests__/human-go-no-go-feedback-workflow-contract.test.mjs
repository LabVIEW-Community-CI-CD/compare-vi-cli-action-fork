#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const repoRoot = process.cwd();

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('human go/no-go feedback workflow is workflow_dispatch-only and exposes the decision inputs', () => {
  const workflow = readRepoFile('.github/workflows/human-go-no-go-feedback.yml');

  assert.match(workflow, /^on:\s*\r?\n\s+workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.doesNotMatch(workflow, /^\s*pull_request_target:/m);
  assert.match(workflow, /target_context:/);
  assert.match(workflow, /target_ref:/);
  assert.match(workflow, /decision:\s+\s*description: 'Human disposition for the next iteration'/ms);
  assert.match(workflow, /options:\s+\s+- go\s+\s+- nogo/ms);
  assert.match(workflow, /feedback:/);
  assert.match(workflow, /transcribed_for:/);
});

test('human go/no-go feedback workflow records the checked-in decision artifact and uploads it deterministically', () => {
  const workflow = readRepoFile('.github/workflows/human-go-no-go-feedback.yml');

  assert.match(workflow, /tools\/priority\/human-go-no-go-feedback\.mjs/);
  assert.match(workflow, /--out" "tests\/results\/_agent\/handoff\/human-go-no-go-decision\.json"/);
  assert.match(workflow, /--events-out" "tests\/results\/_agent\/handoff\/human-go-no-go-events\.ndjson"/);
  assert.match(workflow, /name: Upload human go\/no-go decision artifacts\s+if: always\(\)\s+uses: actions\/upload-artifact@v5/ms);
  assert.match(workflow, /name: human-go-no-go-decision/);
});

test('human go/no-go feedback workflow keeps permissions read-only', () => {
  const workflow = readRepoFile('.github/workflows/human-go-no-go-feedback.yml');

  assert.match(workflow, /permissions:\s+contents: read/ms);
  assert.doesNotMatch(workflow, /permissions:\s+write-all/);
  assert.doesNotMatch(workflow, /deployments: write/);
});
