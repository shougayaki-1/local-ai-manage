export function deploymentDisabled(config, branch) {
  const enabled = config?.git?.deploymentEnabled;
  return enabled === false || (enabled && typeof enabled === 'object' && !Array.isArray(enabled) && enabled[branch] === false);
}

// Permit only disabling the current branch, with every other setting unchanged.
export function branchSuppressionOnly(before, after, branch) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false;
  const expected = structuredClone(before);
  expected.git ??= {};
  expected.git.deploymentEnabled ??= {};
  if (typeof expected.git.deploymentEnabled !== 'object' || Array.isArray(expected.git.deploymentEnabled)) return false;
  expected.git.deploymentEnabled[branch] = false;
  return JSON.stringify(expected) === JSON.stringify(after);
}

export class PublicationSafetyError extends Error {
  constructor() {
    super('Branch deployment must be disabled before automatic publication');
    this.reason = 'branch_deployment_not_disabled';
  }
}
