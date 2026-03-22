#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const repoRoot = process.cwd();

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('CLI lints always ensures a local actionlint binary before running it', () => {
  const workflow = readRepoFile('.github/actions/cli-lints/action.yml');
  assert.match(workflow, /name: Ensure actionlint/);
  assert.match(workflow, /if \[ ! -x \.\/bin\/actionlint \]; then/);
  assert.match(workflow, /chmod \+x \.\/bin\/actionlint/);
  assert.match(workflow, /\.\/bin\/actionlint -version/);
  assert.doesNotMatch(workflow, /hashFiles\('\.\/bin\/actionlint'\)/);
});
