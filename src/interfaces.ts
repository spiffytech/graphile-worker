import { PoolClient, Pool, QueryResultRow, QueryResult } from "pg";
import { Logger } from "./logger";
import { Release } from "./runner";

/*
 * Terminology:
 *
 * - job: an entry in the `jobs` table, representing work to be done
 * - queue: an entry in the `job_queues` table, representing a list of jobs to be executed sequentially
 * - task_identifier: the name of the task to be executed to complete the job
 * - task: a function representing code to be executed for a particular job (identified by the task_identifier); i.e. a file in the `tasks/` folder
 * - task list: an object collection of named tasks
 * - watched task list: an abstraction for a task list that can be updated when the tasks on the disk change
 * - worker: the thing that checks out a job from the database, executes the relevant task, and then returns the job to the database with either success or failure
 * - worker pool: a collection of workers to enable processing multiple jobs in parallel
 * - runner: the thing responsible for building a task list and running a worker pool for said list
 */

export type WithPgClient = <T = void>(
  callback: (pgClient: PoolClient) => Promise<T>
) => Promise<T>;

/**
 * The `addJob` interface is implemented in many places in the library, all
 * conforming to this.
 */
export type AddJobFunction = (
  /**
   * The name of the task that will be executed for this job.
   */
  identifier: string,

  /**
   * The payload (typically a JSON object) that will be passed to the task executor.
   */
  payload?: any,

  /**
   * Additional details about how the job should be handled.
   */
  spec?: TaskSpec
) => Promise<Job>;

export interface Helpers {
  /**
   * A Logger instance.
   */
  logger: Logger;

  /**
   * Grabs a PostgreSQL client from the pool, awaits your callback, then
   * releases the client back to the pool.
   */
  withPgClient: WithPgClient;

  /**
   * Adds a job into our queue.
   */
  addJob: AddJobFunction;
}

export interface JobHelpers extends Helpers {
  /**
   * A Logger instance, scoped to this job.
   */
  logger: Logger;

  /**
   * The currently executing job.
   */
  job: Job;

  /**
   * A shorthand for running an SQL query within the job.
   */
  query<R extends QueryResultRow = any>(
    queryText: string,
    values?: any[]
  ): Promise<QueryResult<R>>;
}

/**
 * Utilities for working with Graphile Worker. Primarily useful for migrating
 * the jobs database and queueing jobs.
 */
export interface WorkerUtils extends Helpers {
  /**
   * A Logger instance, scoped to label: 'WorkerUtils'
   */
  logger: Logger;

  /**
   * Use this to release the WorkerUtils when you no longer need it.
   * Particularly useful in tests, or in short-running scripts.
   */
  release: Release;

  /**
   * Migrate the database schema to the latest version.
   */
  migrate: () => Promise<void>;

  /**
   * Marks the specified jobs (by their ids) as if they were completed,
   * assuming they are not locked. Note that completing a job deletes it. You
   * may mark failed and permanently failed jobs as completed if you wish. The
   * deleted jobs will be returned (note that this may be fewer jobs than you
   * requested).
   */
  completeJobs: (ids: string[]) => Promise<Job[]>;

  /**
   * Marks the specified jobs (by their ids) as failed permanently, assuming
   * they are not locked. This means setting their `attempts` equal to their
   * `max_attempts`. The updated jobs will be returned (note that this may be
   * fewer jobs than you requested).
   */
  permanentlyFailJobs: (ids: string[], reason?: string) => Promise<Job[]>;

  /**
   * Updates the specified scheduling properties of the jobs (assuming they are
   * not locked). All of the specified options are optional, omitted or null
   * values will left unmodified.
   *
   * This method can be used to postpone or advance job execution, or to
   * schedule a previously failed or permanently failed job for execution. The
   * updated jobs will be returned (note that this may be fewer jobs than you
   * requested).
   */
  rescheduleJobs: (
    ids: string[],
    options: {
      runAt?: string | Date;
      priority?: number;
      attempts?: number;
      maxAttempts?: number;
    }
  ) => Promise<Job[]>;
}

export type Task = (
  payload: unknown,
  helpers: JobHelpers
) => void | Promise<void>;

export function isValidTask(fn: unknown): fn is Task {
  if (typeof fn === "function") {
    return true;
  }
  return false;
}

export interface TaskList {
  [name: string]: Task;
}

export interface WatchedTaskList {
  tasks: TaskList;
  release: () => void;
}

export interface Job {
  id: string;
  queue_name: string | null;
  task_identifier: string;
  payload: unknown;
  priority: number;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  key: string | null;
  locked_at: Date | null;
  locked_by: string | null;
}

export interface Worker {
  nudge: () => boolean;
  workerId: string;
  release: () => void;
  promise: Promise<void>;
  getActiveJob: () => Job | null;
}

export interface WorkerPool {
  release: () => Promise<void>;
  gracefulShutdown: (message: string) => Promise<void>;
  promise: Promise<void>;
}

export interface Runner {
  stop: () => Promise<void>;
  addJob: AddJobFunction;
  promise: Promise<void>;
}

export interface TaskSpec {
  /**
   * The queue to run this task under. (Default: null)
   */
  queueName?: string;

  /**
   * A Date to schedule this task to run in the future. (Default: now)
   */
  runAt?: Date;

  /**
   * Higher (numerically larger) priority places job ahead of jobs with lower
   * priority. (Default: 0)
   */
  priority?: number;

  /**
   * How many retries should this task get? (Default: 25)
   */
  maxAttempts?: number;

  /**
   * Unique identifier for the job, can be used to update or remove it later if needed. (Default: null)
   */
  jobKey?: string;
}

export interface WorkerSharedOptions {
  /**
   * How long to wait between polling for jobs in milliseconds (for jobs scheduled in the future/retries)
   */
  pollInterval?: number;

  /**
   * How should messages be logged out? Defaults to using the console logger.
   */
  logger?: Logger;
}

export interface WorkerOptions extends WorkerSharedOptions {
  /**
   * An identifier for this specific worker; if unset then a random ID will be assigned. Do not assign multiple workers the same worker ID!
   */
  workerId?: string;
}

export interface WorkerPoolOptions extends WorkerSharedOptions {
  /**
   * Number of jobs to run concurrently
   */
  concurrency?: number;

  /**
   * If set true, we won't install signal handlers and it'll be up to you to
   * handle graceful shutdown of the worker if the process receives a signal.
   */
  noHandleSignals?: boolean;
}

export interface RunnerOptions extends WorkerPoolOptions {
  /**
   * Task names and handler, e.g. from `getTasks` (use this if you need watch mode)
   */
  taskList?: TaskList;
  /**
   * Each file in this directory will be used as a task handler
   */
  taskDirectory?: string;
  /**
   * A PostgreSQL connection string to the database containing the job queue
   */
  connectionString?: string;
  /**
   * A pg.Pool instance to use instead of the `connectionString`
   */
  pgPool?: Pool;
  /**
   * The maximum size of the PostgreSQL pool. Defaults to the node-postgres
   * default (10).
   */
  maxPoolSize?: number;
}

export interface WorkerUtilsOptions {
  /**
   * A PostgreSQL connection string to the database containing the job queue
   */
  connectionString?: string;

  /**
   * A pg.Pool instance to use instead of the `connectionString`
   */
  pgPool?: Pool;

  /**
   * How should messages be logged out? Defaults to using the console logger.
   */
  logger?: Logger;
}
