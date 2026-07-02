import { z } from 'zod';

export const slToolConnectionIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/, 'Connection id must be alphanumeric and may contain _ or -');
