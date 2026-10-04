export function apply(context, config) {
  const counter = context.services.require({ id: 'example.counter', version: '1.0.0' })
  for (let index = 0; index < config.increments; index += 1) counter.increment()
  context.logger.info('Counter result', { count: counter.read() })
  return () => context.logger.info('Consumer stopped')
}
