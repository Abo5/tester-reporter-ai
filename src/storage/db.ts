// =============================================================================
// src/storage/db.ts
// One IndexedDB database, seven flat object stores, no ORM.
//
// The key fact that makes the whole architecture work: IndexedDB at
// chrome-extension://<id> is SHARED by the service worker, the offscreen
// document and every extension page. So the offscreen document can write a
// 60 MB video Blob and the review page can read it, with no message passing.
// =============================================================================

const DATABASE_NAME: string = "tester-reporter-ai";
const DATABASE_VERSION: number = 1;

export const STORE_SESSIONS: string = "sessions";
export const STORE_EVENTS: string = "events";
export const STORE_DOM_SNAPSHOTS: string = "domSnapshots";
export const STORE_ELEMENT_CONTEXTS: string = "elementContexts";
export const STORE_NETWORK: string = "networkEntries";
export const STORE_CONSOLE: string = "consoleEntries";
export const STORE_MEDIA: string = "media";

/** Stores that carry a per-session index, so they can be bulk-read and purged. */
export const SESSION_SCOPED_STORES: readonly string[] = [
  STORE_EVENTS,
  STORE_DOM_SNAPSHOTS,
  STORE_ELEMENT_CONTEXTS,
  STORE_NETWORK,
  STORE_CONSOLE,
  STORE_MEDIA,
];

/** Cached handle so we do not reopen the database on every call. */
let cachedDatabase: IDBDatabase | null = null;

/**
 * Opens (and on first run creates) the database.
 *
 * WHY a hand-written wrapper instead of a library: the schema is seven flat
 * stores keyed by id with one index each. A library would be more code to read,
 * not less.
 */
export function openDatabase(): Promise<IDBDatabase> {
  if (cachedDatabase !== null) {
    return Promise.resolve(cachedDatabase);
  }

  return new Promise<IDBDatabase>(function executor(resolve, reject): void {
    const request: IDBOpenDBRequest = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = function onUpgrade(): void {
      const database: IDBDatabase = request.result;

      if (!database.objectStoreNames.contains(STORE_SESSIONS)) {
        const store: IDBObjectStore =
          database.createObjectStore(STORE_SESSIONS, { keyPath: "id" });
        store.createIndex("byStartedAt", "startedAtMs", { unique: false });
      }

      if (!database.objectStoreNames.contains(STORE_EVENTS)) {
        const store: IDBObjectStore =
          database.createObjectStore(STORE_EVENTS, { keyPath: ["sessionId", "index"] });
        store.createIndex("bySession", "sessionId", { unique: false });
      }

      if (!database.objectStoreNames.contains(STORE_DOM_SNAPSHOTS)) {
        const store: IDBObjectStore =
          database.createObjectStore(STORE_DOM_SNAPSHOTS, { keyPath: "id" });
        store.createIndex("bySession", "sessionId", { unique: false });
      }

      if (!database.objectStoreNames.contains(STORE_ELEMENT_CONTEXTS)) {
        const store: IDBObjectStore =
          database.createObjectStore(STORE_ELEMENT_CONTEXTS, { keyPath: "id" });
        store.createIndex("bySession", "sessionId", { unique: false });
      }

      if (!database.objectStoreNames.contains(STORE_NETWORK)) {
        const store: IDBObjectStore =
          database.createObjectStore(STORE_NETWORK, { keyPath: "id" });
        store.createIndex("bySession", "sessionId", { unique: false });
      }

      if (!database.objectStoreNames.contains(STORE_CONSOLE)) {
        const store: IDBObjectStore =
          database.createObjectStore(STORE_CONSOLE, { keyPath: "id" });
        store.createIndex("bySession", "sessionId", { unique: false });
      }

      if (!database.objectStoreNames.contains(STORE_MEDIA)) {
        const store: IDBObjectStore =
          database.createObjectStore(STORE_MEDIA, { keyPath: "mediaId" });
        store.createIndex("bySession", "sessionId", { unique: false });
      }
    };

    request.onsuccess = function onSuccess(): void {
      cachedDatabase = request.result;
      cachedDatabase.onclose = function onClose(): void {
        cachedDatabase = null;
      };
      resolve(request.result);
    };

    request.onerror = function onError(): void {
      reject(request.error ?? new Error("Could not open the database."));
    };
  });
}

/**
 * Wraps one IDBRequest in a promise. Every helper below goes through this so
 * the error handling is written exactly once.
 */
function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>(function executor(resolve, reject): void {
    request.onsuccess = function onSuccess(): void {
      resolve(request.result);
    };
    request.onerror = function onError(): void {
      reject(request.error ?? new Error("An IndexedDB request failed."));
    };
  });
}

/**
 * Puts one record into one store.
 */
export async function putRecord<T>(storeName: string, record: T): Promise<void> {
  const database: IDBDatabase = await openDatabase();
  const transaction: IDBTransaction = database.transaction(storeName, "readwrite");
  const store: IDBObjectStore = transaction.objectStore(storeName);
  await promisifyRequest(store.put(record as unknown as never));
}

/**
 * Puts many records into one store inside a single transaction.
 * WHY batched: writing 400 events one transaction at a time is measurably slow.
 */
export async function putRecords<T>(storeName: string, records: T[]): Promise<void> {
  if (records.length === 0) {
    return;
  }
  const database: IDBDatabase = await openDatabase();
  const transaction: IDBTransaction = database.transaction(storeName, "readwrite");
  const store: IDBObjectStore = transaction.objectStore(storeName);
  for (let index = 0; index < records.length; index = index + 1) {
    store.put(records[index] as unknown as never);
  }
  await new Promise<void>(function executor(resolve, reject): void {
    transaction.oncomplete = function onComplete(): void {
      resolve();
    };
    transaction.onerror = function onError(): void {
      reject(transaction.error ?? new Error("A batched write failed."));
    };
  });
}

/**
 * Reads one record by primary key, or null when it does not exist.
 */
export async function getRecord<T>(
  storeName: string,
  key: IDBValidKey,
): Promise<T | null> {
  const database: IDBDatabase = await openDatabase();
  const transaction: IDBTransaction = database.transaction(storeName, "readonly");
  const store: IDBObjectStore = transaction.objectStore(storeName);
  const result: T | undefined = await promisifyRequest<T | undefined>(
    store.get(key) as IDBRequest<T | undefined>,
  );
  if (result === undefined) {
    return null;
  }
  return result;
}

/**
 * Reads every record in a store.
 */
export async function getAllRecords<T>(storeName: string): Promise<T[]> {
  const database: IDBDatabase = await openDatabase();
  const transaction: IDBTransaction = database.transaction(storeName, "readonly");
  const store: IDBObjectStore = transaction.objectStore(storeName);
  return await promisifyRequest<T[]>(store.getAll() as IDBRequest<T[]>);
}

/**
 * Reads every record for one session out of one store.
 */
export async function readAllForSession<T>(
  storeName: string,
  sessionId: string,
): Promise<T[]> {
  const database: IDBDatabase = await openDatabase();
  const transaction: IDBTransaction = database.transaction(storeName, "readonly");
  const store: IDBObjectStore = transaction.objectStore(storeName);
  const index: IDBIndex = store.index("bySession");
  return await promisifyRequest<T[]>(
    index.getAll(IDBKeyRange.only(sessionId)) as IDBRequest<T[]>,
  );
}

/**
 * Counts the records for one session in one store, without loading them.
 * WHY: the review page shows counts long before it needs the data itself.
 */
export async function countForSession(
  storeName: string,
  sessionId: string,
): Promise<number> {
  const database: IDBDatabase = await openDatabase();
  const transaction: IDBTransaction = database.transaction(storeName, "readonly");
  const store: IDBObjectStore = transaction.objectStore(storeName);
  const index: IDBIndex = store.index("bySession");
  return await promisifyRequest<number>(index.count(IDBKeyRange.only(sessionId)));
}

/**
 * Deletes one record by primary key.
 */
export async function deleteRecord(
  storeName: string,
  key: IDBValidKey,
): Promise<void> {
  const database: IDBDatabase = await openDatabase();
  const transaction: IDBTransaction = database.transaction(storeName, "readwrite");
  const store: IDBObjectStore = transaction.objectStore(storeName);
  await promisifyRequest(store.delete(key));
}

/**
 * Deletes every record belonging to one session, across every scoped store,
 * in ONE transaction.
 *
 * WHY one transaction: a half-deleted session leaves orphaned 60 MB blobs that
 * nothing in the UI can find or free.
 */
export async function deleteEverythingForSession(sessionId: string): Promise<void> {
  const database: IDBDatabase = await openDatabase();
  const storeNames: string[] = [STORE_SESSIONS];
  for (let index = 0; index < SESSION_SCOPED_STORES.length; index = index + 1) {
    storeNames.push(SESSION_SCOPED_STORES[index]);
  }

  const transaction: IDBTransaction = database.transaction(storeNames, "readwrite");

  transaction.objectStore(STORE_SESSIONS).delete(sessionId);

  for (let index = 0; index < SESSION_SCOPED_STORES.length; index = index + 1) {
    const store: IDBObjectStore = transaction.objectStore(SESSION_SCOPED_STORES[index]);
    const sessionIndex: IDBIndex = store.index("bySession");
    const cursorRequest: IDBRequest<IDBCursor | null> =
      sessionIndex.openKeyCursor(IDBKeyRange.only(sessionId));

    cursorRequest.onsuccess = function onCursor(): void {
      const cursor: IDBCursor | null = cursorRequest.result;
      if (cursor === null) {
        return;
      }
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  }

  await new Promise<void>(function executor(resolve, reject): void {
    transaction.oncomplete = function onComplete(): void {
      resolve();
    };
    transaction.onerror = function onError(): void {
      reject(transaction.error ?? new Error("Deleting the session failed."));
    };
  });
}

/**
 * Drops every object store's contents. Used by "Clear all data".
 */
export async function clearAllData(): Promise<void> {
  const database: IDBDatabase = await openDatabase();
  const storeNames: string[] = [STORE_SESSIONS];
  for (let index = 0; index < SESSION_SCOPED_STORES.length; index = index + 1) {
    storeNames.push(SESSION_SCOPED_STORES[index]);
  }
  const transaction: IDBTransaction = database.transaction(storeNames, "readwrite");
  for (let index = 0; index < storeNames.length; index = index + 1) {
    transaction.objectStore(storeNames[index]).clear();
  }
  await new Promise<void>(function executor(resolve, reject): void {
    transaction.oncomplete = function onComplete(): void {
      resolve();
    };
    transaction.onerror = function onError(): void {
      reject(transaction.error ?? new Error("Clearing all data failed."));
    };
  });
}
