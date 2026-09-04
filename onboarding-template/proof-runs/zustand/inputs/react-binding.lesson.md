# The store as a React hook

> See how `create` turns the vanilla store into a hook, how `useStore` bridges it to React via useSyncExternalStore, and why no Provider is needed.

## create = store + hook

**The life of one update: the life of one set() call**

Follow one `set()` call from the action that makes it to the component that repaints: five hand-offs inside the store (`src/vanilla.ts`) and three in the React binding (`src/react.ts`). The store side is identical with or without React; React’s involvement starts at step 6.

1. const setState: StoreApi<TState>['setState'] = (partial, replace) => { (vanilla-core / host-app) - An action calls `set`. That `set` is the store’s own `setState`, handed to your state creator as its first argument (`createState(setState, getState, api)`, src/vanilla.ts:95). Its parameters are `(partial, replace)` (src/vanilla.ts:66); the `SetStateInternal` overloads (src/vanilla.ts:1-7) make `replace` optional for the merge form and require `true` for the replace form. Nothing has changed yet.
2. const nextState = typeof partial === 'function' ? (partial as (state: TState) => TState)(state) : partial (vanilla-core) - If `partial` is a function, `setState` calls it with the current `state` and its return value becomes `nextState`; otherwise `partial` itself is `nextState`. Your updater runs synchronously, right here, and `state` is still the previous value.
3. if (!Object.is(nextState, state)) (vanilla-core) - The bail-out. Merge and notify both live inside this `if`, so when your updater returns the current state object itself the call ends here: nothing is merged and no listener fires. Only the reference is compared, never the contents, so a fresh object with identical fields passes this check and goes on to notify everyone.
4. state = (replace ?? (typeof nextState !== 'object' || nextState === null)) ? (nextState as TState) : Object.assign({}, state, nextState) (vanilla-core) - First `const previousState = state` keeps the old value for the listeners (src/vanilla.ts:74). Then the replace-or-merge decision: an explicit `replace` wins (`true` assigns `nextState` wholesale, `false` merges); when you passed none, a non-object or `null` `nextState` is assigned directly and an object is merged with `Object.assign({}, state, nextState)`: a new top-level object, one level deep, so a nested object you did not spread is replaced, not merged.
5. listeners.forEach((listener) => listener(state, previousState)) (vanilla-core) - Notification. Every listener in the store’s `Set` is called synchronously with the new `state` and the `previousState`. There is no filtering here: the store does not know what any subscriber selected, so every subscriber hears about every change. Listeners entered this `Set` through `subscribe` (`listeners.add(listener)`, src/vanilla.ts:88-92).
6. React.useSyncExternalStore (react-bindings / react) - In a React app the listener just called is React’s. The hook that `create` returns delegates to `useStore` (`useStore(api, selector)`, src/react.ts:56), and `useStore` passes `api.subscribe` to `React.useSyncExternalStore` as its subscribe function (src/react.ts:30-31). React subscribes through it, so the callback sitting in the `listeners` Set is React’s own. zustand supplies only three functions here: `api.subscribe` and the two snapshot readers below.
7. selector(api.getState()) (react-bindings / react) - The snapshot reader `useStore` gave React is your selector applied to the store’s current state: `React.useCallback(() => selector(api.getState()), [api, selector])` (src/react.ts:32), where `getState` is simply `() => state` (src/vanilla.ts:83). After the notification React calls it again and compares the new selection with the previous one. (A second reader, `selector(api.getInitialState())`, is passed alongside it, src/react.ts:33.)
8. return slice (react-bindings / react) - Terminal state. When the new selection differs from the previous one, React re-renders the component and `useStore` returns the new `slice` (after `React.useDebugValue(slice)`, src/react.ts:35-36). When it is the same, the component does not re-render even though its listener was called in step 5. That is the whole render-optimization story: notification is broadcast to every subscriber; re-rendering is decided per component by comparing selections.

Two rules fall out of this trace. `set` bails only on the reference your updater returns (step 3), never on contents. Notification reaches every listener (step 5), but re-rendering is decided per component by comparing selections (steps 7 and 8), which is why a narrow selector is the render optimization, and why `useShallow` (the Selectors & re-renders module) exists: it hands back the previous reference when a fresh object is shallow-equal, so the comparison can succeed.

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

> **warning:** The introduction doc says zustand deals with the "zombie child", "React concurrency", and "context loss" pitfalls. Be precise about how. Context loss between mixed renderers is avoided structurally — `src/react.ts` never uses React context; the hook simply closes over its store. Zombie-child safety was hand-rolled until April 2022 (#550): zustand subscribed with useReducer + refs and re-checked state after subscribing. That code was deleted when zustand adopted `useSyncExternalStore` in April 2022 (#550, first through the `use-sync-external-store` shim; the direct `React.useSyncExternalStore` call landed in #2301, January 2024). React’s public API for subscribing to an external store now owns the subscription, and the old zombie-child regression test still passes through it. The concurrency guarantee is React’s: the repo’s docs describe the result ("safe under React concurrency") rather than implementing it.

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
