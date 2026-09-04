# Middleware, the codebase & architecture

> Learn the one shape every middleware shares (wrap the state creator; wrap set and/or patch the api), tour persist/devtools/immer/redux, then map every concept to the real files and the architecture so you can navigate and extend the code.

## Every middleware is the same shape

### A higher-order state creator
A middleware takes your state creator and returns a new one. Inside, it gets `(set, get, api)` and typically wraps `set` and/or patches methods on `api`. `combine` is the gentlest example — it wraps none of them; it just merges an initial state object in front of your creator’s result and infers the types for you.

```typescript
export function combine<
  T extends object,
  U extends object,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  initialState: T,
  create: StateCreator<T, Mps, Mcs, U>,
): StateCreator<Write<T, U>, Mps, Mcs> {
  return (...args) => Object.assign({}, initialState, (create as any)(...args))
}
```
_combine: the minimal middleware — prepend initial state, run the creator (src/middleware/combine.ts)._

```typescript
const immerImpl: ImmerImpl = (initializer) => (set, get, store) => {
  type T = ReturnType<typeof initializer>

  store.setState = (updater, replace, ...args) => {
    const nextState = (
      typeof updater === 'function' ? produce(updater as any) : updater
    ) as ((s: T) => T) | T | Partial<T>

    return set(nextState, replace as any, ...args)
  }

  return initializer(store.setState, get, store)
}
```
_immer: patch store.setState — and hand that same function to the creator as set — so a "mutate the draft" updater becomes an immutable next state via produce (src/middleware/immer.ts)._

On their normal paths, the shipped middleware that wrap **set** also patch **api.setState**, so the raw api and the creator’s `set` agree: immer assigns `store.setState` (running function updaters through produce), persist reassigns `api.setState` (writing to storage after each change), devtools reassigns it (reporting each change to the extension), and ssrSafe swaps in a throwing setter on the server. One known exception: when persist finds no storage it wraps `set` with a warning and leaves `api.setState` alone (src/middleware/persist.ts:208-219). Beyond setState, subscribeWithSelector overwrites **api.subscribe**, persist adds **api.persist**, devtools adds **api.devtools**, and redux attaches a **dispatch** to the api. `get` reaches every middleware too, but none of the built-ins wrap it. Same skeleton, different interception point.
_Entities: middleware, set-fn, store_

## persist: save & rehydrate

persist wraps `set` to write the (partialized) state to storage after each change, and on creation it reads storage, runs version/migrate, and **shallow-merges** the stored state over the initial state. Storage defaults to localStorage via createJSONStorage.

```typescript
  let options = {
    storage: createJSONStorage<S, void>(() => window.localStorage),
    partialize: (state: S) => state,
    version: 0,
    merge: (persistedState: unknown, currentState: S) => ({
      ...currentState,
      ...(persistedState as object),
    }),
    ...baseOptions,
  }
```
_The default options: localStorage + identity partialize + SHALLOW merge (src/middleware/persist.ts)._

```ts
const positionStore = createStore<PositionStore>()(
  persist(
    (set) => ({
      position: { x: 0, y: 0 },
      setPosition: (position) => set({ position }),
    }),
    { name: 'position-storage' },
  ),
)
```
_Wrapping a store in persist — only `name` is required (docs/reference/middlewares/persist.md)._

> **gotcha:** The default `merge` is a **shallow** merge of persisted state over current state. If you add a nested field to your store in a new release, the persisted blob can overwrite the whole nested object and drop your new defaults — pass a custom `merge` (or `migrate`) when state shape changes.

## redux & devtools

If you miss reducers, the `redux` middleware wires a reducer + initial state and attaches a `dispatch` to both the state and the api. `devtools` connects the store to the Redux DevTools extension and labels each change as an action — but it is not inspection-only: it replaces `api.setState` with a three-argument version that also reports to the extension, and it subscribes to the extension so RESET, ROLLBACK, JUMP_TO_STATE / JUMP_TO_ACTION and IMPORT_STATE write state back into the store through `setStateFromDevtools`. That write-back is what makes time-travel debugging work.

```typescript
const reduxImpl: ReduxImpl = (reducer, initial) => (set, _get, api) => {
  type S = typeof initial
  type A = Parameters<typeof reducer>[1]
  ;(api as any).dispatch = (action: A) => {
    ;(set as NamedSet<S>)((state: S) => reducer(state, action), false, action)
    return action
  }
  ;(api as any).dispatchFromDevtools = true

  return { dispatch: (...args) => (api as any).dispatch(...args), ...initial }
}
```
_redux: attach dispatch(action) that runs your reducer through set (src/middleware/redux.ts)._

> **warning:** The README warns: "middlewares that modify `set` or `get` are not applied to `getState` and `setState`." Take it as a rule for middleware authors: if you wrap only the `set` argument you pass to the creator and never reassign `api.setState`, the raw api will bypass your wrapper. The shipped middleware do patch `api.setState` (immer.ts, persist.ts, devtools.ts, ssrSafe.ts), so the bare `store.setState((s) => { s.count = 10 })` DOES go through immer’s draft handling — the repo’s own test asserts it (tests/immer.test.tsx). The docs’ logger example also patches `api.setState` alongside the wrapped `set` (docs/learn/guides/advanced-typescript.md).

```ts
const useBearStore = create<BearState>()(
  devtools(
    persist(
      (set) => ({
        bears: 0,
        increase: (by) => set((state) => ({ bears: state.bears + by })),
      }),
      {
        name: 'bear-storage',
      },
    ),
  ),
)
```
_Composing middleware — devtools(persist(...)) — and the curried create<State>() typing (README.md)._

> **gotcha:** TypeScript gotcha (README "TypeScript Usage"): write `create<State>()(...)` — note the extra empty `()`. The first call is where YOU annotate the state type (the docs explain it cannot be inferred because the state generic is invariant); the second call lets TypeScript infer everything else — chiefly the middleware mutator list — because generic inference is all-or-nothing (docs/learn/guides/advanced-typescript.md, "Why the currying"). Without middleware, plain `create<State>((set) => ...)` types fine and the repo’s own tests use it. What fails is `create<State>(devtools(persist(...)))` with only `State` given: the mutator list defaults to `[]` and the middleware types no longer line up.

## Where each concept lives

The mental model maps cleanly onto the source. The vanilla core is the foundation; React, traditional (equality-fn) and the middleware all build on it. shallow/useShallow are the exception — a standalone equality helper (src/vanilla/shallow.ts imports nothing; src/react/shallow.ts imports only React and shallow) that you plug into selection alongside the core.

**Concept → code**
- Store (state + listeners, set/get/subscribe): src/vanilla.ts
- set (merge / Object.is bail / notify): src/vanilla.ts
- create() + useStore() (React hook): src/react.ts
- Selector & default Object.is gate: src/react.ts
- shallow & useShallow: src/vanilla/shallow.ts, src/react/shallow.ts
- Custom equality fn (createWithEqualityFn): src/traditional.ts, src/shallow.ts
- Middleware barrel: src/middleware.ts
- persist: src/middleware/persist.ts
- devtools: src/middleware/devtools.ts
- immer / redux / combine / subscribeWithSelector: src/middleware/immer.ts, src/middleware/redux.ts, src/middleware/combine.ts, src/middleware/subscribeWithSelector.ts
- Public entry points: src/index.ts

## The architecture

### Core + bindings + middleware
The vanilla core has no React dependency. React bindings and the equality-fn bindings both wrap `createStore`; shallow/useShallow plug into selection without depending on the core; middleware wraps `set` and patches the `api` (`get` is passed to every middleware, but wrapping it is an unused extension point). At the edges sit the externals: React — plus, for `zustand/traditional`, the `use-sync-external-store` shim — Immer for the immer middleware, a storage backend for persist, and the Redux DevTools extension for devtools. package.json lists react, @types/react, immer and use-sync-external-store as optional peer dependencies.

_(Diagram: architecture — How the pieces fit)_

**Design decisions worth knowing**
- No dependency tracking; selectors are manual — zustand compares selected slices by Object.is rather than tracking what you read — the comparison doc contrasts this with Valtio (property-access tracking) and Jotai/Recoil (atom dependency). Simpler and React-concurrent-safe, at the cost of you choosing slices and using useShallow when needed. _(locked)_
- set merges one level by default — A pragmatic convenience so you can skip `...state` for the common case; nested updates are explicit. replace:true opts out entirely. _(locked)_
- React binding sits on useSyncExternalStore — Uses React’s public external-store API; adopted in April 2022 (#550), replacing a hand-rolled useReducer + refs subscription that handled the zombie-child case by hand — React’s hook now does that work. Context loss is avoided structurally (src/react.ts never uses React context); the concurrency-safety guarantee is React’s, described in the docs rather than implemented in zustand. _(locked)_
- Middleware keep the wrapped set and api.setState in sync by convention, not by construction — Nothing forces a middleware to patch both. The README warns that middlewares modifying set/get are not applied to getState/setState; the shipped set-wrapping middleware (immer, persist, devtools, ssrSafe) patch api.setState on their normal paths, persist’s no-storage fallback is the one path that wraps set alone (a warning wrapper, same state semantics), and none wraps get. _(open-question)_

*Exercise (first-task): Good first task: you want a store hook that re-renders using a CUSTOM equality function (not just Object.is). Which file/export do you reach for, and how does it differ from `create`?*
_Hint: There is a separate entry point for equality functions._
