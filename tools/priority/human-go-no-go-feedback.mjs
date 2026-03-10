#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export const HUMAN_GO_NO_GO_DECISION_SCHEMA = 'human-go-no-go-decision@v1';
export const DEFAULT_WORKFLOW_NAME = 'Human Go/No-Go Feedback';
export const DEFAULT_WORKFLOW_PATH = '.github/workflows/human-go-no-go-feedback.yml';
export const DEFAULT_ARTIFACT_NAME = 'human-go-no-go-decision';
export const DEFAULT_OUT_PATH = path.join(
  'tests',
  'results',
  '_agent',
  'handoff',
  'human-go-no-go-decision.json',
);
export const DEFAULT_EVENTS_OUT_PATH = path.join(
  'tests',
  'results',
  '_agent',
  'handoff',
  'human-go-no-go-events.ndjson',
);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_SCHEMA_PATH = path.join(
  repoRoot,
  'docs',
  'schemas',
  'human-go-no-go-decision-v1.schema.json',
);

function printUsage() {
  const lines = [
    'Usage: node tools/priority/human-go-no-go-feedback.mjs [options]',
    '',
    'Write a machine-readable human go/no-go decision artifact for later agent reuse.',
    '',
    'Options:',
    '  --repo <owner/repo>            Repository slug (default: GITHUB_REPOSITORY).',
    '  --target-context <id>          Required target context identifier.',
    '  --target-ref <ref>             Required target ref or branch name.',
    '  --decision <go|nogo>          Required human decision.',
    '  --feedback <text>             Required free-form feedback text.',
    '  --issue-url <url>             Optional related issue URL.',
    '  --pull-request-url <url>      Optional related pull request URL.',
    '  --target-run-id <id>          Optional related workflow run id.',
    '  --run-url <url>               Optional workflow run URL (default: derive from GitHub env).',
    '  --evidence-url <url>          Optional supporting evidence URL.',
    '  --recorded-by <identity>      Optional recorder identity (default: GITHUB_ACTOR).',
    '  --transcribed-for <identity>  Optional human identity when transcribing another operator.',
    '  --next-action <value>         Optional next action override (continue|revise|pause).',
    '  --next-seed <text>            Optional next-iteration seed override.',
    `  --out <path>                  Decision JSON output path (default: ${DEFAULT_OUT_PATH}).`,
    `  --events-out <path>           NDJSON events path (default: ${DEFAULT_EVENTS_OUT_PATH}).`,
    '  --step-summary <path>         Optional GitHub step summary path.',
    '  -h, --help                    Show this message and exit.',
  ];

  for (const line of lines) {
    console.log(line);
  }
}

function normalizeText(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRepositorySlug(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  const segments = normalized.split('/').map((segment) => segment.trim());
  if (segments.length !== 2 || segments.some((segment) => !segment)) {
    throw new Error(`Invalid repository slug '${value}'. Expected <owner>/<repo>.`);
  }
  return `${segments[0]}/${segments[1]}`;
}

function normalizeUrl(value, label) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid ${label} URL '${value}'.`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${label} URL '${value}'. Expected http:// or https://.`);
  }

  return parsed.toString();
}

function normalizeDecision(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized !== 'go' && normalized !== 'nogo') {
    throw new Error(`Invalid decision '${value}'. Expected go or nogo.`);
  }
  return normalized;
}

function normalizeNextAction(value) {
  const normalized = normalizeText(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!['continue', 'revise', 'pause'].includes(normalized)) {
    throw new Error(`Invalid next action '${value}'. Expected continue, revise, or pause.`);
  }
  return normalized;
}

function deriveRunUrl(repository, environment = process.env) {
  const serverUrl = normalizeText(environment.GITHUB_SERVER_URL);
  const runId = normalizeText(environment.GITHUB_RUN_ID);
  if (!serverUrl || !runId || !repository) {
    return null;
  }
  return `${serverUrl.replace(/\/+$/, '')}/${repository}/actions/runs/${runId}`;
}

function deriveRecordedBy(explicit, environment = process.env) {
  return normalizeText(explicit) ?? normalizeText(environment.GITHUB_ACTOR);
}

function defaultNextActionForDecision(decision) {
  return decision === 'go' ? 'continue' : 'revise';
}

function readSchema(schemaPath = DEFAULT_SCHEMA_PATH) {
  const resolved = path.resolve(schemaPath);
  if (!existsSync(resolved)) {
    return null;
  }
  return JSON.parse(readFileSync(resolved, 'utf8'));
}

function validatePayloadAgainstSchema(payload, schema = readSchema()) {
  // #982 can stack ahead of #981 on a fork lane, so runtime validation stays
  // opportunistic until the checked-in contract schema is present on the branch.
  if (!schema) {
    return;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(payload);
  if (!valid) {
    throw new Error(`Decision payload failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`);
  }
}

async function writeJsonFile(filePath, payload) {
  const resolved = path.resolve(process.cwd(), filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resolved;
}

async function writeEventsFile(filePath, entries) {
  const resolved = path.resolve(process.cwd(), filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n');
  await writeFile(resolved, `${content}\n`, 'utf8');
  return resolved;
}

async function appendStepSummary(stepSummaryPath, payload) {
  if (!stepSummaryPath) {
    return null;
  }

  const resolved = path.resolve(process.cwd(), stepSummaryPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  const lines = [
    '### Human Go/No-Go Feedback',
    '',
    `- repository: \`${payload.target.repository}\``,
    `- target_context: \`${payload.target.context}\``,
    `- target_ref: \`${payload.target.ref}\``,
    `- decision: \`${payload.decision.value}\``,
    `- recorded_by: \`${payload.decision.recordedBy ?? 'unknown'}\``,
    `- transcribed_for: \`${payload.decision.transcribedFor ?? 'none'}\``,
    `- issue_url: \`${payload.target.issueUrl ?? 'none'}\``,
    `- pull_request_url: \`${payload.target.pullRequestUrl ?? 'none'}\``,
    `- run_url: \`${payload.links.runUrl ?? 'none'}\``,
    `- next_action: \`${payload.nextIteration.recommendedAction}\``,
    '',
    'Feedback:',
    '',
    payload.decision.feedback,
  ];
  await writeFile(resolved, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'a' });
  return resolved;
}

export function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const options = {
    help: false,
    repo: null,
    targetContext: null,
    targetRef: null,
    decision: null,
    feedback: null,
    issueUrl: null,
    pullRequestUrl: null,
    targetRunId: null,
    runUrl: null,
    evidenceUrl: null,
    recordedBy: null,
    transcribedFor: null,
    nextAction: null,
    nextSeed: null,
    outPath: DEFAULT_OUT_PATH,
    eventsOutPath: DEFAULT_EVENTS_OUT_PATH,
    stepSummaryPath: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--help' || token === '-h') {
      options.help = true;
      continue;
    }

    const next = args[index + 1];
    if (
      token === '--repo' ||
      token === '--target-context' ||
      token === '--target-ref' ||
      token === '--decision' ||
      token === '--feedback' ||
      token === '--issue-url' ||
      token === '--pull-request-url' ||
      token === '--target-run-id' ||
      token === '--run-url' ||
      token === '--evidence-url' ||
      token === '--recorded-by' ||
      token === '--transcribed-for' ||
      token === '--next-action' ||
      token === '--next-seed' ||
      token === '--out' ||
      token === '--events-out' ||
      token === '--step-summary'
    ) {
      if (!next || next.startsWith('-')) {
        throw new Error(`Missing value for ${token}.`);
      }
      index += 1;
      if (token === '--repo') options.repo = normalizeRepositorySlug(next);
      if (token === '--target-context') options.targetContext = normalizeText(next);
      if (token === '--target-ref') options.targetRef = normalizeText(next);
      if (token === '--decision') options.decision = normalizeDecision(next);
      if (token === '--feedback') options.feedback = normalizeText(next);
      if (token === '--issue-url') options.issueUrl = normalizeUrl(next, 'issue');
      if (token === '--pull-request-url') options.pullRequestUrl = normalizeUrl(next, 'pull request');
      if (token === '--target-run-id') options.targetRunId = normalizeText(next);
      if (token === '--run-url') options.runUrl = normalizeUrl(next, 'run');
      if (token === '--evidence-url') options.evidenceUrl = normalizeUrl(next, 'evidence');
      if (token === '--recorded-by') options.recordedBy = normalizeText(next);
      if (token === '--transcribed-for') options.transcribedFor = normalizeText(next);
      if (token === '--next-action') options.nextAction = normalizeNextAction(next);
      if (token === '--next-seed') options.nextSeed = normalizeText(next);
      if (token === '--out') options.outPath = next;
      if (token === '--events-out') options.eventsOutPath = next;
      if (token === '--step-summary') options.stepSummaryPath = next;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!options.help) {
    if (!options.targetContext) {
      throw new Error('Target context is required. Pass --target-context <id>.');
    }
    if (!options.targetRef) {
      throw new Error('Target ref is required. Pass --target-ref <ref>.');
    }
    if (!options.decision) {
      throw new Error('Decision is required. Pass --decision <go|nogo>.');
    }
    if (!options.feedback) {
      throw new Error('Feedback is required. Pass --feedback <text>.');
    }
  }

  return options;
}

export function buildHumanGoNoGoPayload(options, environment = process.env, now = new Date()) {
  const outPath = options.outPath ?? DEFAULT_OUT_PATH;
  const eventsOutPath = options.eventsOutPath ?? DEFAULT_EVENTS_OUT_PATH;
  const repository = options.repo ?? normalizeRepositorySlug(environment.GITHUB_REPOSITORY);
  if (!repository) {
    throw new Error('Repository is required. Pass --repo <owner/repo> or set GITHUB_REPOSITORY.');
  }

  const decisionValue = normalizeDecision(options.decision);
  const nextAction = options.nextAction ?? defaultNextActionForDecision(decisionValue);
  const runUrl = options.runUrl ?? deriveRunUrl(repository, environment);
  const runId = options.targetRunId ?? normalizeText(environment.GITHUB_RUN_ID);
  const feedback = normalizeText(options.feedback);
  if (!feedback) {
    throw new Error('Feedback is required.');
  }

  return {
    schema: HUMAN_GO_NO_GO_DECISION_SCHEMA,
    schemaVersion: '1.0.0',
    generatedAt: new Date(now).toISOString(),
    workflow: {
      name: DEFAULT_WORKFLOW_NAME,
      path: DEFAULT_WORKFLOW_PATH,
    },
    target: {
      repository,
      context: options.targetContext,
      ref: options.targetRef,
      runId,
      issueUrl: options.issueUrl ?? null,
      pullRequestUrl: options.pullRequestUrl ?? null,
    },
    decision: {
      value: decisionValue,
      feedback,
      recordedBy: deriveRecordedBy(options.recordedBy, environment),
      transcribedFor: options.transcribedFor ?? null,
    },
    links: {
      runUrl,
      evidenceUrl: options.evidenceUrl ?? null,
    },
    artifacts: {
      artifactName: DEFAULT_ARTIFACT_NAME,
      decisionPath: outPath.replace(/\\/g, '/'),
      eventsPath: eventsOutPath.replace(/\\/g, '/'),
    },
    nextIteration: {
      recommendedAction: nextAction,
      seed: options.nextSeed ?? feedback,
    },
  };
}

export async function runHumanGoNoGoFeedback({
  argv = process.argv,
  environment = process.env,
  now = new Date(),
  writeJsonFileFn = writeJsonFile,
  writeEventsFileFn = writeEventsFile,
  appendStepSummaryFn = appendStepSummary,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return { exitCode: 0, payload: null, outPath: null, eventsOutPath: null };
  }

  const payload = buildHumanGoNoGoPayload(options, environment, now);
  validatePayloadAgainstSchema(payload);

  const event = {
    schema: 'human-go-no-go-feedback/event@v1',
    recordedAt: payload.generatedAt,
    decision: payload.decision.value,
    repository: payload.target.repository,
    targetContext: payload.target.context,
    targetRef: payload.target.ref,
    runId: payload.target.runId,
  };

  const [outPath, eventsOutPath] = await Promise.all([
    writeJsonFileFn(options.outPath, payload),
    writeEventsFileFn(options.eventsOutPath, [event]),
  ]);

  await appendStepSummaryFn(options.stepSummaryPath, payload);

  console.log(`[human-go-no-go-feedback] decision: ${outPath}`);
  console.log(`[human-go-no-go-feedback] events: ${eventsOutPath}`);
  console.log(
    `[human-go-no-go-feedback] decision=${payload.decision.value} next=${payload.nextIteration.recommendedAction}`,
  );

  return {
    exitCode: 0,
    payload,
    outPath,
    eventsOutPath,
  };
}

function isDirectExecution() {
  const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
  return entryPoint === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  runHumanGoNoGoFeedback().catch((error) => {
    console.error(`[human-go-no-go-feedback] ${error.message}`);
    process.exitCode = 1;
  });
}
