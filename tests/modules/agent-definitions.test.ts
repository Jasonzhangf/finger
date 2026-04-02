import { describe, it, expect } from 'vitest'
import {
  type AgentPromptDefinition,
  type ReviewVerdict,
  explorerAgentDefinition,
  plannerAgentDefinition,
  executorAgentDefinition,
  reviewerAgentDefinition,
  orchestratorAgentDefinition,
  agentDefinitions,
  getAgentDefinition,
  getRegisteredAgentTypes,
  isToolDisallowed,
} from '../../src/agents/prompts/agent-definitions.js'

describe('AgentPromptDefinition interface', () => {
  it('all 6 agents are defined in registry', () => {
    const types = getRegisteredAgentTypes()
    expect(types).toContain('explorer')
    expect(types).toContain('planner')
    expect(types).toContain('executor')
    expect(types).toContain('reviewer')
    expect(types).toContain('orchestrator')
    expect(types).toContain('verifier')
    expect(types).toHaveLength(6)
  })

  it('each agent has a non-empty whenToUse in Chinese', () => {
    for (const def of Object.values(agentDefinitions)) {
      expect(def.whenToUse.length).toBeGreaterThan(0)
      // Chinese characters present
      expect(/[\u4e00-\u9fff]/.test(def.whenToUse)).toBe(true)
    }
  })

  it('each agent has a non-empty getSystemPrompt', () => {
    for (const def of Object.values(agentDefinitions)) {
      const prompt = def.getSystemPrompt()
      expect(prompt.length).toBeGreaterThan(0)
    }
  })
})

describe('Explorer agent', () => {
  it('has disallowedTools for write operations', () => {
    expect(explorerAgentDefinition.disallowedTools).toBeDefined()
    expect(explorerAgentDefinition.disallowedTools).toContain('apply_patch')
    expect(explorerAgentDefinition.disallowedTools).toContain('write')
    expect(explorerAgentDefinition.disallowedTools).toContain('git_commit')
  })

  it('isToolDisallowed returns true for write tools', () => {
    expect(isToolDisallowed('explorer', 'apply_patch')).toBe(true)
    expect(isToolDisallowed('explorer', 'write')).toBe(true)
  })

  it('isToolDisallowed returns false for read tools', () => {
    expect(isToolDisallowed('explorer', 'exec_command')).toBe(false)
    expect(isToolDisallowed('explorer', 'grep')).toBe(false)
  })
})

describe('Planner agent', () => {
  it('has disallowedTools for write operations', () => {
    expect(plannerAgentDefinition.disallowedTools).toBeDefined()
    expect(plannerAgentDefinition.disallowedTools).toContain('apply_patch')
    expect(plannerAgentDefinition.disallowedTools).toContain('write')
  })
})

describe('Executor agent', () => {
  it('has no disallowedTools (full access)', () => {
    expect(executorAgentDefinition.disallowedTools).toBeUndefined()
  })

  it('has maxTurns set', () => {
    expect(executorAgentDefinition.maxTurns).toBe(30)
  })
})

describe('Reviewer agent', () => {
  it('system prompt contains PASS/FAIL/PARTIAL verdict format', () => {
    const prompt = reviewerAgentDefinition.getSystemPrompt()
    expect(prompt).toContain('PASS')
    expect(prompt).toContain('FAIL')
    expect(prompt).toContain('PARTIAL')
    expect(prompt).toContain('VERDICT')
  })

  it('has maxTurns set', () => {
    expect(reviewerAgentDefinition.maxTurns).toBe(10)
  })
})

describe('Orchestrator agent', () => {
  it('has no disallowedTools', () => {
    expect(orchestratorAgentDefinition.disallowedTools).toBeUndefined()
  })

  it('system prompt mentions all 4 agent types', () => {
    const prompt = orchestratorAgentDefinition.getSystemPrompt()
    expect(prompt).toContain('Explorer')
    expect(prompt).toContain('Planner')
    expect(prompt).toContain('Executor')
    expect(prompt).toContain('Reviewer')
  })
})

describe('getAgentDefinition', () => {
  it('returns definition for known agent type', () => {
    const def = getAgentDefinition('explorer')
    expect(def).toBeDefined()
    expect(def!.agentType).toBe('explorer')
  })

  it('returns undefined for unknown agent type', () => {
    const def = getAgentDefinition('nonexistent')
    expect(def).toBeUndefined()
  })
})

describe('isToolDisallowed', () => {
  it('returns false for agent without disallowedTools', () => {
    expect(isToolDisallowed('executor', 'apply_patch')).toBe(false)
    expect(isToolDisallowed('orchestrator', 'anything')).toBe(false)
  })

  it('returns false for unknown agent', () => {
    expect(isToolDisallowed('nonexistent', 'apply_patch')).toBe(false)
  })
})
