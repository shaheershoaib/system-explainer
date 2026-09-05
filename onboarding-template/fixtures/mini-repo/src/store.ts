import { apply, type StoreEvent } from './events'

export interface Store {
  set(key: string, value: string): void
  delete(key: string): void
  get(key: string): string | undefined
  /** Every event ever appended, oldest first. The log is never truncated. */
  history(): readonly StoreEvent[]
}

export function createStoreImpl(): Store {
  const log: StoreEvent[] = []
  let state = new Map<string, string>()
  const append = (event: StoreEvent) => {
    log.push(event)
    state = apply(state, event)
  }
  return {
    set: (key, value) => append({ type: 'set', key, value }),
    delete: (key) => append({ type: 'delete', key }),
    get: (key) => state.get(key),
    history: () => log,
  }
}
