import { PgCommon } from "../common";
import type { Disposable, SyncOrAsync, UnionToTuple } from "../types";

/** Change event function name prefix */
const ON_DID_CHANGE = "onDidChange";

/** Private state property */
const INTERNAL_STATE_PROPERTY = "_state";

/** The property name for keeping track of whether the class has been initialized */
const IS_INITIALIZED_PROPERTY = "_isinitialized";

/** `init` prop */
type Initialize = {
  /** Initializer that returns a disposable */
  init(): SyncOrAsync<Disposable>;
};

/** Updateable decorator */
type Update<T> = {
  /** Update state */
  update(params: Partial<T>): void;
};

/** Default `onDidChange` type */
type OnDidChangeDefault<T> = {
  /**
   * @param cb callback function to run after the change
   * @returns a dispose function to clear the event
   */
  onDidChange(cb: (value: T) => void): Disposable;
};

/** Non-recursive `onDidChange${propertyName}` method types */
type OnDidChangeProperty<T> = {
  [K in keyof T as `${typeof ON_DID_CHANGE}${Capitalize<K>}`]: (
    cb: (value: T[K]) => void
  ) => Disposable;
};

/** Recursive `onDidChange${propertyName}` method types */
type OnDidChangePropertyRecursive<T, U = FlattenObject<T>> = {
  [K in keyof U as `${typeof ON_DID_CHANGE}${K}`]: (
    cb: (value: U[K]) => void
  ) => Disposable;
};

/**
 * Flatten the properties of the given object.
 *
 * ## Input:
 * ```ts
 * {
 *   isReady: boolean;
 *   nested: {
 *     id: number;
 *     name: string;
 *   };
 * }
 *
 * ## Output:
 * ```ts
 *  * {
 *   IsReady: boolean;
 *   NestedId: number;
 *   NestedName: string;
 * }
 */
type FlattenObject<T, U = PropertiesToTuple<T>> = MapNestedProperties<
  // This check solves `Type instantiation is excessively deep and possibly infinite.`
  U extends [string[], unknown] ? U : never
>;

/** Maps the given tuple to an object */
type MapNestedProperties<T extends [string[], unknown]> = {
  [K in T as JoinCapitalized<K[0]>]: K[1];
};

/** Join the given string array capitalized */
type JoinCapitalized<T extends string[]> = T extends [
  infer Head extends string,
  ...infer Tail extends string[]
]
  ? `${Capitalize<Head>}${JoinCapitalized<Tail>}`
  : "";

/** Map the property values to a tuple */
type PropertiesToTuple<T, Acc extends string[] = []> = {
  [K in keyof T]: T[K] extends object
    ? PropertiesToTuple<T[K], [...Acc, K]>
    : [[...Acc, K], T[K]];
}[keyof T];

/** Custom storage implementation */
type CustomStorage<T> = {
  /** Read from storage and deserialize the data. */
  read(): SyncOrAsync<T>;
  /** Serialize the data and write to storage. */
  write(state: T): SyncOrAsync<void>;
};

/**
 * Make a static class updateable.
 *
 * This decorator defines getters for the given prop names and adds an
 * `onDidChange${propertyName}` method for each prop.
 *
 * `update` method is responsible for both updating the state and dispatching
 * change events.
 *
 * NOTE: Types have to be added separately as decorators don't have proper
 * type support.
 */
export function updateable<T>(params: {
  /** Default value to set */
  defaultState: Required<T>;
  /** Storage that is responsible with de/serialization */
  storage: CustomStorage<T>;
  /** Whether to add proxy setters recursively */
  recursive?: boolean;
}) {
  return (sClass: any) => {
    sClass[INTERNAL_STATE_PROPERTY] ??= {};
    sClass[IS_INITIALIZED_PROPERTY] ??= false;

    // Initializer
    (sClass as Initialize).init = async () => {
      const state: T = await params.storage.read();

      // Set the default if any prop is missing(recursively)
      const setMissingDefaults = (state: any, defaultState: any) => {
        for (const prop in defaultState) {
          if (state[prop] === undefined) {
            state[prop] = defaultState[prop];
          } else if (
            typeof state[prop] === "object" &&
            defaultState[prop] !== null
          ) {
            setMissingDefaults(state[prop], defaultState[prop]);
          }
        }
      };
      setMissingDefaults(state, params.defaultState);

      // Remove extra properties if a prop was removed(recursively)
      const removeExtraProperties = (state: any, defaultState: any) => {
        for (const prop in state) {
          if (defaultState[prop] === undefined) {
            delete state[prop];
          } else if (
            typeof state[prop] === "object" &&
            defaultState[prop] !== null
          ) {
            removeExtraProperties(state[prop], defaultState[prop]);
          }
        }
      };
      removeExtraProperties(state, params.defaultState);

      sClass.update(state);
      sClass[IS_INITIALIZED_PROPERTY] = true;

      return sClass.onDidChange((state: T) => params.storage.write(state));
    };

    // Batched main change event
    (sClass as OnDidChangeDefault<T>).onDidChange = (
      cb: (value: T) => void
    ) => {
      return PgCommon.batchChanges(
        () => cb(sClass[INTERNAL_STATE_PROPERTY]),
        [onDidChange]
      );
    };

    // Update method
    if (params.recursive) {
      (sClass as Update<T>).update = (updateParams: Partial<T>) => {
        for (const prop in updateParams) {
          update(prop, updateParams[prop]);

          if (typeof sClass[prop] === "object" && sClass[prop] !== null) {
            sClass[prop] = defineSettersRecursively({
              sClass,
              getter: sClass[prop],
              internal: sClass[INTERNAL_STATE_PROPERTY][prop],
              propNames: [prop],
            });
          }
        }
      };
    } else {
      (sClass as Update<T>).update = (updateParams: Partial<T>) => {
        for (const prop in updateParams) {
          update(prop, updateParams[prop]);
        }
      };
    }

    // Get custom event name
    sClass._getChangeEventName = (name?: string | string[]) => {
      if (Array.isArray(name)) name = name.join(".");
      return "ondidchange" + sClass.name + (name ?? "");
    };

    // Common update method
    const update = (prop: keyof T, value?: T[keyof T]) => {
      if (value === undefined) return;

      // Define getter and setter once
      if (sClass[prop] === undefined) {
        Object.defineProperty(sClass, prop, {
          get: () => sClass[INTERNAL_STATE_PROPERTY][prop],
          set: (value: T[keyof T]) => {
            sClass[INTERNAL_STATE_PROPERTY][prop] = value;

            // Change event
            PgCommon.createAndDispatchCustomEvent(
              sClass._getChangeEventName(prop),
              value
            );

            // Dispatch the main update event
            PgCommon.createAndDispatchCustomEvent(
              sClass._getChangeEventName(),
              sClass[INTERNAL_STATE_PROPERTY]
            );
          },
        });

        // Change event handlers
        const onDidChangeEventName =
          ON_DID_CHANGE + prop[0].toUpperCase() + prop.slice(1);
        sClass[onDidChangeEventName] ??= (cb: (value: unknown) => unknown) => {
          return PgCommon.onDidChange({
            cb,
            eventName: sClass._getChangeEventName(prop),
            initialRun: sClass[IS_INITIALIZED_PROPERTY]
              ? { value: sClass[prop] }
              : undefined,
          });
        };
      }

      // Trigger the setter
      sClass[prop] = value;
    };

    // Main change event
    const onDidChange = (cb: (value: T) => void) => {
      return PgCommon.onDidChange({
        cb,
        eventName: sClass._getChangeEventName(),
        initialRun: sClass[IS_INITIALIZED_PROPERTY]
          ? { value: sClass[INTERNAL_STATE_PROPERTY] }
          : undefined,
      });
    };
  };
}

/** Define proxy setters for properties recursively. */
const defineSettersRecursively = ({
  sClass,
  getter,
  internal,
  propNames,
}: {
  sClass: any;
  getter: any;
  internal: any;
  propNames: string[];
}) => {
  getter = new Proxy(internal, {
    set(target: any, prop: string, value: any) {
      target[prop] = value;

      // Setting a new value should dispatch a change event for all of
      // the parent objects.
      // Example:
      // const obj = { nested: { number: 1 } };
      // obj.a.b = 2; -> obj.OnDidChangeNestedNumber, obj.OnDidChangeNested, obj.onDidChange

      // 1. [nested, number].reduce
      // 2. [nested, nested.number].reverse
      // 3. [nested.number, nested].forEach
      propNames
        .concat([prop])
        .reduce((acc, cur, i) => {
          acc.push(propNames.slice(0, i).concat([cur]).join("."));
          return acc;
        }, [] as string[])
        .reverse()
        .forEach((prop) => {
          PgCommon.createAndDispatchCustomEvent(
            sClass._getChangeEventName(prop),
            PgCommon.getProperty(sClass, prop)
          );
        });

      // Dispatch the main update event
      PgCommon.createAndDispatchCustomEvent(
        sClass._getChangeEventName(),
        sClass[INTERNAL_STATE_PROPERTY]
      );

      return true;
    },
  });

  for (const prop in getter) {
    const currentPropNames = [...propNames, prop];

    // Change event handlers
    const onDidChangeEventName =
      ON_DID_CHANGE +
      currentPropNames.reduce(
        (acc, cur) => acc + cur[0].toUpperCase() + cur.slice(1),
        ""
      );

    sClass[onDidChangeEventName] ??= (cb: (value: unknown) => unknown) => {
      return PgCommon.onDidChange({
        cb,
        eventName: sClass._getChangeEventName(currentPropNames),
        initialRun: sClass[IS_INITIALIZED_PROPERTY]
          ? { value: getter[prop] }
          : undefined,
      });
    };

    // Recursively update
    if (typeof getter[prop] === "object" && getter[prop] !== null) {
      getter[prop] = defineSettersRecursively({
        sClass,
        getter: getter[prop],
        internal: internal[prop],
        propNames: currentPropNames,
      });
    } else {
      // Trigger the setter
      // eslint-disable-next-line no-self-assign
      getter[prop] = getter[prop];
    }
  }

  return getter;
};

/**
 * Add the necessary types to the given updateable static class.
 *
 * @param sClass static class
 * @param options type helper options
 * @returns the static class with correct types
 */
export const declareUpdateable = <C, T, R>(
  sClass: C,
  options?: { defaultState: T; recursive?: R }
) => {
  return sClass as unknown as Omit<typeof sClass, "prototype"> &
    T &
    Initialize &
    Update<T> &
    OnDidChangeDefault<T> &
    (R extends undefined
      ? OnDidChangeProperty<T>
      : OnDidChangePropertyRecursive<T>);
};
