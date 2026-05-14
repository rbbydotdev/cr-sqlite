import { StmtAsync, TXAsync } from "@vlcn.io/xplat-api";
import { Mutex } from "async-mutex";
import Stmt from "./Stmt.js";
export default class TX implements TXAsync {
    api: SQLiteAPI;
    db: number;
    readonly __mutex: Mutex;
    readonly assertOpen: () => void;
    readonly stmtFinalizer: Map<number, Stmt>;
    private cache;
    constructor(api: SQLiteAPI, db: number, __mutex: Mutex, assertOpen: () => void, stmtFinalizer: Map<number, Stmt>);
    execMany(sql: string[]): Promise<void>;
    exec(sql: string, bind?: SQLiteCompatibleType[]): Promise<void>;
    execO<T extends {}>(sql: string, bind?: SQLiteCompatibleType[]): Promise<T[]>;
    execA<T extends any[]>(sql: string, bind?: SQLiteCompatibleType[]): Promise<T[]>;
    prepare(sql: string): Promise<StmtAsync>;
    tx(cb: (tx: TXAsync) => Promise<void>): Promise<void>;
    imperativeTx(): Promise<[() => void, TXAsync]>;
    private statements;
    private bind;
}
//# sourceMappingURL=TX.d.ts.map