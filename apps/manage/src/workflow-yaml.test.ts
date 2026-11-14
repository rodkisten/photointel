import { describe, expect, it } from 'vitest';
import { parseWorkflowInputs } from './workflow-yaml';

describe('workflow_dispatch YAML', () => {
  it('reads types, defaults, descriptions, required flags and choices', () => {
    const result = parseWorkflowInputs(`
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      environment:
        description: Destination
        type: choice
        required: true
        options: [staging, production]
        default: staging
      force:
        type: boolean
        default: false
      sha:
        type: string
        required: false
`);
    expect(result.dispatchable).toBe(true);
    expect(result.inputs.environment).toEqual({
      description: 'Destination', type: 'choice', required: true,
      default: 'staging', options: ['staging', 'production'],
    });
    expect(result.inputs.force.default).toBe('false');
    expect(result.inputs.sha.type).toBe('string');
  });

  it('handles workflows with no inputs and rejects non-dispatchable workflows', () => {
    expect(parseWorkflowInputs('on: workflow_dispatch').dispatchable).toBe(true);
    expect(parseWorkflowInputs('on: [push, pull_request]').dispatchable).toBe(false);
  });
});
