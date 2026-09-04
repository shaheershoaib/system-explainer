# Selectors & re-renders

> Master the one render-performance rule in zustand: a component re-renders when its selected slice changes by Object.is — and learn when you need useShallow or a custom equality fn.

## Object.is is the default gate

### Render optimization is manual and that is the point
zustand does not track which fields you read (the comparison doc contrasts this with Valtio, which optimizes renders through property access). Instead, YOU pick a slice with a selector, and zustand re-renders only when that slice changes by `Object.is` (strict reference equality). Narrow selectors = fewer re-renders.

_(Diagram: flow — set → notify → selective re-render)_

```jsx
const nuts = useBearStore((state) => state.nuts)
const honey = useBearStore((state) => state.honey)
```
_Atomic picks compare with strict equality — efficient by default (README.md)._

## The fresh-object selector trap

The classic zustand selector bug: a selector that builds a NEW object or array every call. Because `Object.is` compares references, the new object is never equal to the last one. With `create` in v5 the consequence is worse than wasted renders: the default `Object.is` comparison fails on every check and, in the words of the useShallow docs, the component "re-subscribes in a loop" that ends in "Maximum update depth exceeded" — the v5 migration guide warns that such selectors "may cause infinite loops", and the useShallow docs call bundling several values into one object "the most common case" of that error. (Before v5, `create` memoized the selection per store snapshot, so the same selector only cost unnecessary re-renders; the v5 migration guide points at `createWithEqualityFn` from `zustand/traditional` "if you need v4 behavior".)

```js
const useMeals = create(() => ({
  papaBear: 'large porridge-pot',
  mamaBear: 'middle-size porridge pot',
  littleBear: 'A little, small, wee pot',
}))

export const BearNames = () => {
  const names = useMeals((state) => Object.keys(state))

  return <div>{names.join(', ')}</div>
}
```
_`Object.keys(state)` is a fresh array each time — the guide describes unnecessary re-renders; with `create` in v5 the unstable snapshot means an infinite update loop (docs/learn/guides/prevent-rerenders-with-use-shallow.md)._

*In the code above, nothing in the store changes at all — no bear orders a new meal. With `create` in v5, does `BearNames` render once and settle?*
No — it never settles. The selector returns a brand-new array each call, so the `Object.is` comparison fails every time and the update loops until it throws "Maximum update depth exceeded" (docs/reference/migrations/migrating-to-v5.md, docs/reference/hooks/use-shallow.md Troubleshooting). No store change is needed — the unstable selection alone triggers it. (The guide phrases the symptom as unnecessary re-renders; the v5 migration guide is the precise statement.)

```js
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

const useMeals = create(() => ({
  papaBear: 'large porridge-pot',
  mamaBear: 'middle-size porridge pot',
  littleBear: 'A little, small, wee pot',
}))

export const BearNames = () => {
  const names = useMeals(useShallow((state) => Object.keys(state)))

  return <div>{names.join(', ')}</div>
}
```
_The fix: wrap the selector in useShallow (docs/learn/guides/prevent-rerenders-with-use-shallow.md)._

## How useShallow and shallow work

`useShallow` keeps a ref to the last slice and returns it unchanged when the new slice is shallow-equal — so React sees the same reference and skips the re-render. The comparison itself is `shallow`, which checks one level deep.

```typescript
export function useShallow<S, U>(selector: (state: S) => U): (state: S) => U {
  const prev = React.useRef<U>(undefined)
  return (state) => {
    const next = selector(state)
    return shallow(prev.current, next)
      ? (prev.current as U)
      : (prev.current = next)
  }
}
```
_useShallow returns the previous reference when shallow-equal (src/react/shallow.ts)._

Default = `Object.is` (one reference check). `useShallow` upgrades that to a one-level structural check: same keys and `Object.is` on each value. It does NOT recurse — a nested object that changed identity still counts as different.
_Entities: selector, shallow-fn_

> **tip:** For anything beyond shallow, the README points to a custom equality function via `createWithEqualityFn` (the `zustand/traditional` entry — covered in the middleware/architecture module).
