import { RequestHandler } from 'express';
import { validationResult } from 'express-validator';

export const validate: RequestHandler = (req, res, next) => {
  const errors = validationResult(req);
  if (errors.isEmpty()) return next();

  return res.status(400).json({ error: 'invalid_input', details: errors.array() });
};
