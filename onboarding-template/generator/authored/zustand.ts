/**
 * Authored onboarding bundle for **zustand** — the 🐻 bear-necessities state
 * manager for React (and vanilla JS).
 *
 * Grounded entirely in a cold read of /tmp/zustand-proto:
 *   - src/vanilla.ts          → the store: state + Set<Listener>, set/get/subscribe
 *   - src/react.ts            → create() + useStore() over React.useSyncExternalStore
 *   - src/vanilla/shallow.ts  → shallow(a, b) equality
 *   - src/react/shallow.ts    → useShallow(selector) re-render guard
 *   - src/traditional.ts      → createWithEqualityFn / useStoreWithEqualityFn
 *   - src/middleware.ts + src/middleware/*  → persist, devtools, immer, redux, combine,
 *                                             subscribeWithSelector
 *   - docs/learn/** + docs/reference/**     → concepts, intended usage, real pitfalls
 *
 * Schema contract: ../../schema/bundle.ts. The CLI (generator/cli.ts) imports this
 * default export, stamps it, and validates it with the same zod schema + referential
 * integrity checks the engine uses.
 */
import { type OnboardingBundle } from '../../schema/bundle'

const bundle = {
  schemaVersion: '1.0.0',
  system: {
    id: 'zustand',
    name: 'zustand',
    oneLiner:
      'zustand is a small state-management library: you `create` a store holding state plus the functions that update it, components subscribe with a selector, and the store re-renders only the components whose selected slice actually changed.',
    elevatorPitch:
      'A store in zustand is just a closure over a `state` value and a `Set` of listener callbacks. `set` computes the next state, bails out if it is the same reference (`Object.is`), shallow-merges it in, and notifies every listener. In React, `create` wraps that store in a hook backed by `useSyncExternalStore`; the selector you pass picks a slice and the component re-renders only when that slice changes. There are no providers, no reducers, and no boilerplate — but the trade-off is that render optimization is manual: you choose what to select and when to use `useShallow`.',
    outOfScope: [
      'zustand does not deep-merge — `set` merges only one level; nested objects you must spread yourself.',
      'zustand does not auto-track which fields a component reads (unlike Valtio/MobX proxies) — you opt into render optimization with selectors.',
      'zustand does not require a Provider or context — the store is a module-level singleton you import directly.',
      'The core (`zustand/vanilla`) has no React dependency; React bindings live in `zustand/react`.',
    ],
    depth: 'L3',
    audience: 'developer',
    repoUrl: 'https://github.com/pmndrs/zustand',
  },

  // ── External actors: the world the library plugs into ──────────────────────
  actors: [
    {
      id: 'host-app',
      name: 'Host application code',
      role: 'The app that calls create()/createStore, writes the state creator, and reads state in components or plain modules.',
      aka: ['your code', 'the consumer'],
      relationships: [
        { to: 'react', label: 'renders components that subscribe to the store' },
        { to: 'storage', label: 'persists store state via the persist middleware' },
        { to: 'devtools-ext', label: 'inspects actions via the devtools middleware' },
      ],
    },
    {
      id: 'react',
      name: 'React',
      role: 'The rendering library. zustand subscribes to the store through React.useSyncExternalStore and re-renders subscribed components when their selected slice changes.',
      aka: ['react-dom', 'useSyncExternalStore'],
      relationships: [{ to: 'host-app', label: 'calls the store hook during render' }],
    },
    {
      id: 'storage',
      name: 'Web Storage / custom storage',
      role: 'Where the persist middleware reads and writes serialized state. Defaults to window.localStorage via createJSONStorage; can be any getItem/setItem/removeItem backend.',
      aka: ['localStorage', 'sessionStorage', 'StateStorage'],
      relationships: [{ to: 'host-app', label: 'rehydrates state on store creation' }],
    },
    {
      id: 'devtools-ext',
      name: 'Redux DevTools extension',
      role: 'The browser extension the devtools middleware connects to so each state change shows up as a named, time-travellable action.',
      aka: ['@redux-devtools/extension', '__REDUX_DEVTOOLS_EXTENSION__'],
    },
    {
      id: 'immer-lib',
      name: 'Immer',
      role: 'An optional peer dependency. The immer middleware runs your mutating updater through Immer’s `produce`, turning a "mutate the draft" function into an immutable next state.',
      aka: ['produce', 'Draft'],
    },
  ],

  // ── Entities: the core types/concepts of the library ───────────────────────
  entities: [
    {
      id: 'store',
      name: 'Store (StoreApi)',
      definition:
        'The live object returned by createStore. It is a closure over a single `state` value and a `Set` of listeners, exposing exactly four methods: setState, getState, getInitialState, and subscribe. Everything else in zustand is built on top of this.',
      fields: [
        { name: 'setState', example: 'set(partial, replace?)', note: 'Computes next state, bails on Object.is, merges one level, notifies listeners' },
        { name: 'getState', example: '() => state', note: 'Returns the current state synchronously, non-reactively' },
        { name: 'getInitialState', example: '() => initialState', note: 'The state captured when the store was created' },
        { name: 'subscribe', example: '(listener) => unsubscribe', note: 'Adds a listener; returns a function that deletes it' },
      ],
      relationships: [
        { to: 'state', cardinality: 'one-to-one', label: 'holds exactly one current state' },
        { to: 'listener', cardinality: 'one-to-many', label: 'notifies a Set of listeners on change' },
        { to: 'state-creator', cardinality: 'one-to-one', label: 'is initialized by running the state creator' },
      ],
    },
    {
      id: 'state',
      name: 'State',
      definition:
        'The current value held by the store. Conventionally a plain object mixing data fields and the action functions that update them, but it can be any value — a number, an array, etc. Treated as immutable: updates produce a new value, they never mutate in place.',
      fields: [
        { name: 'data fields', example: 'bears: 0', note: 'Plain values you read in components' },
        { name: 'actions', example: 'increasePopulation: () => set(...)', note: 'Functions colocated in state that call set' },
      ],
      relationships: [
        { to: 'action', cardinality: 'one-to-many', label: 'colocates the actions that update it' },
      ],
    },
    {
      id: 'state-creator',
      name: 'State creator (StateCreator)',
      definition:
        'The function you pass to create/createStore. It receives (set, get, store) and returns the initial state object — usually data fields plus actions. It is the single place where the store’s shape and its update logic are defined.',
      fields: [
        { name: 'set', note: 'The bound setState — call it to update' },
        { name: 'get', note: 'Read the latest state inside an action' },
        { name: 'store', note: 'The full StoreApi, for advanced wiring' },
      ],
      relationships: [
        { to: 'store', cardinality: 'one-to-one', label: 'produces the initial state for one store' },
        { to: 'action', cardinality: 'one-to-many', label: 'defines the actions' },
      ],
    },
    {
      id: 'action',
      name: 'Action',
      definition:
        'A function colocated inside the state that updates it by calling `set`. zustand is unopinionated, but the recommended Flux-inspired pattern is to keep actions next to the data they change. Async is fine — just call set when ready.',
      relationships: [
        { to: 'state', cardinality: 'many-to-one', label: 'mutates the state via set' },
      ],
    },
    {
      id: 'set-fn',
      name: 'set (the update function)',
      definition:
        'The function that performs every update. It accepts either a partial object or an updater (state) => partial. By default it SHALLOW-MERGES the result into the current state (one level deep). It first checks Object.is(next, current) and does nothing if they are identical, so an update producing the same reference notifies no listeners.',
      fields: [
        { name: 'partial', example: 'set({ count: 1 })', note: 'Object or updater fn — merged one level deep' },
        { name: 'replace', example: 'set(next, true)', note: 'Second arg: replace the whole state instead of merging' },
      ],
      relationships: [
        { to: 'store', cardinality: 'many-to-one', label: 'writes to the store and triggers notification' },
        { to: 'listener', cardinality: 'one-to-many', label: 'notifies every listener after a real change' },
      ],
    },
    {
      id: 'listener',
      name: 'Listener',
      definition:
        'A callback (state, prevState) => void registered via subscribe and held in the store’s Set. After a real change, set iterates the Set and calls every listener. In React the listener is React’s own re-render scheduler, wired by useSyncExternalStore.',
      relationships: [
        { to: 'store', cardinality: 'many-to-one', label: 'is held in the store’s listener Set' },
      ],
    },
    {
      id: 'create',
      name: 'create (the React factory)',
      definition:
        'The React entry point. create(stateCreator) builds a vanilla store under the hood, then returns a bound hook (useBoundStore) with the StoreApi methods (setState/getState/subscribe/getInitialState) attached to it. Call the hook with a selector to read state reactively; call the attached methods to read/write outside React.',
      relationships: [
        { to: 'store', cardinality: 'one-to-one', label: 'wraps one vanilla store' },
        { to: 'selector', cardinality: 'one-to-many', label: 'is called with a selector per component' },
      ],
    },
    {
      id: 'selector',
      name: 'Selector',
      definition:
        'A function (state) => slice passed to the store hook. It picks the part of state a component cares about. By default zustand compares the selected slice to the previous one with Object.is (strict reference equality) and re-renders only when it differs — so selecting a narrow slice is the primary render optimization.',
      relationships: [
        { to: 'state', cardinality: 'many-to-one', label: 'derives a slice from state' },
        { to: 'create', cardinality: 'many-to-one', label: 'is passed to the store hook' },
      ],
    },
    {
      id: 'shallow-fn',
      name: 'shallow / useShallow',
      definition:
        'shallow(a, b) is an equality function that compares two values one level deep (keys/values for objects, element-by-element for iterables, entries for Map/Set). useShallow(selector) wraps a selector so it returns the previous reference when the new slice is shallow-equal — preventing a re-render when a selector builds a fresh object/array each call but its contents did not change.',
      relationships: [
        { to: 'selector', cardinality: 'one-to-one', label: 'wraps a selector to compare its output shallowly' },
      ],
    },
    {
      id: 'middleware',
      name: 'Middleware',
      definition:
        'A higher-order state-creator: a function that takes a state creator and returns a new one, intercepting `set`, `get`, or `api` to add behavior. persist, devtools, immer, redux, combine, and subscribeWithSelector are all middleware. They nest, so create(devtools(persist(creator, opts))) composes their effects.',
      relationships: [
        { to: 'state-creator', cardinality: 'one-to-one', label: 'wraps a state creator and returns a new one' },
        { to: 'set-fn', cardinality: 'many-to-one', label: 'intercepts set/get/api to add behavior' },
      ],
    },
    {
      id: 'persist',
      name: 'persist middleware',
      definition:
        'Middleware that saves state to a storage backend and rehydrates it on creation. It wraps set so every update writes through to storage, and on init it reads the stored value, runs version/migrate checks, and shallow-merges it over the initial state. Storage defaults to localStorage via createJSONStorage.',
      relationships: [
        { to: 'middleware', cardinality: 'many-to-one', label: 'is a middleware' },
        { to: 'store', cardinality: 'one-to-one', label: 'persists and rehydrates one store' },
      ],
    },
    {
      id: 'devtools',
      name: 'devtools middleware',
      definition:
        'Middleware that connects the store to the Redux DevTools browser extension. It wraps set with an optional action name so each change appears as a labelled, time-travellable entry. It does not change state behavior — purely an inspection layer.',
      relationships: [
        { to: 'middleware', cardinality: 'many-to-one', label: 'is a middleware' },
      ],
    },
  ],

  // ── Verbs: the behaviors ───────────────────────────────────────────────────
  verbs: [
    {
      id: 'create-store',
      name: 'create a store',
      trigger: 'App calls create(creator) or createStore(creator) at module load.',
      entitiesTouched: ['create', 'store', 'state-creator', 'state'],
      stateChange: 'Runs the state creator with (set, get, api); the returned object becomes the initial state; an empty listener Set is allocated.',
      failureModes: [
        'Forgetting the extra () in create<State>()(...) — TypeScript needs the curried call to infer the state type.',
      ],
    },
    {
      id: 'update-state',
      name: 'update state with set',
      trigger: 'An action (or external code) calls set(partial) / setState(partial).',
      entitiesTouched: ['set-fn', 'state', 'store', 'listener'],
      stateChange: 'Computes next state (calls the updater if it is a function); if Object.is(next, current) it stops; otherwise it shallow-merges (one level) unless replace is true, then notifies every listener.',
      failureModes: [
        'Mutating state in place (state.x = ...) instead of returning a new object — listeners never fire because the reference is unchanged.',
        'Assuming a deep merge — nested objects are replaced, not merged; you must spread them yourself.',
        'Using replace:true and accidentally wiping out your actions along with the data.',
      ],
    },
    {
      id: 'select-and-render',
      name: 'select state and re-render',
      trigger: 'A component calls the store hook with a selector during render.',
      entitiesTouched: ['create', 'selector', 'state', 'listener'],
      stateChange: 'useSyncExternalStore subscribes the component; after each set, the selector re-runs and the component re-renders only if its slice changed by Object.is (or by useShallow / a custom equality fn).',
      failureModes: [
        'Returning a fresh object/array from a selector every call → Object.is always false → re-renders on every store change. Fix with useShallow.',
      ],
    },
    {
      id: 'subscribe-outside',
      name: 'subscribe outside React',
      trigger: 'Code calls store.subscribe(listener) (often inside a useEffect, or in a plain module).',
      entitiesTouched: ['store', 'listener'],
      stateChange: 'Adds the listener to the Set and returns an unsubscribe fn that deletes it. The listener fires synchronously on every real change with (state, prevState).',
      failureModes: ['Forgetting to call the returned unsubscribe → leaked listener.'],
    },
    {
      id: 'persist-rehydrate',
      name: 'persist & rehydrate',
      trigger: 'A store wrapped in persist(...) is created; later, set is called.',
      entitiesTouched: ['persist', 'store', 'state'],
      stateChange: 'On creation, reads storage, runs version/migrate, and shallow-merges the stored state over the initial state. Each subsequent set writes the partialized state back to storage.',
      failureModes: [
        'Expecting persisted nested state to deep-merge with new code defaults — the default merge is shallow.',
        'Reading state on the server before hydration completes (SSR) — values may be the pre-hydration defaults.',
      ],
    },
  ],

  // ── Flows: a step-by-step of the central update→render cycle ───────────────
  flows: [
    {
      id: 'set-notify-render',
      title: 'An action runs: set → bail-check → merge → notify → re-render',
      steps: [
        { label: 'A component calls an action', actor: 'host-app', entity: 'action', note: 'e.g. onClick={increasePopulation}' },
        { label: 'The action calls set with an updater', entity: 'set-fn', note: 'set((state) => ({ bears: state.bears + 1 }))' },
        { label: 'set computes the next state', entity: 'set-fn', note: 'Runs the updater fn against the current state' },
        { label: 'Object.is bail-out check', entity: 'set-fn', note: 'If next === current, stop here — no notification' },
        { label: 'Shallow-merge (unless replace)', entity: 'state', note: 'Object.assign({}, state, next) — one level deep' },
        { label: 'Notify every listener', entity: 'listener', note: 'listeners.forEach(l => l(state, prevState))' },
        { label: 'React re-runs each subscribed selector', actor: 'react', entity: 'selector', note: 'via useSyncExternalStore’s getSnapshot' },
        { label: 'Components whose slice changed re-render', actor: 'react', entity: 'create', note: 'Compared by Object.is / useShallow / custom eq fn' },
      ],
    },
  ],

  // ── Optional simulation: the live state ledger of one update cycle ─────────
  simulations: [
    {
      id: 'bear-counter-sim',
      title: 'Walk the update cycle: who re-renders?',
      subject: 'A bear store with { bears, fish } and two components: <BearCount> selects bears, <FishCount> selects fish.',
      intro:
        'Follow one click through set → Object.is → merge → notify → selective re-render. The ledger tracks bears, fish, and how many components React actually re-rendered.',
      variables: [
        { key: 'bears', label: 'state.bears', kind: 'number', initial: 0 },
        { key: 'fish', label: 'state.fish', kind: 'number', initial: 3 },
        { key: 'renders', label: 'components re-rendered this step', kind: 'number', initial: 0 },
      ],
      steps: [
        {
          id: 'sim-click',
          title: 'User clicks "one up"',
          narrative:
            'increasePopulation runs set((s) => ({ bears: s.bears + 1 })). How does set decide what to do, and which components re-render?',
          actor: 'host-app',
          decision: {
            prompt: 'What does set do, and who re-renders?',
            options: [
              {
                id: 'opt-correct',
                label: 'Compute next, see bears changed, shallow-merge, notify all listeners; only <BearCount> re-renders because only its selected slice changed.',
                correct: true,
                outcome:
                  'Right. set merges { bears: 1 } over the state. Every listener is notified, but React re-runs each selector and Object.is says fish is unchanged — so <FishCount> is skipped. Exactly one component re-renders.',
                effects: [{ add: { bears: 1, renders: 1 }, note: 'bears 0→1; one component re-rendered' }],
              },
              {
                id: 'opt-both',
                label: 'Both components re-render because the whole store object is a new reference.',
                outcome:
                  'A common misread. The store object IS new, but each component compares only its SELECTED slice. fish’s slice is Object.is-equal, so <FishCount> does not re-render.',
                effects: [{ add: { bears: 1, renders: 1 }, note: 'still only one true re-render' }],
              },
              {
                id: 'opt-none',
                label: 'Nothing happens because set mutated state in place.',
                outcome:
                  'That would be the bug, not this code. Here we return a NEW object, so the reference changes, the Object.is bail-out passes, and listeners fire.',
                effects: [{ note: 'no change applied in this (incorrect) reading' }],
              },
            ],
          },
        },
        {
          id: 'sim-noop',
          title: 'An action calls set with the same value',
          narrative:
            'Now an action runs set((s) => ({ bears: s.bears })) — it returns bears unchanged. What happens?',
          decision: {
            prompt: 'Do any listeners fire?',
            options: [
              {
                id: 'noop-correct',
                label: 'No listeners fire — the merged result is a new object, but if the action returned the exact same state reference, Object.is short-circuits.',
                correct: true,
                outcome:
                  'Careful nuance: set checks Object.is on the value the updater returns BEFORE merging. Returning a brand-new object { bears } is a new reference, so it WOULD notify. To truly no-op you must return the same state reference (e.g. return state).',
                effects: [{ note: 'Teaches the exact bail-out point: Object.is(next, current) on the updater’s return value' }],
              },
              {
                id: 'noop-wrong',
                label: 'zustand deep-compares the values and skips because bears is the same number.',
                outcome:
                  'No — zustand never deep-compares state in set. The only check is Object.is on the reference returned by your updater.',
                effects: [{ note: 'no deep comparison exists in set' }],
              },
            ],
          },
        },
      ],
      outro:
        'Two rules do all the work: (1) set bails only on Object.is of the value your updater returns, and (2) a component re-renders only when ITS selected slice changes by Object.is (or useShallow / a custom eq fn).',
    },
  ],

  // ── Architecture (L3) ──────────────────────────────────────────────────────
  architecture: {
    components: [
      { id: 'vanilla-core', name: 'Vanilla core', kind: 'service', tech: 'src/vanilla.ts', note: 'createStore: state + listener Set + set/get/subscribe. No React.' },
      { id: 'react-bindings', name: 'React bindings', kind: 'frontend', tech: 'src/react.ts', note: 'create() + useStore() over React.useSyncExternalStore' },
      { id: 'traditional', name: 'Equality-fn bindings', kind: 'frontend', tech: 'src/traditional.ts', note: 'createWithEqualityFn / useStoreWithEqualityFn via use-sync-external-store/with-selector' },
      { id: 'shallow-mod', name: 'shallow + useShallow', kind: 'service', tech: 'src/vanilla/shallow.ts, src/react/shallow.ts', note: 'One-level equality + selector re-render guard' },
      { id: 'middleware-mod', name: 'Middleware bundle', kind: 'service', tech: 'src/middleware/*', note: 'persist, devtools, immer, redux, combine, subscribeWithSelector' },
      { id: 'react-ext', name: 'React', kind: 'external', tech: 'react >=18', note: 'Schedules re-renders; provides useSyncExternalStore' },
      { id: 'storage-ext', name: 'Storage', kind: 'datastore', tech: 'localStorage / custom', note: 'persist read/write target' },
      { id: 'devtools-ext-c', name: 'Redux DevTools', kind: 'external', tech: 'browser extension', note: 'devtools action log / time travel' },
    ],
    connections: [
      { from: 'react-bindings', to: 'vanilla-core', label: 'wraps createStore' },
      { from: 'traditional', to: 'vanilla-core', label: 'wraps createStore' },
      { from: 'react-bindings', to: 'react-ext', label: 'useSyncExternalStore' },
      { from: 'traditional', to: 'shallow-mod', label: 'default equality fn = shallow' },
      { from: 'react-bindings', to: 'shallow-mod', label: 'useShallow guards selectors' },
      { from: 'middleware-mod', to: 'vanilla-core', label: 'wraps set/get/api' },
      { from: 'middleware-mod', to: 'storage-ext', label: 'persist read/write' },
      { from: 'middleware-mod', to: 'devtools-ext-c', label: 'devtools connect' },
    ],
  },

  // ── Modules ────────────────────────────────────────────────────────────────
  modules: [
    // M1 — the vanilla store model
    {
      id: 'vanilla-store',
      title: 'The store, from scratch',
      order: 1,
      objective:
        'Understand what a zustand store actually is — a closure over a state value and a Set of listeners — and how set/get/subscribe work, with zero React involved.',
      oneJob: 'Build the mental model of the store before any React enters the picture.',
      estMinutes: 12,
      entitiesIntroduced: ['store', 'state', 'state-creator', 'action', 'set-fn', 'listener'],
      actorsIntroduced: ['host-app'],
      diagrams: [{ kind: 'er', title: 'The core types', scope: ['store', 'state', 'state-creator', 'action', 'set-fn', 'listener'] }],
      lessons: [
        {
          id: 'vs-what',
          title: 'A store is a closure, not magic',
          blocks: [
            {
              type: 'prose',
              heading: 'The whole store is ~30 lines',
              md: 'A zustand store is a function-local `state` variable plus a `Set` of listeners. It exposes four methods — `setState`, `getState`, `getInitialState`, `subscribe` — and nothing else. There is no proxy, no dependency tracking, no Provider. Everything else (React bindings, middleware) is built on top of this.',
            },
            {
              type: 'mental-model',
              heading: 'The three nouns',
              entities: ['store', 'state', 'listener'],
              verbs: ['update-state', 'subscribe-outside'],
              md: 'Hold three things in your head: the **state** (one current value), the **listeners** (a Set of callbacks), and **set** (the only thing that changes state and then tells the listeners). That is the entire engine.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/vanilla.ts',
              caption: 'The state creator runs once; its return value is the initial state (src/vanilla.ts).',
              highlightLines: [4, 5],
              code: `let state: TState
const listeners: Set<Listener> = new Set()
// ...
const api = { setState, getState, getInitialState, subscribe }
const initialState = (state = createState(setState, getState, api))
return api as any`,
            },
            {
              type: 'callout',
              variant: 'note',
              md: 'Notice `createState(setState, getState, api)` — your state creator is handed `set`, `get`, and the store itself. That is why actions you colocate in state can call `set` and `get`.',
            },
          ],
        },
        {
          id: 'vs-set',
          title: 'How set really works',
          blocks: [
            {
              type: 'prose',
              md: 'Every update goes through `set`. Read its body carefully — three behaviors are baked in here and they explain almost every "why didn’t my component update?" question.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/vanilla.ts',
              caption: 'setState: compute → Object.is bail-out → shallow-merge (unless replace) → notify (src/vanilla.ts).',
              highlightLines: [5, 9, 11],
              code: `const setState = (partial, replace) => {
  const nextState =
    typeof partial === 'function'
      ? partial(state)
      : partial
  if (!Object.is(nextState, state)) {
    const previousState = state
    state =
      (replace ?? (typeof nextState !== 'object' || nextState === null))
        ? nextState
        : Object.assign({}, state, nextState)
    listeners.forEach((listener) => listener(state, previousState))
  }
}`,
            },
            {
              type: 'mental-model',
              heading: 'The three behaviors of set',
              entities: ['set-fn', 'state', 'listener'],
              verbs: ['update-state'],
              md: '1) **Bail-out**: if `Object.is(next, current)` it does nothing — no merge, no notify. 2) **Shallow merge**: otherwise it does `Object.assign({}, state, next)` — one level deep only. 3) **Notify**: it then calls every listener with `(state, prevState)`.',
            },
            {
              type: 'predict-reveal',
              prompt: 'You call `set((state) => ({ nested: { count: state.nested.count + 1 } }))` where state is `{ nested: { count: 0 }, other: 5 }`. After the update, is `other` still there?',
              reveal:
                'Yes — `other` survives. The merge is one level deep: `Object.assign({}, state, { nested })` keeps top-level `other` and overwrites top-level `nested`. But the OLD `nested` object is entirely replaced, not merged — so if `nested` had other keys, they would be gone unless you spread `...state.nested`.',
              hint: 'The merge happens at the top level. What gets replaced wholesale?',
            },
            {
              type: 'callout',
              variant: 'gotcha',
              md: '`set` merges **only one level**. From the docs: "If you have a nested object, you need to merge them explicitly… `set((state) => ({ nested: { ...state.nested, count: state.nested.count + 1 } }))`."',
              smeQuestion: 'Is there any case in our codebase where a single-level merge silently drops nested keys we rely on?',
            },
          ],
        },
        {
          id: 'vs-immutable',
          title: 'Why immutability matters here',
          blocks: [
            {
              type: 'prose',
              md: 'Because `set` bails on `Object.is`, the reliable way to trigger an update is to return a **new** object. Mutating the existing state in place changes nothing React (or any listener) can detect.',
            },
            {
              type: 'code',
              language: 'jsx',
              sourcePath: 'docs/learn/guides/immutable-state-and-merging.md',
              caption: 'The idiomatic update — return a new partial; `set` merges it (docs/learn/guides/immutable-state-and-merging.md).',
              code: `const useCountStore = create((set) => ({
  count: 0,
  inc: () => set((state) => ({ count: state.count + 1 })),
}))`,
            },
            {
              type: 'exercise',
              kind: 'find-in-code',
              prompt: 'Find the exact line in the store that decides whether an update is skipped entirely.',
              hint: 'It is a single guard near the top of setState.',
              files: ['src/vanilla.ts'],
              modelAnswer:
                '`if (!Object.is(nextState, state))` in `setState` (src/vanilla.ts). If the value your updater returns is the same reference as the current state, the whole merge-and-notify block is skipped.',
            },
          ],
        },
      ],
      quiz: [
        {
          id: 'vs-q-merge',
          type: 'mcq',
          prompt: 'You call `set({ a: 1 })` on a store whose state is `{ a: 0, b: { x: 1 } }`. What is the resulting state?',
          options: [
            { id: 'a', text: '{ a: 1, b: { x: 1 } } — top-level merge keeps b untouched.', correct: true },
            {
              id: 'b',
              text: '{ a: 1 } — set replaces the whole state.',
              correct: false,
              ifChosen:
                'No — that is the `replace: true` behavior. By default `set` does a one-level merge (`Object.assign({}, state, partial)`), so `b` is preserved. You only get a full replace when you pass `true` as the second argument.',
            },
            { id: 'c', text: '{ a: 1, b: {} } — b is deep-reset.', correct: false, ifChosen: 'No — set never touches keys you did not mention. `b` keeps its exact reference; the merge is shallow and only at the top level.' },
          ],
          explanation:
            'The default `set` does a shallow (one-level) merge: `Object.assign({}, state, partial)`. Unmentioned top-level keys are preserved by reference; mentioned ones are overwritten wholesale.',
          misconception: {
            id: 'mc-set-replaces',
            trap: 'set replaces the entire state object',
            correction: 'set MERGES one level by default; full replace requires the second argument `replace: true`.',
            relatedEntities: ['set-fn', 'state'],
          },
          difficulty: 'core',
        },
        {
          id: 'vs-q-bail',
          type: 'mcq',
          prompt: 'An action does `state.count++` directly and never calls set. What do subscribers see?',
          options: [
            {
              id: 'a',
              text: 'Nothing — no listener fires.',
              correct: true,
            },
            {
              id: 'b',
              text: 'They all fire because the value changed.',
              correct: false,
              ifChosen:
                'No — listeners only ever fire from inside `set`, after the `Object.is` check passes. Mutating state in place never calls `set`, so the listener Set is never iterated. (And even if you fed the mutated object back into set, it would be the same reference and bail out.)',
            },
          ],
          explanation:
            'Listeners are notified only inside `setState`, and only when `Object.is(next, current)` is false. A direct mutation bypasses `set` entirely, so nothing is notified.',
          misconception: {
            id: 'mc-mutation-notifies',
            trap: 'Mutating state in place will still notify subscribers',
            correction: 'Only set notifies, and only on a real (Object.is-distinct) change; in-place mutation is invisible.',
            relatedEntities: ['set-fn', 'listener'],
          },
          difficulty: 'core',
        },
        {
          id: 'vs-q-spotbug',
          type: 'spot-bug',
          prompt: 'This action should add a bear, but subscribers never update. Which line is the bug?',
          language: 'js',
          lines: [
            'increasePopulation: () => {',
            '  const s = get()',
            '  s.bears = s.bears + 1',
            '  set(s)',
            '}',
          ],
          buggyLine: 3,
          explanation:
            'Line 3 mutates the existing state object in place. set then receives the SAME reference, so Object.is(next, current) is true and the update bails out — no listener fires.',
          fix: 'Return a NEW object instead: set((s) => ({ bears: s.bears + 1 })).',
          misconception: {
            id: 'mc-mutate-then-set',
            trap: 'Mutating state then calling set(state) triggers an update',
            correction: 'set bails on Object.is; passing the same (mutated) reference notifies nobody — return a new object.',
            relatedEntities: ['set-fn', 'state'],
          },
          difficulty: 'core',
        },
        {
          id: 'vs-q-order',
          type: 'ordering',
          prompt: 'Put the steps of a single `set(updater)` call in order.',
          items: [
            { id: 'i1', text: 'Run the updater function against the current state to get nextState' },
            { id: 'i2', text: 'Check Object.is(nextState, state) — bail out if equal' },
            { id: 'i3', text: 'Shallow-merge nextState into state (unless replace)' },
            { id: 'i4', text: 'Call every listener with (state, prevState)' },
          ],
          explanation: 'compute → bail-check → merge → notify. The bail-check sits before the merge, so a same-reference result skips everything.',
          difficulty: 'core',
        },
      ],
    },

    // M2 — using it in React
    {
      id: 'react-binding',
      title: 'The store as a React hook',
      order: 2,
      prerequisites: ['vanilla-store'],
      objective:
        'See how `create` turns the vanilla store into a hook, how `useStore` bridges it to React via useSyncExternalStore, and why no Provider is needed.',
      oneJob: 'Connect the vanilla store model to React rendering.',
      estMinutes: 12,
      entitiesIntroduced: ['create', 'selector'],
      actorsIntroduced: ['react'],
      lessons: [
        {
          id: 'rb-create',
          title: 'create = store + hook',
          blocks: [
            {
              type: 'prose',
              heading: 'A hook with the API stapled on',
              md: '`create` builds a vanilla store, then returns a hook. It also copies the store’s methods (`setState`, `getState`, `subscribe`, `getInitialState`) onto the hook, so `useBear` is both a hook AND a handle you can call outside React.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/react.ts',
              caption: 'create wraps createStore, returns a hook, and Object.assigns the store API onto it (src/react.ts).',
              highlightLines: [2, 4, 6],
              code: `const createImpl = (createState) => {
  const api = createStore(createState)
  const useBoundStore = (selector) => useStore(api, selector)
  Object.assign(useBoundStore, api)
  return useBoundStore
}`,
            },
            {
              type: 'code',
              language: 'jsx',
              sourcePath: 'docs/learn/getting-started/introduction.md',
              caption: 'The "your store is a hook" usage — no Provider anywhere (docs/learn/getting-started/introduction.md).',
              code: `const useBear = create((set) => ({
  bears: 0,
  increasePopulation: () => set((state) => ({ bears: state.bears + 1 })),
}))

function BearCounter() {
  const bears = useBear((state) => state.bears)
  return <h1>{bears} bears around here...</h1>
}`,
            },
            {
              type: 'callout',
              variant: 'note',
              md: 'No `<Provider>` is needed because the store is a module-level singleton you import directly. (Contrast: Redux and Recoil wrap your app in a context provider — see the comparison doc.)',
            },
          ],
        },
        {
          id: 'rb-usestore',
          title: 'useStore bridges to React',
          blocks: [
            {
              type: 'prose',
              md: '`useStore` is the bridge. It hands the store’s `subscribe` and a `getSnapshot` (your selector applied to `getState()`) to React’s `useSyncExternalStore`. React owns the subscription lifecycle; zustand just supplies the three functions.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/react.ts',
              caption: 'useStore = useSyncExternalStore(subscribe, selectorOverGetState, selectorOverInitial) (src/react.ts).',
              highlightLines: [2, 3, 4],
              code: `const slice = React.useSyncExternalStore(
  api.subscribe,
  React.useCallback(() => selector(api.getState()), [api, selector]),
  React.useCallback(() => selector(api.getInitialState()), [api, selector]),
)
return slice`,
            },
            {
              type: 'mental-model',
              heading: 'The render path',
              entities: ['create', 'selector', 'listener'],
              verbs: ['select-and-render'],
              md: 'When `set` notifies React’s listener, React re-runs your selector over the fresh state, compares the result to last time, and re-renders the component only if it changed. The default comparison is `Object.is`.',
            },
            {
              type: 'callout',
              variant: 'warning',
              md: 'Using `useSyncExternalStore` is exactly how zustand sidesteps the "zombie child", "React concurrency", and "context loss" problems the introduction doc calls out — it is the official React API for subscribing to an external store.',
            },
          ],
        },
        {
          id: 'rb-outside',
          title: 'Reading and writing outside components',
          blocks: [
            {
              type: 'prose',
              md: 'Because the API is stapled onto the hook, you can use the store from plain modules — getState for a non-reactive read, setState to write, subscribe to react. The README shows this directly.',
            },
            {
              type: 'code',
              language: 'jsx',
              sourcePath: 'README.md',
              caption: 'Non-reactive use of the store outside React (README.md).',
              code: `const useDogStore = create(() => ({ paw: true, snout: true, fur: true }))

const paw = useDogStore.getState().paw          // fresh, non-reactive
const unsub = useDogStore.subscribe(console.log) // fires on every change
useDogStore.setState({ paw: false })             // triggers listeners
unsub()`,
            },
            {
              type: 'exercise',
              kind: 'predict',
              prompt: 'A teammate calls `useBear.getState().bears` inside a component body to render the count, instead of `useBear((s) => s.bears)`. What goes wrong?',
              hint: 'getState is non-reactive.',
              modelAnswer:
                '`getState()` reads the value once and does NOT subscribe — so the component renders the current count but never re-renders when bears changes. To be reactive you must call the hook with a selector, which routes through useSyncExternalStore.',
            },
          ],
        },
      ],
      quiz: [
        {
          id: 'rb-q-provider',
          type: 'mcq',
          prompt: 'Where do you put the `<Provider>` to make a zustand store available to components?',
          options: [
            { id: 'a', text: 'You don’t — the store is a module singleton you import; no Provider is required.', correct: true },
            {
              id: 'b',
              text: 'At the app root, like Redux’s <Provider store={store}>.',
              correct: false,
              ifChosen:
                'That is the Redux/Recoil model. zustand deliberately needs no Provider: `create` returns a hook bound to a module-level store, and `useStore` subscribes via useSyncExternalStore. (You CAN combine zustand with React context to scope a store per subtree, but it is optional, not required.)',
            },
          ],
          explanation:
            'create returns a hook bound to a singleton store; components import and call it directly. The comparison doc highlights "Redux requires your app to be wrapped in context providers; Zustand does not."',
          misconception: {
            id: 'mc-needs-provider',
            trap: 'zustand needs a Provider at the app root like Redux',
            correction: 'No Provider — the store is an imported module singleton; useStore subscribes via useSyncExternalStore.',
            relatedEntities: ['create', 'react'],
          },
          difficulty: 'intro',
        },
        {
          id: 'rb-q-getstate',
          type: 'short-answer',
          prompt: 'Why does reading state with `store.getState()` in a component body not cause the component to re-render on changes, while `store((s) => s.x)` does?',
          modelAnswer:
            'getState() is a one-shot, non-reactive read — it never subscribes. The hook form routes through useStore → React.useSyncExternalStore, which registers a subscription so React re-runs the selector and re-renders when the selected slice changes.',
          rubricKeywords: ['getState', 'non-reactive', 'subscribe', 'useSyncExternalStore', 'selector'],
          difficulty: 'core',
        },
      ],
    },

    // M3 — selectors & re-renders
    {
      id: 'selectors-rerenders',
      title: 'Selectors & re-renders',
      order: 3,
      prerequisites: ['react-binding'],
      objective:
        'Master the one render-performance rule in zustand: a component re-renders when its selected slice changes by Object.is — and learn when you need useShallow or a custom equality fn.',
      oneJob: 'Control exactly which components re-render, and avoid the fresh-object selector trap.',
      estMinutes: 14,
      entitiesIntroduced: ['selector', 'shallow-fn'],
      diagrams: [{ kind: 'flow', flowId: 'set-notify-render', title: 'set → notify → selective re-render' }],
      lessons: [
        {
          id: 'sr-default',
          title: 'Object.is is the default gate',
          blocks: [
            {
              type: 'prose',
              heading: 'Render optimization is manual and that is the point',
              md: 'zustand does not track which fields you read (unlike Valtio/MobX). Instead, YOU pick a slice with a selector, and zustand re-renders only when that slice changes by `Object.is` (strict reference equality). Narrow selectors = fewer re-renders.',
            },
            {
              type: 'diagram',
              diagram: { kind: 'flow', flowId: 'set-notify-render', title: 'set → notify → selective re-render' },
            },
            {
              type: 'code',
              language: 'jsx',
              sourcePath: 'README.md',
              caption: 'Atomic picks compare with strict equality — efficient by default (README.md).',
              code: `// It detects changes with strict-equality (old === new) by default
const nuts = useBearStore((state) => state.nuts)
const honey = useBearStore((state) => state.honey)`,
            },
          ],
        },
        {
          id: 'sr-trap',
          title: 'The fresh-object selector trap',
          blocks: [
            {
              type: 'prose',
              md: 'The single most common zustand performance bug: a selector that builds a NEW object or array every call. Because `Object.is` compares references, the new object is never equal to the last one, so the component re-renders on EVERY store change — even unrelated ones.',
            },
            {
              type: 'code',
              language: 'js',
              sourcePath: 'docs/learn/guides/prevent-rerenders-with-use-shallow.md',
              caption: 'This re-renders on every change — `Object.keys(state)` is a fresh array each time (docs/learn/guides/prevent-rerenders-with-use-shallow.md).',
              code: `const useMeals = create(() => ({
  papaBear: 'large porridge-pot',
  mamaBear: 'middle-size porridge pot',
  littleBear: 'A little, small, wee pot',
}))

export const BearNames = () => {
  const names = useMeals((state) => Object.keys(state))
  return <div>{names.join(', ')}</div>
}`,
            },
            {
              type: 'predict-reveal',
              prompt: 'In the code above, another bear’s meal changes (e.g. `papaBear` becomes "a large pizza"), but the SET of keys is identical. Does `BearNames` re-render?',
              reveal:
                'Yes — and that is the bug. The selector returns a brand-new array each call, so `Object.is(prevArray, newArray)` is false and the component re-renders even though the key set did not change. The docs call this out explicitly.',
              hint: 'What does Object.keys() return each time — the same array, or a new one?',
            },
            {
              type: 'code',
              language: 'js',
              sourcePath: 'docs/learn/guides/prevent-rerenders-with-use-shallow.md',
              caption: 'The fix: wrap the selector in useShallow (docs/learn/guides/prevent-rerenders-with-use-shallow.md).',
              highlightLines: [2, 7],
              code: `import { useShallow } from 'zustand/react/shallow'

export const BearNames = () => {
  const names = useMeals(useShallow((state) => Object.keys(state)))
  return <div>{names.join(', ')}</div>
}`,
            },
          ],
        },
        {
          id: 'sr-shallow',
          title: 'How useShallow and shallow work',
          blocks: [
            {
              type: 'prose',
              md: '`useShallow` keeps a ref to the last slice and returns it unchanged when the new slice is shallow-equal — so React sees the same reference and skips the re-render. The comparison itself is `shallow`, which checks one level deep.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/react/shallow.ts',
              caption: 'useShallow returns the previous reference when shallow-equal (src/react/shallow.ts).',
              highlightLines: [4, 5, 6],
              code: `export function useShallow(selector) {
  const prev = React.useRef(undefined)
  return (state) => {
    const next = selector(state)
    return shallow(prev.current, next)
      ? prev.current
      : (prev.current = next)
  }
}`,
            },
            {
              type: 'mental-model',
              heading: 'Object.is vs shallow',
              entities: ['selector', 'shallow-fn'],
              md: 'Default = `Object.is` (one reference check). `useShallow` upgrades that to a one-level structural check: same keys and `Object.is` on each value. It does NOT recurse — a nested object that changed identity still counts as different.',
            },
            {
              type: 'callout',
              variant: 'tip',
              md: 'For anything beyond shallow, the README points to a custom equality function via `createWithEqualityFn` (the `zustand/traditional` entry — covered in the middleware/architecture module).',
            },
          ],
        },
      ],
      quiz: [
        {
          id: 'sr-q-trap',
          type: 'mcq',
          prompt: 'A selector returns `{ a: state.a, b: state.b }`. Even when neither a nor b changes, the component re-renders on every store update. Why, and what is the fix?',
          options: [
            {
              id: 'a',
              text: 'The selector builds a new object each call, so Object.is is always false; wrap it in useShallow.',
              correct: true,
            },
            {
              id: 'b',
              text: 'zustand re-renders all subscribers on every set; there is no fix.',
              correct: false,
              ifChosen:
                'No — zustand re-renders a component only when ITS selected slice changes. The problem is specific: your selector returns a fresh object literal each call, so the default Object.is reference check always fails. `useShallow((s) => ({ a: s.a, b: s.b }))` compares one level deep and returns the previous reference when a and b are unchanged.',
            },
            {
              id: 'c',
              text: 'You must call set with replace:true to stop the re-renders.',
              correct: false,
              ifChosen:
                'replace is about how state is merged on write, not about how selectors compare on read. The re-render is driven by the selector returning a new reference; the fix is useShallow (or a custom equality fn).',
            },
          ],
          explanation:
            'Default selection compares the slice by Object.is. A selector returning a new object/array each call never matches its previous result, forcing re-renders. useShallow does a one-level comparison and reuses the prior reference when equal.',
          misconception: {
            id: 'mc-fresh-object-selector',
            trap: 'Re-renders on every change mean zustand ignores selectors',
            correction: 'Selectors ARE respected via Object.is; a fresh object/array from the selector defeats it — fix with useShallow.',
            relatedEntities: ['selector', 'shallow-fn'],
          },
          difficulty: 'core',
        },
        {
          id: 'sr-q-shallow-depth',
          type: 'mcq',
          prompt: 'Your slice is `{ user: { name } }` and only `name` changed (a new inner object). You used `useShallow`. Does it prevent the re-render?',
          options: [
            {
              id: 'a',
              text: 'No — shallow only compares one level, and the inner user object is a new reference, so it counts as changed.',
              correct: true,
            },
            {
              id: 'b',
              text: 'Yes — useShallow deep-compares, so identical names mean no re-render.',
              correct: false,
              ifChosen:
                'shallow is explicitly one level deep: it does Object.is on each top-level value. The `user` value is a new object reference, so shallow reports a difference and the component re-renders. For deeper structures you need a custom equality fn (createWithEqualityFn).',
            },
          ],
          explanation:
            'shallow compares only the top level (keys + Object.is on each value). A changed nested object is a new reference at the top level, so it is treated as different.',
          misconception: {
            id: 'mc-shallow-is-deep',
            trap: 'useShallow does a deep comparison',
            correction: 'shallow is one level only; nested identity changes still trigger re-renders.',
            relatedEntities: ['shallow-fn', 'selector'],
          },
          difficulty: 'stretch',
        },
      ],
    },

    // M4 — middleware, codebase map & architecture (the L3 / contributor layer)
    {
      id: 'middleware-and-code',
      title: 'Middleware, the codebase & architecture',
      order: 4,
      prerequisites: ['selectors-rerenders'],
      objective:
        'Learn the one shape every middleware shares (wrap the state creator, intercept set/get/api), tour persist/devtools/immer/redux, then map every concept to the real files and the architecture so you can navigate and extend the code.',
      oneJob: 'Turn the concept model into the ability to read and change the real zustand source.',
      estMinutes: 20,
      capstone: true,
      entitiesIntroduced: ['middleware', 'persist', 'devtools'],
      actorsIntroduced: ['storage', 'devtools-ext', 'immer-lib'],
      diagrams: [
        { kind: 'architecture', title: 'How the pieces fit' },
        { kind: 'er', title: 'Middleware in the type model', scope: ['middleware', 'persist', 'devtools', 'state-creator', 'store'] },
      ],
      lessons: [
        {
          id: 'mc-shape',
          title: 'Every middleware is the same shape',
          blocks: [
            {
              type: 'prose',
              heading: 'A higher-order state creator',
              md: 'A middleware takes your state creator and returns a new one. Inside, it gets `(set, get, api)` and wraps one or more of them. `combine` is the gentlest example — it just merges an initial state object in front of your creator and infers the types for you.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/middleware/combine.ts',
              caption: 'combine: the minimal middleware — prepend initial state, run the creator (src/middleware/combine.ts).',
              code: `export function combine(initialState, create) {
  return (...args) => Object.assign({}, initialState, create(...args))
}`,
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/middleware/immer.ts',
              caption: 'immer: wrap set so a "mutate the draft" updater becomes an immutable next state via produce (src/middleware/immer.ts).',
              highlightLines: [2, 3, 4],
              code: `const immerImpl = (initializer) => (set, get, store) => {
  store.setState = (updater, replace, ...args) => {
    const nextState =
      typeof updater === 'function' ? produce(updater) : updater
    return set(nextState, replace, ...args)
  }
  return initializer(store.setState, get, store)
}`,
            },
            {
              type: 'mental-model',
              heading: 'Wrap set, wrap get, or wrap api',
              entities: ['middleware', 'set-fn', 'store'],
              md: 'persist & immer wrap **set** (immer transforms the updater; persist writes to storage after). subscribeWithSelector & persist also overwrite **api** methods (subscribe / setState). redux attaches a **dispatch** to the api. Same skeleton, different interception point.',
            },
          ],
        },
        {
          id: 'mc-persist',
          title: 'persist: save & rehydrate',
          blocks: [
            {
              type: 'prose',
              md: 'persist wraps `set` to write the (partialized) state to storage after each change, and on creation it reads storage, runs version/migrate, and **shallow-merges** the stored state over the initial state. Storage defaults to localStorage via createJSONStorage.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/middleware/persist.ts',
              caption: 'The default options: localStorage + identity partialize + SHALLOW merge (src/middleware/persist.ts).',
              highlightLines: [2, 4, 5, 6, 7],
              code: `let options = {
  storage: createJSONStorage(() => window.localStorage),
  partialize: (state) => state,
  version: 0,
  merge: (persistedState, currentState) => ({
    ...currentState,
    ...persistedState,
  }),
  ...baseOptions,
}`,
            },
            {
              type: 'code',
              language: 'ts',
              sourcePath: 'docs/reference/middlewares/persist.md',
              caption: 'Wrapping a store in persist — only `name` is required (docs/reference/middlewares/persist.md).',
              code: `const positionStore = createStore()(
  persist(
    (set) => ({
      position: { x: 0, y: 0 },
      setPosition: (position) => set({ position }),
    }),
    { name: 'position-storage' },
  ),
)`,
            },
            {
              type: 'callout',
              variant: 'gotcha',
              md: 'The default `merge` is a **shallow** merge of persisted state over current state. If you add a nested field to your store in a new release, the persisted blob can overwrite the whole nested object and drop your new defaults — pass a custom `merge` (or `migrate`) when state shape changes.',
              smeQuestion: 'For our persisted stores, what is our migrate/version strategy when the state shape changes?',
            },
          ],
        },
        {
          id: 'mc-redux-devtools',
          title: 'redux & devtools',
          blocks: [
            {
              type: 'prose',
              md: 'If you miss reducers, the `redux` middleware wires a reducer + initial state and attaches a `dispatch` to both the state and the api. `devtools` connects the store to the Redux DevTools extension, labelling each change as an action — purely an inspection layer, it does not change state behavior.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/middleware/redux.ts',
              caption: 'redux: attach dispatch(action) that runs your reducer through set (src/middleware/redux.ts).',
              highlightLines: [2, 3],
              code: `const reduxImpl = (reducer, initial) => (set, _get, api) => {
  api.dispatch = (action) => {
    set((state) => reducer(state, action), false, action)
    return action
  }
  return { dispatch: (...a) => api.dispatch(...a), ...initial }
}`,
            },
            {
              type: 'callout',
              variant: 'warning',
              md: 'From the README: "middlewares that modify `set` or `get` are not applied to `getState` and `setState`." So the bare `store.getState()` / `store.setState()` may bypass middleware-added behavior (e.g. immer’s draft handling). Reach for the wrapped `set` inside actions, not the raw api, when middleware semantics matter.',
            },
            {
              type: 'code',
              language: 'ts',
              sourcePath: 'README.md',
              caption: 'Composing middleware — devtools(persist(...)) — and the curried create<State>() typing (README.md).',
              highlightLines: [1],
              code: `const useBearStore = create<BearState>()(
  devtools(
    persist(
      (set) => ({
        bears: 0,
        increase: (by) => set((state) => ({ bears: state.bears + by })),
      }),
      { name: 'bear-storage' },
    ),
  ),
)`,
            },
            {
              type: 'callout',
              variant: 'gotcha',
              md: 'TypeScript gotcha (README "TypeScript Usage"): write `create<State>()(...)` — note the extra empty `()`. The curried call is what lets zustand infer the state type through the middleware stack. `create<State>(...)` (no second call) will not type correctly.',
            },
          ],
        },
        {
          id: 'mc-map',
          title: 'Where each concept lives',
          blocks: [
            {
              type: 'prose',
              md: 'The mental model maps cleanly onto the source. The vanilla core is the foundation; React, traditional (equality-fn), shallow, and the middleware all build on it.',
            },
            {
              type: 'code-map',
              title: 'Concept → code',
              entries: [
                { label: 'Store (state + listeners, set/get/subscribe)', entity: 'store', files: [{ path: 'src/vanilla.ts', role: 'createStore + StoreApi' }] },
                { label: 'set (merge / Object.is bail / notify)', entity: 'set-fn', files: [{ path: 'src/vanilla.ts', role: 'setState body' }] },
                { label: 'create() + useStore() (React hook)', entity: 'create', files: [{ path: 'src/react.ts', role: 'create + useStore over useSyncExternalStore' }] },
                { label: 'Selector & default Object.is gate', entity: 'selector', files: [{ path: 'src/react.ts', role: 'selector applied in getSnapshot' }] },
                { label: 'shallow & useShallow', entity: 'shallow-fn', files: [{ path: 'src/vanilla/shallow.ts', role: 'one-level equality' }, { path: 'src/react/shallow.ts', role: 'selector re-render guard' }] },
                { label: 'Custom equality fn (createWithEqualityFn)', files: [{ path: 'src/traditional.ts', role: 'useStoreWithEqualityFn + createWithEqualityFn' }, { path: 'src/shallow.ts', role: 're-exports shallow + useShallow' }] },
                { label: 'Middleware barrel', entity: 'middleware', files: [{ path: 'src/middleware.ts', role: 're-exports all middleware' }] },
                { label: 'persist', entity: 'persist', files: [{ path: 'src/middleware/persist.ts', role: 'storage write + rehydrate/merge/migrate' }] },
                { label: 'devtools', entity: 'devtools', files: [{ path: 'src/middleware/devtools.ts', role: 'Redux DevTools connect' }] },
                { label: 'immer / redux / combine / subscribeWithSelector', files: [{ path: 'src/middleware/immer.ts' }, { path: 'src/middleware/redux.ts' }, { path: 'src/middleware/combine.ts' }, { path: 'src/middleware/subscribeWithSelector.ts' }] },
                { label: 'Public entry points', entity: 'create', files: [{ path: 'src/index.ts', role: 're-exports vanilla + react' }] },
              ],
            },
          ],
        },
        {
          id: 'mc-arch',
          title: 'The architecture',
          blocks: [
            {
              type: 'prose',
              heading: 'Core + bindings + middleware',
              md: 'The vanilla core has no React dependency. React bindings and the equality-fn bindings both wrap `createStore`; shallow/useShallow plug into selection; middleware wraps `set`/`get`/`api`; and three externals (React, storage, DevTools) sit at the edges.',
            },
            { type: 'diagram', diagram: { kind: 'architecture', title: 'How the pieces fit' } },
            {
              type: 'decisions',
              title: 'Design decisions worth knowing',
              items: [
                { title: 'No dependency tracking; selectors are manual', rationale: 'zustand compares selected slices by Object.is rather than tracking field reads (unlike Valtio/Jotai/Recoil). Simpler and React-concurrent-safe, at the cost of you choosing slices and using useShallow when needed.', status: 'locked' },
                { title: 'set merges one level by default', rationale: 'A pragmatic convenience so you can skip `...state` for the common case; nested updates are explicit. replace:true opts out entirely.', status: 'locked' },
                { title: 'React binding sits on useSyncExternalStore', rationale: 'Uses React’s official external-store API to avoid zombie-child, concurrency, and context-loss bugs.', status: 'locked' },
                { title: 'Middleware-modified set/get are not applied to raw getState/setState', rationale: 'Documented limitation in the README; raw api calls can bypass middleware semantics like immer drafts.', status: 'open-question', sme: 'Confirm whether any of our call sites use the raw api and would be surprised by this.' },
              ],
            },
            {
              type: 'exercise',
              kind: 'first-task',
              prompt: 'Good first task: you want a store hook that re-renders using a CUSTOM equality function (not just Object.is). Which file/export do you reach for, and how does it differ from `create`?',
              hint: 'There is a separate entry point for equality functions.',
              files: ['src/traditional.ts', 'src/shallow.ts'],
              modelAnswer:
                'Use `createWithEqualityFn` from `src/traditional.ts` (the `zustand/traditional` entry). It builds the same vanilla store but its hook routes through `useStoreWithEqualityFn`, which uses `use-sync-external-store/shim/with-selector` so you can pass a per-selector equality function (or a default like `shallow`, re-exported from `src/shallow.ts`). Plain `create` (src/react.ts) only ever compares with Object.is.',
            },
          ],
        },
      ],
      quiz: [
        {
          id: 'mc-q-mwshape',
          type: 'mcq',
          prompt: 'What is a zustand middleware, structurally?',
          options: [
            { id: 'a', text: 'A function that takes a state creator and returns a new state creator, intercepting set/get/api.', correct: true },
            {
              id: 'b',
              text: 'A React component that wraps your tree and provides the store via context.',
              correct: false,
              ifChosen:
                'That is the Redux/Recoil Provider model again. zustand middleware is a higher-order state creator — e.g. immer wraps `set` to run your updater through produce, persist wraps `set` to write to storage. No component or context is involved.',
            },
            {
              id: 'c',
              text: 'A plugin registered globally that applies to all stores at once.',
              correct: false,
              ifChosen:
                'There is no global registry. You opt a single store into middleware by wrapping its creator: create(devtools(persist(creator, opts))). Each store composes only the middleware you wrap it with.',
            },
          ],
          explanation:
            'Middleware is `(stateCreator) => stateCreator`. Inside it receives (set, get, api) and wraps the pieces it needs — combine prepends state, immer transforms the updater, persist writes to storage, redux attaches dispatch.',
          misconception: {
            id: 'mc-middleware-is-provider',
            trap: 'Middleware is a context Provider component',
            correction: 'Middleware is a higher-order state creator that wraps set/get/api; you compose it per store.',
            relatedEntities: ['middleware', 'state-creator'],
          },
          difficulty: 'core',
        },
        {
          id: 'mc-q-persistmerge',
          type: 'mcq',
          prompt: 'You ship v2 of your app adding `settings: { theme, density }` to a persisted store. Returning users see `density` undefined even though the new default sets it. Why?',
          options: [
            {
              id: 'a',
              text: 'persist’s default merge is shallow — the stored `settings` object overwrites the new default `settings` wholesale, dropping `density`.',
              correct: true,
            },
            {
              id: 'b',
              text: 'persist never reads old data, so all defaults are lost.',
              correct: false,
              ifChosen:
                'persist DOES rehydrate old data — that is the whole point. The issue is HOW it merges: the default merge spreads persisted over current at one level, so the old `settings` object (without `density`) replaces the new one. Provide a custom `merge` or use `version` + `migrate`.',
            },
            {
              id: 'c',
              text: 'You forgot replace:true on set.',
              correct: false,
              ifChosen:
                'replace controls write-time merging of a single set call, not rehydration. The relevant behavior is persist’s `merge` option, which defaults to a shallow merge of persisted over current state.',
            },
          ],
          explanation:
            'The default `merge` is `(persisted, current) => ({ ...current, ...persisted })` — one level deep. A persisted nested object replaces the new default nested object. Use a custom merge or version+migrate when shape changes.',
          misconception: {
            id: 'mc-persist-deep-merge',
            trap: 'persist deep-merges stored state with new defaults',
            correction: 'persist’s default merge is shallow; nested shape changes need a custom merge or migrate.',
            relatedEntities: ['persist', 'set-fn'],
          },
          difficulty: 'stretch',
        },
        {
          id: 'mc-q-codemap',
          type: 'short-answer',
          prompt: 'Where is the React subscription wired, and which React API does zustand use to subscribe a component to the store?',
          modelAnswer:
            'In src/react.ts, inside useStore. It calls React.useSyncExternalStore(api.subscribe, () => selector(api.getState()), () => selector(api.getInitialState())). useSyncExternalStore is the React API that subscribes the component and re-runs the selector on change.',
          rubricKeywords: ['src/react.ts', 'useStore', 'useSyncExternalStore', 'subscribe', 'selector'],
          difficulty: 'core',
        },
      ],
    },
  ],

  glossary: [
    { term: 'set', definition: 'The store updater. Computes the next state, bails out via Object.is, shallow-merges one level, then notifies every listener.' },
    { term: 'selector', definition: 'A (state) => slice function passed to the store hook; the component re-renders only when its selected slice changes by Object.is.' },
    { term: 'useShallow', definition: 'Wraps a selector to compare its result one level deep, returning the previous reference when shallow-equal — the fix for the fresh-object re-render trap.' },
    { term: 'Object.is', definition: 'JavaScript strict reference equality. zustand uses it both to bail out of no-op updates and to decide whether a selected slice changed.' },
    { term: 'middleware', definition: 'A higher-order state creator that wraps set/get/api to add behavior (persist, devtools, immer, redux, …).' },
    { term: 'useSyncExternalStore', definition: 'The official React API zustand uses to subscribe a component to the external store safely under concurrent rendering.' },
    { term: 'persist', definition: 'Middleware that writes state to storage and rehydrates it on creation, shallow-merging the stored state over the initial state by default.' },
  ],
  theme: { accent: '#d97706' },
} satisfies OnboardingBundle

export default bundle
