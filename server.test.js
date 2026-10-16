import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { app } from './server.js';
import { attemptStatusText, findRecordedStepOutcome, recordStepOutcome } from './src/attempts.js';

const previousApiKey = process.env.GROQ_API_KEY;
let server;
let baseUrl;

before(async () => {
  process.env.GROQ_API_KEY = '';
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (previousApiKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = previousApiKey;
});

async function solve(body) {
  const response = await fetch(`${baseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function solveMultipart(fields) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    form.append(name, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const response = await fetch(`${baseUrl}/api/solve`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

test('recording an outcome visibly marks its step and preserves outcomes on other steps', () => {
  const initialCase = {
    attempts: [],
    plans: [{
      id: 'plan-visible-status',
      steps: [
        { stepId: 'plan-visible-status:0', text: 'Blot the spill gently.', status: 'suggested', outcome: '' },
        { stepId: 'plan-visible-status:1', text: 'Check the care label.', status: 'suggested', outcome: '' }
      ]
    }]
  };
  const firstAttempt = {
    attemptId: 'attempt-visible-status-1',
    planId: 'plan-visible-status',
    stepId: 'plan-visible-status:0',
    step: 'Blot the spill gently.',
    outcome: 'no_improvement',
    details: ''
  };
  const firstSaved = recordStepOutcome(initialCase, firstAttempt);

  assert.equal(attemptStatusText(firstSaved.attempts[0], [
    { value: 'no_improvement', label: 'No improvement' }
  ]), 'Attempted — No improvement');
  assert.equal(findRecordedStepOutcome(firstSaved.attempts, 'plan-visible-status:0', firstAttempt.step).attemptId, firstAttempt.attemptId);
  assert.equal(firstSaved.plans[0].steps[0].status, 'attempted');
  assert.equal(firstSaved.attempts[0].details, '');

  const secondAttempt = {
    attemptId: 'attempt-visible-status-2',
    planId: 'plan-visible-status',
    stepId: 'plan-visible-status:1',
    step: 'Check the care label.',
    outcome: 'completed',
    details: 'Label confirms washable.'
  };
  const bothSaved = recordStepOutcome(firstSaved, secondAttempt);
  const duplicateSave = recordStepOutcome(bothSaved, secondAttempt);

  assert.equal(bothSaved.attempts.length, 2);
  assert.deepEqual(bothSaved.plans[0].steps.map(({ status, outcome }) => [status, outcome]), [
    ['attempted', 'no_improvement'],
    ['attempted', 'completed']
  ]);
  assert.equal(duplicateSave.attempts.length, 2);
  assert.equal(findRecordedStepOutcome(bothSaved.attempts, 'new-plan:0', firstAttempt.step).outcome, 'no_improvement');
});

test('an unsuccessful attempt produces a different, question-led plan', async () => {
  const first = await solve({ problem: 'Candle wax on a glass table' });
  assert.equal(first.status, 200);
  assert.equal(first.body.workflowState, 'READY_FOR_RECOMMENDATION');

  const revised = await solve({
    problem: 'Candle wax on a glass table',
    attempts: [{
      step: 'Lift the hardened wax with a plastic card',
      outcome: 'no_improvement',
      details: 'The wax did not lift.'
    }]
  });

  assert.equal(revised.body.workflowState, 'ADAPTIVE_REASSESSMENT');
  assert.equal(revised.body.requiresClarification, true);
  assert.match(revised.body.revisionReason, /does not repeat/i);
  assert.match(revised.body.summary, /do not repeat/i);
  assert.deepEqual(revised.body.materials, []);
  assert.ok(revised.body.questions.length > 0);
  assert.ok(!revised.body.steps.join(' ').toLowerCase().includes('plastic card'));
});

test('a submitted failed step is preserved and excluded from the backend reassessment', async () => {
  const problemId = 'case-ui-step-outcome-001';
  const initial = await solve({
    problemId,
    requestId: 'request-ui-outcome-initial',
    problem: 'Candle wax on a glass table'
  });
  const initialPlan = initial.body.problemState.recommendedPlans.find(({ id }) => id === initial.body.requestId);
  const failedStep = initialPlan.steps[0];
  const attempt = {
    attemptId: 'attempt-ui-outcome-failed',
    planId: initialPlan.id,
    stepId: failedStep.stepId,
    step: failedStep.text,
    outcome: 'no_improvement',
    details: ''
  };
  const revised = await solve({
    problemId,
    requestId: 'request-ui-outcome-revised',
    originalProblem: 'Candle wax on a glass table',
    problem: 'Candle wax on a glass table',
    attempts: [attempt],
    planHistory: initial.body.problemState.recommendedPlans
  });

  assert.equal(revised.status, 200);
  assert.equal(revised.body.workflowState, 'ADAPTIVE_REASSESSMENT');
  assert.equal(revised.body.attempts[0].attemptId, attempt.attemptId);
  assert.equal(revised.body.attempts[0].outcome, 'no_improvement');
  assert.match(revised.body.revisionReason, /does not repeat/i);
  assert.ok(!revised.body.steps.some((step) => step === failedStep.text));
  assert.equal(
    findRecordedStepOutcome(revised.body.attempts, `${revised.body.requestId}:0`, failedStep.text).outcome,
    'no_improvement'
  );
});

test('multipart requests preserve structured attempt history', async () => {
  const result = await solveMultipart({
    problem: 'Candle wax on a wooden table',
    attempts: [{ action: 'Use a plastic card', outcome: 'failed', details: 'It did not lift.' }]
  });

  assert.equal(result.body.workflowState, 'ADAPTIVE_REASSESSMENT');
  assert.match(result.body.revisionReason, /plastic card/i);
});

test('legacy outcome history is adapted for issues outside the demo fix catalog', async () => {
  const result = await solve({
    problem: 'A kitchen drawer is still sticking',
    history: 'Outcome: no improvement'
  });

  assert.equal(result.body.workflowState, 'ADAPTIVE_REASSESSMENT');
  assert.match(result.body.revisionReason, /previous approach/i);
  assert.ok(result.body.questions.some((question) => /happened|step/i.test(question)));
  assert.ok(result.body.steps.every((step) => !/lubricant|oil|spray/i.test(step)));
});

test('a new clarification is acknowledged and the demo avoids repeating a failed action', async () => {
  const result = await solve({
    problem: 'Candle wax on glass',
    attempts: [{
      step: 'Lift the hardened wax with a plastic card',
      outcome: 'no_improvement',
      details: 'The wax scraper did not lift it.'
    }],
    history: 'Clarification: What is the exact item/material and are there care or manufacturer instructions?\nAnswer: It is plain glass; the wax scraper did not lift it.\nOutcome: no improvement'
  });

  assert.equal(result.body.workflowState, 'READY_FOR_RECOMMENDATION');
  assert.match(result.body.revisionReason, /omits wax-lift/i);
  assert.ok(result.body.steps.length > 0);
  assert.ok(!result.body.steps.join(' ').toLowerCase().includes('plastic card'));
});

test('demo mode reassesses after clarifications instead of repeating its interim response', async () => {
  const failedAttempt = [{
    step: 'Lift the hardened wax gently with a plastic card',
    outcome: 'no_improvement',
    details: 'No visible change.'
  }];
  const firstReassessment = await solve({ problem: 'Candle wax on a glass table', attempts: failedAttempt });
  const followUpHistory = firstReassessment.body.questions
    .map((question) => `Clarification: ${question}\nAnswer: The wax is on plain glass; it is cool and there is no coating.`)
    .join('\n');
  const revised = await solve({
    problem: 'Candle wax on a glass table',
    attempts: failedAttempt,
    history: followUpHistory
  });

  assert.notEqual(revised.body.workflowState, 'ADAPTIVE_REASSESSMENT');
  assert.ok(revised.body.steps.length > 0);
  assert.ok(!revised.body.steps.join(' ').toLowerCase().includes('plastic card'));
});

test('stain failure pauses treatment and asks for the outcome and product details', async () => {
  const result = await solve({
    problem: 'Coffee stain on a cotton shirt',
    material: 'cotton',
    attempts: [{
      step: 'Apply stain remover',
      outcome: 'no_improvement',
      details: 'No visible change.'
    }]
  });

  assert.equal(result.body.workflowState, 'ADAPTIVE_REASSESSMENT');
  assert.deepEqual(result.body.materials, []);
  assert.ok(result.body.questions.some((question) => /changed|previous treatment|happened after/i.test(question)));
  assert.match(result.body.revisionReason, /does not repeat/i);
});

test('repeated stain attempts recommend a qualified cleaner', async () => {
  const result = await solve({
    problem: 'Coffee stain on an upholstered sofa',
    attempts: [
      { step: 'Blot with a cloth', outcome: 'no_improvement' },
      { step: 'Try a second cleaning pass', outcome: 'failed' }
    ]
  });

  assert.equal(result.body.workflowState, 'ADAPTIVE_REASSESSMENT');
  assert.match(result.body.professionalHelp, /qualified upholstery cleaner/i);
  assert.deepEqual(result.body.materials, []);
});

test('hazardous details in an attempt trigger the safety redirect', async () => {
  const result = await solve({
    problem: 'Wax on a table',
    attempts: [{
      step: 'Clean the table',
      outcome: 'failed',
      details: 'I mixed bleach and ammonia and there are fumes.'
    }]
  });

  assert.equal(result.body.workflowState, 'SAFETY_ESCALATION');
  assert.equal(result.body.solution, null);
  assert.equal(result.body.safety, true);
  assert.match(result.body.message, /toxic gas|dangerous fumes/i);
});

test('repeated unsuccessful attempts recommend qualified professional help', async () => {
  const result = await solve({
    problem: 'Candle wax on a wooden table',
    attempts: [
      { step: 'Try a plastic card', outcome: 'no_improvement' },
      { step: 'Try wiping with a cloth', outcome: 'failed' }
    ]
  });

  assert.equal(result.body.workflowState, 'ADAPTIVE_REASSESSMENT');
  assert.match(result.body.professionalHelp, /qualified professional/i);
  assert.match(result.body.steps.join(' '), /professional-assistance/i);
});

test('attempt history is validated instead of silently ignored', async () => {
  const result = await solve({
    problem: 'Candle wax on a wooden table',
    attempts: [{ step: 'Try a card', outcome: 'maybe' }]
  });

  assert.equal(result.status, 400);
  assert.match(result.body.error, /supported outcome/i);
});

test('washable cotton coffee spills receive the matching tested rule', async () => {
  const result = await solve({ problem: 'Coffee spill on a washable cotton shirt' });

  assert.equal(result.status, 200);
  assert.equal(result.body.workflowState, 'READY_FOR_RECOMMENDATION');
  assert.equal(result.body.mode, 'tested rules mode');
  assert.match(result.body.title, /coffee on washable cotton/i);
  assert.ok(result.body.steps.some((step) => /cool water/i.test(step)));
  assert.ok(result.body.steps.some((step) => /care label/i.test(step)));
  assert.ok(result.body.avoid.some((item) => /mix cleaners/i.test(item)));
  assert.equal(result.body.questions.length, 0);
});

test('fresh coffee on cotton gives ordered conditional steps while requiring the care label', async () => {
  const result = await solve({ problem: 'Coffee spilled on my cotton T-shirt five minutes ago' });

  assert.equal(result.status, 200);
  assert.equal(result.body.workflowState, 'SAFE_INTERIM_GUIDANCE');
  assert.match(result.body.mode, /tested rules mode/i);
  assert.ok(result.body.questions.some((question) => /care label/i.test(question)));
  assert.deepEqual(result.body.steps.map((step) =>
    /blot/i.test(step) ? 'blot' :
      /check the garment care label/i.test(step) ? 'check-label' :
        /treat the stain gently/i.test(step) ? 'gentle-wash' :
          /air-dry/i.test(step) ? 'air-dry' : 'other'
  ), ['blot', 'check-label', 'gentle-wash', 'air-dry']);
  assert.match(result.body.steps[1], /cool water/i);
  assert.match(result.body.steps[1], /do not scrub/i);
  assert.match(result.body.steps[2], /if the label permits washing/i);
  assert.match(result.body.steps[2], /usual laundry detergent as directed/i);
  assert.doesNotMatch(result.body.steps.join(' '), /\b(brand-name|brand name|bleach|solvent)\b/i);
  assert.ok(result.body.avoid.some((item) => /bleach|solvents|extra stain products/i.test(item)));
  assert.ok(result.body.precautions.some((item) => /garment-care label/i.test(item)));
});

test('unknown sofa fibres receive only targeted clarification and precautions', async () => {
  const result = await solve({ problem: 'Coffee spilled on a sofa' });

  assert.equal(result.body.workflowState, 'NEEDS_CLARIFICATION');
  assert.deepEqual(result.body.materials, []);
  assert.ok(result.body.questions.some((question) => /fabric|fibre|care label/i.test(question)));
  assert.ok(result.body.steps.every((step) => /pause|do not/i.test(step)));
});

test('an unspecified sofa stain asks for its cause and upholstery material without treatment', async () => {
  const result = await solve({ problem: 'There is a stain on my sofa' });

  assert.equal(result.status, 200);
  assert.equal(result.body.workflowState, 'SAFE_INTERIM_GUIDANCE');
  assert.ok(result.body.questions.some((question) => /what caused the stain/i.test(question)));
  assert.ok(result.body.questions.some((question) => /material or upholstery fabric/i.test(question)));
  assert.deepEqual(result.body.materials, []);
  assert.ok(result.body.interimGuidance.some((item) => /pause cleaning; do not add another product, water, heat, or force/i.test(item)));
  assert.ok(result.body.interimGuidance.some((item) => /do not mix cleaners|do not add chemicals/i.test(item)));
  assert.doesNotMatch(result.body.steps.join(' '), /\b(apply|wash|scrub|spray)\b/i);
});

test('a bleach and unknown-cleaner request redirects and gives exposure safety steps', async () => {
  const result = await solve({
    problem: 'Can I mix bleach with this other cleaner to remove a stain?'
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.workflowState, 'SAFETY_ESCALATION');
  assert.equal(result.body.safety, true);
  assert.match(result.body.summary, /never mix bleach with an unknown cleaner/i);
  assert.ok(result.body.steps.some((step) => /fresh air/i.test(step)));
  assert.ok(result.body.steps.some((step) => /emergency services/i.test(step)));
  assert.ok(result.body.steps.some((step) => /rinse with clean running water/i.test(step)));
  assert.ok(result.body.steps[0].includes('do not touch, mix'));
  assert.ok(result.body.precautions.some((item) => /neutralise chemicals/i.test(item)));

  const exposure = await solve({
    problem: 'I mixed bleach with an unknown cleaner and now there are fumes and my eyes sting.'
  });
  assert.equal(exposure.body.workflowState, 'SAFETY_ESCALATION');
  assert.ok(exposure.body.steps.some((step) => /fresh air/i.test(step)));
  assert.ok(exposure.body.steps.some((step) => /rinse with clean running water/i.test(step)));
  assert.ok(exposure.body.steps.some((step) => /emergency services now/i.test(step)));
});

test('candle wax on an unknown surface is not treated as glass or ceramic', async () => {
  const result = await solve({ problem: 'Candle wax on a tabletop' });

  assert.equal(result.body.workflowState, 'NEEDS_CLARIFICATION');
  assert.deepEqual(result.body.materials, []);
  assert.ok(result.body.questions.some((question) => /exact surface/i.test(question)));
  assert.ok(result.body.avoid.length > 0 || result.body.interimGuidance.length > 0);
});

test('mud on washable canvas shoes receives a limited dry-first rule', async () => {
  const result = await solve({ problem: 'Mud on washable canvas shoes' });

  assert.equal(result.body.workflowState, 'READY_FOR_RECOMMENDATION');
  assert.equal(result.body.mode, 'tested rules mode');
  assert.match(result.body.title, /canvas shoes/i);
  assert.ok(result.body.steps.some((step) => /dry naturally/i.test(step)));
  assert.ok(result.body.avoid.some((item) => /soak/i.test(item)));
});

test('failed glass-wax step is not repeated after clarification', async () => {
  const result = await solve({
    problem: 'Candle wax on glass',
    attempts: [{ step: 'Ease hardened wax up with a plastic card', outcome: 'no_improvement', details: 'It did not lift.' }],
    history: 'Clarification: What happened after the failed step?\nAnswer: The wax is cool; surface is plain glass with no coating.'
  });

  assert.equal(result.body.workflowState, 'READY_FOR_RECOMMENDATION');
  assert.ok(result.body.steps.length > 0);
  assert.ok(!result.body.steps.some((step) => /plastic card|ease.*wax/i.test(step)));
  assert.match(result.body.revisionReason, /omits wax-lift/i);
});

test('four asked questions do not block safe interim guidance', async () => {
  const result = await solve({
    problem: 'Candle wax on an unknown tabletop surface',
    questionsAsked: '4'
  });

  assert.equal(result.body.workflowState, 'SAFE_INTERIM_GUIDANCE');
  assert.deepEqual(result.body.questions, []);
  assert.equal(result.body.questionBudgetRemaining, 0);
  assert.equal(result.body.questionBudgetReached, true);
  assert.ok(result.body.steps.some((step) => /pause/i.test(step)));
  assert.match(result.body.uncertainty, /cannot be made/i);
});

test('only the remaining clarification budget is returned', async () => {
  const result = await solve({
    problem: 'Candle wax on an unknown tabletop surface',
    questionsAsked: '3'
  });

  assert.equal(result.body.questions.length, 1);
  assert.equal(result.body.questionBudgetUsed, 4);
  assert.equal(result.body.questionBudgetRemaining, 0);
  assert.equal(result.body.questionBudgetReached, true);
  assert.equal(result.body.workflowState, 'NEEDS_CLARIFICATION');
  assert.ok(result.body.steps.some((step) => /pause/i.test(step)));
});

test('sequential outcomes preserve the entire attempt history', async () => {
  const attempts = [
    { step: 'Ease the cooled wax with a plastic card', outcome: 'failed', details: 'No movement.' },
    { step: 'Wipe with a barely damp cloth', outcome: 'completed', details: 'Residue removed.' }
  ];
  const result = await solve({ problem: 'Candle wax on glass', attempts });

  assert.equal(result.body.workflowState, 'READY_FOR_RECOMMENDATION');
  assert.deepEqual(result.body.attempts, attempts);
  assert.ok(!result.body.steps.some((step) => /plastic card|damp.*cloth/i.test(step)));
});

test('problem IDs and server state keep separate cases isolated', async () => {
  const problemA = 'case-independent-a-001';
  const problemB = 'case-independent-b-001';
  const attempt = { attemptId: 'attempt-independent-a-001', stepId: 'plan-a:0', planId: 'plan-a', step: 'Blot gently', outcome: 'no_improvement', details: 'No visible change.' };

  const firstA = await solve({
    problemId: problemA, requestId: 'request-independent-a-001',
    problem: 'Coffee on a washable cotton shirt', attempts: [attempt]
  });
  const firstB = await solve({
    problemId: problemB, requestId: 'request-independent-b-001',
    problem: 'Coffee spilled on a sofa'
  });
  const resumedA = await solve({
    problemId: problemA, requestId: 'request-independent-a-002',
    problem: 'Coffee on a washable cotton shirt', attempts: []
  });

  assert.equal(firstA.body.problemId, problemA);
  assert.equal(firstA.body.problemState.attempts.length, 1);
  assert.equal(firstB.body.problemId, problemB);
  assert.equal(firstB.body.problemState.attempts.length, 0);
  assert.equal(resumedA.body.problemState.attempts.length, 1);
  assert.equal(resumedA.body.problemState.attempts[0].attemptId, attempt.attemptId);
});

test('the API preserves question count across requests and deduplicates equivalent wording', async () => {
  const problemId = 'case-question-memory-001';
  const first = await solve({
    problemId, requestId: 'request-question-memory-001',
    problem: 'Coffee spilled on a sofa'
  });
  const countAfterFirst = first.body.questionBudgetUsed;
  assert.ok(countAfterFirst > 0 && countAfterFirst <= 4);

  const second = await solve({
    problemId, requestId: 'request-question-memory-002',
    problem: 'Coffee spilled on a sofa',
    questionsAsked: '0',
    questionHistory: []
  });

  assert.equal(second.body.questionBudgetUsed, countAfterFirst);
  assert.equal(second.body.problemState.questionHistory.length, countAfterFirst);
  assert.equal(second.body.questions.length, 0);
  assert.notEqual(second.body.mode, 'Groq API');
});

test('four clarification topics still allow a revised plan and outcome history', async () => {
  const problemId = 'case-four-question-outcome-001';
  const questionHistory = [
    { question: 'What is the exact fabric material?', answer: '100% cotton' },
    { question: 'Does the care label permit washing?', answer: 'Machine washable' },
    { question: 'What caused the mark?', answer: 'Coffee' },
    { question: 'What product was used previously?', answer: 'No products used' }
  ];
  const attempt = {
    attemptId: 'attempt-four-question-001',
    planId: 'old-plan-four-question',
    stepId: 'old-plan-four-question:0',
    step: 'Blot gently from the outside toward the centre with a clean white cloth; do not rub.',
    outcome: 'no_improvement',
    details: 'No visible change.'
  };
  const result = await solve({
    problemId, requestId: 'request-four-question-001',
    problem: 'Coffee spill on a washable cotton shirt',
    attempts: [attempt],
    questionHistory
  });

  assert.equal(result.body.questionBudgetUsed, 4);
  assert.equal(result.body.questionBudgetRemaining, 0);
  assert.equal(result.body.questionBudgetReached, true);
  assert.deepEqual(result.body.questions, []);
  assert.ok(result.body.steps.length > 0);
  assert.ok(!result.body.steps.some((step) => /blot gently from the outside/i.test(step)));
  assert.equal(result.body.problemState.attempts[0].attemptId, attempt.attemptId);
});

test('three sequential step outcomes remain attached to their saved plan', async () => {
  const problemId = 'case-three-outcomes-001';
  const initial = await solve({
    problemId, requestId: 'request-three-outcomes-001',
    problem: 'Coffee spill on a washable cotton shirt'
  });
  let planHistory = initial.body.problemState.recommendedPlans;
  const initialPlan = planHistory.find(({ id }) => id === 'request-three-outcomes-001');
  assert.ok(initialPlan?.steps.length >= 3);
  let attempts = [];
  let latest = initial;

  for (const [index, step] of initialPlan.steps.slice(0, 3).entries()) {
    attempts = [...attempts, {
      attemptId: `attempt-three-outcomes-${index + 1}`,
      planId: initialPlan.id,
      stepId: step.stepId,
      step: step.text,
      outcome: index === 0 ? 'partial_improvement' : 'completed',
      details: `Observation ${index + 1}`
    }];
    latest = await solve({
      problemId,
      requestId: `request-three-outcomes-${index + 2}`,
      problem: 'Coffee spill on a washable cotton shirt',
      attempts,
      planHistory: planHistory.map((plan) => ({
        id: plan.id,
        reason: plan.reason,
        steps: plan.steps.map(({ stepId, text, status, outcome }) => ({ stepId, text, status, ...(outcome ? { outcome } : {}) }))
      }))
    });
    planHistory = latest.body.problemState.recommendedPlans;
  }

  assert.equal(latest.body.problemState.attempts.length, 3);
  assert.deepEqual(latest.body.problemState.attempts.map(({ attemptId }) => attemptId), [
    'attempt-three-outcomes-1', 'attempt-three-outcomes-2', 'attempt-three-outcomes-3'
  ]);
  const recordedPlan = latest.body.problemState.recommendedPlans.find(({ id }) => id === initialPlan.id);
  assert.deepEqual(recordedPlan.steps.slice(0, 3).map(({ status, outcome }) => [status, outcome]), [
    ['attempted', 'partial_improvement'], ['attempted', 'completed'], ['attempted', 'completed']
  ]);
});

test('a repeated attempt ID is idempotent and does not duplicate the history', async () => {
  const problemId = 'case-idempotent-attempt-001';
  const attempt = {
    attemptId: 'attempt-idempotent-001', stepId: 'plan-idempotent:0', planId: 'plan-idempotent',
    step: 'Check the care label', outcome: 'completed', details: 'Label checked.'
  };
  const first = await solve({ problemId, requestId: 'request-idempotent-001', problem: 'Coffee on a cotton shirt', attempts: [attempt] });
  const retried = await solve({ problemId, requestId: 'request-idempotent-002', problem: 'Coffee on a cotton shirt', attempts: [attempt] });

  assert.equal(first.body.problemState.attempts.length, 1);
  assert.equal(retried.body.problemState.attempts.length, 1);
});

test('reported deterioration pauses treatment and explains the escalation', async () => {
  const result = await solve({
    problem: 'Coffee stain on a cotton shirt',
    attempts: [{ step: 'Rinse the stain with cool water', outcome: 'worsened', details: 'Colour faded around the mark.' }]
  });

  assert.equal(result.body.workflowState, 'ADAPTIVE_REASSESSMENT');
  assert.deepEqual(result.body.materials, []);
  assert.ok(result.body.steps.some((step) => /pause/i.test(step)));
  assert.match(result.body.revisionReason, /negative change/i);
  assert.match(result.body.professionalHelp, /visible damage/i);
});

test('the deterministic fallback does not invent an oil-stain treatment', async () => {
  const result = await solve({ problem: 'Oil on a shirt' });

  assert.notEqual(result.body.workflowState, 'READY_FOR_RECOMMENDATION');
  assert.deepEqual(result.body.materials, []);
  assert.ok(result.body.questions.length > 0);
  assert.ok(result.body.steps.every((step) => /pause|do not/i.test(step)));
  assert.equal(result.body.mode, 'tested rules mode');
});

test('a stored safety warning keeps ordinary troubleshooting blocked for that case', async () => {
  const problemId = 'case-safety-event-memory-001';
  const hazard = await solve({
    problemId, requestId: 'request-safety-event-001',
    problem: 'I mixed bleach and ammonia and there are fumes.'
  });
  const nextRequest = await solve({
    problemId, requestId: 'request-safety-event-002',
    problem: 'Coffee on a washable cotton shirt'
  });

  assert.equal(hazard.body.workflowState, 'SAFETY_ESCALATION');
  assert.equal(hazard.body.safetyWarnings.length, 1);
  assert.equal(nextRequest.body.workflowState, 'SAFETY_ESCALATION');
  assert.equal(nextRequest.body.safetyWarnings.length, 2);
});

test('malformed JSON receives a clear client error response', async () => {
  const response = await fetch(`${baseUrl}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"problem":'
  });

  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.match((await response.json()).error, /valid JSON/i);
});

test('an unavailable configured AI provider falls back only to tested safe rules', async () => {
  const realFetch = globalThis.fetch;
  const previousApiKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'test-provider-unavailable';
  globalThis.fetch = (url, options) => String(url).startsWith('https://api.groq.com/')
    ? Promise.reject(new Error('mock provider unavailable'))
    : realFetch(url, options);
  try {
    const result = await solve({
      problemId: 'case-ai-fallback-001',
      requestId: 'request-ai-fallback-001',
      problem: 'Coffee spill on a washable cotton shirt'
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.mode, 'tested rules mode');
    assert.equal(result.body.aiFallback, true);
    assert.match(result.body.summary, /AI provider was unavailable/i);
    assert.match(result.body.title, /coffee on washable cotton/i);
  } finally {
    globalThis.fetch = realFetch;
    if (previousApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousApiKey;
  }
});

test('configured AI receives the problem, material, prior actions, and user preferences', async () => {
  const realFetch = globalThis.fetch;
  const previousApiKey = process.env.GROQ_API_KEY;
  const providerRequests = [];
  const recommendation = {
    title: 'Check the router connection',
    summary: 'This plan uses the reported router issue and beginner preference.',
    materials: ['Ethernet cable'],
    steps: ['Check whether the router status light changes.', 'Reconnect the Ethernet cable at both ends.', 'Observe whether the connection remains stable.'],
    precautions: ['Do not open the router enclosure.'],
    avoid: ['Do not reset the router until settings are backed up.'],
    uncertainty: '',
    followUp: [],
    observations: [],
    assumptions: [],
    successCriteria: 'Connection remains stable.',
    stopIf: 'Stop if the device is hot, damaged, or smells burnt.',
    revisionReason: '',
    professionalHelp: '',
    safety: false
  };
  process.env.GROQ_API_KEY = 'test-provider-context';
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://api.groq.com/')) return realFetch(url, options);
    const request = JSON.parse(options.body);
    providerRequests.push(request);
    const call = providerRequests.length;
    const content = call === 1
      ? JSON.stringify({ intent: 'SUPPORTED_PROBLEM', message: 'Router troubleshooting request.', questions: [] })
      : call === 2
        ? JSON.stringify({ safety: false, reason: '' })
        : JSON.stringify(recommendation);
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const result = await solve({
      problemId: 'case-ai-user-context-001',
      requestId: 'request-ai-user-context-001',
      problem: 'My Wi-Fi router keeps disconnecting every 10 minutes',
      material: 'plastic router enclosure',
      cause: 'started after a power outage',
      tried: 'restarted once; issue returned',
      timeAvailable: '20 minutes',
      budget: '$0',
      availableMaterials: 'Ethernet cable, no spare router',
      skillLevel: 'beginner'
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.mode, 'Groq API');
    assert.equal(providerRequests.length, 3);
    const userContent = providerRequests[2].messages.find(({ role }) => role === 'user').content;
    const contextText = userContent.map(({ text }) => text || '').join('\n');
    for (const detail of [
      'My Wi-Fi router keeps disconnecting every 10 minutes',
      'plastic router enclosure',
      'started after a power outage',
      'restarted once; issue returned',
      '20 minutes',
      '$0',
      'Ethernet cable, no spare router',
      'beginner'
    ]) assert.ok(contextText.includes(detail), `AI context should include: ${detail}`);
  } finally {
    globalThis.fetch = realFetch;
    if (previousApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousApiKey;
  }
});

test('health and common rules clearly identify the no-AI rules fallback', async () => {
  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json());
  const result = await solve({ problem: 'Coffee spill on washable cotton clothing' });

  assert.equal(health.ok, true);
  assert.equal(health.aiConfigured, false);
  assert.equal(health.mode, 'tested rules mode');
  assert.equal(result.body.mode, 'tested rules mode');
  assert.notEqual(result.body.mode, 'Groq API');
});
