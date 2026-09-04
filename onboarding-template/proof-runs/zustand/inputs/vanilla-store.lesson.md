# The store, from scratch

> Understand what a zustand store actually is — a closure over a state value and a Set of listeners — and how set/get/subscribe work, with zero React involved.

## A store is a closure, not magic

### The whole store fits on one screen
A zustand store is a function-local `state` variable, the `initialState` it started from, plus a `Set` of listeners. It exposes four methods — `setState`, `getState`, `getInitialState`, `subscribe` — and nothing else. There is no proxy, no dependency tracking, no Provider. Everything else (React bindings, middleware) is built on top of this.

Hold three things in your head: the **state** (one current value), the **listeners** (a Set of callbacks), and **set** (the only thing that changes state and then tells the listeners). That is the entire engine.
_Entities: store, state, listener_

```typescript
  const getState: StoreApi<TState>['getState'] = () => state

  const getInitialState: StoreApi<TState>['getInitialState'] = () =>
    initialState

  const subscribe: StoreApi<TState>['subscribe'] = (listener) => {
    listeners.add(listener)
    // Unsubscribe
    return () => listeners.delete(listener)
  }

  const api = { setState, getState, getInitialState, subscribe }
  const initialState = (state = createState(setState, getState, api))
  return api as any
}
```
_The state creator runs once; its return value is the initial state (src/vanilla.ts)._

> **note:** Notice `createState(setState, getState, api)` — your state creator is handed `set`, `get`, and the store itself. That is why actions you colocate in state can call `set` and `get`.

## How set really works

Every update goes through `set`. Read its body carefully — four steps are baked in here and they explain almost every "why didn’t my component update?" question.

```typescript
  const setState: StoreApi<TState>['setState'] = (partial, replace) => {
    // TODO: Remove type assertion once https://github.com/microsoft/TypeScript/issues/37663 is resolved
    // https://github.com/microsoft/TypeScript/issues/37663#issuecomment-759728342
    const nextState =
      typeof partial === 'function'
        ? (partial as (state: TState) => TState)(state)
        : partial
    if (!Object.is(nextState, state)) {
      const previousState = state
      state =
        (replace ?? (typeof nextState !== 'object' || nextState === null))
          ? (nextState as TState)
          : Object.assign({}, state, nextState)
      listeners.forEach((listener) => listener(state, previousState))
    }
  }
```
_setState: compute → Object.is bail-out → shallow-merge (unless replace) → notify (src/vanilla.ts)._

1) **Compute**: if you passed a function, `set` calls it with the current state to get `next`. 2) **Bail-out**: if `Object.is(next, current)` it does nothing — no merge, no notify. 3) **Merge or replace**: by default it shallow-merges with `Object.assign({}, state, next)` — one level deep only. If you pass `replace: true`, or you omit `replace` and `next` is a primitive or `null`, it assigns `next` directly with no merge (an explicit `replace: false` always merges). 4) **Notify**: it then calls every listener with `(state, prevState)`.
_Entities: set-fn, state, listener_

*You call `set((state) => ({ nested: { count: state.nested.count + 1 } }))` where state is `{ nested: { count: 0 }, other: 5 }`. After the update, is `other` still there?*
Yes — `other` survives. The merge is one level deep: `Object.assign({}, state, { nested })` keeps top-level `other` and overwrites top-level `nested`. But the OLD `nested` object is entirely replaced, not merged — so if `nested` had other keys, they would be gone unless you spread `...state.nested`.

> **gotcha:** `set` merges **only one level**. From the docs: "If you have a nested object, you need to merge them explicitly… `set((state) => ({ nested: { ...state.nested, count: state.nested.count + 1 } }))`."

## Why immutability matters here

Because `set` bails on `Object.is`, the reliable way to trigger an update is to return a **new** object. Mutating the existing state in place never notifies a listener (`set` sees the same reference and returns early); the README states the rule plainly: state has to be updated immutably.

```jsx
const useCountStore = create((set) => ({
  count: 0,
  inc: () => set((state) => ({ count: state.count + 1 })),
}))
```
_The idiomatic update — return a new partial; `set` merges it (docs/learn/guides/immutable-state-and-merging.md)._

*Exercise (find-in-code): Find the exact line in the store that decides whether an update is skipped entirely.*
_Hint: It is a single guard near the top of setState._
