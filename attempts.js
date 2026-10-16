export function recordStepOutcome(caseState, attempt) {
  const attempts = caseState.attempts.some(({ attemptId }) => attemptId === attempt.attemptId)
    ? caseState.attempts
    : [...caseState.attempts, attempt];

  return {
    ...caseState,
    attempts,
    plans: caseState.plans.map((plan) => plan.id !== attempt.planId ? plan : ({
      ...plan,
      steps: plan.steps.map((step) => step.stepId === attempt.stepId
        ? { ...step, status: 'attempted', outcome: attempt.outcome, details: attempt.details }
        : step)
    }))
  };
}

export function findRecordedStepOutcome(attempts, stepId, step) {
  return attempts.find((attempt) =>
    attempt.stepId === stepId || attempt.step === step
  );
}

export function attemptStatusText(attempt, outcomes) {
  const label = outcomes.find(({ value }) => value === attempt.outcome)?.label || attempt.outcome;
  return `Attempted — ${label}`;
}
