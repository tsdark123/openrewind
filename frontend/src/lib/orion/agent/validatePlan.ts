import type { AgentPlan, AgentStep, AgentErrorCode } from './types';
import { isV1Capability } from './types';
import { getCapability, type CapabilitySchema } from './capabilities';

const MAX_STEPS = 12;

interface ArgRef { $ref: string; path?: string }

function isArgRef(value: unknown): value is ArgRef {
  return typeof value === 'object' && value !== null && '$ref' in value && typeof (value as ArgRef).$ref === 'string';
}

const FORBIDDEN_PATTERNS = [
  /javascript:/i,
  /data:/i,
  /file:\/\//i,
  /https?:\/\//i,
  /<script\b/i,
  /eval\s*\(/i,
  /new\s+Function\s*\(/i,
  /require\s*\(/i,
  /import\s*\(/i,
];

function looksLikeInjection(value: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(value));
}

function validateJsonType(key: string, value: unknown, schema: Record<string, unknown> | undefined): string | null {
  if (!schema) return null;

  if (isArgRef(value)) {
    // $refs are placeholders; they resolve into the actual typed value before execution.
    // Only the shape of the ref itself is validated here.
    return null;
  }

  const allowedTypes = schema.oneOf
    ? (schema.oneOf as Record<string, unknown>[]).map((s) => s.type)
    : [schema.type];

  for (const type of allowedTypes) {
    if (type === 'string' && typeof value === 'string') {
      if (typeof value === 'string' && looksLikeInjection(value)) {
        return `${key} contains a forbidden pattern`;
      }
      if (schema.enum && Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
        return `${key} must be one of ${(schema.enum as unknown[]).join(', ')}`;
      }
      return null;
    }
    if (type === 'number' && typeof value === 'number') return null;
    if (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) return null;
    if (type === 'boolean' && typeof value === 'boolean') return null;
    if (type === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) return null;
    if (type === 'array' && Array.isArray(value)) return null;
  }

  return `${key} has invalid type`;
}

function validateArgsAgainstSchema(step: AgentStep, schema: CapabilitySchema): string | null {
  const args = step.args;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const allowAdditional = schema.additionalProperties !== false;

  for (const key of required) {
    if (!(key in args)) return `${step.id} is missing required argument "${key}"`;
  }

  for (const [key, value] of Object.entries(args)) {
    if (!properties[key]) {
      if (!allowAdditional) return `${step.id} has unknown argument "${key}"`;
      // Additional properties are allowed, but still reject dangerous values.
      if (typeof value === 'string' && looksLikeInjection(value)) {
        return `${step.id}.${key} contains a forbidden pattern`;
      }
      if (isArgRef(value)) {
        if (!value.$ref) return `${step.id}.${key} has an empty $ref`;
      }
      continue;
    }
    const propSchema = properties[key];
    const typeErr = validateJsonType(`${step.id}.${key}`, value, propSchema as Record<string, unknown>);
    if (typeErr) return typeErr;
  }

  return null;
}

function validateValueForInjection(value: unknown, path: string): string | null {
  if (typeof value === 'string') {
    if (looksLikeInjection(value)) return `${path} contains a forbidden pattern`;
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = validateValueForInjection(value[i], `${path}[${i}]`);
      if (err) return err;
    }
  } else if (value !== null && typeof value === 'object' && !isArgRef(value)) {
    for (const [k, v] of Object.entries(value)) {
      const err = validateValueForInjection(v, `${path}.${k}`);
      if (err) return err;
    }
  }
  return null;
}

export interface PlanValidationResult {
  ok: boolean;
  error?: string;
  errorCode?: AgentErrorCode;
}

export function validateAgentPlan(plan: AgentPlan): PlanValidationResult {
  if (!plan || typeof plan !== 'object') {
    return { ok: false, error: 'Plan is not an object.', errorCode: 'INVALID_PLAN' };
  }
  if (!plan.id || typeof plan.id !== 'string') {
    return { ok: false, error: 'Plan has no id.', errorCode: 'INVALID_PLAN' };
  }
  if (!Array.isArray(plan.steps)) {
    return { ok: false, error: 'Plan has no steps array.', errorCode: 'INVALID_PLAN' };
  }
  if (plan.steps.length === 0) {
    return { ok: false, error: 'Plan has no steps.', errorCode: 'INVALID_PLAN' };
  }
  if (plan.steps.length > MAX_STEPS) {
    return { ok: false, error: `Plan has too many steps (${plan.steps.length} > ${MAX_STEPS}).`, errorCode: 'INVALID_PLAN' };
  }

  const stepIds = new Set<string>();
  const stepIndex = new Map<string, number>();

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step || typeof step !== 'object') {
      return { ok: false, error: `Step ${i} is not an object.`, errorCode: 'INVALID_PLAN' };
    }
    if (!step.id || typeof step.id !== 'string') {
      return { ok: false, error: `Step ${i} has no id.`, errorCode: 'INVALID_PLAN' };
    }
    if (stepIds.has(step.id)) {
      return { ok: false, error: `Duplicate step id ${step.id}.`, errorCode: 'INVALID_PLAN' };
    }
    if (step.id.length > 64 || /[<>\\/|:&;`$]/.test(step.id)) {
      return { ok: false, error: `Step id ${step.id} is invalid.`, errorCode: 'INVALID_PLAN' };
    }
    stepIds.add(step.id);
    stepIndex.set(step.id, i);

    if (!step.capability || typeof step.capability !== 'string') {
      return { ok: false, error: `Step ${step.id} has no capability.`, errorCode: 'INVALID_PLAN' };
    }
    if (!isV1Capability(step.capability)) {
      return { ok: false, error: `Step ${step.id} uses unknown capability ${step.capability}.`, errorCode: 'UNKNOWN_CAPABILITY' };
    }

    const cap = getCapability(step.capability);
    if (!cap) {
      return { ok: false, error: `Step ${step.id} uses unregistered capability ${step.capability}.`, errorCode: 'UNKNOWN_CAPABILITY' };
    }

    if (typeof step.args !== 'object' || step.args === null || Array.isArray(step.args)) {
      return { ok: false, error: `Step ${step.id} args must be an object.`, errorCode: 'INVALID_ARGUMENTS' };
    }

    const schemaErr = validateArgsAgainstSchema(step, cap.argSchema);
    if (schemaErr) {
      return { ok: false, error: schemaErr, errorCode: 'INVALID_ARGUMENTS' };
    }

    const injectErr = validateValueForInjection(step.args, `step ${step.id} args`);
    if (injectErr) {
      return { ok: false, error: injectErr, errorCode: 'INVALID_ARGUMENTS' };
    }

    if (step.dependsOn !== undefined) {
      if (!Array.isArray(step.dependsOn) || step.dependsOn.some((d) => typeof d !== 'string')) {
        return { ok: false, error: `Step ${step.id} dependsOn must be an array of step id strings.`, errorCode: 'INVALID_PLAN' };
      }
      for (const dep of step.dependsOn) {
        if (!stepIndex.has(dep)) {
          return { ok: false, error: `Step ${step.id} depends on unknown step ${dep}.`, errorCode: 'INVALID_PLAN' };
        }
        if (stepIndex.get(dep)! >= i) {
          return { ok: false, error: `Step ${step.id} cannot depend on a later or same step ${dep}.`, errorCode: 'INVALID_PLAN' };
        }
      }
    }

    // Validate $ref pointers anywhere in the step.
    function validateRefs(value: unknown, path: string): string | null {
      if (isArgRef(value)) {
        if (!stepIndex.has(value.$ref)) {
          return `${path}.$ref points to unknown step ${value.$ref}`;
        }
        if (stepIndex.get(value.$ref)! >= i) {
          return `${path}.$ref points to a later or same step ${value.$ref}`;
        }
        if (value.path !== undefined && typeof value.path !== 'string') {
          return `${path}.$ref path must be a string`;
        }
        return null;
      }
      if (Array.isArray(value)) {
        for (let idx = 0; idx < value.length; idx++) {
          const err = validateRefs(value[idx], `${path}[${idx}]`);
          if (err) return err;
        }
      } else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          const err = validateRefs(v, `${path}.${k}`);
          if (err) return err;
        }
      }
      return null;
    }

    const refErr = validateRefs(step.args, `step ${step.id}.args`);
    if (refErr) {
      return { ok: false, error: refErr, errorCode: 'INVALID_ARGUMENTS' };
    }
  }

  // No future/circular dependencies were found above, but also ensure the graph
  // is a DAG in case chains form indirect cycles.
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string, stack: string[]): boolean {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const step = plan.steps.find((s) => s.id === id);
    if (step?.dependsOn) {
      for (const dep of step.dependsOn) {
        if (!visit(dep, [...stack, id])) return false;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  }

  for (const step of plan.steps) {
    if (!visit(step.id, [])) {
      return { ok: false, error: `Plan contains a dependency cycle involving ${step.id}.`, errorCode: 'INVALID_PLAN' };
    }
  }

  return { ok: true };
}
