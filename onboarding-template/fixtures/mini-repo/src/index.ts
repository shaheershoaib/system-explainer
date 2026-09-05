import { createStoreImpl, type Store } from './store'

/** Public factory. Each call returns an independent store with its own log. */
export function createStore(): Store {
  return createStoreImpl()
}
