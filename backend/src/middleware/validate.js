/**
 * Factory for Zod request-body validation middleware.
 *
 * @param {import('zod').ZodTypeAny} schema
 * @returns {import('express').RequestHandler}
 */
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      return res.status(422).json({
        error: { code: 'VALIDATION_ERROR', message },
      });
    }
    req.body = result.data;
    next();
  };
}
