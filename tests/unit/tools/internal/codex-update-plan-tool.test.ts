import { describe, it, expect, beforeEach } from 'vitest';
import {
  updatePlanTool,
  getLastPlanSnapshot,
  resetUpdatePlanToolState,
} from '../../../../src/tools/internal/codex-update-plan-tool.js';

describe('update_plan tool', () => {
  beforeEach(() => {
    resetUpdatePlanToolState();
  });

  describe('parseUpdatePlanInput validation', () => {
    it('rejects non-object input', async () => {
      await expect(updatePlanTool.execute('not-an-object')).rejects.toThrow('update_plan input must be an object');
    });

    it('rejects missing plan array', async () => {
      await expect(updatePlanTool.execute({})).rejects.toThrow('update_plan input.plan must be an array');
    });

    it('rejects non-array plan', async () => {
      await expect(updatePlanTool.execute({ plan: 'not-array' })).rejects.toThrow('update_plan input.plan must be an array');
    });

    it('accepts wrapped steps alias as legacy plan input', async () => {
      const result = await updatePlanTool.execute({
        payload: {
          steps: [
            { title: 'Wrapped step', status: 'doing' },
          ],
        },
      });
      expect(result.ok).toBe(true);
      expect(result.plan).toEqual([{ step: 'Wrapped step', status: 'in_progress' }]);
    });

    it('rejects invalid plan items (non-object)', async () => {
      await expect(updatePlanTool.execute({ plan: [42] })).rejects.toThrow('update_plan input.plan items must be objects');
    });

    it('rejects empty step', async () => {
      await expect(updatePlanTool.execute({ plan: [{ step: '', status: 'pending' }] })).rejects.toThrow('plan item.step must be a non-empty string');
    });

    it('rejects invalid status', async () => {
      await expect(updatePlanTool.execute({ plan: [{ step: 'test', status: 'invalid' }] })).rejects.toThrow('plan item.status must be pending|in_progress|completed');
    });
  });

  describe('in_progress constraint', () => {
    it('allows zero in_progress steps', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'Step 1', status: 'pending' },
          { step: 'Step 2', status: 'completed' },
          { step: 'Step 3', status: 'pending' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan).toEqual([
        { step: 'Step 1', status: 'pending' },
        { step: 'Step 2', status: 'completed' },
        { step: 'Step 3', status: 'pending' },
      ]);
    });

    it('allows exactly one in_progress step', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'Step 1', status: 'completed' },
          { step: 'Step 2', status: 'in_progress' },
          { step: 'Step 3', status: 'pending' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan).toHaveLength(3);
      expect(result.plan[1].status).toBe('in_progress');
    });

    it('allows all steps completed', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'Step 1', status: 'completed' },
          { step: 'Step 2', status: 'completed' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].status).toBe('completed');
      expect(result.plan[1].status).toBe('completed');
    });

    it('throws when two in_progress steps are provided', async () => {
      await expect(
        updatePlanTool.execute({
          plan: [
            { step: 'Step 1', status: 'in_progress' },
            { step: 'Step 2', status: 'in_progress' },
          ],
        })
      ).rejects.toThrow('allows at most one step with status=in_progress');
    });

    it('throws when three or more in_progress steps are provided', async () => {
      await expect(
        updatePlanTool.execute({
          plan: [
            { step: 'A', status: 'in_progress' },
            { step: 'B', status: 'in_progress' },
            { step: 'C', status: 'in_progress' },
          ],
        })
      ).rejects.toThrow('allows at most one step with status=in_progress');
    });

    it('allows mixed statuses with one in_progress', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'Setup', status: 'completed' },
          { step: 'Implement', status: 'in_progress' },
          { step: 'Review', status: 'pending' },
          { step: 'Deploy', status: 'pending' },
          { step: 'Verify', status: 'completed' },
        ],
      });
      expect(result.ok).toBe(true);
      const inProgress = result.plan.filter(s => s.status === 'in_progress');
      expect(inProgress).toHaveLength(1);
    });
  });

  describe('execution', () => {
    it('returns ok:true and plan items', async () => {
      const result = await updatePlanTool.execute({
        explanation: 'Test plan',
        plan: [
          { step: 'First', status: 'completed' },
          { step: 'Second', status: 'in_progress' },
          { step: 'Third', status: 'pending' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.content).toBe('Plan updated');
      expect(result.explanation).toBe('Test plan');
      expect(result.plan).toHaveLength(3);
      expect(result.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('stores snapshot accessible via getLastPlanSnapshot', async () => {
      const result1 = await updatePlanTool.execute({
        plan: [
          { step: 'Do thing', status: 'completed' },
        ],
      });
      const result2 = getLastPlanSnapshot();
      expect(result2).not.toBeNull();
      expect(result2!.plan).toEqual(result1.plan);
      expect(result2!.ok).toBe(true);
    });

    it('trims whitespace in step names', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: '  Trimmed  ', status: 'pending' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].step).toBe('Trimmed');
    });
  });

  describe('error tolerance - fallback fields', () => {
    it('accepts description field as fallback for step', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { description: 'Step from description', status: 'pending' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].step).toBe('Step from description');
    });

    it('accepts text field as fallback for step', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { text: 'Step from text', status: 'completed' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].step).toBe('Step from text');
    });

    it('accepts title field as fallback for step', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { title: 'Step from title', status: 'in_progress' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].step).toBe('Step from title');
    });

    it('prefers step over fallback fields', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'Primary step', description: 'Fallback desc', status: 'pending' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].step).toBe('Primary step');
    });
  });

  describe('error tolerance - status aliases', () => {
    it('normalizes todo to pending', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'Todo item', status: 'todo' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].status).toBe('pending');
    });

    it('normalizes doing to in_progress', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'Doing item', status: 'doing' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].status).toBe('in_progress');
    });

    it('normalizes done to completed', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'Done item', status: 'done' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].status).toBe('completed');
    });

    it('normalizes inprogress to in_progress', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'Inprogress item', status: 'inprogress' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].status).toBe('in_progress');
    });

    it('normalizes in-progress to in_progress', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'In-progress item', status: 'in-progress' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].status).toBe('in_progress');
    });

    it('normalizes case-insensitively', async () => {
      const result = await updatePlanTool.execute({
        plan: [
          { step: 'TODO item', status: 'TODO' },
          { step: 'Done item', status: 'DONE' },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.plan[0].status).toBe('pending');
      expect(result.plan[1].status).toBe('completed');
    });
  });
});
