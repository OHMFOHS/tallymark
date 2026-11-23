import { it, expect } from 'vitest';
import { BoundedSchemaValidator } from '../../dist/packages/core/schema-validation.js';
it('bounds external schema work and validates ordinary inputs without mutating them', () => {
  const value = { units: 4 };
  const schema = {
    type: 'object' as const,
    properties: { units: { type: 'integer' as const } },
    required: ['units'],
  };
  const validate = new BoundedSchemaValidator().getValidator(schema);
  expect(validate(value)).toMatchObject({ valid: true, data: value });
  expect(validate({ units: 'four' }).valid).toBe(false);
  expect(new BoundedSchemaValidator(1).getValidator(schema)(value).valid).toBe(
    false,
  );
});
