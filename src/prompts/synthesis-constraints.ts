/**
 * Synthesis Discipline Constraints
 *
 * Hard rules that enforce concrete, evidence-backed output from reviewer agents.
 * These rules are injected into reviewer system prompts and can be checked
 * programmatically via `checkSynthesisCompliance()`.
 */

/** A single synthesis rule with a human-readable label and a regex-based violation detector. */
export interface SynthesisRule {
  /** Short identifier */
  id: string;
  /** Human-readable description of the required behavior */
  label: string;
  /** Regex pattern — if the rule is active and the text matches, the rule is satisfied */
  satisfiedPattern: RegExp;
  /** Regex pattern — if matched, the rule is violated regardless of the satisfaction check */
  violationPattern?: RegExp;
}

/**
 * Core synthesis rules that all reviewer output must satisfy.
 * Each rule captures a concrete evidence requirement.
 */
export const SYNTHESIS_RULES: SynthesisRule[] = [
  {
    id: 'file-path',
    label: 'Must include specific file paths',
    satisfiedPattern: /(?:src\/|tests\/|~\/)[^\s\]"',]+\.ts(?:x)?(?::\d+)?/,
  },
  {
    id: 'line-or-symbol',
    label: 'Must indicate line number or function/symbol name',
    satisfiedPattern: /(?:(?:function|class|interface|const|let|var|type)\s+\w+|(?:\w+)\s*\()|:\d+|line\s+\d+/i,
  },
  {
    id: 'diff-format',
    label: 'Must list changes in diff-like format',
    satisfiedPattern: /(?:[-+]{2,3}\s|\b(?:added|removed|changed|modified|deleted|inserted|replaced)\b)/i,
  },
  {
    id: 'no-vague-reference',
    label: 'Must not use vague descriptions like "related files" or "similar changes"',
    violationPattern: /(?:修改相关文件|相关代码|类似修改|similar (?:changes?|files?)|related (?:files?|code|changes?))/i,
    satisfiedPattern: /.+/, // always passes satisfaction — violation is detected by violationPattern
  },
];

/**
 * Check a piece of reviewer output for synthesis compliance.
 *
 * @param text - The reviewer's feedback / thought text to validate
 * @returns Object listing passed rules and violations
 */
export interface SynthesisComplianceResult {
  /** Rules that were satisfied */
  passed: string[];
  /** Rules that were violated (matched by violationPattern) */
  violations: string[];
  /** Rules that were neither satisfied nor violated (missing evidence) */
  missing: string[];
  /** Whether the text is fully compliant (no violations, all rules satisfied) */
  compliant: boolean;
}

export function checkSynthesisCompliance(text: string): SynthesisComplianceResult {
  const passed: string[] = [];
  const violations: string[] = [];
  const missing: string[] = [];

  for (const rule of SYNTHESIS_RULES) {
    // Check violation first — takes precedence
    if (rule.violationPattern && rule.violationPattern.test(text)) {
      violations.push(rule.id);
      continue;
    }
    if (rule.satisfiedPattern.test(text)) {
      passed.push(rule.id);
    } else {
      missing.push(rule.id);
    }
  }

  return {
    passed,
    violations,
    missing,
    compliant: violations.length === 0 && missing.length === 0,
  };
}

/**
 * Render the synthesis rules as a prompt section that can be injected
 * into a reviewer system prompt.
 */
export function renderSynthesisRulesPrompt(): string {
  const lines = SYNTHESIS_RULES.map(
    (rule) => `- ${rule.label}`,
  );
  const violationList = SYNTHESIS_RULES
    .filter((r) => r.violationPattern)
    .map((r) => `  - ${r.label}`)
    .join('\n');

  return `## Synthesis Discipline (Hard Rules)

Your review output MUST satisfy ALL of the following:
${lines.join('\n')}

The following are strictly forbidden:
${violationList}

Non-compliant reviews will be rejected automatically.`;
}
