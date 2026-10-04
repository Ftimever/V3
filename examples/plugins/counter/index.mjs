export function apply(context) {
  let count = 0
  context.services.provide({ id: 'example.counter', version: '1.0.0' }, {
    increment: () => ++count,
    read: () => count,
  })
  return () => context.logger.info('Counter stopped', { count })
}
