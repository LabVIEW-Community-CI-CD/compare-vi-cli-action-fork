import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  DEFAULT_ARTIFACT_NAME,
  buildHumanGoNoGoPayload,
  parseArgs,
  runHumanGoNoGoFeedback,
} from '../human-go-no-go-feedback.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('parseArgs accepts required and optional inputs', () => {
  const parsed = parseArgs([
    'node',
    'human-go-no-go-feedback.mjs',
    '--repo',
    'LabVIEW-Community-CI-CD/compare-vi-cli-action',
    '--target-context',
    'issue/origin-982-human-go-no-go-workflow',
    '--target-ref',
    'issue/origin-982-human-go-no-go-workflow',
    '--decision',
    'nogo',
    '--feedback',
    'Needs another pass.',
    '--issue-url',
    'https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action/issues/982',
    '--pull-request-url',
    'https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action/pull/999',
    '--target-run-id',
    '22890012345',
    '--evidence-url',
    'https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action/actions/runs/22890012345',
    '--recorded-by',
    'svelderrainruiz',
    '--transcribed-for',
    'human-operator',
    '--next-action',
    'pause',
    '--next-seed',
    'Wait for review.',
  ]);

  assert.equal(parsed.repo, 'LabVIEW-Community-CI-CD/compare-vi-cli-action');
  assert.equal(parsed.decision, 'nogo');
  assert.equal(parsed.transcribedFor, 'human-operator');
  assert.equal(parsed.nextAction, 'pause');
});

test('buildHumanGoNoGoPayload derives run URL and next action from environment', () => {
  const payload = buildHumanGoNoGoPayload(
    {
      repo: 'LabVIEW-Community-CI-CD/compare-vi-cli-action',
      targetContext: 'issue/origin-982-human-go-no-go-workflow',
      targetRef: 'issue/origin-982-human-go-no-go-workflow',
      decision: 'go',
      feedback: 'Proceed to implementation.',
      issueUrl: null,
      pullRequestUrl: null,
      targetRunId: null,
      runUrl: null,
      evidenceUrl: null,
      recordedBy: null,
      transcribedFor: null,
      nextAction: null,
      nextSeed: null,
    },
    {
      GITHUB_REPOSITORY: 'LabVIEW-Community-CI-CD/compare-vi-cli-action',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '22890012345',
      GITHUB_ACTOR: 'svelderrainruiz',
    },
    new Date('2026-03-10T02:40:00Z'),
  );

  assert.equal(payload.links.runUrl, 'https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action/actions/runs/22890012345');
  assert.equal(payload.decision.recordedBy, 'svelderrainruiz');
  assert.equal(payload.nextIteration.recommendedAction, 'continue');
  assert.equal(payload.artifacts.artifactName, DEFAULT_ARTIFACT_NAME);
});

test('runHumanGoNoGoFeedback writes schema-valid decision and event artifacts', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'human-go-no-go-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const outPath = path.join(tmpDir, 'human-go-no-go-decision.json');
  const eventsPath = path.join(tmpDir, 'human-go-no-go-events.ndjson');
  const summaryPath = path.join(tmpDir, 'step-summary.md');

  const result = await runHumanGoNoGoFeedback({
    argv: [
      'node',
      'human-go-no-go-feedback.mjs',
      '--repo',
      'LabVIEW-Community-CI-CD/compare-vi-cli-action',
      '--target-context',
      'issue/origin-982-human-go-no-go-workflow',
      '--target-ref',
      'issue/origin-982-human-go-no-go-workflow',
      '--decision',
      'nogo',
      '--feedback',
      'Tighten workflow permissions before promotion.',
      '--issue-url',
      'https://github.com/LabVIEW-Community-CI-CD/compare-vi-cli-action/issues/982',
      '--out',
      outPath,
      '--events-out',
      eventsPath,
      '--step-summary',
      summaryPath,
    ],
    environment: {
      GITHUB_REPOSITORY: 'LabVIEW-Community-CI-CD/compare-vi-cli-action',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_RUN_ID: '22890012345',
      GITHUB_ACTOR: 'svelderrainruiz',
    },
    now: new Date('2026-03-10T02:45:00Z'),
  });

  assert.equal(result.exitCode, 0);

  const payload = JSON.parse(await readFile(outPath, 'utf8'));
  const events = (await readFile(eventsPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const summary = await readFile(summaryPath, 'utf8');

  const schemaPath = path.join(repoRoot, 'docs', 'schemas', 'human-go-no-go-decision-v1.schema.json');
  if (fs.existsSync(schemaPath)) {
    const materializedSchema = JSON.parse(await readFile(schemaPath, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(materializedSchema);
    assert.equal(validate(payload), true, JSON.stringify(validate.errors, null, 2));
  } else {
    assert.equal(payload.schema, 'human-go-no-go-decision@v1');
  }
  assert.equal(payload.decision.value, 'nogo');
  assert.equal(payload.nextIteration.recommendedAction, 'revise');
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, 'nogo');
  assert.match(summary, /Human Go\/No-Go Feedback/);
});
