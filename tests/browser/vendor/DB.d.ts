import { DBAsync, StmtAsync, TXAsync, UpdateType } from "@vlcn.io/xplat-api";
export declare class DB implements DBAsync {
    #private;
    api: SQLiteAPI;
    db: number;
    readonly filename: string;
    readonly __mutex: import("async-mutex/lib/Mutex.js").default;
    private stmtFinalizer;
    private cache;
    constructor(api: SQLiteAPI, db: number, filename: string);
    get siteid(): string;
    _setSiteid(siteid: string): void;
    _setTablesUsedStmt(stmt: StmtAsync): void;
    get tablesUsedStmt(): StmtAsync;
    automigrateTo(schemaName: string, schemaContent: string): Promise<"noop" | "apply" | "migrate">;
    execMany(sql: string[]): Promise<any>;
    exec(sql: string, bind?: SQLiteCompatibleType[]): Promise<void>;
    /**
     * @returns returns an object for each row, e.g. `{ col1: valA, col2: valB, ... }`
     */
    execO<T extends {}>(sql: string, bind?: SQLiteCompatibleType[]): Promise<T[]>;
    /**
     * @returns returns an array for each row, e.g. `[ valA, valB, ... ]`
     */
    execA<T extends any[]>(sql: string, bind?: SQLiteCompatibleType[]): Promise<T[]>;
    prepare(sql: string): Promise<StmtAsync>;
    tx(cb: (tx: TXAsync) => Promise<void>): Promise<void>;
    imperativeTx(): Promise<[() => void, TXAsync]>;
    /**
     * Close the database and finalize any prepared statements that were not freed for the given DB.
     */
    close(): Promise<any>;
    createFunction(name: string, fn: (...args: any) => unknown, opts?: {}): void;
    onUpdate(cb: (type: UpdateType, dbName: string, tblName: string, rowid: bigint) => void): () => void;
}
//# sourceMappingURL=DB.d.ts.map