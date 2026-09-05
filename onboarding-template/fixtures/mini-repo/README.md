# tinystore

A minimal event-sourced key-value store used as a fixture for the system-explainer
offline pipeline tests. It is intentionally small: three source files, one job.

- `src/store.ts` holds the store: an append-only log of events and a `get` that folds them.
- `src/events.ts` defines the two event types and the `apply` reducer.
- `src/index.ts` wires a public `createStore()` factory.

Usage:

```ts
import { createStore } from './src/index'
const store = createStore()
store.set('color', 'blue')
store.get('color') // 'blue'
```
