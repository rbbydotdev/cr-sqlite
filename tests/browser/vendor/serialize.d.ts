import TX from "./TX.js";
import { Mutex } from "async-mutex";
import { TMutex, TXAsync } from "@vlcn.io/xplat-api";
/**
 * Although wa-sqlite exposes an async interface, hitting
 * it concurrently deadlocks it.
 *
 * It is only to be used sequentially.
 *
 * Serialize enforces that, nomatter what the callers of us do.
 *
 * null clears cache. Use for writes.
 * string gets from cache.
 * undefined has no impact on cache and does not check cache.
 */
export declare const topLevelMutex: Mutex;
export declare function serialize(cache: Map<string, Promise<any>> | null, key: string | null | undefined, cb: () => any, mutex: TMutex): Promise<any>;
export declare function serializeTx(cb: (db: TXAsync) => any, mutex: Mutex, db: TX): Promise<any>;
//# sourceMappingURL=serialize.d.ts.map