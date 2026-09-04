# The store as a React hook

> See how `create` turns the vanilla store into a hook, how `useStore` bridges it to React via useSyncExternalStore, and why no Provider is needed.

## create = store + hook

### A hook with the API stapled on
`create` builds a vanilla store, then returns a hook. It also copies the store’s methods (`setState`, `getState`, `subscribe`, `getInitialState`) onto the hook, so `useBear` is both a hook AND a handle you can call outside React.

```typescript
const createImpl = <T>(createState: StateCreator<T, [], []>) => {
  const api = createStore(createState)

  const useBoundStore: any = (selector?: any) => useStore(api, selector)

  Object.assign(useBoundStore, api)

  return useBoundStore
}
```
_create wraps createStore, returns a hook, and Object.assigns the store API onto it (src/react.ts)._

```jsx
function BearCounter() {
  const bears = useBear((state) => state.bears)
  return <h1>{bears} bears around here...</h1>
}

function Controls() {
  const increasePopulation = useBear((state) => state.increasePopulation)
  return <button onClick={increasePopulation}>one up</button>
}
```
_The "your store is a hook" usage — no Provider anywhere (docs/learn/getting-started/introduction.md)._

> **note:** No `<Provider>` is needed because the store is a module-level singleton you import directly. (Contrast: Redux and Recoil wrap your app in a context provider — see the comparison doc.)

## useStore bridges to React

`useStore` is the bridge. It hands the store’s `subscribe` and a `getSnapshot` (your selector applied to `getState()`) to React’s `useSyncExternalStore`. React owns the subscription lifecycle; zustand just supplies the three functions.

```typescript
export function useStore<TState, StateSlice>(
  api: ReadonlyStoreApi<TState>,
  selector: (state: TState) => StateSlice = identity as any,
) {
  const slice = React.useSyncExternalStore(
    api.subscribe,
    React.useCallback(() => selector(api.getState()), [api, selector]),
    React.useCallback(() => selector(api.getInitialState()), [api, selector]),
  )
  React.useDebugValue(slice)
  return slice
}
```
_useStore = useSyncExternalStore(subscribe, selectorOverGetState, selectorOverInitial) (src/react.ts)._

When `set` notifies React’s listener, React re-runs your selector over the fresh state, compares the result to last time, and re-renders the component only if it changed. The default comparison is `Object.is`.
_Entities: create, selector, listener_

> **warning:** The introduction doc says zustand deals with the "zombie child", "React concurrency", and "context loss" pitfalls. Be precise about how. Context loss between mixed renderers is avoided structurally — `src/react.ts` never uses React context; the hook simply closes over its store. Zombie-child safety was hand-rolled until April 2022 (#550): zustand subscribed with useReducer + refs and re-checked state after subscribing. That code was deleted when zustand adopted `useSyncExternalStore` — React’s public API for subscribing to an external store — which now performs the subscription and the post-subscribe re-check itself; the old zombie-child regression test still passes through it. The concurrency guarantee is React’s: the repo’s docs describe the result ("safe under React concurrency") rather than implementing it.

## Reading and writing outside components

Because the API is stapled onto the hook, you can use the store from plain modules — getState for a non-reactive read, setState to write, subscribe to react. The README shows this directly.

```jsx
const useDogStore = create(() => ({ paw: true, snout: true, fur: true }))

// Getting non-reactive fresh state
const paw = useDogStore.getState().paw
// Listening to all changes, fires synchronously on every change
const unsub1 = useDogStore.subscribe(console.log)
// Updating state, will trigger listeners
useDogStore.setState({ paw: false })
// Unsubscribe listeners
unsub1()
```
_Non-reactive use of the store outside React (README.md)._

*Exercise (predict): A teammate calls `useBear.getState().bears` inside a component body to render the count, instead of `useBear((s) => s.bears)`. What goes wrong?*
_Hint: getState is non-reactive._
