import type {
  CompiledQuery,
  InferResult,
  SelectQueryBuilder,
} from 'kysely'
import {
  CamelCasePlugin,
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from 'kysely'
import type { QueryResult } from 'tauri-plugin-sql-api'
import type Database from 'tauri-plugin-sql-api'
import camelcaseKeys from 'camelcase-keys'
import { camelCase } from 'camel-case'

import type { DB } from './transform-types'
import { Program } from './models/program'
import { Activity } from './models/activity'
import { Plan } from './models/plan'
import { Label } from './models/label'
import { Note } from './models/note'
export type { QueryResult } from 'tauri-plugin-sql-api'

type IsSelectQueryBuilder<T> = T extends SelectQueryBuilder<any, any, any> ? true : false
type IsTransactionQueryBuilder<T> = T extends TransactionQueryBuilder<any, any> ? true : false

type IsQueryBuilder<T> = T extends {
  compile(): any
} ? true : false

type Transform<T> =
  {
    [K in keyof T]:
    T[K] extends (...args: any) => any
      ? (...args: Parameters<T[K]>) =>
        IsQueryBuilder<ReturnType<T[K]>> extends true
          ?
          Promise<
            IsSelectQueryBuilder<ReturnType<T[K]>> extends true
              ? InferResult<ReturnType<ReturnType<T[K]>['compile']>>
              : IsTransactionQueryBuilder<ReturnType<T[K]>> extends true
                ? Awaited<ReturnType<ReturnType<ReturnType<T[K]>['compile']>>>
                : QueryResult
            >
          : never
      : T[K]
  }

const kysely = new Kysely<DB>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: db => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
  plugins: [
    new CamelCasePlugin(),
  ],
})

function transformResult(constructor, obj) {
  const { __transform } = constructor
  if (!__transform)
    return obj
  if (__transform.get)
    Object.assign(obj, __transform.get(obj))

  for (const key in __transform.relation) {
    obj[key] = JSON.parse(obj[key])
    transformResult(__transform.relation[key], obj[key])
  }

  return obj
}

function createKyselyDatabase<U extends Record<string, object>>(executor: DatabaseExecutor, models: U) {
  class KyselyDatabase<M extends Record<string, object>> {
    #executor: DatabaseExecutor

    constructor(executor: DatabaseExecutor, models: M) {
      this.#executor = executor
      for (const modelKey in models) {
        const obj = {
          [modelKey]: new Proxy(models[modelKey], {
            get: (target, p) => {
              if (typeof target[p] === 'function') {
                return (...args) => {
                  const fn = target[p]
                  const { __transform } = target.constructor as any
                  const { __setIndex, __getFlag } = fn as any
                  if (__transform && __transform.set && typeof __setIndex == 'number')
                    Object.assign(args[__setIndex], __transform.set(args[__setIndex]))

                  const query = fn.apply(target, args)
                  const CompiledQuery = query.compile()

                  if (query instanceof TransactionQueryBuilder)
                    return this.#executeTransaction(CompiledQuery as any)

                  if (__getFlag) {
                    return this.#select(CompiledQuery).then((result) => {
                      if (__transform)
                        return (result as object[]).map(i => transformResult(target.constructor as any, i))

                      else
                        return result
                    }).then(result => camelcaseKeys(result, {
                      deep: true,
                    }))
                  }

                  return this.#execute(CompiledQuery)
                }
              }
              else {
                return target[p]
              }
            },
          }),
        }
        Object.assign(this, obj)
      }
    }

    async #execute<T extends CompiledQuery>(query: T) {
      try {
        return await this.#executor.execute(query.sql, query.parameters as unknown[])
      }
      catch (error) {
        throw this.#executor.handleError(error)
      }
    }

    #select<T extends CompiledQuery>(query: T) {
      return this.#executor.select<InferResult<T>>(query.sql, query.parameters as unknown[])
    }

    async #executeTransaction(callback: (trx) => Promise<unknown>) {
      try {
        await this.#executor.execute('begin')
        const result = await callback(this)
        await this.#executor.execute('commit')
        return result
      }
      catch (error) {
        await this.#executor.execute('rollback')
        throw error
      }
    }
  }
  return new KyselyDatabase(executor, models) as KyselyDatabase<U> & Executor<U>
}

export class TransactionBuilder<T> {
  execute<U>(callback: (trx: T) => Promise<U>) {
    return new TransactionQueryBuilder<T, U>(callback)
  }
}

export class TransactionQueryBuilder<T, U> {
  constructor(private callback: (trx: T) => Promise<U>) {}

  compile() {
    return this.callback
  }
}

const program = new Program(kysely)
const activity = new Activity(kysely, program)
const plan = new Plan(kysely)
const label = new Label(kysely)
const note = new Note(kysely, label, plan)
const models = {
  program,
  activity,
  plan,
  label,
  note,
}

export type Executor<U = typeof models> = { [K in keyof U]: Transform<U[K]> }

export function createKyselyDatabaseWithModels(executor: DatabaseExecutor) {
  return createKyselyDatabase(executor, models)
}

export enum SqliteErrorEnum {
  RAW = -1,
  SQLITE_CONSTRAINT_UNIQUE = 2067,
}

export class DatabaseError extends Error {
  code: number
  fields: string[]

  constructor(message: string, code: number, fields: string[]) {
    super(message)
    this.name = 'DatabaseError'
    this.code = code
    this.fields = fields
  }
}

export type DatabaseExecutor = Pick<Database, 'execute' | 'select'> & {
  handleError(err: unknown): DatabaseError
}

export function findSqliteMessageFields(message: string) {
  const regex = /[a-zA-Z0-9]+\.([a-zA-Z0-9_]+)/g
  let match: RegExpExecArray | null
  const fields: string[] = []
  match = regex.exec(message)
  while (match !== null) {
    fields.push(match[1])
    match = regex.exec(message)
  }
  return fields.map(v => camelCase(v))
}
