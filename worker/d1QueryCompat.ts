type QueryError = {
  message: string;
  code?: string;
};

export type QueryResult<T = unknown> = {
  data: T | null;
  error: QueryError | null;
};

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: null }
  | { kind: "containsAny"; columns: string[]; value: string };

type OrderBy = {
  column: string;
  ascending: boolean;
};

const D1_MAX_BOUND_PARAMETERS_PER_QUERY = 100;
const JSON_COLUMNS = new Set([
  "revealed_blocks",
  "round_scores",
  "selected_question_ids",
  "team_battle_state",
  "lobby_round_scores",
  "anime_tags_json",
  "character_tags_json",
  "anime_genre_tags_json",
]);
const BOOLEAN_COLUMNS = new Set(["is_host", "is_public", "is_r18"]);
const UPDATED_AT_TABLES = new Set(["rooms", "question_sets", "question_set_ratings"]);
const CREATED_AT_TABLES = new Set([
  "rooms",
  "question_sets",
  "question_image_index",
  "community_question_set_submissions",
  "questions",
  "game_sessions",
  "question_set_ratings",
  "question_snapshots",
  "question_eligible_players",
  "game_participants",
]);
const IMMUTABLE_ON_CONFLICT_COLUMNS = new Set(["created_at", "joined_at"]);
const INSERT_DEFAULT_ONLY_COLUMNS = new Set(["created_at", "joined_at", "submitted_at", "server_received_at", "judged_at"]);
const ID_TABLES = new Set([
  "rooms",
  "question_sets",
  "questions",
  "game_sessions",
  "answers",
  "player_scores",
  "question_results",
  "question_set_ratings",
  "buzzer_answers",
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeValue(column: string, value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (JSON_COLUMNS.has(column)) {
    return JSON.stringify(value ?? []);
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value;
}

function denormalizeRow<T>(row: Record<string, unknown>): T {
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (JSON_COLUMNS.has(key) && typeof value === "string") {
      try {
        next[key] = JSON.parse(value);
      } catch {
        next[key] = [];
      }
      continue;
    }

    if (BOOLEAN_COLUMNS.has(key)) {
      next[key] = Boolean(value);
      continue;
    }

    next[key] = value;
  }

  return next as T;
}

function cleanRecord(table: string, record: Record<string, unknown>) {
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    const normalized = normalizeValue(key, value);
    if (normalized !== undefined) {
      next[key] = normalized;
    }
  }

  if (ID_TABLES.has(table) && !next.id) {
    next.id = crypto.randomUUID();
  }

  const now = nowIso();
  if (CREATED_AT_TABLES.has(table) && !("created_at" in next)) {
    next.created_at = now;
  }
  if (UPDATED_AT_TABLES.has(table)) {
    next.updated_at = now;
  }
  if (table === "players" && !("joined_at" in next)) {
    next.joined_at = now;
  }
  if (table === "answers" && !("submitted_at" in next)) {
    next.submitted_at = now;
  }
  if (table === "buzzer_answers" && !("submitted_at" in next)) {
    next.submitted_at = now;
  }
  if (table === "buzzer_answers" && !("server_received_at" in next)) {
    next.server_received_at = next.submitted_at ?? now;
  }
  if (table === "question_results" && !("judged_at" in next)) {
    next.judged_at = now;
  }

  return next;
}

function hasExplicitPrimaryKey(table: string, record: Record<string, unknown>) {
  if (!ID_TABLES.has(table) || !Object.prototype.hasOwnProperty.call(record, "id")) {
    return false;
  }

  const normalized = normalizeValue("id", record.id);
  return normalized !== undefined && normalized !== null && normalized !== "";
}

function sqlIdentifier(value: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`SQL 标识符无效：${value}`);
  }
  return `"${value}"`;
}

function parseSelectedColumns(columns: string) {
  const trimmed = columns.trim();
  if (!trimmed || trimmed === "*") {
    return null;
  }

  return trimmed
    .split(",")
    .map((column) => column.trim())
    .filter(Boolean)
    .map((column) => {
      if (column === "*") {
        throw new Error("字段选择不能混用 * 和具体字段。");
      }
      return column;
    });
}

function uniqueError(error: unknown): QueryError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    code: /unique/i.test(message) ? "23505" : undefined,
  };
}

export interface GamePreparedStatement {
  bind(...values: unknown[]): GamePreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export interface GameDatabase {
  prepare(query: string): GamePreparedStatement;
  batch<T = Record<string, unknown>>(statements: GamePreparedStatement[]): Promise<Array<{ results?: T[] }>>;
}

export type GameDatabaseMutationTracker = {
  successfulWrites: number;
  markValidated?: () => void;
};

type AtomicInsertOperation = {
  table: string;
  records: Record<string, unknown>[];
};

export type AtomicStatement = {
  query: string;
  bindings?: readonly unknown[];
};

async function executeAtomicStatements(
  db: GameDatabase | null,
  operations: readonly AtomicStatement[],
  mutationTracker?: GameDatabaseMutationTracker,
): Promise<QueryResult<Record<string, unknown>[][]>> {
  if (!db) {
    return { data: null, error: { message: "游戏数据库绑定不可用，请检查本地开发服务配置。" } };
  }

  try {
    const statements = operations.map((operation) => {
      if (!operation.query.trim()) throw new Error("原子 SQL 语句不能为空。");
      return db.prepare(operation.query).bind(...(operation.bindings ?? []));
    });
    const results = statements.length > 0
      ? await db.batch<Record<string, unknown>>(statements)
      : [];
    const rowsByOperation = results.map((result) => (result.results ?? []).map((row) => denormalizeRow(row)));
    if (mutationTracker) {
      mutationTracker.successfulWrites += rowsByOperation.reduce((total, rows) => total + rows.length, 0);
    }
    return { data: rowsByOperation, error: null };
  } catch (error) {
    return { data: null, error: uniqueError(error) };
  }
}

async function executeAtomicInserts(
  db: GameDatabase | null,
  operations: AtomicInsertOperation[],
  mutationTracker?: GameDatabaseMutationTracker,
): Promise<QueryResult<Record<string, unknown>[][]>> {
  if (!db) {
    return { data: null, error: { message: "游戏数据库绑定不可用，请检查本地开发服务配置。" } };
  }

  try {
    const rowsByOperation: Record<string, unknown>[][] = operations.map(() => []);
    const statements: GamePreparedStatement[] = [];
    const statementOperationIndexes: number[] = [];

    operations.forEach((operation, operationIndex) => {
      const records = operation.records.map((record) => cleanRecord(operation.table, record));
      if (records.length === 0) return;
      const columns = Object.keys(records[0]);
      if (columns.length === 0 || columns.length > D1_MAX_BOUND_PARAMETERS_PER_QUERY) {
        throw new Error(`${operation.table} 原子写入字段数量无效。`);
      }
      if (records.some((record) => {
        const recordColumns = Object.keys(record);
        return recordColumns.length !== columns.length
          || columns.some((column) => !Object.prototype.hasOwnProperty.call(record, column));
      })) {
        throw new Error(`${operation.table} 原子写入要求每行字段一致。`);
      }

      const rowsPerStatement = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMETERS_PER_QUERY / columns.length));
      const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
      for (let start = 0; start < records.length; start += rowsPerStatement) {
        const chunk = records.slice(start, start + rowsPerStatement);
        const values = chunk.flatMap((record) => columns.map((column) => record[column]));
        const placeholders = chunk.map(() => rowPlaceholder).join(", ");
        const sql = `INSERT INTO ${sqlIdentifier(operation.table)} (${columns
          .map(sqlIdentifier)
          .join(", ")}) VALUES ${placeholders} RETURNING *`;
        statements.push(db.prepare(sql).bind(...values));
        statementOperationIndexes.push(operationIndex);
      }
    });

    const results = statements.length > 0
      ? await db.batch<Record<string, unknown>>(statements)
      : [];
    results.forEach((result, statementIndex) => {
      const operationIndex = statementOperationIndexes[statementIndex];
      rowsByOperation[operationIndex].push(...(result.results ?? []).map((row) => denormalizeRow(row)));
    });
    if (mutationTracker) {
      mutationTracker.successfulWrites += rowsByOperation.reduce((total, rows) => total + rows.length, 0);
    }
    return { data: rowsByOperation, error: null };
  } catch (error) {
    return { data: null, error: uniqueError(error) };
  }
}

class D1QueryBuilder<T = unknown> implements PromiseLike<QueryResult<T>> {
  private operation: "select" | "insert" | "update" | "delete" = "select";
  private filters: Filter[] = [];
  private orderBys: OrderBy[] = [];
  private maxRows: number | null = null;
  private offsetRows = 0;
  private selectedColumns: string[] | null = null;
  private countMode = false;
  private payload: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private conflictColumns: string[] = [];
  private ignoreDuplicates = false;
  private singleMode: "none" | "single" | "maybeSingle" = "none";

  constructor(
    private readonly db: GameDatabase | null,
    private readonly table: string,
    private readonly mutationTracker?: GameDatabaseMutationTracker,
  ) {}

  select(columns = "*") {
    if (this.operation === "select") {
      this.operation = "select";
    }
    this.selectedColumns = parseSelectedColumns(columns);
    return this;
  }

  insert(payload: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.operation = "insert";
    this.payload = payload;
    this.conflictColumns =
      options?.onConflict
        ?.split(",")
        .map((column) => column.trim())
        .filter(Boolean) ?? [];
    this.ignoreDuplicates = options?.ignoreDuplicates ?? false;
    return this;
  }

  update(payload: Record<string, unknown>) {
    this.operation = "update";
    this.payload = payload;
    return this;
  }

  upsert(payload: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string }) {
    this.operation = "insert";
    this.payload = payload;
    this.conflictColumns =
      options?.onConflict
        ?.split(",")
        .map((column) => column.trim())
        .filter(Boolean) ?? [];
    this.ignoreDuplicates = false;
    return this;
  }

  delete() {
    this.operation = "delete";
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push({ kind: "eq", column, value });
    return this;
  }

  is(column: string, value: null) {
    this.filters.push({ kind: "is", column, value });
    return this;
  }

  containsAny(columns: string[], value: string) {
    const normalizedColumns = Array.from(new Set(columns.map((column) => column.trim()).filter(Boolean)));
    const normalizedValue = value.trim();
    if (normalizedColumns.length > 0 && normalizedValue) {
      this.filters.push({ kind: "containsAny", columns: normalizedColumns, value: normalizedValue });
    }
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orderBys.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(value: number) {
    this.maxRows = value;
    return this;
  }

  offset(value: number) {
    this.offsetRows = Math.max(0, Math.floor(value));
    return this;
  }

  count() {
    this.countMode = true;
    this.selectedColumns = null;
    return this;
  }

  single<U = T>() {
    this.singleMode = "single";
    return this as unknown as D1QueryBuilder<U>;
  }

  maybeSingle<U = T>() {
    this.singleMode = "maybeSingle";
    return this as unknown as D1QueryBuilder<U>;
  }

  returns<U>() {
    return this as unknown as D1QueryBuilder<U>;
  }

  then<TResult1 = QueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private whereSql(params: unknown[]) {
    if (this.filters.length === 0) {
      return "";
    }

    const clauses = this.filters.map((filter) => {
      if (filter.kind === "is") {
        return `${sqlIdentifier(filter.column)} IS NULL`;
      }
      if (filter.kind === "containsAny") {
        return `(${filter.columns
          .map((column) => {
            params.push(filter.value);
            return `INSTR(LOWER(COALESCE(${sqlIdentifier(column)}, '')), LOWER(?)) > 0`;
          })
          .join(" OR ")})`;
      }
      params.push(normalizeValue(filter.column, filter.value));
      return `${sqlIdentifier(filter.column)} = ?`;
    });

    return ` WHERE ${clauses.join(" AND ")}`;
  }

  private orderSql() {
    if (this.orderBys.length === 0) {
      return "";
    }

    return ` ORDER BY ${this.orderBys
      .map((orderBy) => `${sqlIdentifier(orderBy.column)} ${orderBy.ascending ? "ASC" : "DESC"}`)
      .join(", ")}`;
  }

  private limitSql() {
    if (this.maxRows == null) {
      return this.offsetRows > 0 ? ` LIMIT -1 OFFSET ${this.offsetRows}` : "";
    }
    return ` LIMIT ${Math.max(0, Math.floor(this.maxRows))} OFFSET ${this.offsetRows}`;
  }

  private async execute(): Promise<QueryResult<T>> {
    if (!this.db) {
      return { data: null, error: { message: "游戏数据库绑定不可用，请检查本地开发服务配置。" } };
    }

    try {
      if (this.operation === "select") {
        return await this.executeSelect();
      }
      if (this.operation === "insert") {
        return await this.executeInsert();
      }
      if (this.operation === "update") {
        return await this.executeUpdate();
      }
      return await this.executeDelete();
    } catch (error) {
      return { data: null, error: uniqueError(error) };
    }
  }

  private shapeRows(rows: Record<string, unknown>[]): QueryResult<T> {
    const data = rows.map((row) => denormalizeRow(row));

    if (this.singleMode === "single") {
      if (data.length !== 1) {
        return { data: null, error: { message: `${this.table} 查询结果异常：预期 1 行，实际 ${data.length} 行。` } };
      }
      return { data: data[0] as T, error: null };
    }

    if (this.singleMode === "maybeSingle") {
      if (data.length > 1) {
        return { data: null, error: { message: `${this.table} 查询结果异常：预期最多 1 行，实际 ${data.length} 行。` } };
      }
      return { data: (data[0] as T) ?? null, error: null };
    }

    return { data: data as T, error: null };
  }

  private async executeSelect(): Promise<QueryResult<T>> {
    const params: unknown[] = [];
    const selectedColumns = this.selectedSql();
    const sql = `SELECT ${selectedColumns} FROM ${sqlIdentifier(this.table)}${this.whereSql(params)}${this.orderSql()}${this.limitSql()}`;
    const result = await this.db!.prepare(sql).bind(...params).all<Record<string, unknown>>();
    return this.shapeRows(result.results ?? []);
  }

  private selectedSql() {
    if (this.countMode) {
      return 'COUNT(*) AS "count"';
    }
    return this.selectedColumns?.length ? this.selectedColumns.map(sqlIdentifier).join(", ") : "*";
  }

  private async executeInsert(): Promise<QueryResult<T>> {
    const records = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
    const cleanedRecords = records.map((record) => cleanRecord(this.table, record));
    if (cleanedRecords.length === 0) {
      return this.shapeRows([]);
    }

    const rows: Record<string, unknown>[] = [];
    const columns = Object.keys(cleanedRecords[0]);
    const explicitPrimaryKeyByIndex = records.map((record) => hasExplicitPrimaryKey(this.table, record));
    const canUseBulkInsert = cleanedRecords.every((record, index) => {
      const recordColumns = Object.keys(record);
      return (
        explicitPrimaryKeyByIndex[index] === explicitPrimaryKeyByIndex[0] &&
        recordColumns.length === columns.length &&
        columns.every((column) => Object.prototype.hasOwnProperty.call(record, column))
      );
    });

    if (canUseBulkInsert && cleanedRecords.length > 1) {
      const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
      const updateGeneratedId = explicitPrimaryKeyByIndex[0];
      const updateColumns = columns.filter(
        (column) =>
          !this.conflictColumns.includes(column) &&
          !IMMUTABLE_ON_CONFLICT_COLUMNS.has(column) &&
          (column !== "id" || updateGeneratedId) &&
          (!INSERT_DEFAULT_ONLY_COLUMNS.has(column) || records.every((record) => Object.prototype.hasOwnProperty.call(record, column))),
      );
      const conflict =
        this.conflictColumns.length > 0
          ? ` ON CONFLICT (${this.conflictColumns.map(sqlIdentifier).join(", ")}) ${
              this.ignoreDuplicates || updateColumns.length === 0
                ? "DO NOTHING"
                : `DO UPDATE SET ${updateColumns
                    .map((column) => `${sqlIdentifier(column)} = excluded.${sqlIdentifier(column)}`)
                    .join(", ")}`
            }`
          : "";
      const rowsPerStatement = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMETERS_PER_QUERY / columns.length));
      const statements: GamePreparedStatement[] = [];

      for (let start = 0; start < cleanedRecords.length; start += rowsPerStatement) {
        const chunk = cleanedRecords.slice(start, start + rowsPerStatement);
        const values = chunk.flatMap((record) => columns.map((column) => record[column]));
        const placeholders = chunk.map(() => rowPlaceholder).join(", ");
        const sql = `INSERT INTO ${sqlIdentifier(this.table)} (${columns
          .map(sqlIdentifier)
          .join(", ")}) VALUES ${placeholders}${conflict} RETURNING ${this.selectedSql()}`;
        statements.push(this.db!.prepare(sql).bind(...values));
      }

      const results = await this.db!.batch<Record<string, unknown>>(statements);
      const affectedRows = results.flatMap((result) => result.results ?? []);
      if (this.mutationTracker) this.mutationTracker.successfulWrites += affectedRows.length;
      return this.shapeRows(affectedRows);
    }

    for (let index = 0; index < records.length; index += 1) {
      const rawRecord = records[index];
      const updateGeneratedId = hasExplicitPrimaryKey(this.table, rawRecord);
      const record = cleanedRecords[index];
      const recordColumns = Object.keys(record);
      const values = recordColumns.map((column) => record[column]);
      const placeholders = recordColumns.map(() => "?").join(", ");
      const updateColumns = recordColumns.filter(
        (column) =>
          !this.conflictColumns.includes(column) &&
          !IMMUTABLE_ON_CONFLICT_COLUMNS.has(column) &&
          (column !== "id" || updateGeneratedId) &&
          (!INSERT_DEFAULT_ONLY_COLUMNS.has(column) || Object.prototype.hasOwnProperty.call(rawRecord, column)),
      );
      const conflict =
        this.conflictColumns.length > 0
          ? ` ON CONFLICT (${this.conflictColumns.map(sqlIdentifier).join(", ")}) ${
              this.ignoreDuplicates || updateColumns.length === 0
                ? "DO NOTHING"
                : `DO UPDATE SET ${updateColumns
                    .map((column) => `${sqlIdentifier(column)} = excluded.${sqlIdentifier(column)}`)
                    .join(", ")}`
            }`
          : "";
      const sql = `INSERT INTO ${sqlIdentifier(this.table)} (${recordColumns
        .map(sqlIdentifier)
        .join(", ")}) VALUES (${placeholders})${conflict} RETURNING ${this.selectedSql()}`;
      const result = await this.db!.prepare(sql).bind(...values).first<Record<string, unknown>>();
      if (this.mutationTracker && result) this.mutationTracker.successfulWrites += 1;
      if (result) {
        rows.push(result);
      }
    }

    return this.shapeRows(rows);
  }

  private async executeUpdate(): Promise<QueryResult<T>> {
    const rawRecord = (this.payload ?? {}) as Record<string, unknown>;
    const record = cleanRecord(this.table, rawRecord);
    delete record.id;
    delete record.created_at;
    delete record.joined_at;
    for (const column of INSERT_DEFAULT_ONLY_COLUMNS) {
      if (!Object.prototype.hasOwnProperty.call(rawRecord, column)) delete record[column];
    }

    if (Object.keys(record).length === 0) {
      return { data: null, error: { message: `${this.table} 更新失败：没有可更新的字段。` } };
    }

    const params = Object.entries(record).map(([, value]) => value);
    const sql = `UPDATE ${sqlIdentifier(this.table)} SET ${Object.keys(record)
      .map((column) => `${sqlIdentifier(column)} = ?`)
      .join(", ")}${this.whereSql(params)} RETURNING ${this.selectedSql()}`;
    const result = await this.db!.prepare(sql).bind(...params).all<Record<string, unknown>>();
    const affectedRows = result.results ?? [];
    if (this.mutationTracker) this.mutationTracker.successfulWrites += affectedRows.length;
    return this.shapeRows(affectedRows);
  }

  private async executeDelete(): Promise<QueryResult<T>> {
    const params: unknown[] = [];
    const sql = `DELETE FROM ${sqlIdentifier(this.table)}${this.whereSql(params)} RETURNING ${this.selectedSql()}`;
    const result = await this.db!.prepare(sql).bind(...params).all<Record<string, unknown>>();
    const affectedRows = result.results ?? [];
    if (this.mutationTracker) this.mutationTracker.successfulWrites += affectedRows.length;
    return this.shapeRows(affectedRows);
  }
}

export function createD1QueryClient(db: GameDatabase | null, mutationTracker?: GameDatabaseMutationTracker) {
  return {
    hasDatabase() {
      return Boolean(db);
    },
    from(table: string) {
      return new D1QueryBuilder(db, table, mutationTracker);
    },
    insertAtomically(operations: AtomicInsertOperation[]) {
      return executeAtomicInserts(db, operations, mutationTracker);
    },
    executeAtomically(operations: readonly AtomicStatement[]) {
      return executeAtomicStatements(db, operations, mutationTracker);
    },
  };
}
