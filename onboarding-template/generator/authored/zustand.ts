/**
 * Authored onboarding bundle for **zustand** — the 🐻 bear-necessities state
 * manager for React (and vanilla JS).
 *
 * Grounded entirely in a cold read of the pmndrs/zustand repository (pinned commit in the bundle's grounding record):
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
      'A store in zustand is just a closure over a `state` value and a `Set` of listener callbacks. `set` computes the next state, bails out if it is the same reference (`Object.is`), shallow-merges it in (or replaces it outright when you pass the `replace` flag), and notifies every listener. In React, `create` wraps that store in a hook backed by `useSyncExternalStore`; the selector you pass picks a slice and the component re-renders only when that slice changes. There are no providers, no reducers, and no boilerplate — but the trade-off is that render optimization is manual: you choose what to select and when to use `useShallow`.',
    outOfScope: [
      'zustand does not deep-merge — `set` merges only one level; nested objects you must spread yourself.',
      'zustand does not auto-track which fields a component reads (unlike Valtio, whose proxy optimizes renders through property access, per the comparison doc) — you opt into render optimization with selectors.',
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
        { to: 'devtools-ext', label: 'inspects actions and time-travels state via the devtools middleware' },
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
        { name: 'setState', example: 'set(partial, replace?)', note: 'Computes next state, bails on Object.is, merges one level (or replaces), notifies listeners' },
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
        'shallow(a, b) is an equality function that compares two values one level deep (keys/values for objects, element-by-element for iterables, entries for Map/Set). useShallow(selector) wraps a selector so it returns the previous reference when the new slice is shallow-equal — giving a selector that builds a fresh object/array each call a stable result when its contents did not change. That matters because in v5 an unstable selector result is not merely an extra re-render: with `create` it is an infinite update loop ("Maximum update depth exceeded").',
      relationships: [
        { to: 'selector', cardinality: 'one-to-one', label: 'wraps a selector to compare its output shallowly' },
      ],
    },
    {
      id: 'middleware',
      name: 'Middleware',
      definition:
        'A higher-order state-creator: a function that takes a state creator and returns a new one, wrapping `set` and/or patching methods on the `api` to add behavior (`get` is handed through too, but no shipped middleware wraps it). persist, devtools, immer, redux, combine, and subscribeWithSelector are all middleware. They nest, so create(devtools(persist(creator, opts))) composes their effects.',
      relationships: [
        { to: 'state-creator', cardinality: 'one-to-one', label: 'wraps a state creator and returns a new one' },
        { to: 'set-fn', cardinality: 'many-to-one', label: 'wraps set and/or patches the api to add behavior' },
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
        'Middleware that connects the store to the Redux DevTools browser extension. It replaces api.setState with a version that takes an optional action name and reports each change to the extension as a labelled entry, and it listens to the extension so time-travel commands (RESET, ROLLBACK, JUMP_TO_STATE / JUMP_TO_ACTION, IMPORT_STATE) write state back into the store. Data flows both ways — it is not an inspection-only layer — though an app-initiated set still returns the same result.',
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
        'Writing create<State>(middleware(...)) with only the state type and no curried () — the middleware mutator list then defaults to [] and the types stop lining up. The curried create<State>()(...) lets you annotate State while TypeScript infers the mutators; without middleware, plain create<State>(...) types fine.',
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
        'Returning a fresh object/array from a selector every call → Object.is always false → with create in v5, an infinite update loop that throws "Maximum update depth exceeded" (the one-extra-re-render behaviour is v4 / createWithEqualityFn). Fix with useShallow or another stable reference.',
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

  // ── Trace: the life of one set() call, entry trigger to terminal state ────────
  // Every label is the expression at the cited lines of src/vanilla.ts / src/react.ts.
  traces: [
    {
      id: 'life-of-one-set',
      title: 'The life of one update',
      subject: 'one set() call',
      intro:
        'Follow one `set()` call from the action that makes it to the component that repaints: five hand-offs inside the store (`src/vanilla.ts`) and three in the React binding (`src/react.ts`). The store side is identical with or without React; React’s involvement starts at step 6.',
      steps: [
        {
          id: 'call',
          label: `const setState: StoreApi<TState>['setState'] = (partial, replace) => {`,
          component: 'vanilla-core',
          actor: 'host-app',
          entity: 'set-fn',
          sourcePath: 'src/vanilla.ts:66',
          note:
            'An action calls `set`. That `set` is the store’s own `setState`, handed to your state creator as its first argument (`createState(setState, getState, api)`, src/vanilla.ts:95). Its parameters are `(partial, replace)` (src/vanilla.ts:66); the `SetStateInternal` overloads (src/vanilla.ts:1-7) make `replace` optional for the merge form and require `true` for the replace form. Nothing has changed yet.',
        },
        {
          id: 'compute',
          label: `const nextState = typeof partial === 'function' ? (partial as (state: TState) => TState)(state) : partial`,
          component: 'vanilla-core',
          entity: 'state',
          sourcePath: 'src/vanilla.ts:69-72',
          note:
            'If `partial` is a function, `setState` calls it with the current `state` and its return value becomes `nextState`; otherwise `partial` itself is `nextState`. Your updater runs synchronously, right here, and `state` is still the previous value.',
        },
        {
          id: 'bail',
          label: 'if (!Object.is(nextState, state))',
          component: 'vanilla-core',
          entity: 'set-fn',
          sourcePath: 'src/vanilla.ts:73',
          note:
            'The bail-out. Merge and notify both live inside this `if`, so when your updater returns the current state object itself the call ends here: nothing is merged and no listener fires. Only the reference is compared, never the contents, so a fresh object with identical fields passes this check and goes on to notify everyone.',
        },
        {
          id: 'merge',
          label: `state = (replace ?? (typeof nextState !== 'object' || nextState === null)) ? (nextState as TState) : Object.assign({}, state, nextState)`,
          component: 'vanilla-core',
          entity: 'state',
          sourcePath: 'src/vanilla.ts:74-78',
          note:
            'First `const previousState = state` keeps the old value for the listeners (src/vanilla.ts:74). Then the replace-or-merge decision: an explicit `replace` wins (`true` assigns `nextState` wholesale, `false` merges); when you passed none, a non-object or `null` `nextState` is assigned directly and an object is merged with `Object.assign({}, state, nextState)`: a new top-level object, one level deep, so a nested object you did not spread is replaced, not merged.',
        },
        {
          id: 'notify',
          label: 'listeners.forEach((listener) => listener(state, previousState))',
          component: 'vanilla-core',
          entity: 'listener',
          sourcePath: 'src/vanilla.ts:79',
          note:
            'Notification. Every listener in the store’s `Set` is called synchronously with the new `state` and the `previousState`. There is no filtering here: the store does not know what any subscriber selected, so every subscriber hears about every change. Listeners entered this `Set` through `subscribe` (`listeners.add(listener)`, src/vanilla.ts:88-92).',
        },
        {
          id: 'react-listener',
          label: 'React.useSyncExternalStore',
          component: 'react-bindings',
          actor: 'react',
          entity: 'create',
          sourcePath: 'src/react.ts:30-34',
          note:
            'In a React app the listener just called is React’s. The hook that `create` returns delegates to `useStore` (`useStore(api, selector)`, src/react.ts:56), and `useStore` passes `api.subscribe` to `React.useSyncExternalStore` as its subscribe function (src/react.ts:30-31). React subscribes through it, so the callback sitting in the `listeners` Set is React’s own. zustand supplies only three functions here: `api.subscribe` and the two snapshot readers below.',
        },
        {
          id: 'reselect',
          label: 'selector(api.getState())',
          component: 'react-bindings',
          actor: 'react',
          entity: 'selector',
          sourcePath: 'src/react.ts:32',
          note:
            'The snapshot reader `useStore` gave React is your selector applied to the store’s current state: `React.useCallback(() => selector(api.getState()), [api, selector])` (src/react.ts:32), where `getState` is simply `() => state` (src/vanilla.ts:83). After the notification React calls it again and compares the new selection with the previous one. (A second reader, `selector(api.getInitialState())`, is passed alongside it, src/react.ts:33.)',
        },
        {
          id: 'rerender',
          label: 'return slice',
          component: 'react-bindings',
          actor: 'react',
          sourcePath: 'src/react.ts:35-36',
          note:
            'Terminal state. When the new selection differs from the previous one, React re-renders the component and `useStore` returns the new `slice` (after `React.useDebugValue(slice)`, src/react.ts:35-36). When it is the same, the component does not re-render even though its listener was called in step 5. That is the whole render-optimization story: notification is broadcast to every subscriber; re-rendering is decided per component by comparing selections.',
        },
      ],
      outro:
        'Two rules fall out of this trace. `set` bails only on the reference your updater returns (step 3), never on contents. Notification reaches every listener (step 5), but re-rendering is decided per component by comparing selections (steps 7 and 8), which is why a narrow selector is the render optimization, and why `useShallow` (the Selectors & re-renders module) exists: it hands back the previous reference when a fresh object is shallow-equal, so the comparison can succeed.',
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
            'Now an action runs set((s) => s) — it hands back the current state object itself, bears unchanged. What happens?',
          decision: {
            prompt: 'Do any listeners fire?',
            options: [
              {
                id: 'noop-correct',
                label: 'No listeners fire — the updater returned the exact same state reference, so Object.is(next, current) short-circuits before any merge.',
                correct: true,
                outcome:
                  'Right. set checks Object.is on the value the updater returns BEFORE merging, so the same reference skips merge and notify entirely. Careful nuance: had the action returned a brand-new object such as { bears: s.bears }, that is a new reference — set would merge it into a new state object and notify every listener even though bears did not change (tests/vanilla/subscribe.test.tsx asserts exactly this with setState({ ...getState() })).',
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
      { id: 'shallow-mod', name: 'shallow + useShallow', kind: 'service', tech: 'src/vanilla/shallow.ts, src/react/shallow.ts', note: 'One-level equality + selector re-render guard; standalone — imports nothing from the vanilla core' },
      { id: 'middleware-mod', name: 'Middleware bundle', kind: 'service', tech: 'src/middleware/*', note: 'persist, devtools, immer, redux, combine, subscribeWithSelector, unstable_ssrSafe' },
      { id: 'react-ext', name: 'React', kind: 'external', tech: 'react >=18', note: 'Schedules re-renders; provides useSyncExternalStore' },
      { id: 'storage-ext', name: 'Storage', kind: 'datastore', tech: 'localStorage / custom', note: 'persist read/write target' },
      { id: 'devtools-ext-c', name: 'Redux DevTools', kind: 'external', tech: 'browser extension', note: 'devtools action log / time travel' },
      { id: 'immer-ext', name: 'Immer', kind: 'external', tech: 'immer >=9.0.6 (optional peer)', note: 'produce(); imported only by src/middleware/immer.ts' },
      { id: 'uses-shim-ext', name: 'use-sync-external-store', kind: 'external', tech: 'use-sync-external-store >=1.2.0 (optional peer)', note: 'shim/with-selector; imported only by src/traditional.ts' },
    ],
    connections: [
      { from: 'react-bindings', to: 'vanilla-core', label: 'wraps createStore' },
      { from: 'traditional', to: 'vanilla-core', label: 'wraps createStore' },
      { from: 'react-bindings', to: 'react-ext', label: 'useSyncExternalStore' },
      { from: 'traditional', to: 'shallow-mod', label: 'equalityFn slot (e.g. shallow; default Object.is)' },
      { from: 'react-bindings', to: 'shallow-mod', label: 'useShallow guards selectors' },
      { from: 'middleware-mod', to: 'vanilla-core', label: 'wraps set + patches api (types from vanilla)' },
      { from: 'middleware-mod', to: 'storage-ext', label: 'persist read/write' },
      { from: 'middleware-mod', to: 'devtools-ext-c', label: 'devtools connect (two-way: time-travel writes back)' },
      { from: 'middleware-mod', to: 'immer-ext', label: 'immer middleware calls produce' },
      { from: 'traditional', to: 'uses-shim-ext', label: 'useSyncExternalStoreWithSelector' },
      { from: 'shallow-mod', to: 'react-ext', label: 'useShallow uses React.useRef' },
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
              heading: 'The whole store fits on one screen',
              md: 'A zustand store is a function-local `state` variable, the `initialState` it started from, plus a `Set` of listeners. It exposes four methods — `setState`, `getState`, `getInitialState`, `subscribe` — and nothing else. There is no proxy, no dependency tracking, no Provider. Everything else (React bindings, middleware) is built on top of this.',
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
              excerpt: 'verbatim',
              caption: 'The state creator runs once; its return value is the initial state (src/vanilla.ts).',
              highlightLines: [12, 13],
              code: `  const getState: StoreApi<TState>['getState'] = () => state

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
}`,
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
              md: 'Every update goes through `set`. Read its body carefully — four steps are baked in here and they explain almost every "why didn’t my component update?" question.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/vanilla.ts',
              excerpt: 'verbatim',
              caption: 'setState: compute → Object.is bail-out → shallow-merge (unless replace) → notify (src/vanilla.ts).',
              highlightLines: [4, 8, 13, 14],
              code: `  const setState: StoreApi<TState>['setState'] = (partial, replace) => {
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
  }`,
            },
            {
              type: 'mental-model',
              heading: 'The four steps of set',
              entities: ['set-fn', 'state', 'listener'],
              verbs: ['update-state'],
              md: '1) **Compute**: if you passed a function, `set` calls it with the current state to get `next`. 2) **Bail-out**: if `Object.is(next, current)` it does nothing — no merge, no notify. 3) **Merge or replace**: by default it shallow-merges with `Object.assign({}, state, next)` — one level deep only. If you pass `replace: true`, or you omit `replace` and `next` is a primitive or `null`, it assigns `next` directly with no merge (an explicit `replace: false` always merges). 4) **Notify**: it then calls every listener with `(state, prevState)`.',
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
              md: 'Because `set` bails on `Object.is`, the reliable way to trigger an update is to return a **new** object. Mutating the existing state in place never notifies a listener (`set` sees the same reference and returns early); the README states the rule plainly: state has to be updated immutably.',
            },
            {
              type: 'code',
              language: 'jsx',
              sourcePath: 'docs/learn/guides/immutable-state-and-merging.md',
              excerpt: 'verbatim',
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
            { type: 'trace', traceId: 'life-of-one-set' },
            {
              type: 'prose',
              heading: 'A hook with the API stapled on',
              md: '`create` builds a vanilla store, then returns a hook. It also copies the store’s methods (`setState`, `getState`, `subscribe`, `getInitialState`) onto the hook, so `useBear` is both a hook AND a handle you can call outside React.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/react.ts',
              excerpt: 'verbatim',
              caption: 'create wraps createStore, returns a hook, and Object.assigns the store API onto it (src/react.ts).',
              highlightLines: [2, 4, 6],
              code: `const createImpl = <T>(createState: StateCreator<T, [], []>) => {
  const api = createStore(createState)

  const useBoundStore: any = (selector?: any) => useStore(api, selector)

  Object.assign(useBoundStore, api)

  return useBoundStore
}`,
            },
            {
              type: 'code',
              language: 'jsx',
              sourcePath: 'docs/learn/getting-started/introduction.md',
              excerpt: 'verbatim',
              caption: 'The "your store is a hook" usage — no Provider anywhere (docs/learn/getting-started/introduction.md).',
              code: `function BearCounter() {
  const bears = useBear((state) => state.bears)
  return <h1>{bears} bears around here...</h1>
}

function Controls() {
  const increasePopulation = useBear((state) => state.increasePopulation)
  return <button onClick={increasePopulation}>one up</button>
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
              excerpt: 'verbatim',
              caption: 'useStore = useSyncExternalStore(subscribe, selectorOverGetState, selectorOverInitial) (src/react.ts).',
              highlightLines: [6, 7, 8],
              code: `export function useStore<TState, StateSlice>(
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
}`,
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
              md: 'The introduction doc says zustand deals with the "zombie child", "React concurrency", and "context loss" pitfalls. Be precise about how. Context loss between mixed renderers is avoided structurally — `src/react.ts` never uses React context; the hook simply closes over its store. Zombie-child safety was hand-rolled until April 2022 (#550): zustand subscribed with useReducer + refs and re-checked state after subscribing. That code was deleted when zustand adopted `useSyncExternalStore` in April 2022 (#550, first through the `use-sync-external-store` shim; the direct `React.useSyncExternalStore` call landed in #2301, January 2024). React’s public API for subscribing to an external store now owns the subscription, and the old zombie-child regression test still passes through it. The concurrency guarantee is React’s: the repo’s docs describe the result ("safe under React concurrency") rather than implementing it.',
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
              excerpt: 'verbatim',
              caption: 'Non-reactive use of the store outside React (README.md).',
              code: `const useDogStore = create(() => ({ paw: true, snout: true, fur: true }))

// Getting non-reactive fresh state
const paw = useDogStore.getState().paw
// Listening to all changes, fires synchronously on every change
const unsub1 = useDogStore.subscribe(console.log)
// Updating state, will trigger listeners
useDogStore.setState({ paw: false })
// Unsubscribe listeners
unsub1()`,
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
              md: 'zustand does not track which fields you read (the comparison doc contrasts this with Valtio, which optimizes renders through property access). Instead, YOU pick a slice with a selector, and zustand re-renders only when that slice changes by `Object.is` (strict reference equality). Narrow selectors = fewer re-renders.',
            },
            {
              type: 'diagram',
              diagram: { kind: 'flow', flowId: 'set-notify-render', title: 'set → notify → selective re-render' },
            },
            {
              type: 'code',
              language: 'jsx',
              sourcePath: 'README.md',
              excerpt: 'verbatim',
              caption: 'Atomic picks compare with strict equality — efficient by default (README.md).',
              code: `const nuts = useBearStore((state) => state.nuts)
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
              md: 'The classic zustand selector bug: a selector that builds a NEW object or array every call. Because `Object.is` compares references, the new object is never equal to the last one. With `create` in v5 the consequence is worse than wasted renders: the default `Object.is` comparison fails on every check and, in the words of the useShallow docs, the component "re-subscribes in a loop" that ends in "Maximum update depth exceeded" — the v5 migration guide warns that such selectors "may cause infinite loops", and the useShallow docs call bundling several values into one object "the most common case" of that error. (Before v5, `create` memoized the selection per store snapshot, so the same selector only cost unnecessary re-renders; the v5 migration guide points at `createWithEqualityFn` from `zustand/traditional` "if you need v4 behavior".)',
            },
            {
              type: 'code',
              language: 'js',
              sourcePath: 'docs/learn/guides/prevent-rerenders-with-use-shallow.md',
              excerpt: 'verbatim',
              caption: '`Object.keys(state)` is a fresh array each time — the guide describes unnecessary re-renders; with `create` in v5 the unstable snapshot means an infinite update loop (docs/learn/guides/prevent-rerenders-with-use-shallow.md).',
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
              prompt: 'In the code above, nothing in the store changes at all — no bear orders a new meal. With `create` in v5, does `BearNames` render once and settle?',
              reveal:
                'No — it never settles. The selector returns a brand-new array each call, so the `Object.is` comparison fails every time and the update loops until it throws "Maximum update depth exceeded" (docs/reference/migrations/migrating-to-v5.md, docs/reference/hooks/use-shallow.md Troubleshooting). No store change is needed — the unstable selection alone triggers it. (The guide phrases the symptom as unnecessary re-renders; the v5 migration guide is the precise statement.)',
              hint: 'What does Object.keys() return each time — the same array, or a new one? And what does React do when getSnapshot keeps returning something new?',
            },
            {
              type: 'code',
              language: 'js',
              sourcePath: 'docs/learn/guides/prevent-rerenders-with-use-shallow.md',
              excerpt: 'verbatim',
              caption: 'The fix: wrap the selector in useShallow (docs/learn/guides/prevent-rerenders-with-use-shallow.md).',
              highlightLines: [2, 11],
              code: `import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'

const useMeals = create(() => ({
  papaBear: 'large porridge-pot',
  mamaBear: 'middle-size porridge pot',
  littleBear: 'A little, small, wee pot',
}))

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
              excerpt: 'verbatim',
              caption: 'useShallow returns the previous reference when shallow-equal (src/react/shallow.ts).',
              highlightLines: [4, 5, 6],
              code: `export function useShallow<S, U>(selector: (state: S) => U): (state: S) => U {
  const prev = React.useRef<U>(undefined)
  return (state) => {
    const next = selector(state)
    return shallow(prev.current, next)
      ? (prev.current as U)
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
          prompt: 'A component reads `useStore((state) => ({ a: state.a, b: state.b }))` from a v5 `create` store. As soon as it mounts, React throws "Maximum update depth exceeded" even though neither a nor b changes. Why, and what is the fix?',
          options: [
            {
              id: 'a',
              text: 'The selector builds a new object each call, so Object.is is always false and the update loops until it throws; wrap it in useShallow.',
              correct: true,
            },
            {
              id: 'b',
              text: 'zustand re-renders all subscribers on every set; the loop is inherent and there is no fix.',
              correct: false,
              ifChosen:
                'No — zustand re-renders a component only when ITS selected slice changes. The problem is specific: your selector returns a fresh object literal each call, so the Object.is comparison always fails and the update loops until it throws. `useShallow((s) => ({ a: s.a, b: s.b }))` compares one level deep and returns the previous reference when a and b are unchanged, so the selection is stable.',
            },
            {
              id: 'c',
              text: 'You must call set with replace:true to stop the loop.',
              correct: false,
              ifChosen:
                'replace is about how state is merged on write, not about how selectors compare on read. The loop is driven by the selector returning a new reference on every call; the fix is useShallow (or a custom equality fn via createWithEqualityFn).',
            },
          ],
          explanation:
            'Default selection compares the slice by Object.is. A selector returning a new object/array each call never matches its previous result; with create in v5 that is an infinite update loop ending in "Maximum update depth exceeded" — the useShallow docs call bundling values into one object the most common case. useShallow does a one-level comparison and reuses the prior reference when equal, so the selection stabilizes.',
          misconception: {
            id: 'mc-fresh-object-selector',
            trap: 'A fresh-object selector just costs a few unnecessary re-renders (or means zustand ignores selectors)',
            correction: 'Selectors ARE respected via Object.is; a fresh object/array never matches, and with create in v5 that is an infinite update loop ("Maximum update depth exceeded") — return a stable reference, e.g. with useShallow.',
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
        'Learn the one shape every middleware shares (wrap the state creator; wrap set and/or patch the api), tour persist/devtools/immer/redux, then map every concept to the real files and the architecture so you can navigate and extend the code.',
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
              md: 'A middleware takes your state creator and returns a new one. Inside, it gets `(set, get, api)` and typically wraps `set` and/or patches methods on `api`. `combine` is the gentlest example — it wraps none of them; it just merges an initial state object in front of your creator’s result and infers the types for you.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/middleware/combine.ts',
              excerpt: 'verbatim',
              caption: 'combine: the minimal middleware — prepend initial state, run the creator (src/middleware/combine.ts).',
              code: `export function combine<
  T extends object,
  U extends object,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = [],
>(
  initialState: T,
  create: StateCreator<T, Mps, Mcs, U>,
): StateCreator<Write<T, U>, Mps, Mcs> {
  return (...args) => Object.assign({}, initialState, (create as any)(...args))
}`,
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/middleware/immer.ts',
              excerpt: 'verbatim',
              caption: 'immer: patch store.setState — and hand that same function to the creator as set — so a "mutate the draft" updater becomes an immutable next state via produce (src/middleware/immer.ts).',
              highlightLines: [4, 5, 6],
              code: `const immerImpl: ImmerImpl = (initializer) => (set, get, store) => {
  type T = ReturnType<typeof initializer>

  store.setState = (updater, replace, ...args) => {
    const nextState = (
      typeof updater === 'function' ? produce(updater as any) : updater
    ) as ((s: T) => T) | T | Partial<T>

    return set(nextState, replace as any, ...args)
  }

  return initializer(store.setState, get, store)
}`,
            },
            {
              type: 'mental-model',
              heading: 'Where each middleware intercepts',
              entities: ['middleware', 'set-fn', 'store'],
              md: 'On their normal paths, the shipped middleware that wrap **set** also patch **api.setState**, so the raw api and the creator’s `set` agree: immer assigns `store.setState` (running function updaters through produce), persist reassigns `api.setState` (writing to storage after each change), devtools reassigns it (reporting each change to the extension), and ssrSafe swaps in a throwing setter on the server. One known exception: when persist finds no storage it wraps `set` with a warning and leaves `api.setState` alone (src/middleware/persist.ts:208-219). Beyond setState, subscribeWithSelector overwrites **api.subscribe**, persist adds **api.persist**, devtools adds **api.devtools**, and redux attaches a **dispatch** to the api. `get` reaches every middleware too, but none of the built-ins wrap it. Same skeleton, different interception point.',
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
              excerpt: 'verbatim',
              caption: 'The default options: localStorage + identity partialize + SHALLOW merge (src/middleware/persist.ts).',
              highlightLines: [2, 4, 5, 6, 7],
              code: `  let options = {
    storage: createJSONStorage<S, void>(() => window.localStorage),
    partialize: (state: S) => state,
    version: 0,
    merge: (persistedState: unknown, currentState: S) => ({
      ...currentState,
      ...(persistedState as object),
    }),
    ...baseOptions,
  }`,
            },
            {
              type: 'code',
              language: 'ts',
              sourcePath: 'docs/reference/middlewares/persist.md',
              excerpt: 'verbatim',
              caption: 'Wrapping a store in persist — only `name` is required (docs/reference/middlewares/persist.md).',
              code: `const positionStore = createStore<PositionStore>()(
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
              md: 'If you miss reducers, the `redux` middleware wires a reducer + initial state and attaches a `dispatch` to both the state and the api. `devtools` connects the store to the Redux DevTools extension and labels each change as an action — but it is not inspection-only: it replaces `api.setState` with a three-argument version that also reports to the extension, and it subscribes to the extension so RESET, ROLLBACK, JUMP_TO_STATE / JUMP_TO_ACTION and IMPORT_STATE write state back into the store through `setStateFromDevtools`. That write-back is what makes time-travel debugging work.',
            },
            {
              type: 'code',
              language: 'typescript',
              sourcePath: 'src/middleware/redux.ts',
              excerpt: 'verbatim',
              caption: 'redux: attach dispatch(action) that runs your reducer through set (src/middleware/redux.ts).',
              highlightLines: [4, 5],
              code: `const reduxImpl: ReduxImpl = (reducer, initial) => (set, _get, api) => {
  type S = typeof initial
  type A = Parameters<typeof reducer>[1]
  ;(api as any).dispatch = (action: A) => {
    ;(set as NamedSet<S>)((state: S) => reducer(state, action), false, action)
    return action
  }
  ;(api as any).dispatchFromDevtools = true

  return { dispatch: (...args) => (api as any).dispatch(...args), ...initial }
}`,
            },
            {
              type: 'callout',
              variant: 'warning',
              md: 'The README warns: "middlewares that modify `set` or `get` are not applied to `getState` and `setState`." Take it as a rule for middleware authors: if you wrap only the `set` argument you pass to the creator and never reassign `api.setState`, the raw api will bypass your wrapper. The shipped middleware do patch `api.setState` (immer.ts, persist.ts, devtools.ts, ssrSafe.ts), so the bare `store.setState((s) => { s.count = 10 })` DOES go through immer’s draft handling — the repo’s own test asserts it (tests/immer.test.tsx). The docs’ logger example also patches `api.setState` alongside the wrapped `set` (docs/learn/guides/advanced-typescript.md).',
            },
            {
              type: 'code',
              language: 'ts',
              sourcePath: 'README.md',
              excerpt: 'verbatim',
              caption: 'Composing middleware — devtools(persist(...)) — and the curried create<State>() typing (README.md).',
              highlightLines: [1],
              code: `const useBearStore = create<BearState>()(
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
)`,
            },
            {
              type: 'callout',
              variant: 'gotcha',
              md: 'TypeScript gotcha (README "TypeScript Usage"): write `create<State>()(...)` — note the extra empty `()`. The first call is where YOU annotate the state type (the docs explain it cannot be inferred because the state generic is invariant); the second call lets TypeScript infer everything else — chiefly the middleware mutator list — because generic inference is all-or-nothing (docs/learn/guides/advanced-typescript.md, "Why the currying"). Without middleware, plain `create<State>((set) => ...)` types fine and the repo’s own tests use it. What fails is `create<State>(devtools(persist(...)))` with only `State` given: the mutator list defaults to `[]` and the middleware types no longer line up.',
            },
          ],
        },
        {
          id: 'mc-map',
          title: 'Where each concept lives',
          blocks: [
            {
              type: 'prose',
              md: 'The mental model maps cleanly onto the source. The vanilla core is the foundation; React, traditional (equality-fn) and the middleware all build on it. shallow/useShallow are the exception — a standalone equality helper (src/vanilla/shallow.ts imports nothing; src/react/shallow.ts imports only React and shallow) that you plug into selection alongside the core.',
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
                { label: 'devtools', entity: 'devtools', files: [{ path: 'src/middleware/devtools.ts', role: 'Redux DevTools connect + time-travel write-back' }] },
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
              md: 'The vanilla core has no React dependency. React bindings and the equality-fn bindings both wrap `createStore`; shallow/useShallow plug into selection without depending on the core; middleware wraps `set` and patches the `api` (`get` is passed to every middleware, but wrapping it is an unused extension point). At the edges sit the externals: React — plus, for `zustand/traditional`, the `use-sync-external-store` shim — Immer for the immer middleware, a storage backend for persist, and the Redux DevTools extension for devtools. package.json lists react, @types/react, immer and use-sync-external-store as optional peer dependencies.',
            },
            { type: 'diagram', diagram: { kind: 'architecture', title: 'How the pieces fit' } },
            {
              type: 'decisions',
              title: 'Design decisions worth knowing',
              items: [
                { title: 'No dependency tracking; selectors are manual', rationale: 'zustand compares selected slices by Object.is rather than tracking what you read — the comparison doc contrasts this with Valtio (property-access tracking) and Jotai/Recoil (atom dependency). Simpler and React-concurrent-safe, at the cost of you choosing slices and using useShallow when needed.', status: 'locked' },
                { title: 'set merges one level by default', rationale: 'A pragmatic convenience so you can skip `...state` for the common case; nested updates are explicit. replace:true opts out entirely.', status: 'locked' },
                { title: 'React binding sits on useSyncExternalStore', rationale: 'Uses React’s public external-store API; adopted in April 2022 (#550, through the use-sync-external-store shim; direct React.useSyncExternalStore since #2301, January 2024), replacing a hand-rolled useReducer + refs subscription that handled the zombie-child case by hand — that code is gone and the zombie-child regression test passes through React’s hook. Context loss is avoided structurally (src/react.ts never uses React context); the concurrency-safety guarantee is React’s, described in the docs rather than implemented in zustand.', status: 'locked' },
                { title: 'Middleware keep the wrapped set and api.setState in sync by convention, not by construction', rationale: 'Nothing forces a middleware to patch both. The README warns that middlewares modifying set/get are not applied to getState/setState; the shipped set-wrapping middleware (immer, persist, devtools, ssrSafe) patch api.setState on their normal paths, persist’s no-storage fallback is the one path that wraps set alone (a warning wrapper, same state semantics), and none wraps get.', status: 'open-question', sme: 'Do any of our custom middlewares wrap set without also patching api.setState?' },
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
            { id: 'a', text: 'A function that takes a state creator and returns a new state creator, wrapping set and/or patching the store api.', correct: true },
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
            'Middleware is `(stateCreator) => stateCreator`. Inside it receives (set, get, api) and wraps the pieces it needs — combine wraps none and just prepends state, immer transforms the updater and patches api.setState, persist writes to storage, redux attaches dispatch.',
          misconception: {
            id: 'mc-middleware-is-provider',
            trap: 'Middleware is a context Provider component',
            correction: 'Middleware is a higher-order state creator that wraps set and/or patches the api; you compose it per store.',
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
    { term: 'set', definition: 'The store updater. Computes the next state, bails out via Object.is, shallow-merges one level (or replaces outright with the replace flag), then notifies every listener.' },
    { term: 'selector', definition: 'A (state) => slice function passed to the store hook; the component re-renders only when its selected slice changes by Object.is.' },
    { term: 'useShallow', definition: 'Wraps a selector to compare its result one level deep, returning the previous reference when shallow-equal — the fix for the fresh-object selector trap (in v5 an infinite update loop, "Maximum update depth exceeded").' },
    { term: 'Object.is', definition: 'JavaScript strict reference equality. zustand uses it both to bail out of no-op updates and to decide whether a selected slice changed.' },
    { term: 'middleware', definition: 'A higher-order state creator that wraps set and/or patches the api to add behavior (persist, devtools, immer, redux, …).' },
    { term: 'useSyncExternalStore', definition: 'The official React API zustand uses to subscribe a component to the external store safely under concurrent rendering.' },
    { term: 'persist', definition: 'Middleware that writes state to storage and rehydrates it on creation, shallow-merging the stored state over the initial state by default.' },
  ],
  theme: { accent: '#d97706' },
} satisfies OnboardingBundle

export default bundle
