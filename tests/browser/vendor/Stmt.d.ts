import { DBAsync, StmtAsync, TXAsync } from "@vlcn.io/xplat-api";
import TX from "./TX.js";
export default class Stmt implements StmtAsync {
    private originDB;
    private stmtFinalizer;
    private cache;
    private api;
    private base;
    private str;
    private sql;
    private mode;
    private finalized;
    private bindings;
    constructor(originDB: TX, stmtFinalizer: Map<number, Stmt>, cache: Map<string, Promise<any>>, api: SQLiteAPI, base: number, str: number, sql: string);
    run(tx: DBAsync | null, ...bindArgs: any[]): Promise<any>;
    get(tx: DBAsync | null, ...bindArgs: any[]): Promise<any>;
    all(tx: DBAsync | null, ...bindArgs: any[]): Promise<any[]>;
    iterate<T>(tx: DBAsync | null, ...bindArgs: any[]): AsyncIterator<T>;
    raw(isRaw?: boolean): this;
    bind(args: any[]): this;
    /**
     * Release the resources associated with the prepared statement.
     * If you fail to call this it will automatically be called when the statement is garbage collected.
     */
    finalize(tx: TXAsync | null): Promise<void>;
}
//# sourceMappingURL=Stmt.d.ts.map