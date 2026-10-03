import assert from 'node:assert/strict';
import test from 'node:test';
import { deploymentDisabled, branchSuppressionOnly } from './lib/publication.mjs';
import { verificationTests } from './lib/verification.mjs';

const branch = 'codex/issue-50-a11y-input';
const before = { headers: [], git: { deploymentEnabled: { 'codex/other': false } } };
const after = { headers: [], git: { deploymentEnabled: { 'codex/other': false, [branch]: false } } };

test('only explicit global/current branch deployment suppression permits publication', () => {
  assert.ok(deploymentDisabled(after, branch));
  assert.ok(deploymentDisabled({ git: { deploymentEnabled: false } }, branch));
  for (const config of [before, {}, { git: { deploymentEnabled: true } }, { git: { deploymentEnabled: { [branch]: true } } }]) assert.ok(!deploymentDisabled(config, branch));
});

test('branch suppression never permits modifying another deployment/security setting', () => {
  assert.ok(branchSuppressionOnly(before, after, branch));
  for (const config of [{ ...after, headers: ['changed'] }, { ...after, crons: [] }, { ...after, git: { deploymentEnabled: { [branch]: false } } }, { ...after, git: { deploymentEnabled: { [branch]: true } } }]) assert.ok(!branchSuppressionOnly(before, config, branch));
});

test('record form changes select relevant unit/UI/build checks without E2E execution', () => {
  assert.deepEqual(verificationTests(['M\tsrc/components/record/RecordMetaForm.tsx', 'A\tsrc/components/record/RecordMetaForm.stories.tsx', 'M\ttests/record-ui.spec.ts'], { 'test:unit': 'vitest run --project unit', 'test:ui': 'vitest run --project storybook', build: 'next build --webpack' }), ['test:unit', 'test:ui', 'build']);
});
