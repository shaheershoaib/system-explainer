export type SetEvent = { type: 'set'; key: string; value: string }
export type DeleteEvent = { type: 'delete'; key: string }
export type StoreEvent = SetEvent | DeleteEvent

/** Fold one event into the materialized state. Deleting a missing key is a no-op. */
export function apply(state: Map<string, string>, event: StoreEvent): Map<string, string> {
  const next = new Map(state)
  if (event.type === 'set') next.set(event.key, event.value)
  else next.delete(event.key)
  return next
}
