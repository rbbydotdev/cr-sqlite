import * as SQLite from "@vlcn.io/wa-sqlite";
import { DB } from "./DB.js";
export { DB } from "./DB.js";
type SQLiteAPI = ReturnType<typeof SQLite.Factory>;
export declare class SQLite3 {
    private base;
    constructor(base: SQLiteAPI);
    open(filename?: string, mode?: string): Promise<DB>;
}
export default function initWasm(locateWasm?: (file: string) => string): Promise<SQLite3>;
//# sourceMappingURL=index.d.ts.map